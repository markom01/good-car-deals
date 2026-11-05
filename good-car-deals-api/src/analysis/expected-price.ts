import { iqrTrimmed } from './deal-stats';

/**
 * Feature mapping and constants shared by the property-based expected-price model.
 * Pure module: no Nest, no Prisma, no runtime dependencies beyond TypeScript.
 */

/** Number of comparable listings required behind an expected price (excluding the scored row). */
export const EXPECTED_PRICE_MIN_COMPS = 10;

/** Hierarchical shrinkage weight (group -> model -> global). */
export const SHRINKAGE_K = 8;

export type FuelCategory = 'petrol' | 'diesel' | 'gas' | 'hybrid' | 'electric';

/**
 * Maps a Serbian fuel label to a canonical category.
 * Order matters: hybrid is checked before diesel so
 * 'Hibridni pogon (dizel)' maps to hybrid, not diesel.
 */
export function fuelCategory(label: string | null | undefined): FuelCategory {
  const s = (label ?? '').toLowerCase();

  if (s.includes('elektri') || s.includes('electric')) return 'electric';
  if (s.includes('hibrid') || s.includes('hybrid')) return 'hybrid';
  if (
    s.includes('gas') ||
    s.includes('metan') ||
    s.includes('tng') ||
    s.includes('cng')
  )
    return 'gas';
  if (s.includes('dizel') || s.includes('diesel')) return 'diesel';
  return 'petrol';
}

/**
 * Returns true when a transmission label denotes an automatic transmission.
 */
export function isAutomatic(transmission: string | null | undefined): boolean {
  const s = (transmission ?? '').toLowerCase();
  return s.includes('automat');
}

// ------------------------------------------------------------
// Expected-price model (fit + leave-one-out prediction)
// ------------------------------------------------------------

const N_FEATURES = 8;
// feature order: age, km/10k, ln(powerKw), diesel, gas, hybrid, electric, automatic
const IDX_AGE = 0;
const IDX_KM = 1;
const IDX_LN_POWER = 2;
const IDX_DIESEL = 3;
const IDX_GAS = 4;
const IDX_HYBRID = 5;
const IDX_ELECTRIC = 6;
const IDX_AUTO = 7;

// Group key separator used in the serialized FitSnapshot (snapshot.groups keys).
// The internal \u0000 separator works as an in-memory Map key but PostgreSQL
// rejects U+0000 in text/JSON (error 22P05), so the snapshot stores keys with
// this printable separator instead. Must match between buildFitSnapshot and
// predictFromSnapshot.
const GROUP_SEP = '::';

export interface ExpectedPriceRow {
  id: number;
  model: string;
  generation: string;
  price: number;
  age: number;
  km: number;
  powerKw: number | null;
  fuelType: string | null;
  transmission: string | null;
}

export interface ExpectedPriceResult {
  id: number;
  expectedPrice: number | null;
  sampleSize: number | null;
}

/**
 * Persisted fit snapshot: everything `predictFromSnapshot` needs to reproduce
 * `computeExpectedPrices` predictions for new rows without refitting.
 * JSON-safe: all maps are plain objects, all sets are arrays.
 */
export interface GroupSnapshot {
  count: number;
  sumResidual: number;
  model: string;
  minPrice: number;
  maxPrice: number;
  minAge: number;
  maxAge: number;
  minKm: number;
  maxKm: number;
  minLnPower: number;
  maxLnPower: number;
  sumLnPower: number;
}

export interface FitSnapshot {
  version: 1;
  beta: number[];
  means: FeatureMeans;
  groups: Record<string, GroupSnapshot>;
  globalSum: number;
  allFitCount: number;
  modelSum: Record<string, number>;
  modelCount: Record<string, number>;
  keptIds: number[];
  residuals: Record<string, number>;
  scorePool: number[];
}

interface GroupStats {
  count: number;
  sumResidual: number;
  model: string;
  minPrice: number;
  maxPrice: number;
  minAge: number;
  maxAge: number;
  minKm: number;
  maxKm: number;
  minLnPower: number;
  maxLnPower: number;
  sumLnPower: number;
}

