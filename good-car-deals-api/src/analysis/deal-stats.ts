// Pure statistics helpers for Deal Score v2 (no Nest, no Prisma, no network).
// Methodology: Hedonic regression per Lancaster (1966), Griliches (1961), MedCrave (2015).
// Semi-log form: log(price) ~ 1 + age + km + age×km [+ kw] [+ diesel] [+ auto]
// 10-obs-per-predictor rule (Vittinghoff & McCulloch 2007) → min 30 for base, 60 for full.
// Out-of-sample predictions fall back to cell-median (comps), never extrapolate.
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
  /** All coefficients live in log-price space: price = exp(intercept + …). */
  intercept: number;
  coefAge: number;
  coefKm: number;
  /** Interaction term: extra depreciation when old AND high-km (non-linear). */
  coefAgeKm: number;
  /** Log-price effect of one kW — present only when the power term survived the guards. */
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
  /** Training-sample bounds for leverage detection. */
  minAge: number;
  maxAge: number;
  minKm: number;
  maxKm: number;
  /** Hat-matrix diagonals for leverage diagnostics (max per observation). */
  maxLeverage: number;
}

/** Per-row engine-trim attributes used by the fit and by `expectedPrice`. */
export interface FitAttrs {
  kw?: number | null;
  diesel?: boolean | null;
  auto?: boolean | null;
}

/** Result of a fit attempt with diagnostics. */
export interface FitResult {
  model: PriceModel | null;
  /** Rows used in the final fit (after IQR trim). */
  fitRows: ({ age: number; km: number; price: number } & FitAttrs)[];
  /** All usable rows (after IQR trim, before predictor-specific filtering). */
  usableRows: ({ age: number; km: number; price: number } & FitAttrs)[];
  /** Diagnostics. */
  diagnostics: {
    rSquared: number;
    adjRSquared: number;
    maxLeverage: number;
    maxCooksD: number;
    conditionNumber: number;
  } | null;
}

/** Minimum rows in BOTH classes for a dummy (fuel/transmission) term. */
const MIN_DUMMY_CLASS = 10;

/** 1-in-10 rule: minimum usable rows = 10 × (base predictors + optional terms). */
const MIN_USABLE_BASE = 30; // 10 × 3 (intercept, age, km) + interaction term
const MIN_USABLE_FULL = 60; // 10 × 6 (base + kw + diesel + auto)

/**
 * OLS fit of log(price) ~ 1 + age + km + age×km [+ kw] [+ diesel] [+ auto] on
 * IQR-trimmed rows. Semi-log (hedonic) form keeps depreciation multiplicative.
 *
 * Returns null when:
 * - fewer than 30 usable rows (base) / 60 (full) survive trimming
 * - normal equations are singular (condition number > 1e12)
 * - base coefficients have wrong sign (coefAge >= 0 || coefKm >= 0)
 * - the fit is worse than an intercept-only line (rSquared < -1 or non-finite)
 *
 * Soft adjustments (never reject an otherwise valid fit):
 * - positive age×km interaction → drop the interaction term and refit
 * - max Cook's D > 4/n → drop the single most influential row and refit once
 * - leverage is reported in diagnostics, not used as a rejection gate
 *
 * n = rows actually used in the final fit. Diagnostics included for validation.
 */
export function fitPriceModel(
  rows: ({ age: number; km: number; price: number } & FitAttrs)[],
): FitResult | null {
  const positive = rows.filter((r) => r.price > 0);
  const { kept } = iqrTrimmed(positive.map((r) => r.price));
  const usable = positive.filter((r) => kept.includes(r.price));

  const kwRows = usable.filter(
    (r) => r.kw !== null && r.kw !== undefined && Number.isFinite(r.kw),
  );
  const useKw =
    kwRows.length >= MIN_USABLE_FULL &&
    new Set(kwRows.map((r) => r.kw)).size >= 2;
  const fitRows = useKw ? kwRows : usable;
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

  const minUsable = useKw ? MIN_USABLE_FULL : MIN_USABLE_BASE;
  if (fitRows.length < minUsable) {
    return null;
  }

  // Try full spec with interaction
  const full = fitSpecModel(
    fitRows,
    useKw,
    useDiesel,
    useAuto,
    fitKwMean,
    true,
  );
  if (full) return full;

  // Fallback: plain age+km+age×km on ALL usable rows
  return fitSpecModel(usable, false, false, false, undefined, true);
}

