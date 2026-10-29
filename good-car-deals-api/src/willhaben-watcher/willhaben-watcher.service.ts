import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushService } from '../push/push.service';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

const WILLHABEN_API =
  'https://ad-search.willhaben.at/restapi/v2/search/atz/seo/gebrauchtwagen/auto';

// Required by willhaben's ad-search API. Without it the endpoint returns 400.
const WH_CLIENT_HEADER = 'api@willhaben.at;responsive_web;server;1.0.0;desktop';

interface WillhabenAttribute {
  name: string;
  values: string[];
}

interface WillhabenAdvert {
  id: string | number;
  description: string;
  attributes: { attribute: WillhabenAttribute[] };
}

interface WillhabenSearchResponse {
  advertSummaryList?: {
    advertSummary: WillhabenAdvert[];
  };
}

interface WatcherConfig {
  enabled: boolean;
  pollIntervalMs: number;
  filter: string;
}

@Injectable()
export class WillhabenWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WillhabenWatcherService.name);
  private readonly config: WatcherConfig;
  private readonly seenFile: string;
  private readonly seen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  private readonly priceTo?: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly pushService: PushService,
  ) {
    const filter = this.configService.get<string>('WILLHABEN_FILTER') ?? '';
    const priceToMatch = filter.match(/price[_:]?to[=:](\d+)/i);
    this.priceTo = priceToMatch ? Number(priceToMatch[1]) : undefined;

    this.config = {
      enabled: this.configService.get<string>('WILLHABEN_ENABLED') === 'true',
      pollIntervalMs: Number(
        this.configService.get<number>('WILLHABEN_POLL_INTERVAL_MS') ?? 5000,
      ),
      filter,
    };
    this.seenFile = join(process.cwd(), 'data', 'willhaben-seen.json');
    this.loadSeen();
  }

  onModuleInit(): void {
    if (this.config.enabled) {
      this.start();
    } else {
      this.logger.log(
        'Willhaben watcher disabled. Set WILLHABEN_ENABLED=true to start polling.',
      );
    }
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Manually trigger one poll. Used by the /poll endpoint. */
  async poll(): Promise<{ found: number; newAds: number }> {
    const url =
      WILLHABEN_API +
      '?rows=30&sort=1' +
      (this.config.filter ? '&' + this.config.filter : '');

    const headers: Record<string, string> = {
      'x-wh-client': WH_CLIENT_HEADER,
      Accept: 'application/json',
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Willhaben API returned ${response.status}`);
    }

    const body = (await response.json()) as WillhabenSearchResponse;
    const ads: WillhabenAdvert[] = body.advertSummaryList?.advertSummary ?? [];

    let newAds = 0;
    for (const ad of ads) {
      const id = String(ad.id);
      if (this.seen.has(id)) continue;

      const published = this.attr(ad, 'PUBLISHED');
      const priceStr = this.attr(ad, 'PRICE/AMOUNT');
      const price = priceStr ? Number(priceStr) : null;
      const seo = this.attr(ad, 'SEO_URL');
      const link = seo ? 'https://www.willhaben.at/iad/' + seo : null;

      // Client-side price filter (willhaben API doesn't support price filtering)
      if (
        this.priceTo !== undefined &&
        price !== null &&
        price > this.priceTo
      ) {
        continue;
      }

      this.logger.log(
        `[WILLHABEN] NEW ${id} ${ad.description} €${priceStr ?? '-'} ` +
          `${published ? new Date(Number(published)).toISOString() : '-'} ` +
          `${link ?? ''}`,
      );

      await this.pushService.notifyNewAd({
        id,
        title: ad.description,
        price: priceStr,
        published,
        link,
      });

      this.seen.add(id);
      newAds++;
    }

    if (newAds > 0) {
      this.saveSeen();
    }

    return { found: ads.length, newAds };
  }

  private attr(ad: WillhabenAdvert, name: string): string | null {
    const entry = ad.attributes.attribute.find((x) => x.name === name);
    return entry ? entry.values[0] : null;
  }

  private start(): void {
    void this.poll(); // immediate first poll
    this.timer = setInterval(
      () => void this.poll(),
      this.config.pollIntervalMs,
    );
    this.logger.log(
      `Willhaben watcher polling every ${this.config.pollIntervalMs}ms`,
    );
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private loadSeen(): void {
    try {
      if (existsSync(this.seenFile)) {
        const data: unknown = JSON.parse(readFileSync(this.seenFile, 'utf-8'));
        if (Array.isArray(data)) {
          for (const id of data) this.seen.add(String(id));
          this.logger.log(`Loaded ${this.seen.size} seen willhaben ad IDs`);
        }
      }
    } catch {
      // corrupt file -> start fresh
    }
  }

  private saveSeen(): void {
    try {
      const dir = this.seenFile.slice(0, this.seenFile.lastIndexOf('/'));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.seenFile, JSON.stringify([...this.seen]));
    } catch (error) {
      this.logger.error(`Failed to persist seen IDs: ${String(error)}`);
    }
  }
}
