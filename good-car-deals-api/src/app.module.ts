import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration from './config/configuration';
import { validate } from './config/validation.schema';
import { PrismaModule } from './prisma/prisma.module';
import { ScraperModule } from './scraper/scraper.module';
import { AnalysisModule } from './analysis/analysis.module';
import { DealsModule } from './deals/deals.module';
import { CronService } from './scraper/cron.service';
import { WillhabenWatcherModule } from './willhaben-watcher/willhaben-watcher.module';
import { PushModule } from './push/push.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      validate,
    }),
    // Rate limit: 100 req/min per IP (public read-only API on Render free).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    ScraperModule,
    AnalysisModule,
    DealsModule,
    WillhabenWatcherModule,
    PushModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    CronService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
