// Pure statistics helpers for Deal Score v2 (no Nest, no Prisma, no network).
// See docs/superpowers/specs/2026-10-27-deal-score-v2-design.md.

export type TierName =
  | 'GREAT DEAL'
  | 'GOOD DEAL'
  | 'FAIR PRICE'
  | 'HIGH PRICE'
  | 'OVERPRICED'
  | 'UNRATED';

export interface PriceRow {
  price: number;
  year: number;
  km: number;
} // age derived by caller

export interface PriceModel {
  intercept: number;
  coefAge: number;
  coefKm: number;
  n: number;
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
 * Trim outliers using the Tukey IQR fence: kept values lie inside
 * [Q1 - 1.5*IQR, Q3 + 1.5*IQR]. Returns the kept values and the fences.
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

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Solve the 3x3 system S * c = T by Gauss-Jordan elimination with partial
 * pivoting. Returns the coefficient vector, or null when singular
 * (|pivot| < 1e-9).
 */
function solve3(S: number[][], T: number[]): number[] | null {
  const m: number[][] = [
    [S[0][0], S[0][1], S[0][2], T[0]],
    [S[1][0], S[1][1], S[1][2], T[1]],
    [S[2][0], S[2][1], S[2][2], T[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-9) return null;
    if (piv !== col) {
      const tmp = m[col];
      m[col] = m[piv];
      m[piv] = tmp;
    }
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= 3; c++) m[r][c] -= f * m[col][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/**
 * OLS fit of price ~ 1 + age + km on IQR-trimmed rows.
 * Returns null when fewer than 12 rows survive trimming, the normal
 * equations are singular, or a coefficient has the wrong sign
 * (coefAge >= 0 || coefKm >= 0). n = rows actually used in the fit.
 */
export function fitLinearPrice(
  rows: { age: number; km: number; price: number }[],
): PriceModel | null {
  const { kept } = iqrTrimmed(rows.map((r) => r.price));
  const usable = rows.filter((r) => kept.includes(r.price));
  if (usable.length < 12) return null;

  const S: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const T: number[] = [0, 0, 0];
  for (const { age, km, price } of usable) {
    const x = [1, age, km];
    for (let i = 0; i < 3; i++) {
      T[i] += x[i] * price;
      for (let j = 0; j < 3; j++) S[i][j] += x[i] * x[j];
    }
  }

  const coef = solve3(S, T);
  if (!coef) return null;
  const [intercept, coefAge, coefKm] = coef;
  if (![intercept, coefAge, coefKm].every(Number.isFinite)) return null;
  if (coefAge >= 0 || coefKm >= 0) return null;
  return { intercept, coefAge, coefKm, n: usable.length };
}

export function expectedPrice(m: PriceModel, age: number, km: number): number {
  return m.intercept + m.coefAge * age + m.coefKm * km;
}

/** Positive when the asking price is cheaper than expected (a deal). */
export function deviationPct(expected: number, price: number): number {
  return ((expected - price) / expected) * 100;
}

/** 50 + dev*4 clamped to [0,100] and rounded. Positive dev → better score.
 * Kept for the absolute dealScore scale; the market percentile scale is
 * `percentileScores`. */
export function dealScoreFromDeviation(dev: number): number {
  return Math.max(0, Math.min(100, Math.round(50 + dev * 4)));
}

/**
 * Market percentile score: each deviation's rank position mapped to 0..100.
 * Best deviation → 100, worst → 0, single rated row → 50. Deterministic
 * tie-break by input index (equal deviations get adjacent, distinct scores).
 */
export function percentileScores(devs: number[]): number[] {
  const n = devs.length;
  const order = devs
    .map((_, i) => i)
    .sort((a, b) => devs[a] - devs[b] || a - b);
  const scores = new Array<number>(n);
  for (let r = 0; r < n; r++) {
    scores[order[r]!] = n === 1 ? 50 : Math.round((100 * r) / (n - 1));
  }
  return scores;
}

/**
 * Tier bands: GREAT ≥ 10; GOOD ∈ [4, 10); FAIR ∈ (−4, 4);
 * HIGH ∈ (−10, −4]; OVERPRICED ≤ −10.
 */
export function classifyTier(dev: number): TierName {
  if (dev >= 10) return 'GREAT DEAL';
  if (dev >= 4) return 'GOOD DEAL';
  if (dev > -4) return 'FAIR PRICE';
  if (dev > -10) return 'HIGH PRICE';
  return 'OVERPRICED';
}

/**
 * Cell-median expected price fallback: year±1 is mandatory; a km ±20%
 * split is used only when ≥3 rows survive it, otherwise the plain
 * year±1 median. Null below 3 rows in the year window.
 */
export function cellMedianExpected(
  rows: PriceRow[],
  targetYear: number,
  targetKm: number,
): number | null {
  const inYear = rows.filter((r) => Math.abs(r.year - targetYear) <= 1);
  if (inYear.length < 3) return null;
  const inKm = inYear.filter(
    (r) => r.km >= targetKm * 0.8 && r.km <= targetKm * 1.2,
  );
  // Median over IQR-trimmed prices (design doc §1: a part-out inside the
  // window must not shift the median).
  if (inKm.length >= 3) {
    const kept = iqrTrimmed(inKm.map((r) => r.price)).kept;
    return kept.length > 0 ? median(kept) : null;
  }
  const keptYear = iqrTrimmed(inYear.map((r) => r.price)).kept;
  return keptYear.length > 0 ? median(keptYear) : null;
}
