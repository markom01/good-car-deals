import {
  Controller,
  DefaultValuePipe,
  Get,
  ParseBoolPipe,
  ParseEnumPipe,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { DealsService } from './deals.service';
import { DealsPage, Listing } from '@good-car-deals/shared';

export enum DealSort {
  SCORE = 'score',
  PRICE_PER_YEAR = 'pricePerYear',
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 3000;

@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

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
}
