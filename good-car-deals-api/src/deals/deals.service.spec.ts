import { DealsService } from './deals.service';
import { PrismaService } from '../prisma/prisma.service';

// The pure function we want to test.
// Extracted from DealsService for isolated unit testing.
// When computePriceToAvgPct is added to DealsService, this can be
// replaced with an import from deals.service.ts and instantiated via
// Test.createTestingModule.
function computePriceToAvgPct(
  priceNumeric: number | null,
  modelAvgPriceNumeric: number | null,
): number | null {
  if (
    priceNumeric === null ||
    modelAvgPriceNumeric === null ||
    modelAvgPriceNumeric === 0
  ) {
    return null;
  }
  return Math.round(
    ((priceNumeric - modelAvgPriceNumeric) / modelAvgPriceNumeric) * 100,
  );
}

describe('computePriceToAvgPct', () => {
  // --- Normal cases ---

  it('should return -25 when price is 25% below average (15000 vs 20000)', () => {
    expect(computePriceToAvgPct(15000, 20000)).toBe(-25);
  });

  it('should return 25 when price is 25% above average (25000 vs 20000)', () => {
    expect(computePriceToAvgPct(25000, 20000)).toBe(25);
  });

  it('should return 0 when price equals average (20000 vs 20000)', () => {
    expect(computePriceToAvgPct(20000, 20000)).toBe(0);
  });

  // --- Null inputs ---

  it('should return null when priceNumeric is null', () => {
    expect(computePriceToAvgPct(null, 20000)).toBeNull();
  });

  it('should return null when modelAvgPriceNumeric is null', () => {
    expect(computePriceToAvgPct(15000, null)).toBeNull();
  });

  // --- Edge / guard cases ---

  it('should return null when modelAvgPriceNumeric is 0 (division by zero guard)', () => {
    expect(computePriceToAvgPct(15000, 0)).toBeNull();
  });

  it('should return -95 for extreme negative (1000 vs 20000)', () => {
    expect(computePriceToAvgPct(1000, 20000)).toBe(-95);
  });

  it('should return 400 for extreme positive (50000 vs 10000)', () => {
    expect(computePriceToAvgPct(50000, 10000)).toBe(400);
  });
});

