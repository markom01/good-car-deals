import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { validate } from './config/validation.schema';
import { PrismaModule } from './prisma/prisma.module';
import { ScraperModule } from './scraper/scraper.module';
import { AnalysisModule } from './analysis/analysis.module';
import { DealsModule } from './deals/deals.module';
import { CronService } from './scraper/cron.service';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      validate,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ScraperModule,
    AnalysisModule,
    DealsModule,
  ],
  controllers: [AppController],
  providers: [AppService, CronService],
})
export class AppModule {}
