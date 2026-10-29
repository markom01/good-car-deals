import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

interface PushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

interface NewAdPayload {
  type: 'new_ad';
  id: string;
  title: string;
  price: string | null;
  published: string | null;
  link: string | null;
  ts: number;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private subscriptions: PushSubscription[] = [];
  private loaded = false;
  private readonly vapid: {
    publicKey: string;
    privateKey: string;
    email: string;
  } | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const publicKey = this.configService.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.configService.get<string>('VAPID_PRIVATE_KEY');
    const email = this.configService.get<string>('VAPID_EMAIL');

    if (publicKey && privateKey && email) {
      webpush.setVapidDetails(email, publicKey, privateKey);
      this.vapid = { publicKey, privateKey, email };
      this.logger.log('Push service configured with VAPID keys');
    } else {
      this.logger.log(
        'Push service disabled: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL not all set',
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.loadSubs();
  }

  subscriptionCount(): number {
    return this.subscriptions.length;
  }

  isConfigured(): boolean {
    return this.vapid !== null;
  }

  async subscribe(subscription: PushSubscription): Promise<void> {
    const exists = this.subscriptions.some(
      (s) => s.endpoint === subscription.endpoint,
    );
    if (exists) return;

    this.subscriptions.push(subscription);
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      update: {
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
      create: {
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      },
    });
    this.logger.log(
      `Push subscription stored (${this.subscriptions.length} total)`,
    );
  }

  async notifyNewAd(ad: {
    id: string;
    title: string;
    price: string | null;
    published: string | null;
    link: string | null;
  }): Promise<void> {
    if (!this.loaded) await this.loadSubs();
    if (!this.vapid || this.subscriptions.length === 0) return;

    const payload: NewAdPayload = {
      type: 'new_ad',
      id: ad.id,
      title: ad.title,
      price: ad.price,
      published: ad.published,
      link: ad.link,
      ts: Date.now(),
    };

    const payloadStr = JSON.stringify(payload);

    await Promise.all(
      this.subscriptions.map((sub) => this.send(sub, payloadStr)),
    );
  }

  private async send(sub: PushSubscription, payload: string): Promise<void> {
    try {
      await webpush.sendNotification(sub, payload, {
        TTL: 60,
        vapidDetails: {
          subject: this.vapid!.email,
          publicKey: this.vapid!.publicKey,
          privateKey: this.vapid!.privateKey,
        },
      });
    } catch (error: unknown) {
      const err = error as {
        statusCode?: number;
        message?: string;
        body?: string;
        headers?: Record<string, string>;
      };
      const statusCode = err.statusCode;
      const body = err.body ?? 'no body';
      const headers = err.headers ?? {};
      this.logger.error(
        `Push send failed: statusCode=${statusCode} message=${err.message ?? String(error)} body=${body} headers=${JSON.stringify(headers)}`,
      );
      if (statusCode === 410 || statusCode === 404 || statusCode === 401) {
        this.subscriptions = this.subscriptions.filter(
          (s) => s.endpoint !== sub.endpoint,
        );
        await this.prisma.pushSubscription.deleteMany({
          where: { endpoint: sub.endpoint },
        });
        this.logger.log(`Removed expired push subscription ${sub.endpoint}`);
      }
    }
  }

  private async loadSubs(): Promise<void> {
    try {
      const rows = await this.prisma.pushSubscription.findMany();
      this.subscriptions = rows.map((s) => ({
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      }));
      this.loaded = true;
      this.logger.log(
        `Loaded ${this.subscriptions.length} push subscriptions from DB`,
      );
    } catch (error) {
      this.logger.error(`Failed to load push subscriptions: ${String(error)}`);
    }
  }
}
