import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job } from 'bullmq';
import { DownloaderService, VideoFile } from '../downloader/downloader.service.js';
import { BotService } from './bot.service.js';

// Telegram o'lchamni bilsa videoni asl nisbatida ko'rsatadi va darhol o'ynatadi
const videoMeta = (f: VideoFile) => ({
  width: f.width,
  height: f.height,
  duration: f.duration,
  supports_streaming: true,
});

@Processor('downloads', { concurrency: 2 })
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
    const { url, shortcode, chatId, statusMessageId, replyToMessageId } = job.data;
    const tg = this.botService.telegram;
    const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    let dir: string | null = null;
    let done = false;

    try {
      const result = await this.downloader.download(url);
      dir = result.dir;
      const files = result.files;

      if (files.length === 0) {
        await tg.sendMessage(chatId, 'Bu postda video topilmadi.', {
          reply_parameters: { message_id: replyToMessageId },
        });
      } else if (files.length === 1) {
        const sent = await tg.sendVideo(chatId, { source: files[0].path }, {
          ...videoMeta(files[0]),
          reply_parameters: { message_id: replyToMessageId },
        });
        await this.downloader.setCached(shortcode, [sent.video.file_id]);
        await this.postToChannel(url, [sent.video.file_id]);
      } else {
        // Retry'da allaqachon yuborilgan guruhlarni qayta yubormaslik uchun progress job'da saqlanadi
        const fileIds: string[] = job.data.sentFileIds ?? [];
        for (let i = fileIds.length; i < files.length; i += 10) {
          const sent = await tg.sendMediaGroup(
            chatId,
            files.slice(i, i + 10).map((f) => ({
              type: 'video' as const,
              media: { source: f.path },
              ...videoMeta(f),
            })),
            { reply_parameters: { message_id: replyToMessageId } },
          );
          fileIds.push(...sent.map((m: any) => m.video.file_id));
          await job.updateData({ ...job.data, sentFileIds: fileIds });
        }
        await this.downloader.setCached(shortcode, fileIds);
        await this.postToChannel(url, fileIds);
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
      if (dir) await this.downloader.cleanup(dir);
      if (statusMessageId && (done || isLastAttempt)) {
        await tg.deleteMessage(chatId, statusMessageId).catch(() => { });
      }
    }
  }

  // Yangi yuklangan videolarni kanalga ham tashlaydi. file_id orqali yuboriladi — qayta yuklash yo'q.
  // Kanal xatosi foydalanuvchi job'ini yiqitmasligi kerak (aks holda retry userga qayta yuboradi).
  private async postToChannel(url: string, fileIds: string[]) {
    if (!this.channelId) return;
    const tg = this.botService.telegram;
    try {
      if (fileIds.length === 1) {
        await tg.sendVideo(this.channelId, fileIds[0], { caption: url });
      } else {
        for (let i = 0; i < fileIds.length; i += 10) {
          await tg.sendMediaGroup(
            this.channelId,
            fileIds.slice(i, i + 10).map((id, j) => ({
              type: 'video' as const,
              media: id,
              ...(i === 0 && j === 0 ? { caption: url } : {}),
            })),
          );
        }
      }
    } catch (e) {
      this.logger.warn(`Kanalga yuborilmadi: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
