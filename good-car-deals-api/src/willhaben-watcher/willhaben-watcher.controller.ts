import { Controller, Get, Post } from '@nestjs/common';
import { WillhabenWatcherService } from './willhaben-watcher.service';

@Controller('willhaben-watcher')
export class WillhabenWatcherController {
  constructor(private readonly service: WillhabenWatcherService) {}

  @Get('status')
  status() {
    return { ok: true };
  }

  @Post('poll')
  async poll() {
    return this.service.poll();
  }
}
