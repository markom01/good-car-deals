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
  buildFitSnapshot,
  computeExpectedPrices,
  predictFromSnapshot,
  type ExpectedPriceRow,
  type FitSnapshot,
  EXPECTED_PRICE_MIN_COMPS,
} from './expected-price';

/** JSON value compatible with Prisma's `Json` column type. */
type JsonValue =
  string | number | boolean | { [key: string]: JsonValue | null } | JsonValue[];

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
  expectedPriceSampleSize: number | null;
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
   * Classify all listings in the database: property-based expected price per
   * row (group = model + resolved generation, fit once per pass), then % deviation
   * → 5-tier label + 0-100 absolute score. Always re-labels every row in place
   * so stale labels from a previous pass are cleared.
   * @returns Number of classified listings
   */
  async classifyDeals(): Promise<number> {
    this.logger.log('Starting deal classification...');

    // Fetch ALL listings ordered by id so classification is deterministic.
    // Rows whose price turned non-numeric (e.g. "Price on request") must still
    // be re-labeled in place — otherwise they keep a stale GREAT/GOOD label
    // from a previous pass.
    const listings = await this.prismaService.listing.findMany({
      orderBy: { id: 'asc' },
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
        `(unresolved generation, missing price/km/year, or group below ${EXPECTED_PRICE_MIN_COMPS} comps excluding the row)`,
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
              expectedPriceSampleSize: r.sampleSize,
              pricePerYear: pricePerYearById.get(r.id) ?? null,
            },
          }),
        ),
      );
      this.logger.log(
        `Persisted classification ${Math.min(i + UPDATE_BATCH_SIZE, results.length)}/${results.length}`,
      );
    }

    // Persist a fit snapshot so incremental rows can be scored without a refit.
    // Fit on the same rows `classifyGroups` scored (classifiable, resolved
    // generation) so the snapshot reproduces this pass exactly.
    const snapshotFitRows = rows
      .filter((r) => r.generation !== null && isClassifiable(r))
      .map((r) => ({
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
    const scorePool = results
      .filter((r) => r.dealType !== 'UNRATED')
      .map((r) => r.deviationPct!)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const payload: JsonValue = buildFitSnapshot({
      fitRows: snapshotFitRows,
      scorePool,
    }) as unknown as JsonValue;
    try {
      await this.prismaService.classificationSnapshot.deleteMany({});
      await this.prismaService.classificationSnapshot.create({
        data: { payload },
      });
      this.logger.log('Persisted classification snapshot');
    } catch (error) {
      this.logger.error(
        'Failed to persist classification snapshot',
        error instanceof Error ? error : String(error),
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
   * Score already-saved listings against the latest persisted fit snapshot,
   * without refitting. One ClassifyResult per input row, in the same order.
   * Rows stay UNRATED when no usable snapshot exists.
   */
  async scoreNewRows(rows: ClassifierRow[]): Promise<ClassifyResult[]> {
    const latest = await this.prismaService.classificationSnapshot.findFirst({
      orderBy: { id: 'desc' },
    });

    let snapshot: FitSnapshot | null = null;
    if (latest?.payload) {
      try {
        snapshot = latest.payload as unknown as FitSnapshot;
        if (
          snapshot.version !== 1 ||
          !Array.isArray(snapshot.beta) ||
          typeof snapshot.groups !== 'object' ||
          snapshot.groups === null ||
          typeof snapshot.globalSum !== 'number'
        ) {
          throw new Error('malformed snapshot payload');
        }
      } catch (error) {
        this.logger.warn(
          'Classification snapshot is missing or malformed; new rows stay unclassified',
          error,
        );
        snapshot = null;
      }
    }

    if (!snapshot) {
      this.logger.warn(
        'No classification snapshot exists; new rows stay unclassified until classifyDeals runs',
      );
      return rows.map((r) => UNRATED_RESULT(r.id));
    }

    const results: ClassifyResult[] = [];
    for (const r of rows) {
      const generation = resolveGeneration(r.model, r.year);
      if (!generation) {
        results.push(UNRATED_RESULT(r.id));
        continue;
      }
      const expectedRows: ExpectedPriceRow[] = [
        {
          id: r.id,
          model: r.model!,
          generation,
          price: r.priceNumeric!,
          age: r.age ?? new Date().getFullYear() - r.year!,
          km: r.mileageKm!,
          powerKw: r.powerKw,
          fuelType: r.fuelType,
          transmission: r.transmission,
        },
      ];
      const [pred] = predictFromSnapshot(snapshot, expectedRows);
      if (pred.expectedPrice === null) {
        results.push(UNRATED_RESULT(r.id));
      } else {
        results.push(
          scoreRow(r.id, pred.expectedPrice, r.priceNumeric!, pred.sampleSize),
        );
      }
    }

    // Persist immediately: the watcher relies on deal_type to decide what
    // shows in the "new" feed, so a computed-but-unsaved score is invisible.
    await this.persistScores(rows, results);

    return results;
  }

  private async persistScores(
    rows: ClassifierRow[],
    results: ClassifyResult[],
  ): Promise<void> {
    const rowById = new Map(rows.map((row) => [row.id, row]));
    try {
      await Promise.all(
        results.map((result) => {
          const row = rowById.get(result.id);
          const pricePerYear =
            row && row.priceNumeric !== null && row.year !== null
              ? this.calculatePricePerYear(row.priceNumeric, row.year)
              : null;
          return this.prismaService.listing.update({
            where: { id: BigInt(result.id) },
            data: {
              dealType: result.dealType,
              dealScore: result.dealScore,
              expectedPrice: result.expectedPrice,
              deviationPct: result.deviationPct,
              expectedPriceSampleSize: result.sampleSize,
              pricePerYear,
            },
          });
        }),
      );
    } catch (error) {
      // Scoring stays usable even if the write fails; the next full classify
      // pass repairs the row.
      this.logger.error(
        'Failed to persist incremental classification',
        error instanceof Error ? error : String(error),
      );
    }
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
