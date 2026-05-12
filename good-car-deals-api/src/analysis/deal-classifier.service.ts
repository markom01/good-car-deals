import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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
  scrapedAt: Date;
  updatedAt: Date;
}

@Injectable()
export class DealClassifierService {
  private readonly logger = new Logger(DealClassifierService.name);

  constructor(private prismaService: PrismaService) {}

  /**
   * Classify all listings in the database using two methods:
   * 1. Price-per-year ranking (top 20% = GOOD DEAL, middle 30% = DECENT DEAL, bottom 20% = OVERPRICED)
   * 2. Market average comparison (<80% of model avg = GOOD DEAL, <95% = DECENT DEAL)
   * @returns Number of classified listings
   */
  async classifyDeals(): Promise<number> {
    this.logger.log('Starting deal classification...');

    // Fetch all listings from database
    const listings = await this.prismaService.listing.findMany({
      where: {
        priceNumeric: { not: null },
        year: { not: null },
      },
    });

    if (listings.length === 0) {
      this.logger.warn('No listings found to classify');
      return 0;
    }

    this.logger.log(`Found ${listings.length} listings to classify`);

    // Calculate price_per_year for each listing (dynamic year calculation)
    const listingsWithPricePerYear = listings.map((listing) => {
      const pricePerYear = this.calculatePricePerYear(
        Number(listing.priceNumeric!),
        listing.year!,
      );
      return {
        ...listing,
        pricePerYear,
        model: this.extractModel(listing.title),
      };
    });

    // Calculate model averages (need 3+ listings for validity)
    const modelAverages = this.calculateModelAverages(listingsWithPricePerYear);

    // Sort by price_per_year ascending (lower = better deal)
    const sortedListings = [...listingsWithPricePerYear].sort((a, b) => {
      if (a.pricePerYear === null && b.pricePerYear === null) return 0;
      if (a.pricePerYear === null) return 1;
      if (b.pricePerYear === null) return -1;
      return a.pricePerYear - b.pricePerYear;
    });

    // Get valid listings (non-null price_per_year)
    const validListings = sortedListings.filter((l) => l.pricePerYear !== null);
    const totalValid = validListings.length;

    if (totalValid === 0) {
      this.logger.warn('No valid listings with price_per_year to classify');
      return 0;
    }

    // Calculate thresholds
    const goodThreshold = Math.floor(totalValid * 0.2); // Top 20%
    const decentThreshold = Math.floor(totalValid * 0.5); // Top 50%

    this.logger.log(
      `Classification thresholds: good <= ${goodThreshold}, decent <= ${decentThreshold}`,
    );

    // Classify each listing
    const updates: Promise<unknown>[] = [];

    for (let i = 0; i < sortedListings.length; i++) {
      const listing = sortedListings[i];
      const { dealType, dealScore } = this.classifyListing(
        listing,
        i,
        goodThreshold,
        decentThreshold,
        modelAverages,
      );

      updates.push(
        this.prismaService.listing.update({
          where: { id: listing.id },
          data: {
            dealType,
            dealScore,
            pricePerYear: listing.pricePerYear,
            model: listing.model,
          },
        }),
      );
    }

    // Execute all updates
    await Promise.all(updates);

    this.logger.log(
      `Classification complete. Classified ${updates.length} listings`,
    );

    // Print summary
    const summary = await this.getClassificationSummary();
    this.logger.log(
      `Summary: GOOD DEAL: ${summary.goodDeals}, DECENT DEAL: ${summary.decentDeals}, ` +
        `OVERPRICED: ${summary.overpriced}, INSUFFICIENT DATA: ${summary.insufficientData}`,
    );

    return updates.length;
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
   * Extract model from title (first 2 words)
   */
  private extractModel(title: string): string {
    if (!title) return 'Unknown';

    const words = title.trim().split(/\s+/);
    if (words.length < 2) {
      return words[0] || 'Unknown';
    }

    // First two words: "Brand Model" -> "Brand Model"
    return `${words[0]} ${words[1]}`;
  }

  /**
   * Calculate average price_per_year per model (need 3+ listings for validity)
   */
  private calculateModelAverages(
    listings: Array<{ model: string | null; pricePerYear: number | null }>,
  ): Map<string, number> {
    const modelStats = new Map<string, { total: number; count: number }>();

    for (const listing of listings) {
      if (
        !listing.model ||
        listing.model === 'Unknown' ||
        !listing.pricePerYear
      ) {
        continue;
      }

      const existing = modelStats.get(listing.model) || { total: 0, count: 0 };
      modelStats.set(listing.model, {
        total: existing.total + listing.pricePerYear,
        count: existing.count + 1,
      });
    }

    // Calculate averages (only if 3+ listings)
    const averages = new Map<string, number>();
    for (const [model, stats] of modelStats) {
      if (stats.count >= 3) {
        averages.set(
          model,
          Math.round((stats.total / stats.count) * 100) / 100,
        );
      }
    }

    this.logger.log(
      `Model averages calculated for ${averages.size} models (with 3+ listings)`,
    );

    return averages;
  }

  /**
   * Classify a single listing using both methods
   */
  private classifyListing(
    listing: { model: string | null; pricePerYear: number | null },
    index: number,
    goodThreshold: number,
    decentThreshold: number,
    modelAverages: Map<string, number>,
  ): { dealType: string; dealScore: number } {
    // Handle insufficient data
    if (listing.pricePerYear === null) {
      return {
        dealType: 'INSUFFICIENT DATA',
        dealScore: 0,
      };
    }

    // Method 1: Price-per-year ranking
    let method1: string;
    if (index < goodThreshold) {
      method1 = 'GOOD DEAL';
    } else if (index < decentThreshold) {
      method1 = 'DECENT DEAL';
    } else {
      method1 = 'OVERPRICED';
    }

    // Method 2: Market average comparison (overrides if better)
    if (
      listing.model &&
      listing.model !== 'Unknown' &&
      modelAverages.has(listing.model)
    ) {
      const modelAvg = modelAverages.get(listing.model)!;

      if (listing.pricePerYear < 0.8 * modelAvg) {
        return {
          dealType: 'GOOD DEAL (Market)',
          dealScore: this.calculateDealScore(listing.pricePerYear),
        };
      } else if (listing.pricePerYear < 0.95 * modelAvg) {
        return {
          dealType: 'DECENT DEAL (Market)',
          dealScore: this.calculateDealScore(listing.pricePerYear),
        };
      }
    }

    return {
      dealType: method1,
      dealScore: this.calculateDealScore(listing.pricePerYear),
    };
  }

  /**
   * Calculate deal score: max(0, 100 - price_per_year / 100)
   */
  private calculateDealScore(pricePerYear: number): number {
    if (pricePerYear === null) return 0;
    return Math.max(0, Math.round(100 - pricePerYear / 100));
  }

  /**
   * Get classification summary from database
   */
  async getClassificationSummary(): Promise<{
    goodDeals: number;
    decentDeals: number;
    overpriced: number;
    insufficientData: number;
  }> {
    const allListings = await this.prismaService.listing.findMany({
      select: { dealType: true },
    });

    return {
      goodDeals: allListings.filter((l) => l.dealType?.startsWith('GOOD DEAL'))
        .length,
      decentDeals: allListings.filter((l) =>
        l.dealType?.startsWith('DECENT DEAL'),
      ).length,
      overpriced: allListings.filter((l) => l.dealType === 'OVERPRICED').length,
      insufficientData: allListings.filter(
        (l) => l.dealType === 'INSUFFICIENT DATA',
      ).length,
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
