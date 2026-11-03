import { DealsService } from './deals.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DealsService.getDeals (generation average)', () => {
  const NOW = new Date('2026-10-27T00:00:00Z');

  const baseRow = {
    listingUrl: 'u',
    title: 'Fiat Stilo 1.9 JTD',
    price: '450 EUR',
    priceNote: null,
    model: 'Fiat Stilo',
    pricePerYear: 400,
    updatedAt: NOW,
    fuelType: null,
    engineCc: null,
    powerKw: null,
    transmission: null,
    location: null,
    scrapedAt: NOW,
  };

  const mainRows = [
    {
      ...baseRow,
      id: 1n,
      priceNumeric: 450n,
      year: 2002,
      age: 24,
      mileageKm: 307000,
      dealType: 'GREAT DEAL',
      dealScore: 100,
      expectedPrice: 874.5,
      deviationPct: 48.5,
    },
    {
      ...baseRow,
      id: 2n,
      priceNumeric: 440n,
      year: 2003,
      age: 23,
      mileageKm: 356800,
      dealType: 'GOOD DEAL',
      dealScore: 98,
      expectedPrice: 874.5,
      deviationPct: 49.7,
    },
    {
      ...baseRow,
      id: 3n,
      title: 'BMW 520d',
      model: 'BMW 520',
      priceNumeric: 9000n,
      year: 2005,
      age: 21,
      mileageKm: 280000,
      dealType: 'GREAT DEAL',
      dealScore: 90,
      expectedPrice: 10000,
      deviationPct: 10,
    },
    {
      ...baseRow,
      id: 4n,
      title: 'Opel Zafira B 1.9 CDTi',
      model: 'Opel Zafira',
      priceNumeric: 5000n,
      year: 2010,
      age: 16,
      mileageKm: 200000,
      dealType: 'GOOD DEAL',
      dealScore: 70,
      expectedPrice: 6000,
      deviationPct: 16.7,
    },
  ];

  // Tier-agnostic pool: every rated row, grouped by resolved generation.
  const poolRows = [
    { model: 'Fiat Stilo', year: 2002, expectedPrice: 1200 },
    { model: 'Fiat Stilo', year: 2003, expectedPrice: 900 },
    { model: 'Fiat Stilo', year: 2004, expectedPrice: 1000 },
    { model: 'Fiat Stilo', year: 2005, expectedPrice: 600 },
    // Ambiguous year → no generation → must not be pooled.
    { model: 'BMW 520', year: 2005, expectedPrice: 5000 },
    // Generation 'B' with a single comp → average suppressed.
    { model: 'Opel Zafira', year: 2010, expectedPrice: 6000 },
  ];

  const buildService = () => {
    const findMany = jest.fn((args?: { where?: Record<string, unknown> }) => {
      const gate = args?.where?.dealType as { in?: string[] } | undefined;
      const isPool = args?.where !== undefined && 'expectedPrice' in args.where;
      if (isPool) return Promise.resolve(poolRows);
      return Promise.resolve(
        mainRows.filter((r) => gate?.in?.includes(r.dealType)),
      );
    });
    return new DealsService({
      listing: { findMany },
    } as unknown as PrismaService);
  };

  it('gives every listing of one generation the same flat average', async () => {
    const service = buildService();

    const result = await service.getDeals();

    const stilo2002 = result.find((r) => r.id === 1)!;
    const stilo2003 = result.find((r) => r.id === 2)!;

    // Same generation, different years → identical benchmark.
    // Mean of 1200, 900, 1000, 600 = 925; the old year±1 window would have
    // produced two different numbers.
    expect(stilo2002.generation).toBe('Stilo');
    expect(stilo2003.generation).toBe('Stilo');
    expect(stilo2002.generationAvgPriceNumeric).toBe(925);
    expect(stilo2003.generationAvgPriceNumeric).toBe(925);
    // Median of 600, 900, 1000, 1200 = 950.
    expect(stilo2002.generationMedianPriceNumeric).toBe(950);
    expect(stilo2003.generationMedianPriceNumeric).toBe(950);

    // Deviation is measured against the median now.
    expect(stilo2002.priceToGenerationAvgPct).toBe(-53);
    expect(stilo2003.priceToGenerationAvgPct).toBe(-54);
  });

  it('never pools across generations or unresolved years', async () => {
    const service = buildService();

    const result = await service.getDeals();
    const bmw = result.find((r) => r.id === 3)!;

    // 2005 is ambiguous for this label and the 5000 pool row is excluded.
    expect(bmw.generation).toBeNull();
    expect(bmw.generationAvgPriceNumeric).toBeNull();
    expect(bmw.generationMedianPriceNumeric).toBeNull();
    expect(bmw.priceToGenerationAvgPct).toBeNull();
  });

  it('suppresses the average when the generation has fewer than 3 comps', async () => {
    const service = buildService();

    const result = await service.getDeals();
    const zafira = result.find((r) => r.id === 4)!;

    expect(zafira.generation).toBe('B');
    expect(zafira.generationAvgPriceNumeric).toBeNull();
    expect(zafira.generationMedianPriceNumeric).toBeNull();
    expect(zafira.priceToGenerationAvgPct).toBeNull();
  });

  it('still gates on GREAT DEAL and GOOD DEAL only', async () => {
    const service = buildService();

    const result = await service.getDeals();

    expect(result.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(result.every((r) => r.dealType !== null)).toBe(true);
  });
});
