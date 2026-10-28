import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  cellMedianExpected,
  classifyTier,
  deviationPct,
  expectedPrice,
  fitLinearPrice,
  percentileScores,
  type TierName,
} from './deal-stats';

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
  const dev = deviationPct(expected, price);
  if (!Number.isFinite(dev)) {
    return UNRATED_RESULT(id);
  }
  // dealScore is provisional here (dev-based); classifyGroups overwrites it
  // with the market percentile across ALL rated rows before returning.
  return {
    id,
    dealType: classifyTier(dev),
    dealScore: 0,
    expectedPrice: expected,
    deviationPct: dev,
  };
}

/**
 * Pure v2 classification over grouped rows (no Nest, no DB).
 * Per model group: try a per-model OLS fit (IQR trim inside); on fit
 * failure fall back to per-row year±1 / km±20% cell median. Rows without
 * a positive expected price → UNRATED with score 0. Rows trimmed from
 * the fit still get scored. Two model groups never share a fit.
 */
export function classifyGroups(rows: ClassifierRow[]): ClassifyResult[] {
  const results = new Map<number, ClassifyResult>();
  const groups = new Map<string, ClassifierRow[]>();
  for (const r of rows) {
    const key = r.model ?? '';
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

    const fit = fitLinearPrice(
      usable.map((r) => ({
        age: r.age!,
        km: r.mileageKm!,
        price: r.priceNumeric!,
        kw: r.powerKw,
        diesel: r.fuelType === 'Dizel',
        auto: r.transmission === 'Automatic',
      })),
    );

    if (fit) {
      for (const r of usable) {
        const exp = expectedPrice(fit, r.age!, r.mileageKm!, {
          kw: r.powerKw,
          diesel: r.fuelType === 'Dizel',
          auto: r.transmission === 'Automatic',
        });
        results.set(r.id, scoreRow(r.id, exp, r.priceNumeric!));
      }
    } else {
      const cellRows = usable.map((u) => ({
        price: u.priceNumeric!,
        year: u.year!,
        km: u.mileageKm!,
      }));
      for (const r of usable) {
        const exp = cellMedianExpected(cellRows, r.year!, r.mileageKm!);
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

    await Promise.all(
      results.map((r) =>
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
