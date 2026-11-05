import { Controller, Get, Post } from '@nestjs/common';
import { DealWatcherService } from './deal-watcher.service';

@Controller('deal-watcher')
export class DealWatcherController {
  constructor(private readonly service: DealWatcherService) {}

  @Get('status')
  status() {
    return { ok: true };
  }

  @Post('poll')
  async poll() {
    return this.service.poll();
  }
}
