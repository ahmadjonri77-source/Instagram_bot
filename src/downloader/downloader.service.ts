import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Redis } from 'ioredis';

const exec = promisify(execFile);

export interface VideoFile {
    path: string;
    width?: number;
    height?: number;
    duration?: number;
}

@Injectable()
export class DownloaderService implements OnModuleDestroy {
    private readonly logger = new Logger(DownloaderService.name);
    private readonly redis: Redis;

    constructor(config: ConfigService) {
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

    async download(url: string): Promise<{ dir: string; files: VideoFile[] }> {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-'));
        let error: string | null = null;

        try {
            await exec('yt-dlp', [
                '-f', 'best[ext=mp4]',
                '--ignore-errors',
                '--no-warnings',
                '--max-filesize', '50M',
                '--socket-timeout', '30',
                '-o', path.join(dir, '%(id)s.%(ext)s'),
                url,
            ], { timeout: 180_000 });
        } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            this.logger.warn(`yt-dlp exit non-zero: ${error}`);
        }

        const names = (await fs.readdir(dir)).filter((f) => f.endsWith('.mp4')).sort();
        const files = await Promise.all(names.map((f) => this.readMeta(dir, f)));

        // Hech narsa yuklanmagan bo'lsa va yt-dlp xato bergan bo'lsa — bu "video yo'q" emas, xato
        if (files.length === 0 && error) {
            await this.cleanup(dir);
            throw new Error(`yt-dlp: ${error}`);
        }

        return { dir, files };
    }

    // O'lchamlar ffprobe orqali olinadi — Instagram mp4 formatlarida yt-dlp ularni bermaydi.
    // Busiz Telegram videoni kvadrat/noto'g'ri nisbatda ko'rsatadi.
    private async readMeta(dir: string, file: string): Promise<VideoFile> {
        const video: VideoFile = { path: path.join(dir, file) };
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

    async getCached(shortcode: string): Promise<string[] | null> {
        const raw = await this.redis.get(`ig:${shortcode}`);
        return raw ? JSON.parse(raw) : null;
    }

    async setCached(shortcode: string, fileIds: string[]) {
        // 30 kun saqlaymiz
        await this.redis.setex(`ig:${shortcode}`, 60 * 60 * 24 * 30, JSON.stringify(fileIds));
    }

    async cleanup(dir: string) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => { });
    }
}