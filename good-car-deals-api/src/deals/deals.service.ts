import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Listing } from '@good-car-deals/shared';
import { normalizePlateOrigin } from '../utils/normalization';
import { resolveGeneration } from '../analysis/generation-resolver';
import { DealSort } from './deals.controller';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (v2 gate: dealType GREAT DEAL or GOOD DEAL), sorted
   * by the given sort option.
   *
   * `expectedPrice` and `deviationPct` are read straight from the row: the
   * classifier already persisted the generation benchmark (mileage-adjusted
   * per listing) and the deviation from it (positive = ask below benchmark).
   * Display recomputes nothing, so the card always matches the stored score.
   *
   * `generation` is still resolved per row from the offline artifact for the
   * card description; a year ambiguous between two generations yields `null`.
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

    return listings.map((listing) => {
      const generation =
        listing.model !== null
          ? resolveGeneration(listing.model, listing.year)
          : null;

      return {
        ...listing,
        id: Number(listing.id),
        scrapedAt: listing.scrapedAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
        priceNumeric:
          listing.priceNumeric !== null ? Number(listing.priceNumeric) : null,
        generation,
        plateOrigin: normalizePlateOrigin(listing.plateOrigin),
      };
    });
  }
}
