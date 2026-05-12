import { Controller, Get } from '@nestjs/common';
import { DealsService } from './deals.service';
import { Listing } from '../prisma/prisma.service';

@Controller('deals')
export class DealsController {
  constructor(private readonly dealsService: DealsService) {}

  @Get()
  async getDeals(): Promise<Listing[]> {
    return this.dealsService.getDeals();
  }
}
