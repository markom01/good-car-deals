import { Test, TestingModule } from '@nestjs/testing';
import { ScraperService } from './scraper.service';
import { ApiClientService, SearchPage } from './api-client.service';
import { HtmlParserService, RawListingData } from './html-parser.service';
import { PrismaService } from '../prisma/prisma.service';

type UpsertArgs = {
  where: { listingUrl: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
};

const rawListing = (listingUrl: string): RawListingData => ({
  title: 'Opel Astra J',
  brand: 'Opel',
  model: 'Astra',
  listingUrl,
  price: '5.550 €',
  priceNote: '',
  year: '2015',
  mileageKm: '150000',
  fuelType: '',
  engineVolume: '',
  powerKw: '',
  transmission: '',
  location: '',
});

describe('ScraperService', () => {
  let scraperService: ScraperService;
  const fetchSearchPage = jest.fn<Promise<SearchPage>, [number]>();
  const isListingActive = jest.fn<Promise<boolean>, [string]>();
  const upsert = jest.fn<Promise<unknown>, [UpsertArgs]>();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        {
          provide: ApiClientService,
          useValue: { fetchSearchPage, isListingActive },
        },
        {
          provide: HtmlParserService,
          useValue: {
            normalizeMileage: jest.fn().mockReturnValue(150000),
            normalizePrice: jest
              .fn()
              .mockReturnValue({ raw: '5.550 €', numeric: 5550 }),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            listing: { upsert },
          },
        },
      ],
    }).compile();

    scraperService = module.get<ScraperService>(ScraperService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isListingActive.mockResolvedValue(true);
  });

  describe('scrapeTargetModel', () => {
    it('collects listings from every API page and dedupes by url', async () => {
      fetchSearchPage.mockImplementation((page: number) =>
        Promise.resolve({
          pageCount: 2,
          listings:
            page === 1
              ? [rawListing('https://example.com/auto-oglasi/1/a')]
              : [
                  rawListing('https://example.com/auto-oglasi/1/a'),
                  rawListing('https://example.com/auto-oglasi/2/b'),
                ],
        }),
      );

      const listings = await scraperService.scrapeTargetModel();

      expect(fetchSearchPage).toHaveBeenCalledTimes(2);
      expect(listings.map((l) => l.listingUrl)).toEqual([
        'https://example.com/auto-oglasi/1/a',
        'https://example.com/auto-oglasi/2/b',
      ]);
    });

    it('keeps the first page when a later page fails', async () => {
      fetchSearchPage
        .mockResolvedValueOnce({
          pageCount: 2,
          listings: [rawListing('https://example.com/auto-oglasi/1/a')],
        })
        .mockRejectedValueOnce(new Error('HTTP error: 500'));

      const listings = await scraperService.scrapeTargetModel();

      expect(listings).toHaveLength(1);
    });
  });

  describe('saveListings - expired listing filtering', () => {
    it('saves a live listing', async () => {
      const live = 'https://example.com/auto-oglasi/1/live-car';

      const saved = await scraperService.saveListings([rawListing(live)]);

      expect(saved).toHaveLength(1);
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('stores a brand-scoped model label', async () => {
      await scraperService.saveListings([
        rawListing('https://example.com/auto-oglasi/1/live-car'),
      ]);

      expect(upsert.mock.calls[0][0].create.model).toBe('Opel Astra');
    });

    it('does not save an expired listing', async () => {
      const expired = 'https://example.com/auto-oglasi/2/expired-car';
      isListingActive.mockResolvedValue(false);

      const saved = await scraperService.saveListings([rawListing(expired)]);

      expect(saved).toHaveLength(0);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('filters expired from a mixed batch and saves only live ones', async () => {
      const live = 'https://example.com/auto-oglasi/3/live-car';
      const expired = 'https://example.com/auto-oglasi/4/expired-car';
      isListingActive.mockImplementation((id: string) =>
        Promise.resolve(id === '3'),
      );

      const saved = await scraperService.saveListings([
        rawListing(expired),
        rawListing(live),
      ]);

      expect(saved).toHaveLength(1);
      expect(upsert).toHaveBeenCalledTimes(1);
    });
  });
});
