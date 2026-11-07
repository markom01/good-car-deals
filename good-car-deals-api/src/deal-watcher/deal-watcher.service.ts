import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, type Listing } from '../prisma/prisma.service';
import { ScraperService } from '../scraper/scraper.service';
import { ApiClientService } from '../scraper/api-client.service';
import { type FeedAd } from '../scraper/types';
import {
  ClassifyResult,
  DealClassifierService,
} from '../analysis/deal-classifier.service';
import { PushService } from '../push/push.service';

const POLL_PAGE = 1;

/** Buzz gate: only a brand-new listing with exactly this score is pushed. */
function dedupeByAdId(ads: FeedAd[]): FeedAd[] {
  const seen = new Set<string>();
  const out: FeedAd[] = [];
  for (const ad of ads) {
    if (seen.has(ad.adId)) continue;
    seen.add(ad.adId);
    out.push(ad);
  }
  return out;
}

@Injectable()
export class DealWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DealWatcherService.name);
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingSeen: string[] = [];
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly buzzThreshold: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly scraperService: ScraperService,
    private readonly apiClient: ApiClientService,
    private readonly classifier: DealClassifierService,
    private readonly pushService: PushService,
  ) {
    this.enabled =
      this.configService.get<boolean>('dealWatcher.enabled') === true;
    this.pollIntervalMs =
      Number(this.configService.get<number>('dealWatcher.pollIntervalMs')) ||
      600_000;
    this.buzzThreshold =
      Number(this.configService.get<number>('dealWatcher.buzzThreshold')) ||
      100;
  }

  async onModuleInit(): Promise<void> {
    await this.loadSeen();
    if (this.enabled) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
      this.logger.log(`Deal watcher polling every ${this.pollIntervalMs}ms`);
    } else {
      this.logger.log(
        'Deal watcher disabled. Set DEAL_WATCHER_ENABLED=true to start polling.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flushSeen([]);
  }

  /**
   * One poll of the newest-first feed: save+classify brand-new listings and
   * web-push each one whose deal score hits the buzz threshold.
   */
  async poll(): Promise<{ found: number; newAds: number; buzzed: number }> {
    let ads: FeedAd[];
    try {
      ads = await this.apiClient.fetchNewestAds(POLL_PAGE);
    } catch (error) {
      // A failed fetch must not mark any of this batch's IDs as seen:
      // the next interval retries from a clean slate.
      this.logger.error(
        `Deal watcher poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { found: 0, newAds: 0, buzzed: 0 };
    }

    const found = ads.length;

    // Dedupe within the batch before touching the DB.
    const deduped = dedupeByAdId(ads);

    // Unseen gate: skip ads already seen in any prior poll, even if they
    // never landed in `listings` (failed scrape filters, etc.).
    const unseen = deduped.filter((ad) => !this.seen.has(ad.adId));
    const urls = unseen.map((ad) => ad.raw.listingUrl);

    // Pre-check: a listing already in `listings` is not new, even if we
    // haven't seen its feed ID yet (indexedAt moves on bumps/edits).
    const inDb = await this.prisma.listing.findMany({
      where: { listingUrl: { in: urls } },
      select: { listingUrl: true },
    });
    const inDbUrls = new Set(inDb.map((row) => row.listingUrl));
    const kept = unseen.filter((ad) => !inDbUrls.has(ad.raw.listingUrl));
    const newAds = kept.length;

    let buzzed = 0;
    if (kept.length > 0) {
      // saveListings keeps only rows that pass the scrape filters.
      const saved = await this.scraperService.saveListings(
        kept.map((ad) => ad.raw),
      );
      const classified = await this.classifySaved(saved);
      const adByUrl = new Map(unseen.map((ad) => [ad.raw.listingUrl, ad]));

      for (let i = 0; i < saved.length; i++) {
        const result = classified[i];
        const listing = saved[i];
        if (!result || result.dealScore < this.buzzThreshold) continue;
        const ad = adByUrl.get(listing.listingUrl);
        if (!ad) continue;
        await this.pushService.notifyNewAd({
          id: ad.adId,
          title: ad.raw.title,
          price:
            listing.priceNumeric === null ? null : String(listing.priceNumeric),
          dealScore: result.dealScore,
          deviationPct: result.deviationPct,
          published: ad.indexedAt,
          link: listing.listingUrl,
        });
        buzzed++;
      }
    }

    // Mark every batch ad ID as seen, synchronously at the end of a
    // successful poll. A flush failure keeps IDs pending for the next poll.
    await this.flushSeen(deduped.map((ad) => ad.adId));

    return { found, newAds, buzzed };
  }

  private async classifySaved(
    saved: Listing[],
  ): Promise<(ClassifyResult | null)[]> {
    let results: ClassifyResult[];
    try {
      results = await this.classifier.scoreNewRows(
        saved.map((listing) => ({
          id: Number(listing.id),
          model: listing.model,
          priceNumeric:
            listing.priceNumeric === null ? null : Number(listing.priceNumeric),
          year: listing.year,
          age: listing.age,
          mileageKm: listing.mileageKm,
          powerKw: listing.powerKw,
          fuelType: listing.fuelType,
          transmission: listing.transmission,
        })),
      );
    } catch (error) {
      // A failed classification must not abort the poll: rows stay
      // unclassified in DB and will be scored on the next full pass.
      this.logger.error(
        `Deal watcher classification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return saved.map(() => null);
    }
    return results;
  }

  private async loadSeen(): Promise<void> {
    try {
      const rows = await this.prisma.seenPolovniAd.findMany({
        select: { id: true },
      });
      for (const row of rows) this.seen.add(row.id);
      this.logger.log(`Loaded ${this.seen.size} seen polovni ad IDs from DB`);
    } catch (error) {
      this.logger.error(`Failed to load seen polovni ad IDs: ${String(error)}`);
    }
  }

  private async flushSeen(ids: string[]): Promise<void> {
    if (ids.length === 0 && this.pendingSeen.length === 0) return;
    const batch = [...this.pendingSeen, ...ids];
    this.pendingSeen = [];
    try {
      await this.prisma.seenPolovniAd.createMany({
        data: batch.map((id) => ({ id })),
        skipDuplicates: true,
      });
      this.logger.log(`Flushed ${batch.length} seen polovni ad IDs to DB`);
    } catch (error) {
      this.pendingSeen.unshift(...batch);
      this.logger.error(`Failed to persist seen IDs: ${String(error)}`);
    }
  }
}
