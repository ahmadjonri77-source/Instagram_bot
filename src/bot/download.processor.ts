import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { CachedMedia, DownloaderService } from '../downloader/downloader.service.js';
import { BotService } from './bot.service.js';
import { sendMedia } from './media.js';

@Processor('downloads', { concurrency: 5 })
export class DownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(DownloadProcessor.name);
  private readonly adminId: number | null;
  private readonly channelId: string | null;

  constructor(
    private readonly downloader: DownloaderService,
    private readonly botService: BotService,
    config: ConfigService,
  ) {
    super();
    this.adminId = Number(config.get('ADMIN_ID')) || null;
    this.channelId = config.get<string>('CHANNEL_ID') || null;
  }

  async process(job: Job) {
    const { url, cacheKey, chatId, statusMessageId, replyToMessageId } = job.data;
    const tg = this.botService.telegram;
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    let dir: string | null = null;
    let done = false;

    // "video yuborilmoqda..." belgisi — Telegram uni 5 soniyada o'chiradi, shuning uchun takrorlanadi
    const sendAction = () => tg.sendChatAction(chatId, 'upload_video').catch(() => { });
    sendAction();
    const actionTimer = setInterval(sendAction, 4000);

    const t0 = Date.now();
    try {
      const result = await this.downloader.download(url);
      dir = result.dir;
      const t1 = Date.now();

      if (result.tooBig) {
        await tg.sendMessage(chatId, 'Video juda katta (50 MB dan ortiq) — Telegram bot orqali yuborib bo\'lmaydi.', {
          reply_parameters: { message_id: replyToMessageId },
        });
      } else if (result.files.length === 0) {
        await tg.sendMessage(chatId, 'Bu postda media topilmadi.', {
          reply_parameters: { message_id: replyToMessageId },
        });
      } else {
        // Retry'da allaqachon yuborilgan qismlarni qayta yubormaslik uchun progress job'da saqlanadi
        const sent = await sendMedia(tg, chatId, result.files.map((f) => ({ ...f, media: { source: f.path } })), {
          replyTo: replyToMessageId,
          sent: job.data.sent ?? [],
          onProgress: (s) => job.updateData({ ...job.data, sent: s }),
        });
        // Qaysi bosqich sekinligini ko'rish uchun: navbat kutish / yuklab olish / Telegram'ga yuborish
        this.logger.log(
          `${cacheKey}: navbat ${t0 - job.timestamp}ms, yuklash ${t1 - t0}ms, yuborish ${Date.now() - t1}ms`,
        );
        await this.downloader.setCached(cacheKey, sent);
        await this.postToChannel(url, sent);
      }
      done = true;
    } catch (e) {
      this.logger.error(e);
      // Oraliq urinishlarda jim turamiz — BullMQ qayta urinadi
      if (isLastAttempt) {
        await tg.sendMessage(chatId, 'Xatolik yuz berdi.', {
          reply_parameters: { message_id: replyToMessageId },
        }).catch(() => { });
        if (this.adminId) {
          await tg
            .sendMessage(this.adminId, `Xato:\n${url}\n${e instanceof Error ? e.message : String(e)}`)
            .catch(() => { });
        }
      }
      throw e;
    } finally {
      clearInterval(actionTimer);
      if (dir) await this.downloader.cleanup(dir);
      if (statusMessageId && (done || isLastAttempt)) {
        await tg.deleteMessage(chatId, statusMessageId).catch(() => { });
      }
    }
  }

  // Yangi yuklangan medialarni kanalga ham tashlaydi. file_id orqali yuboriladi — qayta yuklash yo'q.
  // Kanal xatosi foydalanuvchi job'ini yiqitmasligi kerak (aks holda retry userga qayta yuboradi).
  private async postToChannel(url: string, media: CachedMedia[]) {
    if (!this.channelId) return;
    try {
      await sendMedia(
        this.botService.telegram,
        this.channelId,
        media.map((m) => ({ type: m.type, media: m.fileId })),
        { caption: url },
      );
    } catch (e) {
      this.logger.warn(`Kanalga yuborilmadi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
