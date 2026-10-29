import {
  Controller,
  Post,
  Body,
  Get,
  BadRequestException,
} from '@nestjs/common';
import { PushService } from './push.service';

type PushSubscriptionBody = unknown;

function isPushSubscription(body: unknown): body is {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
} {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const keys = b.keys as Record<string, unknown> | null;
  return (
    typeof b.endpoint === 'string' &&
    typeof keys === 'object' &&
    keys !== null &&
    typeof keys.p256dh === 'string' &&
    typeof keys.auth === 'string'
  );
}

@Controller('push')
export class PushController {
  constructor(private readonly service: PushService) {}

  @Post('subscribe')
  async subscribe(@Body() subscription: PushSubscriptionBody) {
    if (!isPushSubscription(subscription)) {
      throw new BadRequestException('Invalid push subscription');
    }
    await this.service.subscribe(subscription);
    return { ok: true };
  }

  @Post('test')
  async test() {
    await this.service.notifyNewAd({
      id: 'test',
      title: 'Test push — willhaben watcher is working',
      price: null,
      published: null,
      link: null,
    });
    return {
      ok: true,
      configured: this.service.isConfigured(),
      subscriptions: this.service.subscriptionCount(),
    };
  }

  @Get('status')
  status() {
    return {
      configured: this.service.isConfigured(),
      subscriptions: this.service.subscriptionCount(),
    };
  }
}
