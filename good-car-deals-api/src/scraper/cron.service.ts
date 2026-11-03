import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { ScraperService } from './scraper.service';
import { DealClassifierService } from '../analysis/deal-classifier.service';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly dealClassifierService: DealClassifierService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Weekly scrape: runs every Sunday at midnight (configurable).
   * Scrapes target model listings, saves to DB, and classifies deals.
   */
  @Cron(CronExpression.EVERY_WEEK)
  async handleWeeklyScrape(): Promise<void> {
    const cronSchedule = this.configService.get<string>(
      'scraper.cronSchedule',
    )!;

    this.logger.log(`Cron job triggered (schedule: ${cronSchedule})`);
    this.logger.log('Starting weekly scrape (all brands)...');

    const startTime = Date.now();

    try {
      // Step 1 + 2: Scrape pages and save each page as it arrives.
      // Resumes from the last saved page if a previous run was interrupted.
      const result = await this.scraperService.scrapeAndSaveResumable();
      this.logger.log(
        `Scrape segment done. Resumed from page ${result.resumedFrom}, ` +
          `saved ${result.saved} listings from ${result.pages} pages ` +
          `(${result.failed} failed).`,
      );

      if (result.capped) {
        this.logger.error(
          'Scrape hit the feed deep-pagination cap and stopped early. ' +
            'Raise the page size or partition the query before the next run.',
        );
      }

      if (result.saved === 0) {
        this.logger.warn(
          'Scrape saved 0 listings. Website may be unreachable or changed. ' +
            'Existing DB data preserved.',
        );
        return;
      }

      // Step 3: Classify deals
      const classified = await this.dealClassifierService.classifyDeals();
      this.logger.log(`Classified ${classified} listings`);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `Weekly scrape complete. Saved: ${result.saved}, ` +
          `Classified: ${classified}. Duration: ${duration}s`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Weekly scrape failed: ${message}`);

      if (error instanceof Error && error.stack) {
        this.logger.error(`Stack trace: ${error.stack}`);
      }

      // Don't crash the application — existing data in DB is preserved
      this.logger.warn(
        'Cron job failed but application continues running. ' +
          'Existing database data is preserved.',
      );
    }
  }
}
