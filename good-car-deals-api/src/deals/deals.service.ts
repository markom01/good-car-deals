import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, Listing } from '../prisma/prisma.service';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get good deals only (dealType starts with "GOOD DEAL"), sorted by deal score descending.
   */
  async getDeals(): Promise<Listing[]> {
    this.logger.log('Fetching good deals');
    return this.prismaService.listing.findMany({
      where: {
        dealType: { startsWith: 'GOOD DEAL' },
        year: { not: null },
        title: { not: '' },
        mileageKm: { not: null },
      },
      orderBy: { dealScore: 'desc' },
    });
  }
}
