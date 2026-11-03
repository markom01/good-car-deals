// Pure statistics helpers for Deal Score v3 (no Nest, no Prisma, no network).
// Methodology: generation-only comparison. Each listing is benchmarked against
// the IQR-trimmed median ask price of its own resolved generation, shifted by a
// robust Theil–Sen km slope (mileage adjustment; plain median fallback when the
// slope is degenerate or >= 0). No model-wide pooling, no cross-generation
// comps, no hedonic regression.
// UNRATED when the trimmed kept set has < 4 rows.

export type TierName =
  | 'GREAT DEAL'
  | 'GOOD DEAL'
  | 'FAIR PRICE'
  | 'HIGH PRICE'
  | 'OVERPRICED'
  | 'UNRATED';

/** Hard ceiling on a single listing's deviation (a bad benchmark cannot score -3681%). */
export const MAX_DEVIATION_PCT = 50;

export function capDeviation(dev: number): number {
  return Math.max(-MAX_DEVIATION_PCT, Math.min(MAX_DEVIATION_PCT, dev));
}

/** Positive when the asking price is cheaper than expected (a deal). */
export function deviationPct(expected: number, price: number): number {
  return ((expected - price) / expected) * 100;
}

/** 50 + dev*4 clamped to [0,100] and rounded. Positive dev → better score. */
export function dealScoreFromDeviation(dev: number): number {
  return Math.max(0, Math.min(100, Math.round(50 + dev * 4)));
}

/**
 * Rubric tiers. Percentage bands are gated by the absolute euro saving, so a
 * 10% gain on a 3.000 EUR car cannot outrank a 1.000 EUR saving. Failing a
 * euro gate demotes exactly one tier: GREAT → GOOD, GOOD → FAIR.
 * GREAT: dev ≥ 10 and devEur ≥ 500; GOOD: dev ≥ 4 and devEur ≥ 200;
 * FAIR: dev > −4; HIGH: dev > −10; else OVERPRICED.
 */
export function classifyTier(dev: number, devEur: number): TierName {
  if (dev >= 10) return devEur >= 500 ? 'GREAT DEAL' : 'GOOD DEAL';
  if (dev >= 4) return devEur >= 200 ? 'GOOD DEAL' : 'FAIR PRICE';
  if (dev > -4) return 'FAIR PRICE';
  if (dev > -10) return 'HIGH PRICE';
  return 'OVERPRICED';
}

/** Pairwise-slope sample cap: keeps the O(n²) slope median under ~125k pairs. */
const THEIL_SEN_MAX_ROWS = 500;

/** Rows below this count cannot support a two-variable (km, price) slope. */
const MIN_SLOPE_ROWS = 4;

/**
 * Theil–Sen slope of price against km: median of all pairwise Δprice/Δkm.
 * Robust to part-outs (a single bad row cannot bend a median of slopes) and
 * cheap where 500 rows already give ~125k pairs. Rows above the cap are
 * subsampled with a deterministic stride, never randomly.
 * Pairs with identical km carry no slope information and are skipped.
 * Returns null below 4 rows or when every pair is unusable.
 */
export function theilSenSlope(
  rows: { km: number; price: number }[],
): number | null {
  if (rows.length < MIN_SLOPE_ROWS) return null;
  const stride = Math.ceil(rows.length / THEIL_SEN_MAX_ROWS);
  const sample = stride > 1 ? rows.filter((_, i) => i % stride === 0) : rows;
  const slopes: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      const dKm = sample[j].km - sample[i].km;
      if (dKm === 0) continue;
      const slope = (sample[j].price - sample[i].price) / dKm;
      if (Number.isFinite(slope)) slopes.push(slope);
    }
  }
  return slopes.length > 0 ? median(slopes) : null;
}

/**
 * Median of the IQR-trimmed prices, shifted by the slope over the km gap
 * between the target and the pool's median km. Lets a low-km car be priced
 * above the pool median and a high-km car below it, without extrapolating
 * past the observed band. A null slope means "no mileage information": the
 * plain trimmed median is returned.
 */
export function adjustedBenchmark(
  prices: number[],
  kmOf: number[],
  slope: number | null,
  targetKm: number,
): number {
  const { kept } = iqrTrimmed(prices);
  const band = kept.length > 0 ? kept : prices;
  const base = median(band);
  if (band.length === 0) return base;
  const lo = Math.min(...band);
  const hi = Math.max(...band);
  if (slope === null || !Number.isFinite(slope)) return base;
  const medianKm = median(kmOf);
  if (!Number.isFinite(medianKm)) return base;
  const adjusted = base + slope * (targetKm - medianKm);
  return Math.min(Math.max(adjusted, lo), hi);
}

/** Minimum trimmed comps for a mileage-adjusted generation benchmark. */
const MIN_BENCHMARK_ROWS = 4;

/**
 * Generation benchmark: IQR-trim the pool, fit a Theil–Sen km slope on the
 * kept rows and apply it at `targetKm`. A non-negative (or unusable) slope
 * means mileage carries no reliable information, so the plain trimmed median
 * is used. Too few comps → null, and the caller shows no benchmark.
 */
export function benchmarkExpected(
  rows: { price: number; km: number }[],
  targetKm: number,
): number | null {
  const { kept } = iqrTrimmed(rows.map((r) => r.price));
  if (kept.length < MIN_BENCHMARK_ROWS) return null;
  const keptRows = rows.filter((r) => kept.includes(r.price));
  const slope = theilSenSlope(keptRows);
  return adjustedBenchmark(
    keptRows.map((r) => r.price),
    keptRows.map((r) => r.km),
    slope !== null && Number.isFinite(slope) && slope < 0 ? slope : null,
    targetKm,
  );
}

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

export function iqrTrimmed(values: number[]): {
  kept: number[];
  lo: number;
  hi: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return { kept: values.filter((v) => v >= lo && v <= hi), lo, hi };
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
