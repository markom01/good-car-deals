import {
  dealScoreFromDeviation,
  classifyTier,
  capDeviation,
  theilSenSlope,
  benchmarkExpected,
  median,
  MAX_DEVIATION_PCT,
} from './deal-stats';

describe('deviation → score and tier', () => {
  it.each([
    [10, 60],
    [0, 50],
    [-12.5, 38],
    [40, 90],
    [50, 100], // upper clamp
    [-50, 0], // lower clamp
  ])('dev %s → score %s', (dev, score) =>
    expect(dealScoreFromDeviation(dev)).toBe(score),
  );
  it('bands: ≥10 GREAT, 5 GOOD, 0 FAIR, −5 HIGH, −15 OVERPRICED', () => {
    expect(classifyTier(10, 500)).toBe('GREAT DEAL');
    expect(classifyTier(5, 300)).toBe('GOOD DEAL');
    expect(classifyTier(0, 0)).toBe('FAIR PRICE');
    expect(classifyTier(-5, 0)).toBe('HIGH PRICE');
    expect(classifyTier(-15, 0)).toBe('OVERPRICED');
    expect(classifyTier(9.99, 300)).toBe('GOOD DEAL');
  });
});

describe('theilSenSlope', () => {
  it('recovers exact slope on a deterministic line', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      km: 50_000 + i * 10_000,
      price: 10_000 - i * 100,
    }));
    expect(theilSenSlope(rows)).toBeCloseTo(-0.01, 6);
  });
  it('returns null below 4 rows', () => {
    expect(
      theilSenSlope([
        { km: 1, price: 1 },
        { km: 2, price: 2 },
        { km: 3, price: 3 },
      ]),
    ).toBeNull();
  });
  it('flat pricing → slope 0 (not null)', () => {
    expect(
      theilSenSlope([
        { km: 1, price: 5 },
        { km: 2, price: 5 },
        { km: 3, price: 5 },
        { km: 4, price: 5 },
      ]),
    ).toBe(0);
  });
});

describe('adjustedBenchmark / benchmarkExpected', () => {
  // Prices descend as km rises: the fixture models depreciation, so the
  // fitted Theil–Sen slope is negative (-0.005 EUR/km).
  const pool = [
    { price: 5700, km: 100_000 },
    { price: 5600, km: 120_000 },
    { price: 5500, km: 140_000 },
    { price: 5400, km: 160_000 },
    { price: 5300, km: 180_000 },
  ];
  it('negative slope: high-km row benchmark below plain median', () => {
    const plain = median(pool.map((r) => r.price)); // 5500
    const adj = benchmarkExpected(pool, 260_000);
    expect(adj).not.toBeNull();
    expect(adj!).toBeLessThan(plain);
  });
  it('low-km row benchmark above plain median', () => {
    const adj = benchmarkExpected(pool, 60_000);
    expect(adj!).toBeGreaterThan(5500);
  });
  it('clamps to IQR range, adjusted benchmark cannot exceed observed band', () => {
    const out = benchmarkExpected(pool, 0);
    expect(out!).toBeLessThanOrEqual(Math.max(...pool.map((p) => p.price)));
  });
  it('zero-km spread → plain median (no crash, no adjustment)', () => {
    const flat = pool.map((r, i) => ({ price: 5000 + i * 10, km: 100_000 }));
    expect(benchmarkExpected(flat, 100_000)).toBe(
      median([5000, 5010, 5020, 5030, 5040]),
    );
  });
  it('null when kept rows < 4', () => {
    expect(benchmarkExpected(pool.slice(0, 3), 100_000)).toBeNull();
  });
});

describe('classifyTier (absolute-euro gate)', () => {
  it('GREAT needs both >=10% and >=500 EUR', () => {
    expect(classifyTier(12, 800)).toBe('GREAT DEAL');
    expect(classifyTier(12, 100)).toBe('GOOD DEAL');
    expect(classifyTier(6, 1000)).toBe('GOOD DEAL');
  });
  it('GOOD needs >=4% and >=200 EUR', () => {
    expect(classifyTier(4, 199)).toBe('FAIR PRICE');
  });
  it('penalty bands unchanged', () => {
    expect(classifyTier(-5, 0)).toBe('HIGH PRICE');
    expect(classifyTier(-11, 0)).toBe('OVERPRICED');
  });
});

describe('capDeviation', () => {
  it(`caps at ±${MAX_DEVIATION_PCT}`, () => {
    expect(capDeviation(-3681)).toBe(-MAX_DEVIATION_PCT);
    expect(capDeviation(80)).toBe(MAX_DEVIATION_PCT);
    expect(capDeviation(12.5)).toBe(12.5);
  });
});
