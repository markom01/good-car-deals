import { Injectable, Logger } from '@nestjs/common';
import { ApiClientService } from './api-client.service';
import { RawListingData } from './types';
import { PrismaService } from '../prisma/prisma.service';
import {
  normalizeMileage,
  normalizePrice,
  parseEngineCc,
  parsePowerKw,
} from '../utils/normalization';
import { Listing } from '@prisma/client';

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    private apiClientService: ApiClientService,
    private prismaService: PrismaService,
  ) {}

  private get maxPages(): number {
    return Number(process.env.SCRAPER_MAX_PAGES) || 500;
  }

  /**
   * Scrape the site-wide search feed (up to maxPages).
   * Pages come from the site's JSON search feed; pagination stops at the
   * last page the API reports or at the safety cap.
   * @returns Array of raw listing data (deduplicated by listingUrl)
   */
  async scrapeTargetModel({
    maxListings,
  }: { maxListings?: number } = {}): Promise<RawListingData[]> {
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

        // Early exit for bounded test runs: stop once we have enough unique
        // listings instead of crawling the whole catalogue.
        if (maxListings && allListings.length >= maxListings) {
          break;
        }

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
   * Resumable scrape: fetch pages from the saved checkpoint, persist each page
   * immediately, and advance the checkpoint. Re-running after an interruption
   * continues from the last saved page instead of refetching page 1.
   * @returns Counts for the completed (or paused) segment
   */
  async scrapeAndSaveResumable(): Promise<{
    saved: number;
    pages: number;
    failed: number;
    resumedFrom: number;
    capped: boolean;
  }> {
    const progressKey = 'default';
    const targetUrl = process.env.SCRAPER_TARGET_URL ?? '';

    const existing = await this.prismaService.scrapeProgress.findUnique({
      where: { key: progressKey },
    });
    const resumableRun =
      existing !== null &&
      existing.status === 'running' &&
      existing.targetUrl === targetUrl;

    const startedAt = resumableRun ? existing.startedAt : new Date();
    // SCRAPER_START_PAGE seeds a fresh run when earlier pages are already in
    // the DB from a run that predates checkpointing.
    const seeded = Number(process.env.SCRAPER_START_PAGE) || 0;
    const resumeFrom = resumableRun
      ? existing.lastPage + 1
      : Math.max(1, seeded);
    let lastPage = resumeFrom - 1;
    // On a fresh run the real page count is unknown until the first response,
    // so start at the safety cap instead of 1 (a seeded start would otherwise
    // never enter the loop).
    let pageCount = resumableRun ? existing.pageCount : this.maxPages;
    // A seeded run never refetched the pages below its start page, so it must
    // not treat their rows as stale.
    const seededRun = !resumableRun && seeded >= 1;

    await this.prismaService.scrapeProgress.upsert({
      where: { key: progressKey },
      update: { targetUrl, lastPage, pageCount, status: 'running', startedAt },
      create: {
        key: progressKey,
        targetUrl,
        lastPage,
        pageCount,
        status: 'running',
        startedAt,
      },
    });

    this.logger.log(
      resumableRun
        ? `Resuming scrape from page ${resumeFrom} (pages up to ${existing.lastPage} already saved)`
        : `Starting new scrape from page ${resumeFrom}`,
    );

    let saved = 0;
    let successCount = 0;
    let failCount = 0;
    let cappedAtPage: number | null = null;
    const seenUrls = new Set<string>();

    for (
      let page = resumeFrom;
      page <= Math.min(pageCount, this.maxPages);
      page++
    ) {
      try {
        this.logger.log(
          `Fetching page ${page}/${Math.min(pageCount, this.maxPages)}`,
        );

        const result = await this.apiClientService.fetchSearchPage(page);

        // The feed sporadically serves an empty page whose pageCount collapses
        // to 1 (a hole in the pagination, not the end of the catalogue):
        // neighbouring pages still return results. Keep the page count already
        // known and keep advancing; only a page 1 response may redefine it.
        const emptyPageHole =
          page > 1 && result.listings.length === 0 && result.pageCount === 1;
        if (!emptyPageHole) {
          pageCount = result.pageCount;
        }

        // Deep-pagination guard: past its limit the site re-serves the first
        // page instead of returning an error, so "no new listings" means the
        // feed is exhausted — never that the dataset is complete.
        const fresh = result.listings.filter(
          (listing) => !seenUrls.has(listing.listingUrl),
        );
        for (const listing of result.listings) {
          seenUrls.add(listing.listingUrl);
        }
        if (result.listings.length > 0 && fresh.length === 0) {
          cappedAtPage = page;
          this.logger.error(
            `Page ${page} repeated listings already seen in this run. ` +
              `The site caps deep pagination; stopping instead of saving duplicates.`,
          );
          break;
        }

        // Persist this page before moving on, so an interruption keeps it.
        const savedPage = await this.saveListings(result.listings);
        saved += savedPage.length;
        successCount++;
        lastPage = page;

        await this.prismaService.scrapeProgress.update({
          where: { key: progressKey },
          data: { lastPage: page, pageCount },
        });

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

    const totalPages = Math.min(pageCount, this.maxPages);

    if (cappedAtPage !== null) {
      await this.prismaService.scrapeProgress.update({
        where: { key: progressKey },
        data: { status: 'capped' },
      });
      this.logger.error(
        `Scrape stopped at page ${cappedAtPage}: the feed returned no new listings. ` +
          `Raise the page size or partition the query before re-running.`,
      );
      return {
        saved,
        pages: successCount,
        failed: failCount,
        resumedFrom: resumeFrom,
        capped: true,
      };
    }

    if (lastPage >= totalPages) {
      await this.prismaService.scrapeProgress.update({
        where: { key: progressKey },
        data: { status: 'done' },
      });

      // Rows this run never touched are listings that dropped off the feed.
      // Seeded runs never refetched earlier pages, and resumable runs are
      // filling gaps (not re-scraping everything), so both skip cleanup.
      if (seededRun || resumableRun) {
        this.logger.log(
          `${resumableRun ? 'Resumable' : 'Seeded'} start: skipping stale-listing cleanup`,
        );
      } else {
        const deleted = await this.prismaService.listing.deleteMany({
          where: { scrapedAt: { lt: startedAt } },
        });
        this.logger.log(
          `Removed ${deleted.count} stale listings not in this scrape`,
        );
      }
    } else {
      this.logger.warn(
        `Scrape paused at page ${lastPage}/${totalPages}. Progress saved — re-run to resume.`,
      );
    }

    this.logger.log(
      `Scrape saved ${saved} listings. Pages: ${successCount} successful, ${failCount} failed.`,
    );

    return {
      saved,
      pages: successCount,
      failed: failCount,
      resumedFrom: resumeFrom,
      capped: false,
    };
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
    let processedCount = 0;

    for (const raw of listings) {
      try {
        // Foreign-plate cars ("Strane tablice") are imports: their ask excludes
        // Serbian import duty, VAT and registration, so their price is not
        // comparable to a domestic car. Never persist them — they must not
        // reach the DB or the /deals endpoint.
        if (raw.plateOrigin === 'foreign') {
          processedCount++;
          continue;
        }

        // The feed already returns only `status === 'active'` ads. A per-ad
        // detail lookup adds one request per listing (~70k per full pass)
        // and finds nothing extra, so the feed is authoritative here.

        // Normalize mileage
        const mileageKm = normalizeMileage(raw.mileageKm);

        // Normalize price
        const priceData = normalizePrice(raw.price);

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
            plateOrigin: raw.plateOrigin ?? null,
            indexedAt: raw.indexedAt ? new Date(raw.indexedAt) : null,
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
            plateOrigin: raw.plateOrigin ?? null,
            indexedAt: raw.indexedAt ? new Date(raw.indexedAt) : null,
          },
        });

        savedListings.push(listing);
      } catch (error) {
        this.logger.warn(
          `Failed to save listing ${raw.listingUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      processedCount++;
      if (processedCount % 500 === 0) {
        this.logger.log(
          `Save progress: ${processedCount}/${listings.length} (saved ${savedListings.length})`,
        );
      }
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
