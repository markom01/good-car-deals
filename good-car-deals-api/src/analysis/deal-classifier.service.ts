import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  capDeviation,
  cellMedianExpected,
  clampExpected,
  classifyTier,
  deviationPct,
  expectedPrice,
  fitPriceModel,
  percentileScores,
  type TierName,
} from './deal-stats';
import { resolveGeneration } from './generation-resolver';

export interface ListingWithDeal {
  id: bigint;
  listingUrl: string;
  title: string;
  price: string;
  priceNumeric: bigint | null;
  priceNote: string | null;
  year: number | null;
  age: number | null;
  mileageKm: number | null;
  model: string | null;
  dealType: string | null;
  dealScore: number | null;
  pricePerYear: number | null;
  fuelType: string | null;
  engineCc: number | null;
  powerKw: number | null;
  transmission: string | null;
  location: string | null;
  expectedPrice: number | null;
  deviationPct: number | null;
  scrapedAt: Date;
  updatedAt: Date;
}

export interface ClassifierRow {
  id: number;
  model: string | null;
  priceNumeric: number | null;
  year: number | null;
  age: number | null;
  mileageKm: number | null;
  powerKw?: number | null;
  fuelType?: string | null;
  transmission?: string | null;
  /**
   * Generation resolved from the offline artifact. Only used for grouping
   * when that generation has enough comps to fit on its own; see
   * GENERATION_MIN_COMPARABLES.
   */
  generation?: string | null;
}

/**
 * Minimum usable comps before a generation is fitted separately.
 *
 * Holdout sweep on the full 18,745-row snapshot (MdAPE, lower is better):
 * model-only 10.63%, t=3 10.08, t=5 10.06, t=6 10.05, t=8 10.04,
 * t=10 10.06, t=12 10.09, t=20 10.21, t=40 10.30, t=60 10.44.
 * The curve is flat between 3 and 12 and degrades above 20, so 10 is the
 * widest gate that stays at the minimum. Coverage: 285 generations /
 * 12,162 rated rows (65.2%) at t=10 versus 102 / 8,846 (47.4%) at t=40.
 */
export const GENERATION_MIN_COMPARABLES = 10;

const GROUP_KEY_SEPARATOR = '\u0000';

function generationGroupKey(model: string | null, generation: string): string {
  return `${model ?? ''}${GROUP_KEY_SEPARATOR}${generation}`;
}

/**
 * Assign each row to a fit group. A generation becomes its own group only
 * when it holds at least GENERATION_MIN_COMPARABLES usable rows; otherwise
 * the row stays in its model group, so thin generations never get an
 * unstable standalone fit.
 */
function buildGroupKeys(rows: ClassifierRow[]): Map<number, string> {
  const generationCounts = new Map<string, number>();
  for (const r of rows) {
    if (!r.generation || !isClassifiable(r)) continue;
    const key = generationGroupKey(r.model, r.generation);
    generationCounts.set(key, (generationCounts.get(key) ?? 0) + 1);
  }

  const keys = new Map<number, string>();
  for (const r of rows) {
    const modelKey = r.model ?? '';
    if (!r.generation) {
      keys.set(r.id, modelKey);
      continue;
    }
    const key = generationGroupKey(r.model, r.generation);
    const eligible =
      (generationCounts.get(key) ?? 0) >= GENERATION_MIN_COMPARABLES;
    keys.set(r.id, eligible ? key : modelKey);
  }
  return keys;
}

export interface ClassifyResult {
  id: number;
  dealType: TierName;
  dealScore: number;
  expectedPrice: number | null;
  deviationPct: number | null;
}

function isClassifiable(r: ClassifierRow): boolean {
  return (
    r.priceNumeric !== null &&
    r.priceNumeric > 0 &&
    r.year !== null &&
    r.age !== null &&
    r.age > 0 &&
    r.mileageKm !== null &&
    r.mileageKm > 0
  );
}

const UNRATED_RESULT = (id: number): ClassifyResult => ({
  id,
  dealType: 'UNRATED',
  dealScore: 0,
  expectedPrice: null,
  deviationPct: null,
});

