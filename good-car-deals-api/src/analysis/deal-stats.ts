// Pure statistics helpers for deal classification (no Nest, no Prisma, no network).
// Methodology: tier/score rubric and IQR trimming. The property-based expected
// price model lives in expected-price.ts (group = model\0generation, log-price
// OLS with hierarchical shrinkage, leave-one-out prediction, 10-comp gate).
// UNRATED when a group has fewer than EXPECTED_PRICE_MIN_COMPS kept comps
// excluding the scored row.

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

/** 50 + dev clamped to [0,100] and rounded. Positive dev → better score. */
export function dealScoreFromDeviation(dev: number): number {
  return Math.max(0, Math.min(100, Math.round(50 + dev)));
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

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

/**
 * IQR-trim a price array: drop values outside [Q1 − 1.5×IQR, Q3 + 1.5×IQR].
 * Used by the expected-price model to remove part-outs before fitting.
 */
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
