import { Injectable, Logger } from '@nestjs/common';
import { ApiClientService } from './api-client.service';
import { HtmlParserService, RawListingData } from './html-parser.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseEngineCc, parsePowerKw } from '../utils/normalization';
import { Listing } from '@prisma/client';

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    private apiClientService: ApiClientService,
    private htmlParserService: HtmlParserService,
    private prismaService: PrismaService,
  ) {}

  private get maxPages(): number {
    return Number(process.env.SCRAPER_MAX_PAGES) || 100;
  }

  /**
   * Scrape the site-wide search feed (up to maxPages).
   * Pages come from the site's JSON search feed; pagination stops at the
   * last page the API reports or at the safety cap.
   * @returns Array of raw listing data (deduplicated by listingUrl)
   */
  async scrapeTargetModel(): Promise<RawListingData[]> {
    const allListings: RawListingData[] = [];
    let pageCount = 1;
    let successCount = 0;
    let failCount = 0;

    this.logger.log('Starting scrape (all brands)...');

    for (let page = 1; page <= Math.min(pageCount, this.maxPages); page++) {
      try {
        this.logger.log(
          `Fetching page ${page}/${Math.min(pageCount, this.maxPages)}`,
        );

        const result = await this.apiClientService.fetchSearchPage(page);
        pageCount = result.pageCount;
        allListings.push(...result.listings);
        successCount++;

        // Small delay between pages to be polite
        if (page < Math.min(pageCount, this.maxPages)) {
          await this.sleep(1000);
        }
      } catch (error) {
        failCount++;
        this.logger.warn(
          `Failed to fetch page ${page}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        // Continue to next page on error
      }
    }

    // Deduplicate by listingUrl
    const uniqueListings = this.deduplicateByUrl(allListings);

    this.logger.log(
      `Scraping complete. Pages: ${successCount} successful, ${failCount} failed. ` +
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

    this.logger.log(`Saving ${listings.length} listings to database...`);
    let expiredCount = 0;

    for (const raw of listings) {
      try {
        // Skip listings that are no longer active
        // (the detail API returns 404 or a non-active status).
        const adId = raw.listingUrl.match(/\/auto-oglasi\/(\d+)/)?.[1];
        const live = adId
          ? await this.apiClientService.isListingActive(adId)
          : true;
        if (!live) {
          expiredCount++;
          this.logger.debug(`Skipping expired listing: ${raw.listingUrl}`);
          continue;
        }

        // Normalize mileage
        const mileageKm = this.htmlParserService.normalizeMileage(
          raw.mileageKm,
        );

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

        const model = this.modelLabel(raw);

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
            fuelType: raw.fuelType?.trim() || null,
            engineCc: parseEngineCc(raw.engineVolume),
            powerKw: parsePowerKw(raw.powerKw),
            transmission: raw.transmission?.trim() || null,
            location: raw.location?.trim() || null,
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
            fuelType: raw.fuelType?.trim() || null,
            engineCc: parseEngineCc(raw.engineVolume),
            powerKw: parsePowerKw(raw.powerKw),
            transmission: raw.transmission?.trim() || null,
            location: raw.location?.trim() || null,
          },
        });

        savedListings.push(listing);
      } catch (error) {
        this.logger.warn(
          `Failed to save listing ${raw.listingUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }

    if (expiredCount > 0) {
      this.logger.log(`Skipped ${expiredCount} expired listings`);
    }
    this.logger.log(`Saved ${savedListings.length} listings to database`);
    return savedListings;
  }

  /**
   * Brand-scoped model label ("Opel Astra") so deal comps never mix brands.
   */
  private modelLabel(raw: RawListingData): string | null {
    const label = [raw.brand, raw.model]
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' ');

    return label || null;
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
