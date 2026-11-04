/**
 * Holdout evaluator for the property-based expected price model.
 *
 * Compares the new model (`expected-price.ts`) against the legacy
 * generation+km Theil–Sen benchmark on an 80/20 holdout split of resolved
 * listings, printing MdAPE/coverage for both, the intersection delta, gate
 * coverage, and calibration by group size and price decile.
 *
 * Run: npx ts-node --transpile-only --compiler-options
 *   '{"module":"commonjs","moduleResolution":"node"}'
 *   tools/evaluate-expected-price.ts --seed=7
 *
 * Requires DATABASE_URL in the environment (or a .env file).
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Client } from 'pg';

import {
  computeExpectedPrices,
  type ExpectedPriceRow,
  type ExpectedPriceResult,
} from '../src/analysis/expected-price';
import { resolveGeneration } from '../src/analysis/generation-resolver';

const seedArg = process.argv.find((a) => a.startsWith('--seed=')) ?? '';
const SEED = Number(seedArg.split('=')[1]) ?? 7;

interface RawRow {
  id: number;
  model: string | null;
  year: number | null;
  price: number;
  km: number;
  powerKw: number | null;
  fuelType: string | null;
  transmission: string | null;
  updatedAt: Date;
}

// ------------------------------------------------------------
// Legacy baseline (copied from deal-stats.ts before removal)
// ------------------------------------------------------------

function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function iqrTrimmed(values: number[]): {
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

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function theilSenSlope(rows: { km: number; price: number }[]): number | null {
  if (rows.length < 4) return null;
  const stride = Math.ceil(rows.length / 500);
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

function adjustedBenchmark(
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

function benchmarkExpected(
  rows: { price: number; km: number }[],
  targetKm: number,
): number | null {
  const { kept } = iqrTrimmed(rows.map((r) => r.price));
  if (kept.length < 4) return null;
  const keptRows = rows.filter((r) => kept.includes(r.price));
  const slope = theilSenSlope(keptRows);
  return adjustedBenchmark(
    keptRows.map((r) => r.price),
    keptRows.map((r) => r.km),
    slope !== null && Number.isFinite(slope) && slope < 0 ? slope : null,
    targetKm,
  );
}

// Legacy baseline per model+generation group, fit on train, applied to test.
// Legacy gate: >=5 usable comps (keeping the legacy behavior honest).
function computeLegacy(
  train: ExpectedPriceRow[],
  test: ExpectedPriceRow[],
): { id: number; expectedPrice: number | null }[] {
  // Build per-group train pools: model\0generation -> {price, km}[]
  const trainByGroup = new Map<string, { price: number; km: number }[]>();
  for (const r of train) {
    const key = `${r.model}\u0000${r.generation}`;
    const arr = trainByGroup.get(key);
    if (arr) arr.push({ price: r.price, km: r.km });
    else trainByGroup.set(key, [{ price: r.price, km: r.km }]);
  }

  const out: { id: number; expectedPrice: number | null }[] = [];
  for (const r of test) {
    const key = `${r.model}\u0000${r.generation}`;
    const pool = trainByGroup.get(key);
    const ep = pool != null ? benchmarkExpected(pool, r.km) : null;
    out.push({ id: r.id, expectedPrice: ep });
  }
  return out;
}

// ------------------------------------------------------------
// Data loading
// ------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed, seed);
    t = (t ^ (t >>> 15)) | 0;
    t = (t + Math.imul(t, t >>> 13)) | 0;
    t = (t ^ (t >>> 16)) | 0;
    t = (t + Math.imul(t, t >>> 5)) | 0;
    t = (t ^ (t >>> 18)) | 0;
    return (t >>> 0) / 4294967296;
  };
}

async function loadRows(): Promise<{
  rows: ExpectedPriceRow[];
  updatedAtById: Map<number, Date>;
}> {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'good_car_deals_e2e',
  });
  await client.connect();
  const { rows: rawRows } = await client.query<RawRow>(
    `select id, model, year, price_numeric::float8 as price, mileage_km,
            power_kw, fuel_type, transmission, updated_at
     from listings
     where price_numeric > 0
       and year between 1950 and extract(year from current_date)
       and mileage_km > 0
       and model is not null and model <> ''
     order by id asc`,
  );
  await client.end();

  const now = new Date().getFullYear();
  const out: ExpectedPriceRow[] = [];
  const updatedAtById = new Map<number, Date>();
  for (const r of rawRows) {
    const generation = resolveGeneration(r.model ?? '', r.year ?? 0);
    if (!generation) continue;
    out.push({
      id: r.id,
      model: r.model!,
      generation,
      price: r.price,
      age: now - r.year!,
      km: r.km,
      powerKw: r.powerKw,
      fuelType: r.fuelType,
      transmission: r.transmission,
    });
    updatedAtById.set(r.id, r.updatedAt);
  }
  return { rows: out, updatedAtById };
}

// ------------------------------------------------------------
// Metrics
// ------------------------------------------------------------

function mdape(actual: number[], pred: number[]): number {
  const diffs: number[] = [];
  for (let i = 0; i < actual.length; i++) {
    if (pred[i] == null || !Number.isFinite(pred[i])) continue;
    if (!actual[i] || !Number.isFinite(actual[i])) continue;
    diffs.push(Math.abs((pred[i]! - actual[i]) / actual[i]) * 100);
  }
  if (diffs.length === 0) return NaN;
  return median(diffs);
}

function medianOf<T>(arr: T[]): T {
  const s = [...arr].sort();
  return s[Math.floor(s.length / 2)];
}

function groupSizeKey(s: number): string {
  if (s < 20) return '10-19';
  if (s < 50) return '20-49';
  return '50+';
}

function decileKey(i: number, n: number): number {
  return Math.min(Math.floor(((i + 1) * 10) / n), 10);
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
  const { rows: all, updatedAtById } = await loadRows();
  const resolved = all.length;

  // Deterministic seeded shuffle + 80/20 split.
  const rng = mulberry32(SEED);
  const idx = all.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const cut = Math.floor(idx.length * 0.8);
  const trainIdx = idx.slice(0, cut);
  const testIdx = idx.slice(cut);

  const train = trainIdx.map((i) => all[i]);
  const test = testIdx.map((i) => all[i]);

  // New model: fit on train, predict on test.
  const newResults = computeExpectedPrices(train, test);
  const newById = new Map<number, ExpectedPriceResult>(
    newResults.map((r) => [r.id, r]),
  );

  // Legacy baseline: fit per group on train, apply to test.
  const legacyResults = computeLegacy(train, test);
  const legacyById = new Map<number, number | null>(
    legacyResults.map((r) => [r.id, r.expectedPrice]),
  );

  // Intersection = rows both estimators scored.
  const intersection: number[] = [];
  for (const t of test) {
    const n = newById.get(t.id);
    const l = legacyById.get(t.id);
    if (n?.expectedPrice != null && l != null) {
      intersection.push(t.id);
    }
  }

  const newActual: number[] = [];
  const newPred: number[] = [];
  for (const id of intersection) {
    newActual.push(all.find((r) => r.id === id)!.price);
    newPred.push(newById.get(id)!.expectedPrice!);
  }

  const legacyActual: number[] = [];
  const legacyPred: number[] = [];
  for (const id of intersection) {
    legacyActual.push(all.find((r) => r.id === id)!.price);
    legacyPred.push(legacyById.get(id)!);
  }

  const newMdape = mdape(newActual, newPred);
  const legacyMdape = mdape(legacyActual, legacyPred);
  const delta = legacyMdape - newMdape;

  // Gate coverage: of resolved test rows, how many got a new-model price.
  const gatePass = test.filter(
    (t) => newById.get(t.id)?.expectedPrice != null,
  ).length;
  const gatePct = ((gatePass / test.length) * 100).toFixed(1);

  // Calibration by group size (predicted / actual ratio median).
  const byGroupSize: Record<string, number[]> = {};
  for (const id of intersection) {
    const t = all.find((r) => r.id === id)!;
    const g = newById.get(id)!;
    const group = all.filter(
      (r) => r.model === t.model && r.generation === t.generation,
    ).length;
    const key = groupSizeKey(group);
    if (!byGroupSize[key]) byGroupSize[key] = [];
    byGroupSize[key].push(g.expectedPrice! / t.price);
  }

  // Calibration by price decile of predicted price.
  const sortedByPred = [...intersection].sort(
    (a, b) => newById.get(a)!.expectedPrice! - newById.get(b)!.expectedPrice!,
  );
  const byDecile: Record<number, number[]> = {};
  for (let i = 0; i < sortedByPred.length; i++) {
    const id = sortedByPred[i];
    const t = all.find((r) => r.id === id)!;
    const g = newById.get(id)!;
    const d = decileKey(i, sortedByPred.length);
    if (!byDecile[d]) byDecile[d] = [];
    byDecile[d].push(g.expectedPrice! / t.price);
  }

  const maxUpdatedTs = Math.max(
    ...all.map((r) => updatedAtById.get(r.id)?.getTime() ?? 0),
  );

  console.log(
    `rows=${all.length} resolved=${resolved} seed=${SEED} train=${train.length} test=${test.length} max_updated_at=${new Date(maxUpdatedTs).toISOString()}`,
  );
  console.log(
    `new      MdAPE=${newMdape.toFixed(2)} coverage=${((newResults.filter((r) => r.expectedPrice != null).length / test.length) * 100).toFixed(1)}`,
  );
  console.log(
    `baseline MdAPE=${legacyMdape.toFixed(2)} coverage=${((legacyResults.filter((r) => r.expectedPrice != null).length / test.length) * 100).toFixed(1)}`,
  );
  console.log(
    `intersection n=${intersection.length} new=${newMdape.toFixed(2)} baseline=${legacyMdape.toFixed(2)} delta=${delta.toFixed(2)}`,
  );
  console.log(`gate pass (resolved)=${gatePct}`);

  for (const key of ['10-19', '20-49', '50+'] as const) {
    const v = byGroupSize[key] ?? [];
    if (v.length === 0) continue;
    console.log(
      `group size ${key}: ratio=${medianOf(v).toFixed(3)} n=${v.length}`,
    );
  }
  for (let d = 1; d <= 10; d++) {
    const v = byDecile[d] ?? [];
    if (v.length === 0) continue;
    console.log(
      `price decile ${d}: ratio=${medianOf(v).toFixed(3)} n=${v.length}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
