import {
  DealClassifierService,
  type ClassifierRow,
} from './deal-classifier.service';
import { PrismaService } from '../prisma/prisma.service';
import { deviationPct } from './deal-stats';
import { buildFitSnapshot, computeExpectedPrices } from './expected-price';

interface ListingInput {
  id: bigint;
  model: string | null;
  priceNumeric: bigint | null;
  year: number | null;
  age: number | null;
  mileageKm: number | null;
  powerKw: number | null;
  fuelType: string | null;
  transmission: string | null;
  scrapedAt: Date;
  updatedAt: Date;
}

function listing(input: Partial<ListingInput>): ListingInput {
  return {
    id: 1n,
    model: 'Opel Astra',
    priceNumeric: 10000n,
    year: 2015,
    age: 11,
    mileageKm: 100000,
    powerKw: 100,
    fuelType: 'Dizel',
    transmission: 'Manuelni 5 brzina',
    scrapedAt: new Date(),
    updatedAt: new Date(),
    ...input,
  };
}

describe('DealClassifierService.classifyDeals', () => {
  let service: DealClassifierService;
  const findMany = jest.fn();
  const update = jest.fn();
  const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
  const create = jest.fn().mockResolvedValue({});

  beforeEach(async () => {
    findMany.mockReset();
    update.mockReset();
    deleteMany.mockReset();
    create.mockReset();
    update.mockResolvedValue({});

    const module = {
      listing: { findMany, update },
      classificationSnapshot: { deleteMany, create },
    } as unknown as PrismaService;

    service = new DealClassifierService(module);
  });

  it('returns 0 when no listings exist', async () => {
    findMany.mockResolvedValue([]);

    const count = await service.classifyDeals();

    expect(count).toBe(0);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('classifies and persists a flat 12-row pool (≥11 kept comps)', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      listing({
        id: BigInt(10 + i),
        model: 'Opel Astra',
        priceNumeric: BigInt(10_000),
        year: 2015,
        age: 11,
        mileageKm: 100_000,
      }),
    );
    findMany.mockResolvedValue(rows);
    // getClassificationSummary calls findMany again with select
    findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map(() => ({ dealType: 'GOOD DEAL' })));

    const count = await service.classifyDeals();

    expect(count).toBe(12);
    // First fetch is deterministic: all rows ordered by id ascending.
    expect(findMany).toHaveBeenNthCalledWith(1, { orderBy: { id: 'asc' } });
    // One update per row, batched (batch size 500 → one batch for 12 rows)
    expect(update).toHaveBeenCalledTimes(12);
    // First update sets a rated dealType, a stored expected price, and comp count.
    const firstUpdate = update.mock.calls[0][0];
    expect(firstUpdate.where.id).toBe(BigInt(10));
    expect(firstUpdate.data.dealType).not.toBe('UNRATED');
    expect(firstUpdate.data.expectedPrice).not.toBeNull();
    expect(firstUpdate.data.expectedPriceSampleSize).toBe(11);

    // Snapshot persisted after the per-row pass
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0].data.payload;
    expect(Array.isArray(payload.scorePool)).toBe(true);
    expect(payload.scorePool).toHaveLength(12);
    expect(Object.keys(payload.groups).length).toBeGreaterThanOrEqual(1);
  });

  it('marks every row UNRATED when pool is below 11 kept rows', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      listing({
        id: BigInt(20 + i),
        priceNumeric: BigInt(10_000),
        year: 2015,
        age: 11,
        mileageKm: 100_000,
      }),
    );
    findMany.mockResolvedValue(rows);
    findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map(() => ({ dealType: 'UNRATED' })));

    const count = await service.classifyDeals();

    expect(count).toBe(10);
    expect(update).toHaveBeenCalledTimes(10);
    for (const call of update.mock.calls) {
      expect(call[0].data.dealType).toBe('UNRATED');
      expect(call[0].data.dealScore).toBe(0);
      expect(call[0].data.expectedPrice).toBeNull();
      expect(call[0].data.expectedPriceSampleSize).toBeNull();
    }
  });

  it('re-labels stale UNRATED rows when generation resolves', async () => {
    // A row with null generation in DB gets resolveGeneration(model, year)
    // applied in classifyDeals, so an Opel Astra 2015 resolves to a real gen.
    const rows = [listing({ id: BigInt(40), model: 'Opel Astra', year: 2015 })];
    // Need 12 total for a rated pool; add 11 more rated siblings
    const siblings = Array.from({ length: 11 }, (_, i) =>
      listing({ id: BigInt(41 + i), model: 'Opel Astra', year: 2015 }),
    );
    findMany.mockResolvedValue([...rows, ...siblings]);
    findMany
      .mockResolvedValueOnce([...rows, ...siblings])
      .mockResolvedValueOnce(
        [...rows, ...siblings].map(() => ({ dealType: 'GOOD DEAL' })),
      );

    await service.classifyDeals();

    // All 12 rows should be updated; the previously-null-generation row now rated
    expect(update).toHaveBeenCalledTimes(12);
    const firstUpdate = update.mock.calls.find(
      (c) => c[0].where.id === BigInt(40),
    );
    expect(firstUpdate).toBeDefined();
    expect(firstUpdate![0].data.dealType).not.toBe('UNRATED');
  });
});

