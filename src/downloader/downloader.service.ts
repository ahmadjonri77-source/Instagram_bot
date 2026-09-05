import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const exec = promisify(execFile);

@Injectable()
export class DownloaderService {
  private readonly logger = new Logger(DownloaderService.name);

  async download(url: string): Promise<{ dir: string; files: string[] }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-'));

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
       const msg = e instanceof Error ? e.message : String(e);
  this.logger.warn(`yt-dlp exit non-zero: ${msg}`);
    }

    const files = (await fs.readdir(dir))
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => path.join(dir, f));

    return { dir, files };
  }

  async cleanup(dir: string) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}