interface FitRow extends ExpectedPriceRow {
  groupKey: string;
  x: number[];
}

interface FeatureMeans {
  age: number;
  km: number;
  lnPower: number;
  diesel: number;
  gas: number;
  hybrid: number;
  electric: number;
  auto: number;
  y: number; // mean log price
}

/**
 * Fit a within-group log-price OLS over age, km, power, fuel and transmission,
 * pool intercepts group -> model -> global, then predict with leave-one-out.
 *
 * `fitRows` supply the fit statistics; `predictRows` (defaults to `fitRows`)
 * receive predictions in their own order. A predict row that was part of the
 * fit is excluded from its own group, model and global sums.
 */
export function computeExpectedPrices(
  fitRows: ExpectedPriceRow[],
  predictRows: ExpectedPriceRow[] = fitRows,
): ExpectedPriceResult[] {
  const fit = [...fitRows].sort((a, b) => a.id - b.id);

  // ---- group fit rows -------------------------------------------------
  const groups = new Map<string, ExpectedPriceRow[]>();
  for (const r of fit) {
    const key = `${r.model}\u0000${r.generation}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const keptIds = new Set<number>();
  const fitByGroup = new Map<string, FitRow[]>();

  for (const [key, arr] of groups) {
    const prices = arr.map((r) => r.price);
    const trimmed = arr.length >= 8 ? iqrTrimmed(prices).kept : prices;
    const keptSet = new Set(trimmed);

    const fitRowsGroup: FitRow[] = [];
    for (const r of arr) {
      if (!keptSet.has(r.price)) continue; // trimmed out
      if (r.powerKw == null || r.powerKw <= 0) continue;
      if (!r.fuelType || !r.transmission) continue;
      fitRowsGroup.push({
        ...r,
        groupKey: key,
        x: featureVector(r),
      });
      keptIds.add(r.id);
    }
    fitByGroup.set(key, fitRowsGroup);
  }

  const allFit: FitRow[] = [];
  for (const arr of fitByGroup.values()) allFit.push(...arr);

  // ---- OLS over demeaned features -------------------------------------
  const means = featureMeans(allFit);
  const XTX = zeros(N_FEATURES, N_FEATURES);
  const XTy = new Array<number>(N_FEATURES).fill(0);

  for (const r of allFit) {
    const x = demean(r.x, means);
    const yDev = Math.log(r.price) - means.y;
    for (let i = 0; i < N_FEATURES; i++) {
      for (let j = 0; j < N_FEATURES; j++) {
        XTX[i][j] += x[i] * x[j];
      }
      XTy[i] += x[i] * yDev;
    }
  }

  const maxDiag = Math.max(...XTX.map((row, i) => row[i]));
  const ridge = 1e-8 * Math.max(1, maxDiag);
  for (let i = 0; i < N_FEATURES; i++) XTX[i][i] += ridge;
  const beta = solve(XTX, XTy);
  const residualById = new Map<number, number>();
  const groupStats = new Map<string, GroupStats>();

  let globalSum = 0;
  const modelSum = new Map<string, number>();
  const modelCount = new Map<string, number>();

  for (const r of allFit) {
    const residual = Math.log(r.price) - dot(beta, r.x);
    residualById.set(r.id, residual);
    globalSum += residual;

    const key = r.groupKey;
    let g = groupStats.get(key);
    if (!g) {
      g = {
        count: 0,
        sumResidual: 0,
        model: r.model,
        minPrice: r.price,
        maxPrice: r.price,
        minAge: r.age,
        maxAge: r.age,
        minKm: r.km,
        maxKm: r.km,
        minLnPower: Math.log(r.powerKw!),
        maxLnPower: Math.log(r.powerKw!),
        sumLnPower: Math.log(r.powerKw!),
      };
      groupStats.set(key, g);
    }
    g.count++;
    g.sumResidual += residual;
    if (r.price < g.minPrice) g.minPrice = r.price;
    if (r.price > g.maxPrice) g.maxPrice = r.price;
    if (r.age < g.minAge) g.minAge = r.age;
    if (r.age > g.maxAge) g.maxAge = r.age;
    if (r.km < g.minKm) g.minKm = r.km;
    if (r.km > g.maxKm) g.maxKm = r.km;
    const lnPower = Math.log(r.powerKw!);
    if (lnPower < g.minLnPower) g.minLnPower = lnPower;
    if (lnPower > g.maxLnPower) g.maxLnPower = lnPower;
    g.sumLnPower += lnPower;

    const mSum = modelSum.get(r.model) ?? 0;
    modelSum.set(r.model, mSum + residual);
    modelCount.set(r.model, (modelCount.get(r.model) ?? 0) + 1);
  }

  const mu = allFit.length > 0 ? globalSum / allFit.length : 0;

  const modelBase = new Map<string, number>();
  for (const [model, count] of modelCount) {
    modelBase.set(
      model,
      (modelSum.get(model)! + SHRINKAGE_K * mu) / (count + SHRINKAGE_K),
    );
  }
  const groupBase = new Map<string, number>();
  for (const [key, g] of groupStats) {
    groupBase.set(
      key,
      (g.sumResidual + SHRINKAGE_K * modelBase.get(g.model)!) /
        (g.count + SHRINKAGE_K),
    );
  }

  // ---- predict ---------------------------------------------------------
  const out: ExpectedPriceResult[] = [];
  for (const r of predictRows) {
    const key = `${r.model}\u0000${r.generation}`;
    const stats = groupStats.get(key);
    if (!stats) {
      out.push({ id: r.id, expectedPrice: null, sampleSize: null });
      continue;
    }
    const wasKept = keptIds.has(r.id);
    const n = stats.count - (wasKept ? 1 : 0);
    if (n < EXPECTED_PRICE_MIN_COMPS) {
      out.push({ id: r.id, expectedPrice: null, sampleSize: null });
      continue;
    }

    let muLoo = mu;
    let modelBaseLoo = modelBase.get(stats.model)!;
    let groupBaseLoo = groupBase.get(key)!;
    if (wasKept) {
      const resid = residualById.get(r.id) ?? 0;
      muLoo = (globalSum - resid) / (allFit.length - 1);
      const mCount = modelCount.get(stats.model)!;
      const mSum = modelSum.get(stats.model)!;
      modelBaseLoo =
        (mSum - resid + SHRINKAGE_K * muLoo) / (mCount - 1 + SHRINKAGE_K);
      groupBaseLoo =
        (stats.sumResidual - resid + SHRINKAGE_K * modelBaseLoo) /
        (stats.count - 1 + SHRINKAGE_K);
    }

    const x = predictVector(r, stats);
    let expected = Math.exp(groupBaseLoo + dot(beta, x));
    expected = Math.min(expected, stats.maxPrice);
    expected = Math.max(expected, stats.minPrice);
    if (!Number.isFinite(expected) || expected <= 0) {
      out.push({ id: r.id, expectedPrice: null, sampleSize: null });
    } else {
      out.push({ id: r.id, expectedPrice: expected, sampleSize: n });
    }
  }
  return out;
}

/**
 * Build a persisted fit snapshot from a fit pass: reuses the exact fit
 * internals of `computeExpectedPrices` (OLS beta, feature means, per-group
 * base terms and bands, LOO residual data) plus the classifier's score pool.
 * Predicting from this snapshot reproduces `computeExpectedPrices` bit for
 * bit on the same inputs.
 */
export function buildFitSnapshot(args: {
  fitRows: ExpectedPriceRow[];
  scorePool: number[];
}): FitSnapshot {
  const fit = [...args.fitRows].sort((a, b) => a.id - b.id);

  // ---- group fit rows (identical to computeExpectedPrices) -------------
  const groups = new Map<string, ExpectedPriceRow[]>();
  for (const r of fit) {
    const key = `${r.model}\u0000${r.generation}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const keptIds = new Set<number>();
  const fitByGroup = new Map<string, FitRow[]>();

  for (const [key, arr] of groups) {
    const prices = arr.map((r) => r.price);
    const trimmed = arr.length >= 8 ? iqrTrimmed(prices).kept : prices;
    const keptSet = new Set(trimmed);

    const fitRowsGroup: FitRow[] = [];
    for (const r of arr) {
      if (!keptSet.has(r.price)) continue; // trimmed out
      if (r.powerKw == null || r.powerKw <= 0) continue;
      if (!r.fuelType || !r.transmission) continue;
      fitRowsGroup.push({
        ...r,
        groupKey: key,
        x: featureVector(r),
      });
      keptIds.add(r.id);
    }
    fitByGroup.set(key, fitRowsGroup);
  }

  const allFit: FitRow[] = [];
  for (const arr of fitByGroup.values()) allFit.push(...arr);

  // ---- OLS over demeaned features -------------------------------------
  const means = featureMeans(allFit);
  const XTX = zeros(N_FEATURES, N_FEATURES);
  const XTy = new Array<number>(N_FEATURES).fill(0);

  for (const r of allFit) {
    const x = demean(r.x, means);
    const yDev = Math.log(r.price) - means.y;
    for (let i = 0; i < N_FEATURES; i++) {
      for (let j = 0; j < N_FEATURES; j++) {
        XTX[i][j] += x[i] * x[j];
      }
      XTy[i] += x[i] * yDev;
    }
  }

  const maxDiag = Math.max(...XTX.map((row, i) => row[i]));
  const ridge = 1e-8 * Math.max(1, maxDiag);
  for (let i = 0; i < N_FEATURES; i++) XTX[i][i] += ridge;
  const beta = solve(XTX, XTy);

  const residualById = new Map<number, number>();
  const groupStats = new Map<string, GroupStats>();
  let globalSum = 0;
  const modelSum = new Map<string, number>();
  const modelCount = new Map<string, number>();

  for (const r of allFit) {
    const residual = Math.log(r.price) - dot(beta, r.x);
    residualById.set(r.id, residual);
    globalSum += residual;

    const key = r.groupKey;
    let g = groupStats.get(key);
    if (!g) {
      g = {
        count: 0,
        sumResidual: 0,
        model: r.model,
        minPrice: r.price,
        maxPrice: r.price,
        minAge: r.age,
        maxAge: r.age,
        minKm: r.km,
        maxKm: r.km,
        minLnPower: Math.log(r.powerKw!),
        maxLnPower: Math.log(r.powerKw!),
        sumLnPower: Math.log(r.powerKw!),
      };
      groupStats.set(key, g);
    }
    g.count++;
    g.sumResidual += residual;
    if (r.price < g.minPrice) g.minPrice = r.price;
    if (r.price > g.maxPrice) g.maxPrice = r.price;
    if (r.age < g.minAge) g.minAge = r.age;
    if (r.age > g.maxAge) g.maxAge = r.age;
    if (r.km < g.minKm) g.minKm = r.km;
    if (r.km > g.maxKm) g.maxKm = r.km;
    const lnPower = Math.log(r.powerKw!);
    if (lnPower < g.minLnPower) g.minLnPower = lnPower;
    if (lnPower > g.maxLnPower) g.maxLnPower = lnPower;
    g.sumLnPower += lnPower;

    const mSum = modelSum.get(r.model) ?? 0;
    modelSum.set(r.model, mSum + residual);
    modelCount.set(r.model, (modelCount.get(r.model) ?? 0) + 1);
  }

  const mu = allFit.length > 0 ? globalSum / allFit.length : 0;

  const modelBase = new Map<string, number>();
  for (const [model, count] of modelCount) {
    modelBase.set(
      model,
      (modelSum.get(model)! + SHRINKAGE_K * mu) / (count + SHRINKAGE_K),
    );
  }
  const groupBase = new Map<string, number>();
  for (const [key, g] of groupStats) {
    groupBase.set(
      key,
      (g.sumResidual + SHRINKAGE_K * modelBase.get(g.model)!) /
        (g.count + SHRINKAGE_K),
    );
  }

  const snapshotGroups: Record<string, GroupSnapshot> = {};
  for (const [key, g] of groupStats) {
    snapshotGroups[key.replace(/\u0000/g, GROUP_SEP)] = {
      count: g.count,
      sumResidual: g.sumResidual,
      model: g.model,
      minPrice: g.minPrice,
      maxPrice: g.maxPrice,
      minAge: g.minAge,
      maxAge: g.maxAge,
      minKm: g.minKm,
      maxKm: g.maxKm,
      minLnPower: g.minLnPower,
      maxLnPower: g.maxLnPower,
      sumLnPower: g.sumLnPower,
    };
  }

  return {
    version: 1,
    beta,
    means,
    groups: snapshotGroups,
    globalSum,
    allFitCount: allFit.length,
    modelSum: Object.fromEntries(modelSum),
    modelCount: Object.fromEntries(modelCount),
    keptIds: [...keptIds],
    residuals: Object.fromEntries(
      [...residualById].map(([id, v]) => [String(id), v]),
    ),
    scorePool: args.scorePool,
  };
}

/**
 * Predict from a persisted snapshot: reproduces the predict phase of
 * `computeExpectedPrices` exactly (leave-one-out adjustments, shrinkage,
 * band clamps), so snapshot scoring matches the full-pass benchmark.
 */
export function predictFromSnapshot(
  snapshot: FitSnapshot,
  predictRows: ExpectedPriceRow[],
): ExpectedPriceResult[] {
  const SHRINKAGE_K = 8;
  const mu =
    snapshot.allFitCount > 0 ? snapshot.globalSum / snapshot.allFitCount : 0;

  const modelBase = new Map<string, number>();
  for (const [model, count] of Object.entries(snapshot.modelCount)) {
    modelBase.set(
      model,
      (snapshot.modelSum[model] + SHRINKAGE_K * mu) / (count + SHRINKAGE_K),
    );
  }

  const groupBase = new Map<string, number>();
  for (const [key, g] of Object.entries(snapshot.groups)) {
    const mb = modelBase.get(g.model)!;
    groupBase.set(
      key,
      (g.sumResidual + SHRINKAGE_K * mb) / (g.count + SHRINKAGE_K),
    );
  }

  const keptIds = new Set(snapshot.keptIds);
  const residuals = snapshot.residuals;

  const out: ExpectedPriceResult[] = [];
  for (const r of predictRows) {
    const key = `${r.model}${GROUP_SEP}${r.generation}`;
    const stats = snapshot.groups[key];
    if (!stats) {
      out.push({ id: r.id, expectedPrice: null, sampleSize: null });
      continue;
    }
    const wasKept = keptIds.has(r.id);
    const n = stats.count - (wasKept ? 1 : 0);
    if (n < EXPECTED_PRICE_MIN_COMPS) {
      out.push({ id: r.id, expectedPrice: null, sampleSize: null });
      continue;
    }

    let muLoo = mu;
    let modelBaseLoo = modelBase.get(stats.model)!;
    let groupBaseLoo = groupBase.get(key)!;
    if (wasKept) {
      const resid = residuals[String(r.id)] ?? 0;
      muLoo = (snapshot.globalSum - resid) / (snapshot.allFitCount - 1);
      const mCount = snapshot.modelCount[stats.model];
      const mSum = snapshot.modelSum[stats.model];
      modelBaseLoo =
        (mSum - resid + SHRINKAGE_K * muLoo) / (mCount - 1 + SHRINKAGE_K);
      groupBaseLoo =
        (stats.sumResidual - resid + SHRINKAGE_K * modelBaseLoo) /
        (stats.count - 1 + SHRINKAGE_K);
    }

    const x = predictVector(r, stats);
    let expected = Math.exp(groupBaseLoo + dot(snapshot.beta, x));
    expected = Math.min(expected, stats.maxPrice);
    expected = Math.max(expected, stats.minPrice);
    if (!Number.isFinite(expected) || expected <= 0) {
      out.push({ id: r.id, expectedPrice: null, sampleSize: null });
    } else {
      out.push({ id: r.id, expectedPrice: expected, sampleSize: n });
    }
  }
  return out;
}

/** feature vector: [age, km/10k, ln(powerKw), diesel, gas, hybrid, electric, automatic] */
function featureVector(r: ExpectedPriceRow): number[] {
  return [
    r.age,
    r.km / 10_000,
    r.powerKw == null || r.powerKw <= 0 ? 0 : Math.log(r.powerKw),
    fuelCategory(r.fuelType) === 'diesel' ? 1 : 0,
    fuelCategory(r.fuelType) === 'gas' ? 1 : 0,
    fuelCategory(r.fuelType) === 'hybrid' ? 1 : 0,
    fuelCategory(r.fuelType) === 'electric' ? 1 : 0,
    isAutomatic(r.transmission) ? 1 : 0,
  ];
}

function featureMeans(rows: FitRow[]): FeatureMeans {
  const n = rows.length;
  if (n === 0) {
    return {
      age: 0,
      km: 0,
      lnPower: 0,
      diesel: 0,
      gas: 0,
      hybrid: 0,
      electric: 0,
      auto: 0,
      y: 0,
    };
  }
  let age = 0,
    km = 0,
    lnPower = 0,
    diesel = 0,
    gas = 0,
    hybrid = 0,
    electric = 0,
    auto = 0,
    y = 0;
  for (const r of rows) {
    age += r.x[IDX_AGE];
    km += r.x[IDX_KM];
    lnPower += r.x[IDX_LN_POWER];
    diesel += r.x[IDX_DIESEL];
    gas += r.x[IDX_GAS];
    hybrid += r.x[IDX_HYBRID];
    electric += r.x[IDX_ELECTRIC];
    auto += r.x[IDX_AUTO];
    y += Math.log(r.price);
  }
  return {
    age: age / n,
    km: km / n,
    lnPower: lnPower / n,
    diesel: diesel / n,
    gas: gas / n,
    hybrid: hybrid / n,
    electric: electric / n,
    auto: auto / n,
    y: y / n,
  };
}

function demean(x: number[], m: FeatureMeans): number[] {
  return [
    x[IDX_AGE] - m.age,
    x[IDX_KM] - m.km,
    x[IDX_LN_POWER] - m.lnPower,
    x[IDX_DIESEL] - m.diesel,
    x[IDX_GAS] - m.gas,
    x[IDX_HYBRID] - m.hybrid,
    x[IDX_ELECTRIC] - m.electric,
    x[IDX_AUTO] - m.auto,
  ];
}

function predictVector(r: ExpectedPriceRow, stats: GroupStats): number[] {
  const lnPower =
    r.powerKw == null || r.powerKw <= 0
      ? stats.sumLnPower / stats.count
      : Math.log(r.powerKw);
  return [
    clamp(r.age, stats.minAge, stats.maxAge),
    clamp(r.km / 10_000, stats.minKm / 10_000, stats.maxKm / 10_000),
    clamp(lnPower, stats.minLnPower, stats.maxLnPower),
    fuelCategory(r.fuelType) === 'diesel' ? 1 : 0,
    fuelCategory(r.fuelType) === 'gas' ? 1 : 0,
    fuelCategory(r.fuelType) === 'hybrid' ? 1 : 0,
    fuelCategory(r.fuelType) === 'electric' ? 1 : 0,
    isAutomatic(r.transmission) ? 1 : 0,
  ];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function zeros(rows: number, cols?: number): number[][] {
  const c = cols ?? rows;
  const m: number[][] = [];
  for (let i = 0; i < rows; i++) m.push(new Array(c).fill(0));
  return m;
}

/** Gaussian elimination with partial pivoting; singular system -> zeros. */
function solve(A: number[][], b: number[]): number[] {
  const n = A.length;
  const M: number[][] = [];
  for (let i = 0; i < n; i++) M.push([...A[i], b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row][col]);
      if (v > maxVal) {
        maxVal = v;
        pivotRow = row;
      }
    }
    if (maxVal < 1e-12) return new Array<number>(n).fill(0);
    if (pivotRow !== col) [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const piv = M[col][col];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / piv;
      for (let c2 = col; c2 <= n; c2++) M[row][c2] -= factor * M[col][c2];
    }
  }

  const x: number[] = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    const piv = M[i][i];
    x[i] = Math.abs(piv) < 1e-12 ? 0 : s / piv;
  }
  return x;
}
