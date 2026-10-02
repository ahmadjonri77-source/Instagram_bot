import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Redis } from 'ioredis';

const exec = promisify(execFile);

export type MediaType = 'video' | 'photo';

export interface MediaFile {
    type: MediaType;
    path: string;
    width?: number;
    height?: number;
    duration?: number;
}

export interface CachedMedia {
    type: MediaType;
    fileId: string;
}

const PHOTO_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

// yt-dlp shunday desa, bu xato emas — postda haqiqatan video yo'q
const NO_VIDEO = /no video|no media|unsupported url/i;
const TOO_BIG = /larger than max-filesize/i;

// YouTube'da ovozli mp4 faqat 360p — shuning uchun H.264 video va m4a ovoz alohida olinib, mp4 ga birlashtiriladi
// (Telegram VP9/AV1 ni hamma qurilmada o'ynatmaydi)
const YOUTUBE = /youtube\.com|youtu\.be/i;
const YOUTUBE_FORMAT = 'bv*[ext=mp4][vcodec^=avc][height<=1080]+ba[ext=m4a]/b[ext=mp4]';

@Injectable()
export class DownloaderService implements OnModuleDestroy {
    private readonly logger = new Logger(DownloaderService.name);
    private readonly redis: Redis;
    private readonly cookieArgs: string[];

    constructor(config: ConfigService) {
        // Netscape formatidagi cookie fayli — Instagram rasmlari va 429 cheklovi uchun kerak
        const cookies = config.get<string>('COOKIES_FILE');
        this.cookieArgs = cookies ? ['--cookies', cookies] : [];

        this.redis = new Redis({
            host: config.get<string>('REDIS_HOST', '127.0.0.1'),
            port: Number(config.get('REDIS_PORT', 6379)),
        });
        // Busiz ioredis har qayta ulanishda "Unhandled error event" deb logni to'ldiradi
        this.redis.on('error', (e) => this.logger.warn(`Redis: ${e.message}`));
    }

    async onModuleDestroy() {
        await this.redis.quit();
    }

    async hitRateLimit(key: string): Promise<number> {
        // INCR va EXPIRE atomik bajariladi — aks holda kalit abadiy qolishi mumkin
        const res = await this.redis.multi().set(key, 0, 'EX', 60, 'NX').incr(key).exec();
        return Number(res?.[1]?.[1] ?? 0);
    }