function scoreRow(id: number, expected: number, price: number): ClassifyResult {
  if (expected <= 0 || !Number.isFinite(expected)) {
    return UNRATED_RESULT(id);
  }
  // Cap the deviation so one bad fit cannot dominate the market percentile
  // scale (raw values like -3681% existed before the log-price fit).
  const dev = capDeviation(deviationPct(expected, price));
  if (!Number.isFinite(dev)) {
    return UNRATED_RESULT(id);
  }
  // dealScore is provisional here (dev-based); classifyGroups overwrites it
  // with the market percentile across ALL rated rows before returning.
  return {
    id,
    // Euro saving = the same percentage of the benchmark (positive = cheaper).
    dealType: classifyTier(dev, (dev / 100) * expected),
    dealScore: 0,
    expectedPrice: expected,
    deviationPct: dev,
  };
}

/**
 * Pure v2 classification over grouped rows (no Nest, no DB).
 * Per group: try a per-group OLS fit (IQR trim inside); on fit failure fall
 * back to per-row year±1 / km±20% cell median. Rows without a positive
 * expected price → UNRATED with score 0. Rows trimmed from the fit still get
 * scored. Groups start as model labels; a generation replaces the model as
 * the group only when it has GENERATION_MIN_COMPARABLES usable rows.
 * Two groups never share a fit.
 */
