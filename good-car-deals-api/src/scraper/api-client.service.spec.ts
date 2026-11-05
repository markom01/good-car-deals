import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ApiClientService } from './api-client.service';
import { HttpError, HttpService } from './http.service';

const NEXT_DATA_HTML = `<!DOCTYPE html><html><head></head><body>
<script id="__NEXT_DATA__" type="application/json" nonce="abc123" crossorigin="anonymous">{"buildId":"build-TEST123"}</script>
</body></html>`;

const searchPayload = (overrides: Record<string, unknown> = {}) => ({
  pageProps: {
    searchResults: {
      totalItems: 2,
      page: 1,
      pageCount: 7,
      resultsPerPage: 25,
      results: [
        {
          id: '30120777',
          title: 'Opel Astra K 1.6 CDTi S.S . SPORT',
          brand: 'Opel',
          model: 'Astra',
          year: 2018,
          mileage: 167707,
          fuel: 'Dizel',
          engineVolume: 1598,
          power: 100,
          gearBox: 'Manuelni 6 brzina',
          price: 6250,
          city: 'Novi Sad',
          status: 'active',
          ...overrides,
        },
      ],
    },
  },
});

describe('ApiClientService', () => {
  let service: ApiClientService;
  const fetchPage = jest.fn<Promise<string>, [string]>();
  const fetchJson = jest.fn<Promise<unknown>, [string]>();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiClientService,
        { provide: HttpService, useValue: { fetchPage, fetchJson } },
        // scraper.targetUrl is the base search URL config — ApiClientService
        // transforms it into the Next.js JSON API endpoint
        // (_next/data/<buildId>/auto-oglasi/pretraga.json). It is NOT used
        // for HTML scraping of listing data.
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'scraper.targetUrl'
                ? 'https://www.polovniautomobili.com/auto-oglasi/pretraga'
                : undefined,
          },
        },
      ],
    }).compile();

    service = module.get<ApiClientService>(ApiClientService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fetchPage.mockResolvedValue(NEXT_DATA_HTML);
  });

  it('maps a search result into raw listing data', async () => {
    fetchJson.mockResolvedValue(searchPayload());

    const page = await service.fetchSearchPage(1);

    expect(page.pageCount).toBe(7);
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]).toEqual({
      title: 'Opel Astra K 1.6 CDTi S.S . SPORT',
      brand: 'Opel',
      model: 'Astra',
      listingUrl:
        'https://www.polovniautomobili.com/auto-oglasi/30120777/opel-astra-k-16-cdti-ss-sport',
      price: '6.250 €',
      priceNote: '',
      year: '2018',
      mileageKm: '167707',
      fuelType: 'Dizel',
      engineVolume: '1598',
      powerKw: '100',
      transmission: 'Manuelni 6 brzina',
      location: 'Novi Sad',
      plateOrigin: null,
    });
  });

  it('maps plate-origin tags from the feed', async () => {
    fetchJson.mockResolvedValue(
      searchPayload({ tags: ['Garancija', 'Strane tablice'] }),
    );
    const imported = await service.fetchSearchPage(1);
    expect(imported.listings[0].plateOrigin).toBe('foreign');

    fetchJson.mockResolvedValue(searchPayload({ tags: ['Domaće tablice'] }));
    const domestic = await service.fetchSearchPage(1);
    expect(domestic.listings[0].plateOrigin).toBe('domestic');
  });

  it('turns diacritics and punctuation into a url-safe slug', async () => {
    fetchJson.mockResolvedValue(
      searchPayload({ title: 'Škoda Octavia 1.9 TDI, 2008. godište — Đakovo' }),
    );

    const page = await service.fetchSearchPage(1);

    expect(page.listings[0].listingUrl).toBe(
      'https://www.polovniautomobili.com/auto-oglasi/30120777/skoda-octavia-19-tdi-2008-godiste-dakovo',
    );
  });

  it('falls back to a placeholder slug when the title is empty', async () => {
    fetchJson.mockResolvedValue(searchPayload({ title: '' }));

    const page = await service.fetchSearchPage(1);

    expect(page.listings[0].listingUrl).toBe(
      'https://www.polovniautomobili.com/auto-oglasi/30120777/oglas',
    );
  });

  it('drops ads that are not active', async () => {
    fetchJson.mockResolvedValue(searchPayload({ status: 'expired' }));

    const page = await service.fetchSearchPage(1);

    expect(page.listings).toHaveLength(0);
  });

  it('builds a whole-site url without brand or model filters', async () => {
    fetchJson.mockResolvedValue(searchPayload());

    await service.fetchSearchPage(2);

    const url = fetchJson.mock.calls[0][0];
    expect(url).toContain(
      '/_next/data/build-TEST123/auto-oglasi/pretraga.json?',
    );
    expect(url).not.toContain('brand=');
    expect(url).not.toContain('model');
    expect(url).toContain('page=2');
    // 200 is the feed's maximum; 250 silently falls back to 25.
    expect(url).toContain('pageSize=200');
    expect(url).toContain('sort=basic');
    expect(url).toContain('onlyWithPrice=true');
    expect(url).toContain('damaged%5B0%5D=notDamaged');
    expect(url).toContain('showOldNew=old');
  });

  it('rediscovers the build id when a cached one is rejected', async () => {
    fetchJson
      .mockRejectedValueOnce(new HttpError(404))
      .mockResolvedValue(searchPayload());

    const page = await service.fetchSearchPage(1);

    expect(fetchPage).toHaveBeenCalledTimes(1); // build id fetched after the 404
    expect(page.listings).toHaveLength(1);
  });

  describe('fetchNewestAds', () => {
    const feedPayload = (results: Record<string, unknown>[]) => ({
      pageProps: { searchResults: { pageCount: 3, results } },
    });

    const third = (id: string) => ({
      id,
      title: `Opel Astra ${id}`,
      brand: 'Opel',
      model: 'Astra',
      year: 2019,
      mileage: 120000,
      fuel: 'Dizel',
      engineVolume: 1598,
      power: 100,
      gearBox: 'Manuelni 6 brzina',
      price: 9000,
      city: 'Beograd',
      status: 'active',
    });

    it('requests sort=renew_date_desc and pageSize=200 and maps ads with ids/indexedAt', async () => {
      fetchJson.mockResolvedValue(
        feedPayload([
          { ...third('301'), indexedAt: '2026-11-05T09:00:00Z' },
          { ...third('302'), indexedAt: '2026-11-05T08:00:00Z' },
          {
            ...third('303'),
            status: 'expired',
            indexedAt: '2026-11-05T07:00:00Z',
          },
        ]),
      );

      const ads = await service.fetchNewestAds(1);

      const url = fetchJson.mock.calls[0][0];
      expect(url).toContain(
        '/_next/data/build-TEST123/auto-oglasi/pretraga.json?',
      );
      expect(url).toContain('sort=renew_date_desc');
      expect(url).toContain('pageSize=200');
      expect(url).toContain('page=1');

      expect(ads).toHaveLength(2);
      expect(ads[0].adId).toBe('301');
      expect(ads[0].indexedAt).toBe('2026-11-05T09:00:00Z');
      expect(ads[0].updatedAt).toBeNull();
      expect(ads[0].raw.listingUrl).toBe(
        'https://www.polovniautomobili.com/auto-oglasi/301/opel-astra-301',
      );
      expect(ads[1].adId).toBe('302');
    });

    it('does not mutate the shared searchUrl between calls', async () => {
      fetchJson.mockResolvedValue(feedPayload([third('301')]));

      await service.fetchNewestAds(1);
      await service.fetchNewestAds(2);
      await service.fetchSearchPage(1);

      const newestUrl = fetchJson.mock.calls[0][0];
      const secondNewestUrl = fetchJson.mock.calls[1][0];
      const scrapeUrl = fetchJson.mock.calls[2][0];

      expect(newestUrl).toContain('sort=renew_date_desc');
      expect(secondNewestUrl).toContain('sort=renew_date_desc');
      expect(secondNewestUrl).toContain('page=2');
      expect(scrapeUrl).toContain('sort=basic');
      expect(scrapeUrl).not.toContain('sort=renew_date_desc');
    });

    it('deduplicates FeedAds by adId within a page', async () => {
      fetchJson.mockResolvedValue(
        feedPayload([
          { ...third('301'), indexedAt: '2026-11-05T09:00:00Z' },
          { ...third('301'), indexedAt: '2026-11-05T09:05:00Z' },
          third('302'),
        ]),
      );

      const ads = await service.fetchNewestAds(1);

      expect(ads.map((ad) => ad.adId)).toEqual(['301', '302']);
    });
  });
});
