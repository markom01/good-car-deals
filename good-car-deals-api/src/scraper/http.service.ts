import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Impit, HTTPStatusError, TimeoutError } from 'impit';

/** Non-2xx response, carrying the status so callers can react to 404s. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP error: ${status}`);
    this.name = 'HttpError';
  }
}

@Injectable()
export class HttpService {
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
    return this.request(url, this.headers.Accept);
  }

  /**
   * Fetch a JSON endpoint with the same retry/proxy behaviour as fetchPage.
   * @param url - JSON endpoint
   * @returns Parsed response body
   */
  async fetchJson<T>(url: string): Promise<T> {
    const body = await this.request(url, 'application/json, text/plain, */*');
    return JSON.parse(body) as T;
  }

  private async request(url: string, accept: string): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.impit.fetch(url, {
          headers: { ...this.headers, Accept: accept },
          timeout: this.timeout,
        });

        // Check for HTTP errors
        if (!response.ok) {
          throw new HttpError(response.status);
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
