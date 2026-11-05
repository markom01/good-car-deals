import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DealsPage, Listing } from '@good-car-deals/shared';
import { normalizePlateOrigin } from '../utils/normalization';
import { resolveGeneration } from '../analysis/generation-resolver';
import { DealSort } from './deals.controller';

/** How long a listing counts as "new" after it was first saved (default 1h). */
const NEW_LISTING_WINDOW_HOURS =
  Number(process.env.NEW_LISTING_WINDOW_HOURS) || 1;
const NEW_LISTING_WINDOW_MS = NEW_LISTING_WINDOW_HOURS * 3_600_000;

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (v2 gate: dealType GREAT DEAL or GOOD DEAL), sorted
   * by the given sort option, paginated.
   *
   * `expectedPrice` and `deviationPct` are read straight from the row: the
   * classifier already persisted the property-based expected price and its
   * comparable count. Display recomputes nothing, so the card always matches
   * the stored score.
   *
   * `generation` is still resolved per row from the offline artifact for the
   * card description; a year ambiguous between two generations yields `null`.
   *
   * Foreign-plate imports ("Strane tablice") are excluded: their ask excludes
   * Serbian import duty, VAT and registration, so they are not comparable to
   * domestic cars. They are skipped during scraping (never reach the DB) and
   * filtered out here, so `/deals` returns domestic-only listings.
   */
  async getDeals(
    sort: DealSort = DealSort.SCORE,
    page: number = 1,
    pageSize: number = 50,
    isNew: boolean = false,
  ): Promise<DealsPage> {
    this.logger.log(
      `Fetching deals (GREAT/GOOD) sorted by ${sort}, page ${page}/${pageSize}${
        isNew ? ' (new only)' : ''
      }`,
    );

    const skip = (page - 1) * pageSize;

    const orderBy =
      sort === DealSort.PRICE_PER_YEAR
        ? { pricePerYear: 'asc' as const }
        : [{ dealScore: 'desc' as const }, { pricePerYear: 'asc' as const }];

    const where: Record<string, unknown> = {
      dealType: { in: ['GREAT DEAL', 'GOOD DEAL'] },
      year: { not: null },
      title: { not: '' },
      mileageKm: { not: null },
      // Exclude foreign-plate imports ("Strane tablice"): their ask excludes
      // Serbian import duty, VAT and registration, so they are not
      // comparable to domestic cars. Keep domestic-tagged rows plus rows
      // with unknown plate origin.
      OR: [{ plateOrigin: 'domestic' }, { plateOrigin: null }],
    };

    if (isNew) {
      const cutoff = new Date(Date.now() - NEW_LISTING_WINDOW_MS);
      where.scrapedAt = { gte: cutoff };
    }

    const [listings, total] = await Promise.all([
      this.prismaService.listing.findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
      this.prismaService.listing.count({ where }),
    ]);

    const windowMs = isNew ? NEW_LISTING_WINDOW_MS : 0;

    return {
      data: listings.map((listing) => {
        const generation =
          listing.model !== null
            ? resolveGeneration(listing.model, listing.year)
            : null;
        const scrapedAt = listing.scrapedAt;

        return {
          ...listing,
          id: Number(listing.id),
          scrapedAt: listing.scrapedAt.toISOString(),
          updatedAt: listing.updatedAt.toISOString(),
          priceNumeric:
            listing.priceNumeric !== null ? Number(listing.priceNumeric) : null,
          generation,
          plateOrigin: normalizePlateOrigin(listing.plateOrigin),
          isNew: isNew
            ? scrapedAt >= new Date(Date.now() - windowMs)
            : undefined,
        };
      }),
      total,
      page,
      pageSize,
    };
  }
}
