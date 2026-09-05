import { Module } from '@nestjs/common';
import { DownloaderService } from './downloader.service.js';

@Module({
  providers: [DownloaderService],
  exports: [DownloaderService],
})
export class DownloaderModule {}