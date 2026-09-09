import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { DownloaderService } from '../downloader/downloader.service.js';
import { BotService } from './bot.service.js';

const ADMIN_ID = 1267528378;

@Processor('downloads', { concurrency: 2 })
export class DownloadProcessor extends WorkerHost {
  private readonly logger = new Logger(DownloadProcessor.name);

  constructor(
    private readonly downloader: DownloaderService,
    private readonly botService: BotService,
  ) {
    super();
  }

  async process(job: Job) {
    const { url, shortcode, chatId, statusMessageId, replyToMessageId } = job.data;
    const tg = this.botService.telegram;

    const { dir, files } = await this.downloader.download(url);

    try {
      if (files.length === 0) {
        await tg.sendMessage(chatId, 'Bu postda video topilmadi.', {
          reply_parameters: { message_id: replyToMessageId },
        });
      } else if (files.length === 1) {
        const sent = await tg.sendVideo(chatId, { source: files[0] }, {
          reply_parameters: { message_id: replyToMessageId },
        });
        await this.downloader.setCached(shortcode, [sent.video.file_id]);
      } else {
        const fileIds: string[] = [];
        for (let i = 0; i < files.length; i += 10) {
          const sent = await tg.sendMediaGroup(
            chatId,
            files.slice(i, i + 10).map((f) => ({
              type: 'video' as const,
              media: { source: f },
            })),
            { reply_parameters: { message_id: replyToMessageId } },
          );
          fileIds.push(...sent.map((m: any) => m.video.file_id));
        }
        await this.downloader.setCached(shortcode, fileIds);
      }
    } catch (e) {
      this.logger.error(e);
      await tg.sendMessage(chatId, 'Xatolik yuz berdi.', {
        reply_parameters: { message_id: replyToMessageId },
      }).catch(() => { });
      await tg
        .sendMessage(ADMIN_ID, `Xato:\n${url}\n${e instanceof Error ? e.message : String(e)}`)
        .catch(() => { });
      throw e;
    } finally {
      await this.downloader.cleanup(dir);
      if (statusMessageId) {
        await tg.deleteMessage(chatId, statusMessageId).catch(() => { });
      }
    }
  }
}