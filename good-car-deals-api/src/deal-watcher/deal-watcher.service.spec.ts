import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DealWatcherService } from './deal-watcher.service';
import { ScraperService } from '../scraper/scraper.service';
import { ApiClientService } from '../scraper/api-client.service';
import { DealClassifierService } from '../analysis/deal-classifier.service';
import { PushService } from '../push/push.service';
import { type FeedAd, type RawListingData } from '../scraper/types';

function feedAd(
  overrides: Omit<Partial<FeedAd>, 'raw'> & {
    raw?: Partial<RawListingData>;
  } = {},
): FeedAd {
  const raw: RawListingData = Object.assign(
    {
      title: 'Opel Astra 1.6',
      brand: 'Opel',
      model: 'Astra',
      listingUrl:
        'https://www.polovniautomobili.com/auto-oglasi/1/opel-astra-16',
      price: '6.250 €',
      priceNote: '',
      year: '2018',
      mileageKm: '100000',
      fuelType: 'Dizel',
      engineVolume: '1598',
      powerKw: '85',
      transmission: 'Manuelni 5 brzina',
      location: 'Beograd',
      plateOrigin: null,
    },
    overrides.raw ?? {},
  );
  return {
    adId: '1',
    indexedAt: '2026-11-05T09:00:00Z',
    updatedAt: null,
    raw,
    ...(overrides as Omit<Partial<FeedAd>, 'raw'>),
  };
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    listingUrl: 'https://www.polovniautomobili.com/auto-oglasi/1/opel-astra-16',
    title: 'Opel Astra 1.6',
    model: 'Opel Astra',
    priceNumeric: 9500n,
    year: 2018,
    age: 8,
    mileageKm: 100000,
    powerKw: 85,
    fuelType: 'Dizel',
    transmission: 'Manuelni 5 brzina',
    ...overrides,
  };
}