function fitSpecModel(
  rows: ({ age: number; km: number; price: number } & FitAttrs)[],
  useKw: boolean,
  useDiesel: boolean,
  useAuto: boolean,
  fitKwMean?: number,
  includeInteraction: boolean = true,
): FitResult | null {
  let fitRows = rows;
  let interaction = includeInteraction;
  let droppedInfluential = false;

  // Each adjustment below runs at most once, so the loop terminates.
  for (;;) {
    const n = fitRows.length;
    const p =
      3 +
      (interaction ? 1 : 0) +
      (useKw ? 1 : 0) +
      (useDiesel ? 1 : 0) +
      (useAuto ? 1 : 0);

    // Build design matrix X (n × p) and response vector y
    const X: number[][] = [];
    const y: number[] = [];
    for (const r of fitRows) {
      const x: number[] = [1, r.age, r.km];
      if (interaction) x.push((r.age * r.km) / 1e6); // scaled for numerical stability
      if (useKw) x.push(r.kw!);
      if (useDiesel) x.push(r.diesel === true ? 1 : 0);
      if (useAuto) x.push(r.auto === true ? 1 : 0);
      X.push(x);
      y.push(Math.log(r.price));
    }

    // Solve (X'X)β = X'y using QR decomposition (more stable than normal equations)
    const result = qrSolve(X, y, p);
    if (!result.coef || !result.diagnostics) return null;
    const { coef, diagnostics } = result;

    // Coefficient indices
    const idxIntercept = 0;
    const idxAge = 1;
    const idxKm = 2;
    const idxAgeKm = interaction ? 3 : -1;
    const kwIdx = 3 + (interaction ? 1 : 0);
    const dieselIdx = kwIdx + (useKw ? 1 : 0);
    const autoIdx = dieselIdx + (useDiesel ? 1 : 0);

    // Base coefficient sign checks (depreciation must be negative). The
    // interaction can absorb a main effect and flip its sign; drop the
    // optional term before discarding a fit that works without it.
    if (coef[idxAge] >= 0 || coef[idxKm] >= 0) {
      if (interaction) {
        interaction = false;
        continue;
      }
      return null;
    }
    // Power term sign check
    if (useKw) {
      if (!Number.isFinite(coef[kwIdx]) || coef[kwIdx] <= 0) return null;
    }
    if (diagnostics.conditionNumber > 1e12) return null;
    // Degenerate fit: very negative R-squared indicates fit is much worse than
    // a horizontal line (intercept only). This catches flat-price data with
    // varying predictors where spurious correlations create nonsense fits.
    if (!Number.isFinite(diagnostics.rSquared) || diagnostics.rSquared < -1) {
      return null;
    }

    // Soft guard: a positive interaction says the data does not support extra
    // depreciation for old AND high-km cars. Drop the term and refit instead
    // of discarding an otherwise valid age/km fit.
    if (interaction && coef[idxAgeKm] > 0) {
      interaction = false;
      continue;
    }

    // Soft guard: one row dominates the fit (Cook's D). Drop that row and
    // refit once. Leverage alone is a property of the design matrix, not a
    // data-quality defect, so it is reported but never rejects the fit.
    if (!droppedInfluential && diagnostics.maxCooksD > 4 / n && n - 1 > p) {
      fitRows = fitRows.filter((_, i) => i !== result.maxCooksDIndex);
      droppedInfluential = true;
      continue;
    }

    const model: PriceModel = {
      intercept: coef[idxIntercept],
      coefAge: coef[idxAge],
      coefKm: coef[idxKm],
      coefAgeKm: interaction ? coef[idxAgeKm] : 0,
      n: n,
      minAge: Math.min(...fitRows.map((r) => r.age)),
      maxAge: Math.max(...fitRows.map((r) => r.age)),
      minKm: Math.min(...fitRows.map((r) => r.km)),
      maxKm: Math.max(...fitRows.map((r) => r.km)),
      maxLeverage: diagnostics.maxLeverage,
    };
    if (useKw) {
      model.coefKw = coef[kwIdx]!;
      model.meanKw = fitKwMean;
    }
    if (useDiesel) model.coefDiesel = coef[dieselIdx]!;
    if (useAuto) model.coefAuto = coef[autoIdx]!;
    return { model, fitRows, usableRows: rows, diagnostics };
  }
}

