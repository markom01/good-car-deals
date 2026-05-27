import { Controller, DefaultValuePipe, Get, ParseEnumPipe, Query } from '@nestjs/common';
import { DealsService } from './deals.service';
import { Listing } from '@good-car-deals/shared';

export enum DealSort {
  SCORE = 'score',
  PRICE_PER_YEAR = 'pricePerYear',
}

@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  async getDeals(
    @Query('sort', new DefaultValuePipe(DealSort.SCORE), new ParseEnumPipe(DealSort))
    sort: DealSort,
  ): Promise<Listing[]> {
    return this.dealsService.getDeals(sort);
  }
}
