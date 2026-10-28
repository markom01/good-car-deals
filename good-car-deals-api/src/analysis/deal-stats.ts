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
  /** € per kW (raw kW) — present only when the power term survived the guards. */
  coefKw?: number;
  /**
   * Mean kW of the fit sample — present only when `coefKw` is. Rows without
   * a kW value are scored at this mean (unbiased in expectation), NOT at
   * kw=0 which would understate their expected price.
   */
  meanKw?: number;
  /** Diesel dummy coefficient — present only when both fuel classes ≥ 10 rows. */
  coefDiesel?: number;
  /** Automatic dummy coefficient — present only when both transmission classes ≥ 10 rows. */
  coefAuto?: number;
  n: number;
}

/** Per-row engine-trim attributes used by the fit and by `expectedPrice`. */
export interface FitAttrs {
  kw?: number | null;
  diesel?: boolean | null;
  auto?: boolean | null;
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
 * Solve the p×p system S * c = T by Gauss-Jordan elimination with partial
 * pivoting. Returns the coefficient vector, or null when singular
 * (|pivot| < 1e-9).
 */
function solveN(S: number[][], T: number[]): number[] | null {
  const p = T.length;
  const m: number[][] = S.map((row, i) => [...row, T[i]]);
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    }
    if (Math.abs(m[piv][col]) < 1e-9) return null;
    if (piv !== col) {
      const tmp = m[col];
      m[col] = m[piv]!;
      m[piv] = tmp;
    }
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= p; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[p] / row[i]);
}

/** Minimum rows in BOTH classes for a dummy (fuel/transmission) term. */
const MIN_DUMMY_CLASS = 10;

/**
 * OLS fit of price ~ 1 + age + km [+ kw] [+ diesel] [+ auto] on
 * IQR-trimmed rows.
 *
 * Optional engine-trim terms, each behind a guard so a thin column can
 * never destabilize the base fit:
 * - kw (power in kW): used only when ≥ 12 usable rows carry a kW value
 *   with ≥ 2 distinct values; the fit then runs on those rows only. A
 *   wrong-sign coefficient (≤ 0 — power must raise price) drops the term
 *   and the fit falls back to the plain age+km spec on all usable rows.
 * - diesel / auto dummies: used only when BOTH classes have ≥ 10 rows in
 *   the fit set. Missing attributes count as the 0 side.
 *
 * Returns null when fewer than 12 rows survive trimming, the normal
 * equations are singular, or a base coefficient has the wrong sign
 * (coefAge >= 0 || coefKm >= 0). n = rows actually used in the fit.
 */
export function fitLinearPrice(
  rows: ({ age: number; km: number; price: number } & FitAttrs)[],
): PriceModel | null {
  const { kept } = iqrTrimmed(rows.map((r) => r.price));
  const usable = rows.filter((r) => kept.includes(r.price));
  if (usable.length < 12) return null;

  const kwRows = usable.filter(
    (r) => r.kw !== null && r.kw !== undefined && Number.isFinite(r.kw),
  );
  const useKw =
    kwRows.length >= 12 && new Set(kwRows.map((r) => r.kw)).size >= 2;
  const fitRows = useKw ? kwRows : usable;
  // Fit-sample mean kW, for scoring rows that lack a kW value.
  const fitKwMean = useKw
    ? kwRows.reduce((s, r) => s + (r.kw ?? 0), 0) / kwRows.length
    : undefined;

  const dieselCount = fitRows.filter((r) => r.diesel === true).length;
  const autoCount = fitRows.filter((r) => r.auto === true).length;
  const useDiesel =
    dieselCount >= MIN_DUMMY_CLASS &&
    fitRows.length - dieselCount >= MIN_DUMMY_CLASS;
  const useAuto =
    autoCount >= MIN_DUMMY_CLASS &&
    fitRows.length - autoCount >= MIN_DUMMY_CLASS;

  // 1) Full candidate spec (power + guarded dummies). A singular matrix,
  //    bad base sign, or wrong-sign power term → null here.
  const full = fitSpecModel(fitRows, useKw, useDiesel, useAuto, fitKwMean);
  if (full) return full;
  // 2) Plain age+km spec on ALL usable rows — the pre-power-term behavior.
  return fitSpecModel(usable, false, false, false);
}

function fitSpecModel(
  rows: ({ age: number; km: number; price: number } & FitAttrs)[],
  useKw: boolean,
  useDiesel: boolean,
  useAuto: boolean,
  fitKwMean?: number,
): PriceModel | null {
  const p = 3 + (useKw ? 1 : 0) + (useDiesel ? 1 : 0) + (useAuto ? 1 : 0);
  const S: number[][] = Array.from({ length: p }, () =>
    Array<number>(p).fill(0),
  );
  const T: number[] = new Array<number>(p).fill(0);
  for (const r of rows) {
    const x: number[] = [1, r.age, r.km];
    if (useKw) x.push(r.kw!);
    if (useDiesel) x.push(r.diesel === true ? 1 : 0);
    if (useAuto) x.push(r.auto === true ? 1 : 0);
    for (let i = 0; i < p; i++) {
      T[i] += x[i] * r.price;
      for (let j = 0; j < p; j++) S[i][j] += x[i] * x[j];
    }
  }

  const coef = solveN(S, T);
  if (!coef) return null;
  if (![coef[0], coef[1], coef[2]].every(Number.isFinite)) return null;
  if (coef[1] >= 0 || coef[2] >= 0) return null;

  const kwIdx = 3;
  const dieselIdx = 3 + (useKw ? 1 : 0);
  const autoIdx = dieselIdx + (useDiesel ? 1 : 0);
  if (useKw) {
    if (!Number.isFinite(coef[kwIdx]) || coef[kwIdx] <= 0) return null;
  }

  const model: PriceModel = {
    intercept: coef[0],
    coefAge: coef[1],
    coefKm: coef[2],
    n: rows.length,
  };
  if (useKw) {
    model.coefKw = coef[kwIdx]!;
    model.meanKw = fitKwMean;
  }
  if (useDiesel) model.coefDiesel = coef[dieselIdx]!;
  if (useAuto) model.coefAuto = coef[autoIdx]!;
  return model;
}

export function expectedPrice(
  m: PriceModel,
  age: number,
  km: number,
  attrs?: FitAttrs,
): number {
  let p = m.intercept + m.coefAge * age + m.coefKm * km;
  if (m.coefKw !== undefined) {
    // Missing kW → fit-sample mean (unbiased in expectation). kw=0 would
    // understate rows the fit never saw (see PriceModel.meanKw).
    const kw =
      attrs?.kw !== null && attrs?.kw !== undefined
        ? attrs.kw
        : (m.meanKw ?? 0);
    p += m.coefKw * kw;
  }
  if (m.coefDiesel !== undefined && attrs?.diesel === true) {
    p += m.coefDiesel;
  }
  if (m.coefAuto !== undefined && attrs?.auto === true) {
    p += m.coefAuto;
  }
  return p;
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
    scores[order[r]] = n === 1 ? 50 : Math.round((100 * r) / (n - 1));
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