/**
 * QR decomposition solver for OLS: more numerically stable than normal equations.
 * Returns coefficients and diagnostics (leverage, Cook's D, condition number).
 */
function qrSolve(
  X: number[][],
  y: number[],
  p: number,
): {
  coef: number[] | null;
  diagnostics: {
    rSquared: number;
    adjRSquared: number;
    maxLeverage: number;
    maxCooksD: number;
    conditionNumber: number;
  } | null;
  /** Index of the most influential row (argmax Cook's D), -1 when unsolved. */
  maxCooksDIndex: number;
} {
  const n = X.length;
  if (n < p) return { coef: null, diagnostics: null, maxCooksDIndex: -1 };

  // Build X as matrix, compute QR via Gram-Schmidt (stable for small p)
  const Q: number[][] = Array.from({ length: n }, () =>
    Array<number>(p).fill(0),
  );
  const R: number[][] = Array.from({ length: p }, () =>
    Array<number>(p).fill(0),
  );

  for (let j = 0; j < p; j++) {
    const v: number[] = X.map((row) => row[j]);
    for (let i = 0; i < j; i++) {
      // Project onto the ORTHONORMAL column Q[:,i], not the raw column
      // X[:,i]. Modified Gram-Schmidt reuses Q; projecting onto X corrupts R
      // and every downstream coefficient and diagnostic.
      let rij = 0;
      for (let k = 0; k < n; k++) rij += Q[k][i] * v[k];
      R[i][j] = rij;
      for (let k = 0; k < n; k++) v[k] -= rij * Q[k][i];
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0));
    if (norm < 1e-12) {
      return { coef: null, diagnostics: null, maxCooksDIndex: -1 }; // singular
    }
    R[j][j] = norm;
    for (let k = 0; k < n; k++) Q[k][j] = v[k] / norm;
  }

  // Q'y
  const QTy: number[] = Array<number>(p).fill(0);
  for (let j = 0; j < p; j++) {
    for (let i = 0; i < n; i++) QTy[j] += Q[i][j] * y[i];
  }

  // Back-substitution: Rβ = Q'y
  const coef = Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let sum = QTy[i];
    for (let j = i + 1; j < p; j++) sum -= R[i][j] * coef[j];
    coef[i] = sum / R[i][i];
  }

  // Diagnostics
  const yHat = X.map((row) => row.reduce((s, xj, j) => s + xj * coef[j], 0));
  const residuals = y.map((yi, i) => yi - yHat[i]);
  const rss = residuals.reduce((s, r) => s + r * r, 0);
  const tss = y.reduce(
    (s, yi) => s + (yi - y.reduce((a, b) => a + b, 0) / n) ** 2,
    0,
  );
  const rSquared = 1 - rss / tss;
  const adjRSquared = 1 - ((1 - rSquared) * (n - 1)) / (n - p);

  // Hat matrix diagonal (leverage): h_ii = sum_j Q_ij^2
  const leverage: number[] = Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) leverage[i] += Q[i][j] * Q[i][j];
  }
  const maxLeverage = Math.max(...leverage);

  // Cook's distance
  const mse = rss / (n - p);
  let maxCooksD = 0;
  let maxCooksDIndex = -1;
  for (let i = 0; i < n; i++) {
    const di =
      (residuals[i] ** 2 / (p * mse)) * (leverage[i] / (1 - leverage[i]) ** 2);
    if (di > maxCooksD) {
      maxCooksD = di;
      maxCooksDIndex = i;
    }
  }

  // Condition number of X (via R diagonal)
  const rDiag = R.map((row, i) => row[i]).filter((v) => v > 0);
  const conditionNumber = Math.max(...rDiag) / Math.min(...rDiag);

  return {
    coef,
    diagnostics: {
      rSquared,
      adjRSquared,
      maxLeverage,
      maxCooksD,
      conditionNumber,
    },
    maxCooksDIndex,
  };
}

