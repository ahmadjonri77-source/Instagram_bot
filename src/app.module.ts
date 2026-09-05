import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BotModule } from './bot/bot.module.js';

@Module({
  imports: [ConfigModule.forRoot({
    isGlobal:true
  }),
  BotModule
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
