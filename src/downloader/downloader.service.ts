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
    }

    async onModuleDestroy() {
        await this.redis.quit();
    }

    async hitRateLimit(key: string): Promise<number> {
        // INCR va EXPIRE atomik bajariladi — aks holda kalit abadiy qolishi mumkin
        const res = await this.redis.multi().set(key, 0, 'EX', 60, 'NX').incr(key).exec();
        return Number(res?.[1]?.[1] ?? 0);
    }

    async download(url: string): Promise<{ dir: string; files: MediaFile[] }> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-'));

        const ytError = await this.run('yt-dlp', [
            '-f', 'best[ext=mp4]',
            '--ignore-errors',
            '--no-warnings',
            '--no-mtime',
            '--max-filesize', '50M',
            '--socket-timeout', '30',
            ...this.cookieArgs,
            '-o', path.join(dir, '%(id)s.%(ext)s'),
            url,
        ], 180_000);

        let files = await this.collect(dir);

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
        if (files.length === 0 && ytError && !NO_VIDEO.test(ytError)) {
            await this.cleanup(dir);
            throw new Error(`yt-dlp: ${ytError}`);
        }

        return { dir, files };
    }

    // Dasturni ishga tushiradi; xato bo'lsa matnini qaytaradi (qisman yuklangan fayllar ham ishlatiladi)
    private async run(cmd: string, args: string[], timeout: number): Promise<string | null> {
        try {
            await exec(cmd, args, { timeout });
            return null;
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.warn(`${cmd} exit non-zero: ${msg}`);
            return msg;
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
        const err = await this.run('ffmpeg', ['-y', '-v', 'error', '-i', file, out], 30_000);
        return err ? file : out;
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