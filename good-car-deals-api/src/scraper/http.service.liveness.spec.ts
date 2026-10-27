import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';

// Impit is instantiated inside HttpService's constructor, so the whole
// module must be mocked to control redirect responses. The existing
// http.service.spec.ts performs REAL HTTP calls and must not be broken,
// hence this separate file.
const mockFetch = jest.fn();

jest.mock('impit', () => {
  class ImpitMock {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    fetch = (...args: unknown[]) => mockFetch(...args);
  }
  class HTTPStatusError extends Error {}
  class TimeoutError extends Error {}
  return { Impit: ImpitMock, HTTPStatusError, TimeoutError };
});

import { HttpService } from './http.service';

describe('HttpService - isListingLive (mocked redirects)', () => {
  let httpService: HttpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
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

  it('returns true when final URL still contains the ad id', async () => {
    const url =
      'https://www.polovniautomobili.com/auto-oglasi/30308599/opel-astra-j';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url,
      text: () => Promise.resolve('<html></html>'),
    });

    expect(await httpService.isListingLive(url)).toBe(true);
  });

  it('returns false when redirected to the generic search page (expired ad)', async () => {
    const url =
      'https://www.polovniautomobili.com/auto-oglasi/29140613/opel-astra-j-14-novo-novo-ch';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.polovniautomobili.com/auto-oglasi/opel/astra-j/karavan/benzin?redirect',
      text: () => Promise.resolve('<html></html>'),
    });

    expect(await httpService.isListingLive(url)).toBe(false);
  });

  it('returns true when liveness cannot be determined (transient error)', async () => {
    const url =
      'https://www.polovniautomobili.com/auto-oglasi/30308599/opel-astra-j';
    mockFetch.mockRejectedValue(new Error('ETIMEDOUT'));

    // Cloudflare/network hiccup must not drop a good listing
    expect(await httpService.isListingLive(url)).toBe(true);
  });

  it('returns true when URL has no extractable ad id (cannot verify)', async () => {
    const url = 'https://www.polovniautomobili.com/some/other/page';
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url,
      text: () => Promise.resolve('<html></html>'),
    });

    expect(await httpService.isListingLive(url)).toBe(true);
    // Nothing verifiable to fetch — must not even call the site
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('matches the ad id on word boundaries (id 1 must not match id 12345)', async () => {
    const url = 'https://www.polovniautomobili.com/auto-oglasi/1/some-car';
    // Redirect preserves a longer id containing the shorter one
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      url: 'https://www.polovniautomobili.com/auto-oglasi/12345/some-car',
      text: () => Promise.resolve('<html></html>'),
    });

    expect(await httpService.isListingLive(url)).toBe(false);
  });
});
