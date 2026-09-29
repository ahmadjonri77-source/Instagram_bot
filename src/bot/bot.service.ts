import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Telegraf } from 'telegraf';
import { DownloaderService } from '../downloader/downloader.service.js';

const IG_REGEX =
  /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i;

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
      ctx.reply(' Assalomu Aleykum Hurmatli Mizoj😊\nInstagram post yoki reel linkini yuboring.✅\n '),
    );

    this.bot.on('text', async (ctx) => {
      const match = ctx.message.text.match(IG_REGEX);
      if (!match) {
        // Guruhda javob yozmaymiz, faqat shaxsiy chatda
        if (ctx.chat.type === 'private') {
          await ctx.reply('Bu Instagram linkiga o\'xshamaydi.');
        }
        return; // guruhda link topilmasa — jim turamiz
      }

      const url = match[0];
      const shortcode = match[1];

      // 1. Cache
      const cached = await this.downloader.getCached(shortcode);
      if (cached?.length) {
        if (cached.length === 1) {
          await ctx.replyWithVideo(cached[0], {
            reply_parameters: { message_id: ctx.message.message_id },
          });
        } else {
          for (let i = 0; i < cached.length; i += 10) {
            await ctx.replyWithMediaGroup(
              cached.slice(i, i + 10).map((id) => ({ type: 'video' as const, media: id })),
            );
          }
        }
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
          url,
          shortcode,
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