describe('DealClassifierService.scoreNewRows', () => {
  let service: DealClassifierService;
  const findFirst = jest.fn();

  beforeEach(async () => {
    findFirst.mockReset();
    const module = {
      listing: { findMany: jest.fn(), update: jest.fn() },
      classificationSnapshot: { findFirst },
    } as unknown as PrismaService;

    service = new DealClassifierService(module);
  });

  const row = (overrides = {}): ClassifierRow => ({
    id: 100,
    model: 'Audi A3',
    priceNumeric: 9500,
    year: 2015,
    age: 11,
    mileageKm: 100000,
    powerKw: 100,
    fuelType: 'Dizel',
    transmission: 'Manuelni 5 brzina',
    generation: '8V (Third Gen)',
    ...overrides,
  });

  it('returns v2 fields null when no snapshot exists', async () => {
    findFirst.mockResolvedValue(null);

    const results = await service.scoreNewRows([row()]);

    expect(results).toHaveLength(1);
    expect(results[0].expectedPrice).toBeNull();
    expect(results[0].deviationPct).toBeNull();
    expect(results[0].sampleSize).toBeNull();
    expect(results[0].dealType).toBe('UNRATED');
    expect(results[0].dealScore).toBe(0);
  });

  it('scores rows deterministically against the stored snapshot', async () => {
    const fit = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      model: 'Audi A3',
      generation: '8V (Third Gen)',
      price: 10_000 + i * 100,
      age: 10,
      km: 100_000 + i * 5_000,
      powerKw: 90 + i * 5,
      fuelType: 'Dizel',
      transmission: 'Manuelni 5 brzina',
    }));
    const full = computeExpectedPrices(fit);
    const scorePool = full
      .map((p, i) =>
        p.expectedPrice !== null
          ? deviationPct(p.expectedPrice, fit[i].price)
          : null,
      )
      .filter((v): v is number => v !== null);
    const snapshot = buildFitSnapshot({ fitRows: fit, scorePool });
    findFirst.mockResolvedValue({
      payload: snapshot,
    } as unknown as { payload: unknown });

    const results = await service.scoreNewRows([row()]);

    expect(results[0].expectedPrice).not.toBeNull();
    expect(results[0].dealType).not.toBe('UNRATED');

    // deterministic across repeated polls
    const again = await service.scoreNewRows([row()]);
    expect(again[0]).toEqual(results[0]);
  });

  it('survives a malformed payload (v2 fields null)', async () => {
    findFirst.mockResolvedValue({
      payload: { version: 1 },
    } as unknown as { payload: unknown });

    const results = await service.scoreNewRows([row()]);

    expect(results[0].expectedPrice).toBeNull();
    expect(results[0].dealType).toBe('UNRATED');
    expect(results[0].dealScore).toBe(0);
  });

  it('leaves rows UNRATED when their generation cannot be resolved', async () => {
    const fit = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      model: 'Audi A3',
      generation: '8V (Third Gen)',
      price: 10_000 + i * 100,
      age: 10,
      km: 100_000 + i * 5_000,
      powerKw: 90 + i * 5,
      fuelType: 'Dizel',
      transmission: 'Manuelni 5 brzina',
    }));
    const snapshot = buildFitSnapshot({ fitRows: fit, scorePool: [] });
    findFirst.mockResolvedValue({
      payload: snapshot,
    } as unknown as { payload: unknown });

    const results = await service.scoreNewRows([
      row({ generation: null, model: 'Unknownmobile X' }),
    ]);

    expect(results[0].expectedPrice).toBeNull();
    expect(results[0].dealType).toBe('UNRATED');
  });
});
