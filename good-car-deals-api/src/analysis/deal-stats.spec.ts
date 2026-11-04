import {
  dealScoreFromDeviation,
  classifyTier,
  capDeviation,
  iqrTrimmed,
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

describe('iqrTrimmed', () => {
  it('trims a single high outlier', () => {
    const { kept } = iqrTrimmed([1000, 1000, 1000, 1000, 100000]);
    expect(kept).toEqual([1000, 1000, 1000, 1000]);
  });
  it('keeps all values when none are outliers', () => {
    const { kept } = iqrTrimmed([1000, 1100, 1200, 1300, 1400]);
    expect(kept).toEqual([1000, 1100, 1200, 1300, 1400]);
  });
});
