import { Module } from "@nestjs/common";
import { DownloaderModule } from "../downloader/downloader.module.js";
import { BotService } from "./bot.service.js";

@Module({
    imports:[DownloaderModule],
    providers:[BotService]
})
export class BotModule{}