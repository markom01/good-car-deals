import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, Listing } from '../prisma/prisma.service';
import { DealSort } from './deals.controller';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (dealType starts with "GOOD DEAL"), sorted by the given sort option.
   */
  async getDeals(sort: DealSort = DealSort.SCORE): Promise<Listing[]> {
    this.logger.log(`Fetching good deals sorted by ${sort}`);

    const orderBy =
      sort === DealSort.PRICE_PER_YEAR
        ? { pricePerYear: 'asc' as const }
        : [{ dealScore: 'desc' as const }, { pricePerYear: 'asc' as const }];

    return this.prismaService.listing.findMany({
      where: {
        dealType: { startsWith: 'GOOD DEAL' },
        year: { not: null },
        title: { not: '' },
        mileageKm: { not: null },
      },
      orderBy,
    });
  }
}