describe('DealsService.getDeals (v2 gate + pooled average)', () => {
  const NOW = new Date('2026-10-27T00:00:00Z');

  const baseRow = {
    listingUrl: 'u',
    title: 'Opel Astra J 1.4',
    price: '4.400 EUR',
    priceNote: null,
    model: 'Astra J',
    pricePerYear: 400,
    updatedAt: NOW,
  };

  // Stubs for the two findMany calls: (1) gated deals, (2) the model pool.
  // Pool rows are deal-tier-agnostic on purpose: the v2 pool must include
  // ALL same-model rows with expectedPrice set (not good-deals-only).
  const mainRows = [
    {
      ...baseRow,
      id: 1n,
      priceNumeric: 4400n,
      year: 2015,
      age: 11,
      mileageKm: 120000,
      dealType: 'GREAT DEAL',
      dealScore: 98,
      fuelType: 'Petrol',
      engineCc: 1364,
      powerKw: 103,
      transmission: 'Manual',
      location: 'Beograd',
      expectedPrice: 5000,
      deviationPct: 12,
      scrapedAt: NOW,
    },
    {
      ...baseRow,
      id: 2n,
      priceNumeric: 5600n,
      year: 2016,
      age: 10,
      mileageKm: 90000,
      dealType: 'GOOD DEAL',
      dealScore: 74,
      fuelType: null,
      engineCc: null,
      powerKw: null,
      transmission: 'Manual',
      location: 'Novi Sad',
      expectedPrice: 5200,
      deviationPct: 5.9,
      scrapedAt: NOW,
    },
    {
      ...baseRow,
      id: 3n,
      priceNumeric: 7000n,
      year: 2015,
      age: 11,
      mileageKm: 100000,
      dealType: 'FAIR PRICE',
      dealScore: 52,
      fuelType: null,
      engineCc: null,
      powerKw: null,
      transmission: null,
      location: null,
      expectedPrice: 6500,
      deviationPct: -7,
      scrapedAt: NOW,
    },
    {
      ...baseRow,
      id: 4n,
      priceNumeric: 8000n,
      year: 2015,
      age: 11,
      mileageKm: 100000,
      dealType: 'HIGH PRICE',
      dealScore: 45,
      fuelType: null,
      engineCc: null,
      powerKw: null,
      transmission: null,
      location: null,
      expectedPrice: 6800,
      deviationPct: -15,
      scrapedAt: NOW,
    },
    {
      ...baseRow,
      id: 5n,
      title: 'Opel Zafira B 1.9',
      model: 'Zafira B',
      priceNumeric: 6000n,
      year: 2010,
      age: 16,
      mileageKm: 200000,
      dealType: 'GOOD DEAL',
      dealScore: 63,
      fuelType: 'Diesel',
      engineCc: null,
      powerKw: 88,
      transmission: null,
      location: null,
      expectedPrice: 6000,
      deviationPct: 3,
      scrapedAt: NOW,
    },
  ];

  const poolRows = [
    { model: 'Astra J', year: 2015, expectedPrice: 5000 },
    { model: 'Astra J', year: 2016, expectedPrice: 5200 },
    { model: 'Astra J', year: 2014, expectedPrice: 5400 },
    { model: 'Astra J', year: 2015, expectedPrice: 4600 },
    { model: 'Astra J', year: 2013, expectedPrice: 9000 }, // outside year±1 of 2016
    { model: 'Zafira B', year: 2010, expectedPrice: 6000 }, // pool of 1 < 3
  ];

  it('returns only GREAT/GOOD rows with new fields mapped and pooled averages', async () => {
    // Mock emulates the DB: filters by the where clause the service sends,
    // so a wrong gate (e.g. startsWith 'GOOD DEAL') is caught here.
    const findMany = jest.fn((args?: { where?: { dealType?: unknown } }) => {
      const gate = args?.where?.dealType;
      const pred = (dealType: string | null): boolean => {
        if (!gate || typeof gate !== 'object') return true;
        const g = gate as { in?: string[]; startsWith?: string };
        if (g.in) return g.in.includes(dealType ?? '');
        if (g.startsWith) return (dealType ?? '').startsWith(g.startsWith);
        return true;
      };
      // second call = pool fetch (no dealType gate) — rows are
      // tier-agnostic by construction
      return args?.where !== undefined &&
        'expectedPrice' in args.where &&
        Object.keys(args.where).length === 3
        ? poolRows
        : mainRows.filter((r) => r.mileageKm !== null && pred(r.dealType));
    });
    const service = new DealsService({
      listing: { findMany },
    } as unknown as PrismaService);

    const result = await service.getDeals();

    // Gate sent to the DB is exactly the v2 pair
    expect(
      (findMany.mock.calls[0]?.[0] as { where: { dealType: unknown } }).where
        .dealType,
    ).toEqual({
      in: ['GREAT DEAL', 'GOOD DEAL'],
    });
    expect(result.map((r) => r.id)).toEqual([1, 2, 5]);

    const great = result.find((r) => r.id === 1)!;
    expect(great.priceNumeric).toBe(4400); // BigInt → Number
    expect(great.expectedPrice).toBe(5000);
    expect(great.deviationPct).toBe(12);
    expect(great.fuelType).toBe('Petrol');
    expect(great.engineCc).toBe(1364);
    expect(great.powerKw).toBe(103);
    expect(great.transmission).toBe('Manual');
    expect(great.location).toBe('Beograd');
    // Astra J pool (listing year 2015): years 2014-2016 → 4 rows, mean 5050
    expect(great.modelAvgPriceNumeric).toBe(5050);
    expect(great.priceToModelAvgPct).toBe(-13);

    const good = result.find((r) => r.id === 2)!;
    expect(good.fuelType).toBeNull(); // null new fields map through
    expect(good.engineCc).toBeNull();
    expect(good.powerKw).toBeNull();
    // Listing year 2016: window drops the 2014 row → 3 rows, mean 4933.33
    expect(good.modelAvgPriceNumeric).toBeCloseTo(4933.333, 2);
    expect(good.priceToModelAvgPct).toBe(14);

    const zafira = result.find((r) => r.id === 5)!;
    expect(zafira.expectedPrice).toBe(6000);
    expect(zafira.transmission).toBeNull();
    // Pool of 1 (< 3 rows) → null average, null pct
    expect(zafira.modelAvgPriceNumeric).toBeNull();
    expect(zafira.priceToModelAvgPct).toBeNull();
  });
});
