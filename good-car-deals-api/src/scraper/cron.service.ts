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
    const cronSchedule = this.configService.get<string>('scraper.cronSchedule')!;
    const model = this.configService.get<string>('scraper.model')!;

    this.logger.log(`Cron job triggered (schedule: ${cronSchedule})`);
    this.logger.log(`Starting weekly scrape of ${model} listings...`);

    const startTime = Date.now();

    try {
      // Step 1: Scrape all pages
      const listings = await this.scraperService.scrapeTargetModel();
      this.logger.log(`Scraped ${listings.length} unique listings`);

      if (listings.length === 0) {
        this.logger.warn(
          'Scrape returned 0 listings. Website may be unreachable or changed. ' +
            'Existing DB data preserved.',
        );
        return;
      }

      // Step 2: Save to database
      const saved = await this.scraperService.saveListings(listings);
      this.logger.log(`Saved ${saved.length} listings to database`);

      // Step 3: Classify deals
      const classified = await this.dealClassifierService.classifyDeals();
      this.logger.log(`Classified ${classified} listings`);

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(
        `Weekly scrape complete. Scraped: ${listings.length}, ` +
          `Saved: ${saved.length}, Classified: ${classified}. ` +
          `Duration: ${duration}s`,
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
