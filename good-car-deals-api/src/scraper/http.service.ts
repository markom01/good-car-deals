import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Impit, HTTPStatusError, TimeoutError } from 'impit';

@Injectable()
export class HttpService {
  private readonly baseUrl: string;
  private readonly brand: string;
  private readonly model: string;
  private readonly timeout = 10000;
  private readonly maxRetries = 3;
  private readonly headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.google.com/',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };
  private readonly impit: Impit;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('scraper.targetUrl')!;
    this.brand = this.configService.get<string>('scraper.brand')!;
    this.model = this.configService.get<string>('scraper.model')!;

    const opts: Record<string, unknown> = {
      browser: 'firefox',
      timeout: this.timeout,
      http3: true,
    };

    // Optional residential proxy to bypass Cloudflare IP blocks
    const proxyUrl = this.configService.get<string>('scraper.proxyUrl');
    if (proxyUrl) {
      opts.proxyUrl = proxyUrl;
      console.log('Using proxy for scraping');
    }

    this.impit = new Impit(opts);
  }

  /**
   * Fetch a page with retry logic (3 attempts, exponential backoff)
   * @param url - The URL to fetch
   * @returns The HTML content as a string
   */
  async fetchPage(url: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.impit.fetch(url, {
          headers: this.headers,
          timeout: this.timeout,
        });

        // Check for HTTP errors
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status}`);
        }

        return await response.text();
      } catch (error) {
        lastError = error as Error;

        // Determine if this error is retryable
        const isRetryable = this.isRetryableError(error);

        if (isRetryable && attempt < this.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.log(
            `Retry ${attempt}/${this.maxRetries} for ${url} after ${delay}ms`,
          );
          await this.sleep(delay);
        } else if (!isRetryable) {
          // Non-retryable error, don't retry
          throw error;
        }
      }
    }

    // All retries exhausted
    throw new Error(
      `Failed to fetch ${url} after ${this.maxRetries} attempts: ${lastError?.message}`,
    );
  }

  /**
   * Probe a listing detail URL and decide whether the ad is still live.
   * Expired ads no longer resolve to their detail page: the site
   * redirects them to the generic search page (brand/model facet URL),
   * so the final URL loses the ad id path segment.
   * Returns false only when a redirect is confirmed. Transient errors
   * (403 challenge, timeout, network) count as live, so a single
   * hiccup cannot drop a good listing — the next run probes it again.
   * @param url - The listing detail URL (canonical, without tracking params)
   * @returns true when the listing is live (or liveness could not be verified)
   */
  async isListingLive(url: string): Promise<boolean> {
    const adId = url.match(/\/auto-oglasi\/(\d+)/)?.[1];
    // No ad id → nothing to verify against; keep the listing.
    if (!adId) return true;

    try {
      const response = await this.impit.fetch(url, {
        headers: this.headers,
        timeout: this.timeout,
      });
      // Live detail pages keep /auto-oglasi/<adId>/ in the final URL;
      // expired ones redirect to a query-less facet URL without the id.
      const finalUrl = response.url ?? url;
      return new RegExp(`/auto-oglasi/${adId}(/|\\?|$)`).test(finalUrl);
    } catch {
      return true; // Cannot verify — assume live.
    }
  }

  /**
   * Build search URL with brand/model.
   * Mirrors the site's canonical link format exactly
   * (e.g. ?brand=Opel&model[]=Astra+J&page=2&sort=basic):
   * lowercase/hyphenated slugs return page 1 content for every
   * page number, so case and spacing must be preserved.
   * @param page - Page number (1-based)
   * @returns The constructed URL
   */
  buildSearchUrl(page: number): string {
    const separator = this.baseUrl.includes('?') ? '&' : '?';
    // Preserve model spacing as "+" (site canonical form, not hyphenated)
    const modelParam = this.model.trim().replace(/\s+/g, '+');
    // Capitalize brand ("opel" → "Opel"), keep the rest untouched
    // so already-correct values ("BMW") survive
    const brandParam = this.brand.charAt(0).toUpperCase() + this.brand.slice(1);

    return `${this.baseUrl}${separator}brand=${brandParam}&model[]=${modelParam}&page=${page}&sort=basic&damaged[]=notDamaged&onlyWithPrice=true&showOldNew=old`;
  }

  /**
   * Check if an error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    // Retry on timeout errors
    if (error instanceof TimeoutError) {
      return true;
    }
    // Retry on HTTP 403 (Cloudflare challenge) or 503 (service unavailable)
    if (error instanceof HTTPStatusError) {
      // HTTPStatusError may not always carry status; try message parsing
      const msg = error.message || '';
      if (msg.includes('403') || msg.includes('503')) {
        return true;
      }
    }
    // Retry on generic network errors
    if (error instanceof Error) {
      if (
        error.message?.includes('ETIMEDOUT') ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('ENOTFOUND') ||
        error.message?.includes('ECONNRESET')
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
