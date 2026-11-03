import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Listing } from '@good-car-deals/shared';
import { normalizePlateOrigin } from '../utils/normalization';
import { resolveGeneration } from '../analysis/generation-resolver';
import { DealSort } from './deals.controller';

/** Minimum rated rows before a generation average is shown. */
const MIN_GROUP_SIZE = 3;

const GROUP_KEY_SEPARATOR = '\u0000';

const median = (prices: number[]): number => {
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (v2 gate: dealType GREAT DEAL or GOOD DEAL), sorted
   * by the given sort option, with the flat average expected price of the
   * listing's own generation (every year of that generation, no year window)
   * and the listing's percentage deviation from it.
   *
   * Grouping follows `resolveGeneration`, the same unit the classifier fits.
   * A row whose year is ambiguous between two generations resolves to `null`
   * and shows no average at all — a model-wide number would mix generations.
   *
   * Foreign-plate imports ("Strane tablice") are excluded: their ask excludes
   * Serbian import duty, VAT and registration, so they are not comparable to
   * domestic cars. They are skipped during scraping (never reach the DB) and
   * filtered out here, so `/deals` returns domestic-only listings.
   */
  async getDeals(sort: DealSort = DealSort.SCORE): Promise<Listing[]> {
    this.logger.log(`Fetching deals (GREAT/GOOD) sorted by ${sort}`);

    const orderBy =
      sort === DealSort.PRICE_PER_YEAR
        ? { pricePerYear: 'asc' as const }
        : [{ dealScore: 'desc' as const }, { pricePerYear: 'asc' as const }];

    const listings = await this.prismaService.listing.findMany({
      where: {
        dealType: { in: ['GREAT DEAL', 'GOOD DEAL'] },
        year: { not: null },
        title: { not: '' },
        mileageKm: { not: null },
        // Exclude foreign-plate imports ("Strane tablice"): their ask excludes
        // Serbian import duty, VAT and registration, so they are not
        // comparable to domestic cars. Keep domestic-tagged rows plus rows
        // with unknown plate origin.
        OR: [{ plateOrigin: 'domestic' }, { plateOrigin: null }],
      },
      orderBy,
    });

    // Pool every rated row by generation. Tier-agnostic on purpose: a good
    // deal is compared against the whole market, not against other deals.
    // Foreign-plate rows are excluded so the benchmark stays domestic-only.
    const poolRows = await this.prismaService.listing.findMany({
      where: {
        model: { not: null },
        expectedPrice: { not: null },
        year: { not: null },
        OR: [{ plateOrigin: 'domestic' }, { plateOrigin: null }],
      },
      select: { model: true, year: true, expectedPrice: true },
    });

    const poolsByGeneration = new Map<string, number[]>();
    for (const p of poolRows) {
      const generation = resolveGeneration(p.model, p.year);
      if (generation === null) continue;
      const key = `${p.model!}${GROUP_KEY_SEPARATOR}${generation}`;
      const pool = poolsByGeneration.get(key);
      if (pool) pool.push(p.expectedPrice!);
      else poolsByGeneration.set(key, [p.expectedPrice!]);
    }

    return listings.map((listing) => {
      const generation =
        listing.model !== null
          ? resolveGeneration(listing.model, listing.year)
          : null;

      let generationAvg: number | null = null;
      let generationMedian: number | null = null;
      if (generation !== null && listing.model !== null) {
        const pool =
          poolsByGeneration.get(
            `${listing.model}${GROUP_KEY_SEPARATOR}${generation}`,
          ) ?? [];
        if (pool.length >= MIN_GROUP_SIZE) {
          generationAvg =
            pool.reduce((sum, price) => sum + price, 0) / pool.length;
          generationMedian = median(pool);
        }
      }

      // Deviation is measured against the generation median so the badge and
      // the "compared to generation median of €X" line stay consistent.
      let pct: number | null = null;
      if (
        generationMedian !== null &&
        generationMedian !== 0 &&
        listing.priceNumeric !== null
      ) {
        pct = Math.round(
          ((Number(listing.priceNumeric) - generationMedian) /
            generationMedian) *
            100,
        );
      }

      return {
        ...listing,
        id: Number(listing.id),
        scrapedAt: listing.scrapedAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
        priceNumeric:
          listing.priceNumeric !== null ? Number(listing.priceNumeric) : null,
        generation,
        generationAvgPriceNumeric: generationAvg,
        generationMedianPriceNumeric: generationMedian,
        priceToGenerationAvgPct: pct,
        plateOrigin: normalizePlateOrigin(listing.plateOrigin),
      };
    });
  }
}
