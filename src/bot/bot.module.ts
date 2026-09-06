import { Module } from "@nestjs/common";
import { DownloaderModule } from "../downloader/downloader.module.js";
import { BotService } from "./bot.service.js";
import { BullModule } from "@nestjs/bullmq";
import { DownloadProcessor } from "./download.processor.js";

@Module({
    imports: [
        BullModule.registerQueue({ name: 'downloads' }),
        DownloaderModule
    ],
    providers: [BotService,DownloadProcessor]
})
export class BotModule { }