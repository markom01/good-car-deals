import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ScraperService } from './scraper.service';
import { HttpService } from './http.service';
import { HtmlParserService, RawListingData } from './html-parser.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ScraperService - expired listing filtering', () => {
  let scraperService: ScraperService;
  const isListingLive = jest.fn<Promise<boolean>, [string]>();
  const upsert = jest.fn();

  const rawListing = (listingUrl: string): RawListingData => ({
    title: 'Opel Astra J',
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

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScraperService,
        {
          provide: HttpService,
          useValue: { isListingLive },
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
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'scraper.model') return 'Astra J';
              return undefined;
            },
          },
        },
      ],
    }).compile();

    scraperService = module.get<ScraperService>(ScraperService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    isListingLive.mockResolvedValue(true);
  });

  it('saves a live listing', async () => {
    const live = 'https://example.com/auto-oglasi/1/live-car';

    const saved = await scraperService.saveListings([rawListing(live)]);

    expect(saved).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('does not save an expired listing', async () => {
    const expired = 'https://example.com/auto-oglasi/2/expired-car';
    isListingLive.mockResolvedValue(false);

    const saved = await scraperService.saveListings([rawListing(expired)]);

    expect(saved).toHaveLength(0);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('filters expired from a mixed batch and saves only live ones', async () => {
    const live = 'https://example.com/auto-oglasi/3/live-car';
    const expired = 'https://example.com/auto-oglasi/4/expired-car';
    isListingLive.mockImplementation((url: string) =>
      Promise.resolve(url === live),
    );

    const saved = await scraperService.saveListings([
      rawListing(expired),
      rawListing(live),
    ]);

    expect(saved).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