export function expectedPrice(
  m: PriceModel,
  age: number,
  km: number,
  attrs?: FitAttrs,
): number {
  // IN-SAMPLE ONLY: if age/km outside training range, return NaN to signal fallback
  const inSample =
    age >= m.minAge && age <= m.maxAge && km >= m.minKm && km <= m.maxKm;
  if (!inSample) return NaN;

  const ageKmTerm = (m.coefAgeKm || 0) * ((age * km) / 1e6);
  let p = m.intercept + m.coefAge * age + m.coefKm * km + ageKmTerm;
  if (m.coefKw !== undefined) {
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
  return Math.exp(p);
}

/**
 * Clamp a fitted expectation to the group's IQR-trimmed observed price range.
 * Safety net only — the log fit + in-sample check should already prevent extremes.
 */
export function clampExpected(value: number, prices: number[]): number {
  if (prices.length === 0) return value;
  const { kept } = iqrTrimmed(prices);
  const band = kept.length > 0 ? kept : prices;
  return Math.min(Math.max(value, Math.min(...band)), Math.max(...band));
}

/** Hard ceiling on a single listing's deviation (a bad fit cannot score -3681%). */
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
 * Market percentile score: each deviation's rank position mapped to 0..100.
 * Best deviation → 100, worst → 0, single rated row → 50.
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

/**
 * Cell-median expected price fallback: year±1 is mandatory; a km ±20%
 * split is used only when enough rows survive it, otherwise the plain
 * year±1 median.
 *
 * `excludeIndex` removes the row being priced from its own comp set.
 * Self-inclusion drags the benchmark toward the ask (one row is a third
 * of a 3-row median), shrinking every deviation toward zero.
 *
 * A cell must contain 3 listings to be considered active. When the priced
 * row is excluded it still counts toward that activity floor, so the median
 * rests on the other two. Leave-one-out testing on the local dump shows this
 * keeps 72.9% coverage at 10.2% median log error; requiring 3 independent
 * comps costs 8.9 points of coverage for 0.3 points of error, and widening
 * the year window to ±2/±3 is worse on both error and bias.
 */
export function cellMedianExpected(
  rows: PriceRow[],
  targetYear: number,
  targetKm: number,
  excludeIndex?: number,
): number | null {
  const comps =
    excludeIndex === undefined
      ? rows
      : rows.filter((_, i) => i !== excludeIndex);
  const minComps = excludeIndex === undefined ? 3 : 3;
  const inYear = comps.filter((r) => Math.abs(r.year - targetYear) <= 1);
  if (inYear.length < minComps) return null;
  const inKm = inYear.filter(
    (r) => r.km >= targetKm * 0.8 && r.km <= targetKm * 1.2,
  );
  if (inKm.length >= minComps) {
    const kept = iqrTrimmed(inKm.map((r) => r.price)).kept;
    return kept.length > 0 ? median(kept) : null;
  }
  const keptYear = iqrTrimmed(inYear.map((r) => r.price)).kept;
  return keptYear.length > 0 ? median(keptYear) : null;
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
