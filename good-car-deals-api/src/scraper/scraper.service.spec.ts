import { Test, TestingModule } from '@nestjs/testing';
import { ScraperService } from './scraper.service';
import { ApiClientService } from './api-client.service';
import { SearchPage, RawListingData } from './types';
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
  const upsert = jest.fn<Promise<unknown>, [UpsertArgs]>();
  const deleteMany = jest.fn<Promise<{ count: number }>, [unknown]>();
  const progressFindUnique = jest.fn<Promise<unknown>, [unknown]>();
  const progressUpsert = jest.fn<Promise<unknown>, [unknown]>();
  const progressUpdate = jest.fn<Promise<unknown>, [unknown]>();

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        {
          provide: ApiClientService,
          useValue: { fetchSearchPage },
        },
        {
          provide: PrismaService,
          useValue: {
            listing: { upsert, deleteMany },
            scrapeProgress: {
              findUnique: progressFindUnique,
              upsert: progressUpsert,
              update: progressUpdate,
            },
          },
        },
      ],
    }).compile();

    scraperService = module.get<ScraperService>(ScraperService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    deleteMany.mockResolvedValue({ count: 0 });
    progressUpsert.mockResolvedValue({});
    progressUpdate.mockResolvedValue({});
  });

  describe('scrapeAndSaveResumable', () => {
    it('resumes from the page after the saved checkpoint', async () => {
      progressFindUnique.mockResolvedValue({
        key: 'default',
        targetUrl: process.env.SCRAPER_TARGET_URL ?? '',
        lastPage: 3,
        pageCount: 4,
        status: 'running',
        startedAt: new Date(),
      });
      fetchSearchPage.mockResolvedValue({
        pageCount: 4,
        listings: [rawListing('https://example.com/auto-oglasi/4/d')],
      });

      const result = await scraperService.scrapeAndSaveResumable();

      expect(result.resumedFrom).toBe(4);
      expect(fetchSearchPage).toHaveBeenCalledTimes(1);
      expect(fetchSearchPage).toHaveBeenCalledWith(4);
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('starts at page 1 when the previous run finished', async () => {
      progressFindUnique.mockResolvedValue({
        key: 'default',
        targetUrl: process.env.SCRAPER_TARGET_URL ?? '',
        lastPage: 9,
        pageCount: 9,
        status: 'done',
        startedAt: new Date(),
      });
      fetchSearchPage.mockResolvedValue({
        pageCount: 1,
        listings: [rawListing('https://example.com/auto-oglasi/1/a')],
      });

      const result = await scraperService.scrapeAndSaveResumable();

      expect(result.resumedFrom).toBe(1);
      expect(fetchSearchPage).toHaveBeenCalledWith(1);
    });
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

  describe('saveListings', () => {
    it('saves every listing from the feed without a detail-API call', async () => {
      const saved = await scraperService.saveListings([
        rawListing('https://example.com/auto-oglasi/1/a'),
        rawListing('https://example.com/auto-oglasi/2/b'),
      ]);

      expect(saved).toHaveLength(2);
      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it('stores a brand-scoped model label', async () => {
      await scraperService.saveListings([
        rawListing('https://example.com/auto-oglasi/1/live-car'),
      ]);

      expect(upsert.mock.calls[0][0].create.model).toBe('Opel Astra');
    });

    it('stores the plate origin derived from feed tags', async () => {
      await scraperService.saveListings([
        {
          ...rawListing('https://example.com/auto-oglasi/5/domestic'),
          plateOrigin: 'domestic',
        },
      ]);

      expect(upsert.mock.calls[0][0].create.plateOrigin).toBe('domestic');
      expect(upsert.mock.calls[0][0].update.plateOrigin).toBe('domestic');
    });

    it('skips foreign-plate listings (never reaches the DB)', async () => {
      await scraperService.saveListings([
        {
          ...rawListing('https://example.com/auto-oglasi/6/import'),
          plateOrigin: 'foreign',
        },
      ]);

      expect(upsert).not.toHaveBeenCalled();
    });
  });

  describe('deep-pagination guard', () => {
    it('stops when the feed repeats a page instead of saving duplicates', async () => {
      const repeated = [
        rawListing('https://example.com/auto-oglasi/1/a'),
        rawListing('https://example.com/auto-oglasi/2/b'),
      ];
      progressFindUnique.mockResolvedValue(null);
      fetchSearchPage.mockResolvedValue({
        pageCount: 5000,
        listings: repeated,
      });

      const result = await scraperService.scrapeAndSaveResumable();

      expect(result.capped).toBe(true);
      expect(fetchSearchPage).toHaveBeenCalledTimes(2); // page 1 saved, page 2 repeated
      expect(upsert).toHaveBeenCalledTimes(2);
      expect(progressUpdate).toHaveBeenCalledWith({
        where: { key: 'default' },
        data: { status: 'capped' },
      });
    });

    it('keeps going when each page brings new listings', async () => {
      progressFindUnique.mockResolvedValue(null);
      fetchSearchPage.mockImplementation((page: number) =>
        Promise.resolve({
          pageCount: 3,
          listings: [
            rawListing(`https://example.com/auto-oglasi/${page}/a`),
            rawListing(`https://example.com/auto-oglasi/${page}/b`),
          ],
        }),
      );

      const result = await scraperService.scrapeAndSaveResumable();

      expect(result.capped).toBe(false);
      expect(fetchSearchPage).toHaveBeenCalledTimes(3);
      expect(upsert).toHaveBeenCalledTimes(6);
    });
  });
});