    async download(url: string): Promise<{ dir: string; files: MediaFile[]; tooBig?: boolean }> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));
        const ytdlp = (format: string) => this.run('yt-dlp', [
            '-f', format,
            '--ignore-errors',
            '--no-warnings',
            '--no-mtime',
            // Telegram botlar 50 MB dan katta fayl yubora olmaydi
            '--max-filesize', '50M',
            '--socket-timeout', '30',
            '--merge-output-format', 'mp4',
            ...this.cookieArgs,
            '-o', path.join(dir, '%(id)s.%(ext)s'),
            url,
        ], 180_000);

        const yt = await ytdlp(YOUTUBE.test(url) ? YOUTUBE_FORMAT : 'best[ext=mp4]');
        let files = await this.collect(dir);

        // yt-dlp katta faylni jimgina tashlab ketadi (exit 0). Past sifatga o'tish yordam bermaydi:
        // Instagram'ning ovozli mp4 formatlari bitta fayl, qolganlari ovozsiz VP9.
        if (files.length === 0 && TOO_BIG.test(yt.output)) {
            return { dir, files, tooBig: true };
        }

        // Video topilmadi — rasmli post bo'lishi mumkin, gallery-dl bilan urinib ko'ramiz
        if (files.length === 0) {
            await this.run('gallery-dl', [
                '-D', dir,
                '--no-part',
                '--no-mtime',
                ...this.cookieArgs,
                url,
            ], 120_000);
            files = await this.collect(dir);
        }

        // Hech narsa yuklanmagan bo'lsa va yt-dlp haqiqiy xato bergan bo'lsa — retry uchun xato tashlaymiz
        if (files.length === 0 && yt.error && !NO_VIDEO.test(yt.error)) {
            await this.cleanup(dir);
            throw new Error(`yt-dlp: ${yt.error}`);
        }

        return { dir, files };
    }

    // Dasturni ishga tushiradi. Xato bo'lsa ham to'xtamaydi — qisman yuklangan fayllar ishlatiladi.
    private async run(cmd: string, args: string[], timeout: number): Promise<{ error: string | null; output: string }> {
        try {
            const { stdout, stderr } = await exec(cmd, args, { timeout });
            return { error: null, output: stdout + stderr };
        } catch (e: any) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`${cmd} exit non-zero: ${msg}`);
            return { error: msg, output: `${e?.stdout ?? ''}${e?.stderr ?? ''}` };
        }
    }

    // Yuklangan fayllarni yuklanish tartibida (post ichidagi tartib) yig'adi
    private async collect(dir: string): Promise<MediaFile[]> {
        const entries = await Promise.all(
            (await fs.readdir(dir)).map(async (name) => ({
                name,
                ext: path.extname(name).toLowerCase(),
                mtime: (await fs.stat(path.join(dir, name))).mtimeMs,
            })),
        );
        const media = entries
            .filter((e) => e.ext === '.mp4' || PHOTO_EXT.has(e.ext))
            .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));

        return Promise.all(media.map(async (e) => {
            const file = path.join(dir, e.name);
            if (e.ext === '.mp4') return this.readMeta(file);
            return { type: 'photo' as const, path: e.ext === '.webp' ? await this.toJpeg(file) : file };
        }));
    }

    // Telegram webp'ni rasm sifatida yaxshi qabul qilmaydi — jpg'ga o'giramiz
    private async toJpeg(file: string): Promise<string> {
        const out = file.replace(/\.webp$/i, '.jpg');
        const { error } = await this.run('ffmpeg', ['-y', '-v', 'error', '-i', file, out], 30_000);
        return error ? file : out;
    }

    // O'lchamlar ffprobe orqali olinadi — Instagram mp4 formatlarida yt-dlp ularni bermaydi.
    // Busiz Telegram videoni kvadrat/noto'g'ri nisbatda ko'rsatadi.
    private async readMeta(file: string): Promise<MediaFile> {
        const video: MediaFile = { type: 'video', path: file };
        try {
            const { stdout } = await exec('ffprobe', [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height:stream_side_data=rotation:format=duration',
                '-of', 'json',
                video.path,
            ], { timeout: 15_000 });
            const info = JSON.parse(stdout);
            const stream = info.streams?.[0] ?? {};
            const rotation = Math.abs(Number(stream.side_data_list?.[0]?.rotation ?? 0));
            const rotated = rotation === 90 || rotation === 270;
            if (stream.width && stream.height) {
                video.width = rotated ? stream.height : stream.width;
                video.height = rotated ? stream.width : stream.height;
            }
            const duration = Number(info.format?.duration);
            if (duration > 0) video.duration = Math.round(duration);
        } catch (e) {
            // ffprobe bo'lmasa ham video yuboriladi, faqat o'lchamsiz
            this.logger.warn(`ffprobe: ${e instanceof Error ? e.message : String(e)}`);
        }
        return video;
    }

    async getCached(key: string): Promise<CachedMedia[] | null> {
        const raw = await this.redis.get(key);
        if (!raw) return null;
        // Eski format: faqat video file_id'lari massivi
        return (JSON.parse(raw) as (string | CachedMedia)[]).map((m) =>
            typeof m === 'string' ? { type: 'video', fileId: m } : m,
        );
    }

    async setCached(key: string, media: CachedMedia[]) {
        // 30 kun saqlaymiz
        await this.redis.setex(key, 60 * 60 * 24 * 30, JSON.stringify(media));
    }

    async cleanup(dir: string) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}