describe('DealWatcherService.poll', () => {
  let service: DealWatcherService;
  const configService = { get: jest.fn() };
  const prisma = {
    listing: { findMany: jest.fn() },
    seenPolovniAd: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const scraperService = { saveListings: jest.fn() };
  const apiClient = { fetchNewestAds: jest.fn() };
  const classifier = { scoreNewRows: jest.fn() };
  const pushService = { notifyNewAd: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    jest.clearAllMocks();
    configService.get.mockImplementation((key: string) => {
      if (key === 'dealWatcher.enabled') return false;
      if (key === 'dealWatcher.pollIntervalMs') return 600_000;
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DealWatcherService,
        { provide: ConfigService, useValue: configService },
        { provide: PrismaService, useValue: prisma },
        { provide: ScraperService, useValue: scraperService },
        { provide: ApiClientService, useValue: apiClient },
        { provide: DealClassifierService, useValue: classifier },
        { provide: PushService, useValue: pushService },
      ],
    }).compile();

    service = module.get<DealWatcherService>(DealWatcherService);
  });

  it('saves only rows that are unseen and not in the DB, and buzzes score-100 rows', async () => {
    const ad1 = feedAd({
      adId: '301',
      raw: {
        title: 'Opel Astra 1.6 CDTi',
        listingUrl: '.../301/opel-astra-16-cdti',
      },
    });
    const ad2 = feedAd({
      adId: '302',
      raw: { title: 'VW Golf 7', listingUrl: '.../302/golf-7' },
    });
    apiClient.fetchNewestAds.mockResolvedValue([ad1, ad2]);
    prisma.listing.findMany.mockResolvedValue([]);
    scraperService.saveListings.mockResolvedValue([
      listing({ id: 10n, listingUrl: ad1.raw.listingUrl }),
      listing({ id: 11n, listingUrl: ad2.raw.listingUrl }),
    ]);
    classifier.scoreNewRows.mockResolvedValue([
      {
        id: 10,
        dealType: 'GREAT DEAL',
        dealScore: 100,
        expectedPrice: 10000,
        deviationPct: 5,
        sampleSize: 11,
      },
      {
        id: 11,
        dealType: 'GOOD DEAL',
        dealScore: 95,
        expectedPrice: 9000,
        deviationPct: 4,
        sampleSize: 11,
      },
    ]);

    const result = await service.poll();

    expect(result).toEqual({ found: 2, newAds: 2, buzzed: 1 });
    expect(apiClient.fetchNewestAds).toHaveBeenCalledWith(1);
    expect(scraperService.saveListings).toHaveBeenCalledTimes(1);
    expect(scraperService.saveListings.mock.calls[0][0]).toHaveLength(2);
    expect(classifier.scoreNewRows).toHaveBeenCalledTimes(1);
    expect(pushService.notifyNewAd).toHaveBeenCalledTimes(1);
    const payload = pushService.notifyNewAd.mock.calls[0][0];
    expect(payload.id).toBe('301');
    expect(typeof payload.id).toBe('string');
    expect(payload.link).toBe('.../301/opel-astra-16-cdti');
    expect(prisma.seenPolovniAd.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.seenPolovniAd.createMany.mock.calls[0][0].data).toEqual([
      { id: '301' },
      { id: '302' },
    ]);
  });

  it('dedupes by adId before pre-check/save', async () => {
    const ad1 = feedAd({ adId: '301' });
    const ad1dup = feedAd({ adId: '301', indexedAt: '2026-11-05T09:05:00Z' });
    apiClient.fetchNewestAds.mockResolvedValue([ad1, ad1dup]);
    prisma.listing.findMany.mockResolvedValue([]);
    scraperService.saveListings.mockResolvedValue([listing()]);

    await service.poll();

    expect(scraperService.saveListings).toHaveBeenCalledTimes(1);
    expect(scraperService.saveListings.mock.calls[0][0]).toHaveLength(1);
  });

  it('treats rows already in the DB as not new even when unseen', async () => {
    const ad1 = feedAd({ adId: '301' });
    const ad2 = feedAd({
      adId: '302',
      raw: { listingUrl: '.../302/golf-7' },
    });
    apiClient.fetchNewestAds.mockResolvedValue([ad1, ad2]);
    prisma.listing.findMany.mockResolvedValue([
      { listingUrl: ad1.raw.listingUrl },
    ]);
    scraperService.saveListings.mockResolvedValue([listing({ id: 11n })]);
    classifier.scoreNewRows.mockResolvedValue([]);

    const result = await service.poll();

    expect(result.newAds).toBe(1);
    expect(scraperService.saveListings.mock.calls[0][0]).toHaveLength(1);
    // ad1 was not saved, but both IDs are still marked seen
    expect(prisma.seenPolovniAd.createMany.mock.calls[0][0].data).toEqual([
      { id: '301' },
      { id: '302' },
    ]);
  });

  it('skips ads already seen in a prior poll (cross-poll unseen gate)', async () => {
    const ad1 = feedAd({ adId: '301' });
    const ad2 = feedAd({
      adId: '302',
      raw: { listingUrl: '.../302/golf-7' },
    });
    apiClient.fetchNewestAds.mockResolvedValue([ad1, ad2]);
    prisma.listing.findMany.mockResolvedValue([]);
    scraperService.saveListings.mockResolvedValue([]);
    // 301 was seen in an earlier poll
    (service as unknown as { seen: Set<string> }).seen.add('301');

    const result = await service.poll();

    expect(result.newAds).toBe(1);
    expect(scraperService.saveListings.mock.calls[0][0]).toHaveLength(1);
    // both IDs still flushed to seen
    expect(prisma.seenPolovniAd.createMany.mock.calls[0][0].data).toEqual([
      { id: '301' },
      { id: '302' },
    ]);
  });

  it('skips marking seen when fetchNewestAds rejects', async () => {
    const error = new Error('403');
    apiClient.fetchNewestAds.mockRejectedValue(error);

    const result = await service.poll();

    expect(result).toEqual({ found: 0, newAds: 0, buzzed: 0 });
    expect(prisma.seenPolovniAd.createMany).not.toHaveBeenCalled();
  });

  it('completes the poll when scoreNewRows rejects (zero buzzes, seen flushed)', async () => {
    const ad1 = feedAd({ adId: '301' });
    apiClient.fetchNewestAds.mockResolvedValue([ad1]);
    prisma.listing.findMany.mockResolvedValue([]);
    scraperService.saveListings.mockResolvedValue([listing()]);
    classifier.scoreNewRows.mockRejectedValue(new Error('no snapshot'));

    const result = await service.poll();

    expect(result.buzzed).toBe(0);
    expect(pushService.notifyNewAd).not.toHaveBeenCalled();
    expect(prisma.seenPolovniAd.createMany).toHaveBeenCalledTimes(1);
  });

  it('flushes all batch ids to seenPolovniAd synchronously at poll end', async () => {
    const ad1 = feedAd({ adId: '301' });
    const ad2 = feedAd({ adId: '302' });
    apiClient.fetchNewestAds.mockResolvedValue([ad1, ad2]);
    prisma.listing.findMany.mockResolvedValue([]);
    scraperService.saveListings.mockResolvedValue([]);

    await service.poll();

    expect(prisma.seenPolovniAd.createMany).toHaveBeenCalledTimes(1);
    const data = prisma.seenPolovniAd.createMany.mock.calls[0][0].data;
    expect(data).toEqual([{ id: '301' }, { id: '302' }]);
    expect(
      prisma.seenPolovniAd.createMany.mock.calls[0][0].skipDuplicates,
    ).toBe(true);
  });

  it('poll still works when disabled (no interval started)', async () => {
    configService.get.mockImplementation((key: string) =>
      key === 'dealWatcher.enabled' ? false : undefined,
    );
    await service.onModuleInit();
    expect((service as any).timer).toBeNull();

    apiClient.fetchNewestAds.mockResolvedValue([]);
    prisma.listing.findMany.mockResolvedValue([]);
    const result = await service.poll();
    expect(result).toEqual({ found: 0, newAds: 0, buzzed: 0 });
  });
});
