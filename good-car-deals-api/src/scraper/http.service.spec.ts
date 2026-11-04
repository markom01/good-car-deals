import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService, HttpError } from './http.service';
import { HTTPStatusError } from 'impit';

// Impit is instantiated inside HttpService's constructor, so the whole
// module must be mocked to control responses. This spec tests the real
// retry logic, error classification, and response parsing without any
// network calls.
const mockFetch = jest.fn();

jest.mock('impit', () => {
  class ImpitMock {
    fetch = (...args: unknown[]) => mockFetch(...args);
  }
  class HTTPStatusError extends Error {}
  class TimeoutError extends Error {}
  return {
    Impit: ImpitMock,
    HTTPStatusError,
    TimeoutError,
  };
});

describe('HttpService - mocked impit (no network)', () => {
  let httpService: HttpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              // scraper.targetUrl is the base search URL config — ApiClientService
              // transforms it into the Next.js JSON API endpoint. Not used for
              // HTML scraping of listing data.
              if (key === 'scraper.targetUrl')
                return 'https://www.polovniautomobili.com/auto-oglasi/pretraga';
              if (key === 'scraper.brand') return 'opel';
              if (key === 'scraper.model') return 'Astra J';
              return undefined;
            },
          },
        },
      ],
    }).compile();

    httpService = module.get<HttpService>(HttpService);
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  // Next.js JSON data endpoint pattern (current production approach):
  // /_next/data/<buildId>/auto-oglasi/pretraga.json?page=1&pageSize=200&...
  const JSON_DATA_URL =
    'https://www.polovniautomobili.com/_next/data/build-TEST123/auto-oglasi/pretraga.json?page=1&pageSize=200&sort=basic&onlyWithPrice=true&damaged%5B0%5D=notDamaged&showOldNew=old';

  // Base search URL (config value only — transformed to JSON API URL by
  // ApiClientService, never scraped as HTML directly).
  const SEARCH_TARGET_URL =
    'https://www.polovniautomobili.com/auto-oglasi/pretraga';

  it('fetchPage returns HTML text on successful response (buildId discovery only)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        '<html><head><script id="__NEXT_DATA__" type="application/json">{"buildId":"build-TEST123"}</script></head></html>',
    });

    const result = await httpService.fetchPage(SEARCH_TARGET_URL);

    expect(typeof result).toBe('string');
    expect(result).toContain('__NEXT_DATA__');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetchPage throws HttpError on non-2xx response (buildId discovery)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await expect(httpService.fetchPage(SEARCH_TARGET_URL)).rejects.toThrow(
      HttpError,
    );
  });

  it('fetchJson parses JSON body from Next.js data endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true }),
    });

    const result = await httpService.fetchJson<{ ok: boolean }>(JSON_DATA_URL);

    expect(result.ok).toBe(true);
  });

  it('fetchJson throws HttpError on non-2xx response from Next.js data endpoint', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(httpService.fetchJson(JSON_DATA_URL)).rejects.toThrow(
      HttpError,
    );
  });

  it('retries on timeout error (ETIMEDOUT)', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html>ok</html>',
      });

    const result = await httpService.fetchPage(SEARCH_TARGET_URL);

    expect(result).toContain('<html>');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('retries on 403 (Cloudflare challenge)', async () => {
    mockFetch
      .mockRejectedValueOnce(new HTTPStatusError('HTTP error: 403'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html>ok</html>',
      });

    const result = await httpService.fetchPage(SEARCH_TARGET_URL);

    expect(result).toContain('<html>');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on 503 (service unavailable)', async () => {
    mockFetch
      .mockRejectedValueOnce(new HTTPStatusError('HTTP error: 503'))
      .mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '<html>ok</html>',
      });

    const result = await httpService.fetchPage(SEARCH_TARGET_URL);

    expect(result).toContain('<html>');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on network errors (ETIMEDOUT, ECONNREFUSED, etc.)', async () => {
    const networkError = new Error('ETIMEDOUT');
    Object.defineProperty(networkError, 'message', { value: 'ETIMEDOUT' });

    mockFetch.mockRejectedValueOnce(networkError).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html>ok</html>',
    });

    const result = await httpService.fetchPage(SEARCH_TARGET_URL);

    expect(result).toContain('<html>');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries exhausted', async () => {
    mockFetch.mockRejectedValue(new Error('ETIMEDOUT'));

    await expect(httpService.fetchPage(SEARCH_TARGET_URL)).rejects.toThrow();
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors immediately', async () => {
    const nonRetryable = new Error('something else');
    mockFetch.mockRejectedValue(nonRetryable);

    await expect(httpService.fetchPage(SEARCH_TARGET_URL)).rejects.toThrow(
      'something else',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('isListingLive returns true when final URL still contains the ad id', async () => {
    const url =
      'https://www.polovniautomobili.com/auto-oglasi/30308599/opel-astra-j';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url,
      text: async () => '<html></html>',
    });

    expect(await httpService.isListingLive(url)).toBe(true);
  });

  it('isListingLive returns false when redirected to generic search page', async () => {
    const url =
      'https://www.polovniautomobili.com/auto-oglasi/29140613/opel-astra-j-14-novo-novo-ch';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.polovniautomobili.com/auto-oglasi/opel/astra-j/karavan/benzin?redirect',
      text: async () => '<html></html>',
    });

    expect(await httpService.isListingLive(url)).toBe(false);
  });

  it('isListingLive returns true when liveness cannot be determined (transient error)', async () => {
    const url =
      'https://www.polovniautomobili.com/auto-oglasi/30308599/opel-astra-j';
    mockFetch.mockRejectedValue(new Error('ETIMEDOUT'));

    expect(await httpService.isListingLive(url)).toBe(true);
  });

  it('isListingLive returns true when URL has no extractable ad id', async () => {
    const url = 'https://www.polovniautomobili.com/some/other/page';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url,
      text: async () => '<html></html>',
    });

    expect(await httpService.isListingLive(url)).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('isListingLive matches ad id on word boundaries (id 1 must not match id 12345)', async () => {
    const url = 'https://www.polovniautomobili.com/auto-oglasi/1/some-car';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.polovniautomobili.com/auto-oglasi/12345/some-car',
      text: async () => '<html></html>',
    });

    expect(await httpService.isListingLive(url)).toBe(false);
  });
});
