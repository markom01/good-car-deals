import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Listing } from '@good-car-deals/shared';
import { DealSort } from './deals.controller';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (dealType starts with "GOOD DEAL"), sorted by the given sort option,
   * with per-model average priceNumeric and per-listing percentage from that average.
   */
  async getDeals(sort: DealSort = DealSort.SCORE): Promise<Listing[]> {
    this.logger.log(`Fetching good deals sorted by ${sort}`);

    const orderBy =
      sort === DealSort.PRICE_PER_YEAR
        ? { pricePerYear: 'asc' as const }
        : [{ dealScore: 'desc' as const }, { pricePerYear: 'asc' as const }];

    const listings = await this.prismaService.listing.findMany({
      where: {
        dealType: { startsWith: 'GOOD DEAL' },
        year: { not: null },
        title: { not: '' },
        mileageKm: { not: null },
      },
      orderBy,
    });

    // Compute per-model average priceNumeric via groupBy
    const modelAverages = await this.prismaService.listing.groupBy({
      by: ['model'],
      where: {
        model: { not: null },
        priceNumeric: { not: null },
        dealType: { startsWith: 'GOOD DEAL' },
      },
      _avg: { priceNumeric: true },
      _count: { model: true },
    });

    // Build map: model -> average price (only models with 2+ listings)
    const modelAvgMap = new Map<string, number>();
    for (const entry of modelAverages) {
      if (
        entry.model &&
        entry._count.model >= 2 &&
        entry._avg.priceNumeric !== null
      ) {
        modelAvgMap.set(entry.model, Number(entry._avg.priceNumeric));
      }
    }

    // Attach average and percentage to each listing
    return listings.map((listing) => {
      const modelAvg =
        listing.model !== null
          ? modelAvgMap.get(listing.model) ?? null
          : null;

      let pct: number | null = null;
      if (modelAvg !== null && modelAvg !== 0 && listing.priceNumeric !== null) {
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
          listing.priceNumeric !== null
            ? Number(listing.priceNumeric)
            : null,
        modelAvgPriceNumeric: modelAvg,
        priceToModelAvgPct: pct,
      };
    });
  }
}
