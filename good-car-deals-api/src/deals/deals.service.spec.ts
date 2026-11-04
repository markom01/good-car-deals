import { DealsService } from './deals.service';
import { PrismaService } from '../prisma/prisma.service';

describe('DealsService.getDeals (stored generation benchmark)', () => {
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

  // The classifier computes and persists expectedPrice/deviationPct/dealScore;
  // the service must serve them untouched.
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
      expectedPrice: null,
      deviationPct: null,
    },
  ];

  const buildService = () => {
    const findMany = jest.fn((args?: { where?: Record<string, unknown> }) => {
      const gate = args?.where?.dealType as { in?: string[] } | undefined;
      return Promise.resolve(
        mainRows.filter((r) => gate?.in?.includes(r.dealType)),
      );
    });
    const count = jest.fn(() => Promise.resolve(mainRows.length));
    return {
      service: new DealsService({
        listing: { findMany, count },
      } as unknown as PrismaService),
      findMany,
      count,
    };
  };

  it('serves stored expectedPrice and deviationPct verbatim', async () => {
    const { service } = buildService();

    const result = await service.getDeals();

    const stilo2002 = result.data.find((r) => r.id === 1)!;
    const stilo2003 = result.data.find((r) => r.id === 2)!;
    const bmw = result.data.find((r) => r.id === 3)!;
    const zafira = result.data.find((r) => r.id === 4)!;

    // Row-specific benchmarks: not flattened to one generation number.
    expect(stilo2002.expectedPrice).toBe(874.5);
    expect(stilo2003.expectedPrice).toBe(874.5);
    expect(bmw.expectedPrice).toBe(10000);
    expect(stilo2002.deviationPct).toBe(48.5);
    expect(stilo2003.deviationPct).toBe(49.7);
    expect(bmw.deviationPct).toBe(10);
    expect(bmw.dealScore).toBe(90);
    expect(bmw.dealType).toBe('GREAT DEAL');

    // Unrated row keeps nulls instead of a recomputed number.
    expect(zafira.expectedPrice).toBeNull();
    expect(zafira.deviationPct).toBeNull();
  });

  it('no longer returns the removed recompute fields', async () => {
    const { service } = buildService();

    const { data } = await service.getDeals();

    const [first] = data;

    expect(first).not.toHaveProperty('generationAvgPriceNumeric');
    expect(first).not.toHaveProperty('generationMedianPriceNumeric');
    expect(first).not.toHaveProperty('priceToGenerationAvgPct');
  });

  it('resolves the generation display field per row', async () => {
    const { service } = buildService();

    const result = await service.getDeals();

    expect(result.data.find((r) => r.id === 1)!.generation).toBe('Stilo');
    expect(result.data.find((r) => r.id === 3)!.generation).toBeNull();
    expect(result.data.find((r) => r.id === 4)!.generation).toBe('B');
  });

  it('queries the listings table once — no request-time pool scan', async () => {
    const { service, findMany } = buildService();

    await service.getDeals();

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('still gates on GREAT DEAL and GOOD DEAL only', async () => {
    const { service } = buildService();

    const result = await service.getDeals();

    expect(result.data.map((r) => r.id)).toEqual([1, 2, 3, 4]);
    expect(result.data.every((r) => r.dealType !== null)).toBe(true);
  });
});
