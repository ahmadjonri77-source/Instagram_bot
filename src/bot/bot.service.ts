import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
    ) {
        const token = this.config.get<string>('BOT_TOKEN');
        if (!token) throw new Error('BOT_TOKEN topilmadi');
        this.bot = new Telegraf(token);
    }

    async onModuleInit() {
        this.bot.start((ctx) =>
            ctx.reply(' Assalomu Aleykum Hurmatli Mizoj😊\nInstagram post yoki reel linkini yuboring.✅\n '),
        );

        this.bot.on('text', async (ctx) => {
            const url = ctx.message.text.match(IG_REGEX)?.[0];
            if (!url) {
                await ctx.reply('Bu Instagram linkiga o\'xshamaydi.');
                return;
            }

            const status = await ctx.reply('Yuklanmoqda...');
            const { dir, files } = await this.downloader.download(url);

            try {
                if (files.length === 0) {
                    await ctx.reply('Bu postda video topilmadi.');
                } else if (files.length === 1) {
                    await ctx.replyWithVideo({ source: files[0] });
                } else {
                    for (let i = 0; i < files.length; i += 10) {
                        await ctx.replyWithMediaGroup(
                            files.slice(i, i + 10).map((f) => ({
                                type: 'video' as const,
                                media: { source: f },
                            })),
                        );
                    }
                }
            } catch (e) {
                this.logger.error(e);
                await ctx.reply('Xatolik yuz berdi.');
            } finally {
                await this.downloader.cleanup(dir);
                await ctx.deleteMessage(status.message_id).catch(() => { });
            }
        });

        this.bot.launch();
        this.logger.log('Bot ishga tushdi');
    }

    async onModuleDestroy() {
        this.bot.stop('SIGTERM');
    }
}