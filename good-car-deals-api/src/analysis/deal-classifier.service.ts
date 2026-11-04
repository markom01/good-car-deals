import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  capDeviation,
  classifyTier,
  dealScoreFromDeviation,
  deviationPct,
  type TierName,
} from './deal-stats';
import { resolveGeneration } from './generation-resolver';
import {
  computeExpectedPrices,
  type ExpectedPriceRow,
  EXPECTED_PRICE_MIN_COMPS,
} from './expected-price';

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
  powerKw: number | null;
  fuelType: string | null;
  transmission: string | null;
  /**
   * Generation resolved upstream by `resolveGeneration(model, year)`. Artifact
   * generation names are model-relative ('MK1', 'J', ...), so the grouping key
   * is model + generation: rows without a generation are UNRATED and never
   * pooled.
   */
  generation?: string | null;
}

/**
 * Minimum comparable rows behind an expected price, excluding the scored row.
 */
export interface ClassifyResult {
  id: number;
  dealType: TierName;
  dealScore: number;
  expectedPrice: number | null;
  deviationPct: number | null;
  sampleSize: number | null;
}

function isClassifiable(r: ClassifierRow): boolean {
  return (
    r.model !== null &&
    r.priceNumeric !== null &&
    r.priceNumeric > 0 &&
    r.year !== null &&
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
  sampleSize: null,
});

function scoreRow(
  id: number,
  benchmark: number,
  price: number,
  sampleSize: number | null,
): ClassifyResult {
  if (benchmark <= 0 || !Number.isFinite(benchmark)) {
    return UNRATED_RESULT(id);
  }
  // Cap the deviation so a single extreme ask cannot dominate the score.
  const dev = capDeviation(deviationPct(benchmark, price));
  if (!Number.isFinite(dev)) {
    return UNRATED_RESULT(id);
  }
  return {
    id,
    // Euro saving = the same percentage of the benchmark (positive = cheaper).
    dealType: classifyTier(dev, (dev / 100) * benchmark),
    dealScore: dealScoreFromDeviation(dev),
    expectedPrice: benchmark,
    deviationPct: dev,
    sampleSize,
  };
}

/**
 * Pure classification over grouped rows (no Nest, no DB).
 * Groups rows by model + resolved generation, fits the property-based
 * expected-price model once per pass, then scores each row's deviation from
 * its leave-one-out expected price on the absolute rubric.
 * Rows without a generation, rows failing `isClassifiable`, and rows whose
 * group has fewer than EXPECTED_PRICE_MIN_COMPS kept comps (excluding the
 * scored row) are UNRATED (score 0, no expected price).
 */
export function classifyGroups(rows: ClassifierRow[]): ClassifyResult[] {
  const results = new Map<number, ClassifyResult>();

  // Rows without a generation or failing isClassifiable are UNRATED outright.
  const scorable: ClassifierRow[] = [];
  for (const r of rows) {
    if (!r.generation || !isClassifiable(r)) {
      results.set(r.id, UNRATED_RESULT(r.id));
      continue;
    }
    scorable.push(r);
  }

  const expectedRows: ExpectedPriceRow[] = scorable.map((r) => ({
    id: r.id,
    model: r.model!,
    generation: r.generation!,
    price: r.priceNumeric!,
    age: r.age ?? new Date().getFullYear() - r.year!,
    km: r.mileageKm!,
    powerKw: r.powerKw,
    fuelType: r.fuelType,
    transmission: r.transmission,
  }));

  const predictions = computeExpectedPrices(expectedRows);
  const byId = new Map(predictions.map((p) => [p.id, p]));

  for (const r of scorable) {
    const pred = byId.get(r.id)!;
    if (pred.expectedPrice === null) {
      results.set(r.id, UNRATED_RESULT(r.id));
    } else {
      results.set(
        r.id,
        scoreRow(r.id, pred.expectedPrice, r.priceNumeric!, pred.sampleSize),
      );
    }
  }

  return [...results.values()];
}

@Injectable()
export class DealClassifierService {
  private readonly logger = new Logger(DealClassifierService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Classify listings in the database (v2): model+generation comps —
   * per-group median ask adjusted to each row's odometer by a Theil-Sen
   * km slope, then % deviation → 5-tier label + 0-100 absolute score.
   * When `limit` is given, only the `limit` most recently scraped listings
   * are classified (useful for fast e2e smoke tests); otherwise all rows
   * are re-labeled in place so stale labels from a previous pass are cleared.
   * @returns Number of classified listings
   */
  async classifyDeals(limit?: number): Promise<number> {
    this.logger.log('Starting deal classification...');

    // Fetch ALL listings by default: rows whose price turned non-numeric (e.g.
    // "Price on request") must still be re-labeled in place — otherwise
    // they keep a stale GREAT/GOOD label from a previous pass.
    // With a limit, fetch only the most recently scraped `limit` rows.
    const listings = await this.prismaService.listing.findMany({
      take: limit,
      orderBy: limit ? { scrapedAt: 'desc' } : undefined,
    });

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

    const unrated = results.filter((r) => r.dealType === 'UNRATED').length;
    this.logger.log(
      `Unrated ${unrated}/${results.length} listings ` +
        `(unresolved generation, missing price/km/year, or group below ${EXPECTED_PRICE_MIN_COMPS} comps)`,
    );

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
