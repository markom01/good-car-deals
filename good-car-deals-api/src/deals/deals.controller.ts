import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
import { DealsService } from './deals.service';
import { PrismaService } from '../prisma/prisma.service';
import { DealsPage, Listing } from '@good-car-deals/shared';

export enum DealSort {
  SCORE = 'score',
  PRICE_PER_YEAR = 'pricePerYear',
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 3000;

@Controller('deals')
export class DealsController {
  constructor(
    private readonly dealsService: DealsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async getDeals(
    @Query(
      'sort',
      new DefaultValuePipe(DealSort.SCORE),
      new ParseEnumPipe(DealSort),
    )
    sort: DealSort,
    @Query('page', new DefaultValuePipe(1), new ParseIntPipe()) page: number,
    @Query(
      'pageSize',
      new DefaultValuePipe(DEFAULT_PAGE_SIZE),
      new ParseIntPipe(),
    )
    pageSize: number,
    @Query('new', new DefaultValuePipe(false), new ParseBoolPipe())
    isNew: boolean,
  ): Promise<DealsPage> {
    const safePage = Math.max(1, page);
    const safePageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSize));
    return this.dealsService.getDeals(sort, safePage, safePageSize, isNew);
  }

  /**
   * Delete pre-fix unregistered-import leaks so the watcher re-saves them
   * with the correct plateOrigin=foreign classification.
   * POST /deals/cleanup with { urls: [...] }
   */
  @Post('cleanup')
  async cleanup(@Body('urls') urls: string[]): Promise<{ deleted: number }> {
    let n = 0;
    for (const url of urls) {
      const r = await this.prisma.listing.deleteMany({
        where: { listingUrl: url },
      });
      n += r.count;
      const adId = url.split('/auto-oglasi/')[1]?.split('/')[0];
      if (adId) {
        await this.prisma.seenPolovniAd.deleteMany({ where: { id: adId } });
      }
    }
    return { deleted: n };
  }
}
