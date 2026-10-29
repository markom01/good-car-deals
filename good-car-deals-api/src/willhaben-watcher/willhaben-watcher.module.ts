import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PushModule } from '../push/push.module';
import { WillhabenWatcherService } from './willhaben-watcher.service';
import { WillhabenWatcherController } from './willhaben-watcher.controller';

@Module({
  imports: [ConfigModule, PushModule],
  providers: [WillhabenWatcherService],
  controllers: [WillhabenWatcherController],
  exports: [WillhabenWatcherService],
})
export class WillhabenWatcherModule {}
