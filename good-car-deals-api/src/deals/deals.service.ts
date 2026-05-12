import { Injectable, Logger } from '@nestjs/common';
import { PrismaService, Listing } from '../prisma/prisma.service';

@Injectable()
export class DealsService {
  private readonly logger = new Logger(DealsService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Get all deals sorted by price_per_year ascending (best deals first).
   */
  async getDeals(): Promise<Listing[]> {
    this.logger.log('Fetching deals with year, title, and mileageKm');
    return this.prismaService.listing.findMany({
      where: {
        year: { not: null },
        title: { not: '' },
        mileageKm: { not: null },
      },
      orderBy: { pricePerYear: 'asc' },
    });
  }
}