export function classifyGroups(rows: ClassifierRow[]): ClassifyResult[] {
  const results = new Map<number, ClassifyResult>();
  const groupKeys = buildGroupKeys(rows);
  const groups = new Map<string, ClassifierRow[]>();
  for (const r of rows) {
    const key = groupKeys.get(r.id) ?? r.model ?? '';
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  for (const group of groups.values()) {
    const usable = group.filter(isClassifiable);

    for (const r of group) {
      if (!isClassifiable(r)) {
        results.set(r.id, UNRATED_RESULT(r.id));
      }
    }

    const fitResult = fitPriceModel(
      usable.map((r) => ({
        age: r.age!,
        km: r.mileageKm!,
        price: r.priceNumeric!,
        kw: r.powerKw,
        diesel: r.fuelType === 'Dizel',
        auto: r.transmission === 'Automatic',
      })),
    );

    if (fitResult?.model) {
      const model = fitResult.model;
      const groupPrices = usable.map((r) => r.priceNumeric!);
      const cellRows = usable.map((u) => ({
        price: u.priceNumeric!,
        year: u.year!,
        km: u.mileageKm!,
      }));
      for (let i = 0; i < usable.length; i++) {
        const r = usable[i];
        // expectedPrice returns NaN for out-of-sample (age/km outside training range)
        const raw = expectedPrice(model, r.age!, r.mileageKm!, {
          kw: r.powerKw,
          diesel: r.fuelType === 'Dizel',
          auto: r.transmission === 'Automatic',
        });
        // Out-of-sample → fallback to cell median (comps), not clamping
        const exp = Number.isFinite(raw)
          ? clampExpected(raw, groupPrices)
          : cellMedianExpected(cellRows, r.year!, r.mileageKm!, i);
        results.set(
          r.id,
          exp === null
            ? UNRATED_RESULT(r.id)
            : scoreRow(r.id, exp, r.priceNumeric!),
        );
      }
    } else {
      const cellRows = usable.map((u) => ({
        price: u.priceNumeric!,
        year: u.year!,
        km: u.mileageKm!,
      }));
      for (let i = 0; i < usable.length; i++) {
        const r = usable[i];
        const exp = cellMedianExpected(cellRows, r.year!, r.mileageKm!, i);
        results.set(
          r.id,
          exp === null
            ? UNRATED_RESULT(r.id)
            : scoreRow(r.id, exp, r.priceNumeric!),
        );
      }
    }
  }

  // dealScore = market percentile across ALL rated rows (global, not
  // per-model): best deviation → 100, worst → 0, UNRATED stays 0.
  const rated = [...results.values()].filter((r) => r.deviationPct !== null);
  const scores = percentileScores(rated.map((r) => r.deviationPct!));
  rated.forEach((r, i) => {
    r.dealScore = scores[i]!;
  });

  return [...results.values()];
}

@Injectable()
export class DealClassifierService {
  private readonly logger = new Logger(DealClassifierService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Classify all listings in the database (v2): per-model comps —
   * per-model OLS expected price, cell-median fallback, then
   * % deviation → 5-tier label + 0-100 score.
   * @returns Number of classified listings
   */
  async classifyDeals(): Promise<number> {
    this.logger.log('Starting deal classification...');

    // Fetch ALL listings: rows whose price turned non-numeric (e.g.
    // "Price on request") must still be re-labeled in place — otherwise
    // they keep a stale GREAT/GOOD label from a previous pass.
    const listings = await this.prismaService.listing.findMany({});

    if (listings.length === 0) {
      this.logger.warn('No listings found to classify');
      return 0;
    }

    this.logger.log(`Found ${listings.length} listings to classify`);

    const rows: ClassifierRow[] = listings.map((l) => ({
      id: Number(l.id),
      model: l.model,
      priceNumeric: l.priceNumeric === null ? null : Number(l.priceNumeric),
      year: l.year,
      age: l.age,
      mileageKm: l.mileageKm,
      powerKw: l.powerKw,
      fuelType: l.fuelType,
      transmission: l.transmission,
      generation: resolveGeneration(l.model, l.year),
    }));

    // Keep price_per_year populated for display/sorting compatibility.
    const pricePerYearById = new Map<number, number | null>();
    for (const r of rows) {
      pricePerYearById.set(
        r.id,
        r.priceNumeric !== null && r.year !== null
          ? this.calculatePricePerYear(r.priceNumeric, r.year)
          : null,
      );
    }

    const results = classifyGroups(rows);

    // One update per row; chunked so a 70k-row snapshot does not open 70k
    // concurrent queries against the Prisma pool at once.
    const UPDATE_BATCH_SIZE = 500;
    for (let i = 0; i < results.length; i += UPDATE_BATCH_SIZE) {
      await Promise.all(
        results.slice(i, i + UPDATE_BATCH_SIZE).map((r) =>
          this.prismaService.listing.update({
            where: { id: BigInt(r.id) },
            data: {
              dealType: r.dealType,
              dealScore: r.dealScore,
              expectedPrice: r.expectedPrice,
              deviationPct: r.deviationPct,
              pricePerYear: pricePerYearById.get(r.id) ?? null,
            },
          }),
        ),
      );
      this.logger.log(
        `Persisted classification ${Math.min(i + UPDATE_BATCH_SIZE, results.length)}/${results.length}`,
      );
    }

    this.logger.log(
      `Classification complete. Classified ${results.length} listings`,
    );

    // Print summary
    const summary = await this.getClassificationSummary();
    this.logger.log(
      `Summary: GREAT: ${summary.great}, GOOD: ${summary.good}, FAIR: ${summary.fair}, ` +
        `HIGH: ${summary.high}, OVERPRICED: ${summary.overpriced}, UNRATED: ${summary.unrated}`,
    );

    return results.length;
  }

  /**
   * Calculate price per year: price / age
   * Uses dynamic year calculation: currentYear - year
   */
  calculatePricePerYear(price: number, year: number): number | null {
    const currentYear = new Date().getFullYear();
    const age = currentYear - year;

    if (age <= 0 || price <= 0) {
      return null;
    }

    return Math.round((price / age) * 100) / 100;
  }

  /**
   * Get classification summary from database (six v2 tiers)
   */
  async getClassificationSummary(): Promise<{
    great: number;
    good: number;
    fair: number;
    high: number;
    overpriced: number;
    unrated: number;
  }> {
    const allListings = await this.prismaService.listing.findMany({
      select: { dealType: true },
    });

    const byType = (t: TierName) =>
      allListings.filter((l) => l.dealType === t).length;

    return {
      great: byType('GREAT DEAL'),
      good: byType('GOOD DEAL'),
      fair: byType('FAIR PRICE'),
      high: byType('HIGH PRICE'),
      overpriced: byType('OVERPRICED'),
      unrated: byType('UNRATED'),
    };
  }

  /**
   * Get all listings with their deal classification
   * Used by GET /deals endpoint
   */
  async getClassifiedListings(): Promise<ListingWithDeal[]> {
    return this.prismaService.listing.findMany({
      orderBy: { pricePerYear: 'asc' },
    });
  }
}
