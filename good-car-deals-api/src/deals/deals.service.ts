import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Listing } from '@good-car-deals/shared';
import { DealSort } from './deals.controller';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (v2 gate: dealType GREAT DEAL or GOOD DEAL), sorted
   * by the given sort option, with the per-model pooled expected-price
   * average and per-listing percentage from that average.
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
      },
      orderBy,
    });

    // v2 model-average pool: ALL rows with an expected price (any deal
    // tier, not just good deals), same model, year ±1 of the listing;
    // ≥3 rows in the window required.
    const poolRows = await this.prismaService.listing.findMany({
      where: {
        model: { not: null },
        expectedPrice: { not: null },
        year: { not: null },
      },
      select: { model: true, year: true, expectedPrice: true },
    });

    const poolsByModel = new Map<
      string,
      { year: number; expectedPrice: number }[]
    >();
    for (const p of poolRows) {
      const pool = poolsByModel.get(p.model!);
      const entry = { year: p.year!, expectedPrice: p.expectedPrice! };
      if (pool) pool.push(entry);
      else poolsByModel.set(p.model!, [entry]);
    }

    // Attach average and percentage to each listing
    return listings.map((listing) => {
      let modelAvg: number | null = null;
      if (listing.model !== null && listing.year !== null) {
        const window = (poolsByModel.get(listing.model) ?? []).filter(
          (p) => Math.abs(p.year - listing.year!) <= 1,
        );
        if (window.length >= 3) {
          modelAvg =
            window.reduce((sum, p) => sum + p.expectedPrice, 0) / window.length;
        }
      }

      let pct: number | null = null;
      if (
        modelAvg !== null &&
        modelAvg !== 0 &&
        listing.priceNumeric !== null
      ) {
        pct = Math.round(
          ((Number(listing.priceNumeric) - modelAvg) / modelAvg) * 100,
        );
      }

      return {
        ...listing,
        id: Number(listing.id),
        scrapedAt: listing.scrapedAt.toISOString(),
        updatedAt: listing.updatedAt.toISOString(),
        priceNumeric:
          listing.priceNumeric !== null ? Number(listing.priceNumeric) : null,
        modelAvgPriceNumeric: modelAvg,
        priceToModelAvgPct: pct,
      };
    });
  }
}
