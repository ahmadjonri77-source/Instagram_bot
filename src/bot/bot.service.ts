import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Telegraf } from 'telegraf';
import { DownloaderService } from '../downloader/downloader.service.js';
import { parseLink } from './links.js';
import { sendMedia } from './media.js';

@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotService.name);
  private bot: Telegraf;

  constructor(
    private readonly config: ConfigService,
    private readonly downloader: DownloaderService,
    @InjectQueue('downloads') private readonly queue: Queue,
  ) {
    const token = this.config.get<string>('BOT_TOKEN');
    if (!token) throw new Error('BOT_TOKEN topilmadi');
    this.bot = new Telegraf(token);
  }

  get telegram() {
    return this.bot.telegram;
  }

  async onModuleInit() {
    this.bot.start((ctx) =>
      ctx.reply(' Assalomu Aleykum Hurmatli Mizoj😊\nInstagram linkini yuboring.✅\n '),
    );

    this.bot.on('text', async (ctx) => {
      const link = parseLink(ctx.message.text);
      if (!link) {
        // Guruhda javob yozmaymiz, faqat shaxsiy chatda
        if (ctx.chat.type === 'private') {
          await ctx.reply('Instagram linkini yuboring.');
        }
        return; // guruhda link topilmasa — jim turamiz
      }

      // 1. Cache
      const cached = await this.downloader.getCached(link.cacheKey);
      if (cached?.length) {
        await sendMedia(ctx.telegram, ctx.chat.id, cached.map((m) => ({ type: m.type, media: m.fileId })), {
          replyTo: ctx.message.message_id,
        });
        return;
      }

      // 2. Rate limit
      const userId = ctx.from?.id;
      if (!userId) return;
      const count = await this.downloader.hitRateLimit(`rl:${userId}`);
      if (count > 5) {
        await ctx.reply('Biroz sekinroq — bir daqiqada 5 tagacha video yuklash mumkin.', {
          reply_parameters: { message_id: ctx.message.message_id },
        });
        return;
      }

      // 3. Navbatga
      const isPrivate = ctx.chat.type === 'private';

      const status = isPrivate
        ? await ctx.reply('⏳ Yuklanmoqda...', {
          reply_parameters: { message_id: ctx.message.message_id },
        })
        : null;

      await this.queue.add(
        'download',
        {
          url: link.url,
          cacheKey: link.cacheKey,
          chatId: ctx.chat.id,
          statusMessageId: status?.message_id ?? null,
          replyToMessageId: ctx.message.message_id,
        },
        {
          attempts: 2,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
        },
      );
    });

    // Handler ichidagi xato polling'ni to'xtatib qo'ymasligi uchun
    this.bot.catch((err, ctx) => {
      this.logger.error(`Update ${ctx.update.update_id} xatosi: ${err instanceof Error ? err.stack : String(err)}`);
    });

    this.bot.launch().catch((err) => {
      this.logger.error(`Bot ishga tushmadi: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
    this.logger.log('Bot ishga tushdi');
  }

  async onModuleDestroy() {
    this.bot.stop('SIGTERM');
  }
}