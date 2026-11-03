import { classifyGroups, type ClassifierRow } from './deal-classifier.service';
import { MAX_DEVIATION_PCT } from './deal-stats';

const GEN_A = 'Astra J (2009-2015)';
const GEN_B = 'Astra K (2015-2021)';

// Rows for one generation share model 'Opel Astra' + a generation string.
// Price must DECREASE as km increases: the benchmark's Theil-Sen slope is only
// applied when it is negative.
function genRow(
  id: number,
  year: number,
  km: number,
  price: number,
  generation: string = GEN_A,
): ClassifierRow {
  return {
    id,
    model: 'Opel Astra',
    generation,
    priceNumeric: price,
    year,
    age: 2026 - year,
    mileageKm: km,
  };
}

describe('classifyGroups (generation-only)', () => {
  it('two generations of one model never mix: benchmarks differ per group', () => {
    const g1 = Array.from({ length: 6 }, (_, i) =>
      genRow(1 + i, 2009 + i, 100_000 + i * 10_000, 10_000 - i * 100, GEN_A),
    );
    const g2 = Array.from({ length: 6 }, (_, i) =>
      genRow(10 + i, 2016 + i, 100_000 + i * 10_000, 5_000 - i * 50, GEN_B),
    );
    const out = classifyGroups([...g1, ...g2]);
    const a = out.find((r) => r.id === 1)!;
    const b = out.find((r) => r.id === 10)!;
    expect(a.expectedPrice).not.toBeNull();
    expect(b.expectedPrice).not.toBeNull();
    // Both rows are the same model and the same odometer; only the
    // generation differs, so the benchmarks must reflect the price level.
    expect(a.expectedPrice! / b.expectedPrice!).toBeGreaterThan(1.05);
    expect(a.dealType).not.toBe('UNRATED');
    expect(b.dealType).not.toBe('UNRATED');
  });

  it('pool below 5 usable rows → every row UNRATED (no 3-row scoring)', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      genRow(20 + i, 2010 + i, 120_000 + i * 5_000, 9_000 - i * 100),
    );
    const out = classifyGroups(rows);
    expect(out).toHaveLength(4);
    for (const r of out) {
      expect(r).toMatchObject({
        dealType: 'UNRATED',
        dealScore: 0,
        expectedPrice: null,
        deviationPct: null,
      });
    }
  });

  it('unresolved model → UNRATED; resolved siblings of same model still rated', () => {
    const rated = Array.from({ length: 6 }, (_, i) =>
      genRow(30 + i, 2009 + i, 100_000 + i * 10_000, 10_000 - i * 100),
    );
    const unresolved: ClassifierRow = {
      id: 99,
      model: 'Dacia Nonexistent',
      generation: null,
      priceNumeric: 5000,
      year: 2018,
      age: 8,
      mileageKm: 100_000,
    };
    const out = classifyGroups([...rated, unresolved]);
    expect(out.find((r) => r.id === 99)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
      expectedPrice: null,
      deviationPct: null,
    });
    for (const r of rated) {
      expect(out.find((x) => x.id === r.id)!.dealType).not.toBe('UNRATED');
    }
  });

  it('absolute rubric (50 + dev*4), not a market percentile', () => {
    // All ten rows sit at 150_000 km, so the mileage slope is unusable and
    // the benchmark is the trimmed median price, 8_000 for every row.
    const flat = Array.from({ length: 8 }, (_, i) =>
      genRow(40 + i, 2012, 150_000, 8_000),
    );
    const cheap = genRow(200, 2012, 150_000, 6_800); // dev +15%
    const dear = genRow(201, 2012, 150_000, 9_000); // dev -12.5%
    const out = classifyGroups([...flat, cheap, dear]);

    expect(out.find((r) => r.id === 200)!.deviationPct).toBeCloseTo(15, 5);
    expect(out.find((r) => r.id === 200)!.dealScore).toBe(100);
    expect(out.find((r) => r.id === 201)!.deviationPct).toBeCloseTo(-12.5, 5);
    expect(out.find((r) => r.id === 201)!.dealScore).toBe(0);
    // Absolute score: every at-benchmark row is exactly 50. A percentile
    // pass would spread these identical rows across 0..100 instead.
    for (const r of flat) {
      expect(out.find((x) => x.id === r.id)!.dealScore).toBe(50);
    }
  });

  it('mileage-adjusted benchmark: 300k km row scores lower than the identical ask at 100k km', () => {
    // Two km levels only: every cross-level pair has the same slope
    // (7_500 - 9_000) / (210_000 - 90_000) = -0.0125 EUR/km.
    const low = Array.from({ length: 5 }, (_, i) =>
      genRow(50 + i, 2012, 90_000, 9_000),
    );
    const high = Array.from({ length: 5 }, (_, i) =>
      genRow(55 + i, 2012, 210_000, 7_500),
    );
    const lowProbe = genRow(300, 2012, 90_000, 8_500);
    const highProbe = genRow(301, 2012, 210_000, 8_500);
    const out = classifyGroups([...low, ...high, lowProbe, highProbe]);

    const a = out.find((r) => r.id === 300)!;
    const b = out.find((r) => r.id === 301)!;
    expect(a.expectedPrice).not.toBeNull();
    expect(b.expectedPrice).not.toBeNull();
    expect(b.expectedPrice!).toBeLessThan(a.expectedPrice!);
    expect(b.deviationPct!).toBeLessThan(a.deviationPct!);
  });

  it('GREAT requires both pct and euro legs: 8% of a 3_000 benchmark passes GOOD', () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      genRow(60 + i, 2012, 150_000, 3_000),
    );
    const probe = genRow(400, 2012, 150_000, 2_760); // dev 8%, devEur 240
    const out = classifyGroups([...pool, probe]);
    const r = out.find((x) => x.id === 400)!;
    expect(r.deviationPct).toBeCloseTo(8, 5);
    expect(r.dealType).toBe('GOOD DEAL');
    expect(r.dealScore).toBe(82);
  });

  it('price-null / km-null / year-null rows inside a healthy group → UNRATED', () => {
    const healthy = Array.from({ length: 6 }, (_, i) =>
      genRow(70 + i, 2009 + i, 100_000 + i * 10_000, 10_000 - i * 100),
    );
    const stalePrice: ClassifierRow = {
      id: 904,
      model: 'Opel Astra',
      generation: GEN_A,
      priceNumeric: null,
      year: 2015,
      age: 11,
      mileageKm: 120_000,
    };
    const noKm: ClassifierRow = {
      id: 903,
      model: 'Opel Astra',
      generation: GEN_A,
      priceNumeric: 5_000,
      year: 2012,
      age: 14,
      mileageKm: null,
    };
    const noYear: ClassifierRow = {
      id: 902,
      model: 'Opel Astra',
      generation: GEN_A,
      priceNumeric: 5_000,
      year: null,
      age: null,
      mileageKm: 150_000,
    };
    const out = classifyGroups([...healthy, stalePrice, noKm, noYear]);
    for (const id of [904, 903, 902]) {
      expect(out.find((r) => r.id === id)).toMatchObject({
        dealType: 'UNRATED',
        dealScore: 0,
        expectedPrice: null,
        deviationPct: null,
      });
    }
    // The healthy rows are unaffected by the unusable siblings.
    for (const r of healthy) {
      expect(out.find((x) => x.id === r.id)!.dealType).not.toBe('UNRATED');
    }
  });

  it(`caps deviations at ±${MAX_DEVIATION_PCT}%`, () => {
    const pool = Array.from({ length: 5 }, (_, i) =>
      genRow(80 + i, 2012, 150_000, 3_000),
    );
    const freeCar = genRow(951, 2012, 150_000, 1);
    const overpriced = genRow(952, 2012, 150_000, 100_000);
    const out = classifyGroups([...pool, freeCar, overpriced]);
    expect(out.find((r) => r.id === 951)!.deviationPct).toBe(MAX_DEVIATION_PCT);
    expect(out.find((r) => r.id === 952)!.deviationPct).toBe(
      -MAX_DEVIATION_PCT,
    );
    expect(out.find((r) => r.id === 951)!.dealType).toBe('GREAT DEAL');
    expect(out.find((r) => r.id === 952)!.dealType).toBe('OVERPRICED');
  });
});
