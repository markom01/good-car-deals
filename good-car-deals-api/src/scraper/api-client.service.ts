import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService, HttpError } from './http.service';
import { RawListingData } from './html-parser.service';

export interface SearchPage {
  listings: RawListingData[];
  pageCount: number;
}

interface SearchResult {
  id?: string | number;
  title?: string;
  year?: number;
  mileage?: number | null;
  fuel?: string;
  engineVolume?: number | null;
  power?: number | null;
  gearBox?: string;
  price?: number | null;
  city?: string;
  status?: string;
}

interface SearchPayload {
  pageProps?: {
    searchResults?: {
      pageCount?: number;
      results?: SearchResult[];
    };
  };
}

const CORE_API = 'https://core.polovniautomobili.com/api/v1';

@Injectable()
export class ApiClientService {
  private readonly logger = new Logger(ApiClientService.name);
  private readonly searchUrl: URL;
  private buildId: string | null = null;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.searchUrl = new URL(
      this.configService.get<string>('scraper.targetUrl')!,
    );
  }

  /**
   * Fetch one page of search results through the site's Next.js data endpoint.
   * @param page - Page number (1-based)
   */
  async fetchSearchPage(page: number): Promise<SearchPage> {
    const payload = await this.fetchWithBuildRetry<SearchPayload>(() =>
      this.dataUrl(page),
    );
    const searchResults = payload.pageProps?.searchResults;
    const results = searchResults?.results ?? [];

    return {
      pageCount: searchResults?.pageCount ?? 1,
      listings: results
        .filter((result) => result.status === 'active')
        .map((result) => this.toRawListing(result)),
    };
  }

  /**
   * Check whether an ad is still live via the detail API.
   * A 404 means the ad is gone; any other failure is treated as unverifiable
   * so a transient network error never deletes a listing.
   */
  async isListingActive(adId: string): Promise<boolean> {
    try {
      const detail = await this.httpService.fetchJson<{ status?: string }>(
        `${CORE_API}/classifieds/car/${adId}`,
      );
      return detail.status === 'active';
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return false;
      }
      return true;
    }
  }

  /**
   * Fetch JSON, refreshing the cached build id once when the deploy changed
   * and the old data endpoint answers 404.
   */
  private async fetchWithBuildRetry<T>(
    buildUrl: () => Promise<string>,
  ): Promise<T> {
    try {
      return await this.httpService.fetchJson<T>(await buildUrl());
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) {
        throw error;
      }
      this.buildId = null;
      return this.httpService.fetchJson<T>(await buildUrl());
    }
  }

  private dataUrl(page: number): Promise<string> {
    return this.dataUrlFrom(this.searchUrl.toString(), page);
  }

  private async dataUrlFrom(
    originalUrl: string,
    page?: number,
  ): Promise<string> {
    const buildId = await this.getBuildId();
    const url = new URL(originalUrl);
    const path = url.pathname.replace(/\/$/, '');

    if (page !== undefined) {
      url.searchParams.set('page', String(page));
    }
    if (!url.searchParams.has('sort')) {
      url.searchParams.set('sort', 'basic');
    }
    // Same defaults the old HTML search URL applied.
    if (!url.searchParams.has('onlyWithPrice')) {
      url.searchParams.set('onlyWithPrice', 'true');
    }
    if (!url.searchParams.has('damaged[]')) {
      url.searchParams.set('damaged[]', 'notDamaged');
    }
    if (!url.searchParams.has('showOldNew')) {
      url.searchParams.set('showOldNew', 'old');
    }

    // The site addresses array params as model[0], model[1], …
    const params = new URLSearchParams();
    const arrayIndexes = new Map<string, number>();
    for (const [key, value] of url.searchParams) {
      if (!key.endsWith('[]')) {
        params.append(key, value);
        continue;
      }
      const base = key.slice(0, -2);
      const index = arrayIndexes.get(base) ?? 0;
      arrayIndexes.set(base, index + 1);
      params.append(`${base}[${index}]`, value);
    }

    return `${url.origin}/_next/data/${buildId}${path}.json?${params.toString()}`;
  }

  /** buildId changes on every deploy; read it from the server-rendered page. */
  private async getBuildId(): Promise<string> {
    if (this.buildId) {
      return this.buildId;
    }

    const html = await this.httpService.fetchPage(
      `${this.searchUrl.origin}${this.searchUrl.pathname}`,
    );
    const match = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    );
    if (!match) {
      throw new Error('Could not read __NEXT_DATA__ build id');
    }

    this.buildId =
      (JSON.parse(match[1]) as { buildId?: string }).buildId ?? null;
    if (!this.buildId) {
      throw new Error('Could not read __NEXT_DATA__ build id');
    }
    this.logger.log(`Using build id ${this.buildId}`);

    return this.buildId;
  }

  private toRawListing(result: SearchResult): RawListingData {
    return {
      title: result.title ?? '',
      listingUrl: `https://www.polovniautomobili.com/auto-oglasi/${result.id}`,
      price: this.formatPrice(result.price),
      priceNote: '',
      year: result.year ? String(result.year) : '',
      mileageKm: result.mileage ? String(result.mileage) : '',
      fuelType: result.fuel ?? '',
      engineVolume: result.engineVolume ? String(result.engineVolume) : '',
      powerKw: result.power ? String(result.power) : '',
      transmission: result.gearBox ?? '',
      location: result.city ?? '',
    };
  }

  /** "6250" → "6.250 €" (site display format). */
  private formatPrice(price?: number | null): string {
    if (!price) {
      return '';
    }
    return `${String(price).replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;
  }
}
