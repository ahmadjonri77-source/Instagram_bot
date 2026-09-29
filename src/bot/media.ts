import type { Telegram } from 'telegraf';
import type { CachedMedia, MediaType } from '../downloader/downloader.service.js';

export interface OutgoingMedia {
  type: MediaType;
  // Yangi fayl uchun { source: path }, keshdagi uchun file_id
  media: string | { source: string };
  width?: number;
  height?: number;
  duration?: number;
}

interface SendOptions {
  replyTo?: number;
  caption?: string;
  // Retry'da allaqachon yuborilganlar — ular qayta yuborilmaydi
  sent?: CachedMedia[];
  onProgress?: (sent: CachedMedia[]) => Promise<unknown>;
}

// Telegram o'lchamni bilsa videoni asl nisbatida ko'rsatadi va darhol o'ynatadi
const videoExtra = (m: OutgoingMedia) =>
  m.type === 'video'
    ? { width: m.width, height: m.height, duration: m.duration, supports_streaming: true }
    : {};

const fileIdOf = (msg: any): CachedMedia =>
  msg.video
    ? { type: 'video', fileId: msg.video.file_id }
    : { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id };

// Bitta bo'lsa oddiy xabar, ko'p bo'lsa 10 tadan albom qilib yuboradi. Yuborilganlarning file_id'larini qaytaradi.
export async function sendMedia(
  tg: Telegram,
  chatId: number | string,
  items: OutgoingMedia[],
  opts: SendOptions = {},
): Promise<CachedMedia[]> {
  const sent = [...(opts.sent ?? [])];
  const reply = opts.replyTo ? { reply_parameters: { message_id: opts.replyTo } } : {};

  for (let i = sent.length; i < items.length; i += 10) {
    const chunk = items.slice(i, i + 10);
    const caption = i === 0 && opts.caption ? { caption: opts.caption } : {};

    // Albomda kamida 2 ta element bo'lishi shart — bittasi alohida yuboriladi
    if (chunk.length === 1) {
      const m = chunk[0];
      const msg = m.type === 'video'
        ? await tg.sendVideo(chatId, m.media, { ...videoExtra(m), ...caption, ...reply })
        : await tg.sendPhoto(chatId, m.media, { ...caption, ...reply });
      sent.push(fileIdOf(msg));
    } else {
      const msgs = await tg.sendMediaGroup(
        chatId,
        chunk.map((m, j) => ({
          type: m.type,
          media: m.media,
          ...videoExtra(m),
          ...(j === 0 ? caption : {}),
        })) as any,
        reply,
      );
      sent.push(...msgs.map(fileIdOf));
    }
    await opts.onProgress?.(sent);
  }
  return sent;
}
