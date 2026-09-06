import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotModule } from './bot/bot.module.js';
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({ connection: { host: '127.0.0.1', port: 6379 }, }),
    BotModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule { }
