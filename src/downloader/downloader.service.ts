import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Redis } from 'ioredis';

const exec = promisify(execFile);

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

    async download(url: string): Promise<{ dir: string; files: string[] }> {
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

        const files = (await fs.readdir(dir))
            .filter((f) => f.endsWith('.mp4'))
            .map((f) => path.join(dir, f));

        // Hech narsa yuklanmagan bo'lsa va yt-dlp xato bergan bo'lsa — bu "video yo'q" emas, xato
        if (files.length === 0 && error) {
            await this.cleanup(dir);
            throw new Error(`yt-dlp: ${error}`);
        }

        return { dir, files };
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