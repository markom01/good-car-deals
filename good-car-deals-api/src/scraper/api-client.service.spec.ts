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
    });
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

  it('reports a listing as active from the detail API', async () => {
    fetchJson.mockResolvedValue({ status: 'active' });

    await expect(service.isListingActive('30120777')).resolves.toBe(true);
    expect(fetchJson.mock.calls[0][0]).toContain(
      '/api/v1/classifieds/car/30120777',
    );
  });

  it('reports a missing listing as inactive', async () => {
    fetchJson.mockRejectedValue(new HttpError(404));

    await expect(service.isListingActive('999')).resolves.toBe(false);
  });

  it('keeps a listing when its status cannot be verified', async () => {
    fetchJson.mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.isListingActive('30120777')).resolves.toBe(true);
  });
});
