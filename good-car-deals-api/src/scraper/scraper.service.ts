import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from './http.service';
import { HtmlParserService, RawListingData } from './html-parser.service';
import { PrismaService } from '../prisma/prisma.service';
import { Listing } from '@prisma/client';

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly maxPages = 15;

  constructor(
    private httpService: HttpService,
    private htmlParserService: HtmlParserService,
    private prismaService: PrismaService,
    private configService: ConfigService,
  ) {}

  /**
   * Scrape all target model listings from pages 1-15
   * @returns Array of raw listing data (deduplicated by listingUrl)
   */
  async scrapeTargetModel(): Promise<RawListingData[]> {
    const allListings: RawListingData[] = [];
    let successCount = 0;
    let failCount = 0;
    const model = this.configService.get<string>('scraper.model')!;

    this.logger.log(`Starting scrape of ${model} listings...`);

    for (let page = 1; page <= this.maxPages; page++) {
      try {
        const url = this.httpService.buildSearchUrl(page);
        this.logger.log(`Scraping page ${page}/${this.maxPages}: ${url}`);

        const html = await this.httpService.fetchPage(url);
        const pageListings = this.htmlParserService.parsePage(html);

        allListings.push(...pageListings);
        successCount++;

        // Small delay between pages to be polite
        await this.sleep(1000);
      } catch (error) {
        failCount++;
        this.logger.warn(
          `Failed to scrape page ${page}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Continue to next page on error
      }
    }

    // Deduplicate by listingUrl
    const uniqueListings = this.deduplicateByUrl(allListings);

    this.logger.log(
      `Scraping complete. Pages: ${successCount}/${this.maxPages} successful, ${failCount} failed. ` +
        `Total listings: ${allListings.length}, Unique: ${uniqueListings.length}`,
    );

    return uniqueListings;
  }

  /**
   * Save listings to database with upsert (handle duplicates)
   * @param listings - Array of raw listing data
   * @returns Array of saved Listing records
   */
  async saveListings(listings: RawListingData[]): Promise<Listing[]> {
    const savedListings: Listing[] = [];
    const currentYear = new Date().getFullYear();
    const model = this.configService.get<string>('scraper.model')!;

    this.logger.log(`Saving ${listings.length} listings to database...`);

    for (const raw of listings) {
      try {
        // Normalize mileage
        const mileageKm = this.htmlParserService.normalizeMileage(raw.mileageKm);

        // Normalize price
        const priceData = this.htmlParserService.normalizePrice(raw.price);

        // Calculate age from year
        let age: number | null = null;
        if (raw.year) {
          const yearNum = parseInt(raw.year, 10);
          if (!isNaN(yearNum)) {
            age = currentYear - yearNum;
          }
        }

        // Upsert listing
        const listing = await this.prismaService.listing.upsert({
          where: { listingUrl: raw.listingUrl },
          update: {
            title: raw.title,
            price: priceData.raw,
            priceNumeric: priceData.numeric,
            priceNote: raw.priceNote || null,
            year: raw.year ? parseInt(raw.year, 10) : null,
            age,
            mileageKm,
            model,
            scrapedAt: new Date(),
            updatedAt: new Date(),
          },
          create: {
            listingUrl: raw.listingUrl,
            title: raw.title,
            price: priceData.raw,
            priceNumeric: priceData.numeric,
            priceNote: raw.priceNote || null,
            year: raw.year ? parseInt(raw.year, 10) : null,
            age,
            mileageKm,
            model,
          },
        });

        savedListings.push(listing);
      } catch (error) {
        this.logger.warn(
          `Failed to save listing ${raw.listingUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    this.logger.log(`Saved ${savedListings.length} listings to database`);
    return savedListings;
  }

  /**
   * Deduplicate listings by listingUrl
   */
  private deduplicateByUrl(listings: RawListingData[]): RawListingData[] {
    const seen = new Set<string>();
    const unique: RawListingData[] = [];

    for (const listing of listings) {
      if (!seen.has(listing.listingUrl)) {
        seen.add(listing.listingUrl);
        unique.push(listing);
      }
    }

    return unique;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
