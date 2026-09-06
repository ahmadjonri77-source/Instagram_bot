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
            const match = ctx.message.text.match(IG_REGEX);
            if (!match) {
                await ctx.reply('Bu Instagram linkiga o\'xshamaydi.');
                return;
            }

            const url = match[0];
            const shortcode = match[1];   // regex'dagi ([\w-]+) qismi

            // 1. Avval cache
            const cached = await this.downloader.getCached(shortcode);
            if (cached?.length) {
                if (cached.length === 1) {
                    await ctx.replyWithVideo(cached[0]);
                } else {
                    for (let i = 0; i < cached.length; i += 10) {
                        await ctx.replyWithMediaGroup(
                            cached.slice(i, i + 10).map((id) => ({ type: 'video' as const, media: id })),
                        );
                    }
                }
                return;
            }


            const userId = ctx.from.id;
            const key = `rl:${userId}`;
            const count = await this.downloader.hitRateLimit(key);

            if (count > 5) {
                await ctx.reply('Biroz sekinroq — bir daqiqada 5 tagacha video yuklash mumkin.');
                return;
            }


            // 2. Cache'da yo'q — yuklaymiz
            const status = await ctx.reply('Yuklanmoqda...');
            const { dir, files } = await this.downloader.download(url);

            try {
                if (files.length === 0) {
                    await ctx.reply('Bu postda video topilmadi.');
                } else if (files.length === 1) {
                    const sent = await ctx.replyWithVideo({ source: files[0] });
                    await this.downloader.setCached(shortcode, [sent.video.file_id]);
                } else {
                    const fileIds: string[] = [];
                    for (let i = 0; i < files.length; i += 10) {
                        const sent = await ctx.replyWithMediaGroup(
                            files.slice(i, i + 10).map((f) => ({
                                type: 'video' as const,
                                media: { source: f },
                            })),
                        );
                        fileIds.push(...sent.map((m: any) => m.video.file_id));
                    }
                    await this.downloader.setCached(shortcode, fileIds);
                }
            } catch (e) {
                this.logger.error(e);
                await ctx.reply('Xatolik yuz berdi.');
                const adminId = 1267528378
                if (adminId) {
                    await this.bot.telegram
                        .sendMessage(adminId, `Xato:\n${url}\n${e instanceof Error ? e.message : String(e)}`)
                        .catch(() => { });
                }

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