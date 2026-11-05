import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScraperModule } from '../scraper/scraper.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { PushModule } from '../push/push.module';
import { DealWatcherService } from './deal-watcher.service';
import { DealWatcherController } from './deal-watcher.controller';

@Module({
  imports: [ConfigModule, ScraperModule, AnalysisModule, PushModule],
  providers: [DealWatcherService],
  controllers: [DealWatcherController],
  exports: [DealWatcherService],
})
export class DealWatcherModule {}
