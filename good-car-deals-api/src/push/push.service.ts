import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

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
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly subsFile: string;
  private subscriptions: PushSubscription[] = [];
  private readonly vapid: {
    publicKey: string;
    privateKey: string;
    email: string;
  } | null = null;

  constructor(private readonly configService: ConfigService) {
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

    this.subsFile = join(process.cwd(), 'data', 'push-subscriptions.json');
    this.loadSubs();
  }

  subscriptionCount(): number {
    return this.subscriptions.length;
  }

  isConfigured(): boolean {
    return this.vapid !== null;
  }

  subscribe(subscription: PushSubscription): void {
    const exists = this.subscriptions.some(
      (s) => s.endpoint === subscription.endpoint,
    );
    if (!exists) {
      this.subscriptions.push(subscription);
      this.saveSubs();
      this.logger.log(
        `Push subscription stored (${this.subscriptions.length} total)`,
      );
    }
  }

  async notifyNewAd(ad: {
    id: string;
    title: string;
    price: string | null;
    published: string | null;
    link: string | null;
  }): Promise<void> {
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
    } catch (error) {
      const err = error as { statusCode?: number; message?: string };
      if (err.statusCode === 410 || err.statusCode === 404) {
        this.subscriptions = this.subscriptions.filter(
          (s) => s.endpoint !== sub.endpoint,
        );
        this.saveSubs();
        this.logger.log(`Removed expired push subscription ${sub.endpoint}`);
      } else {
        this.logger.error(`Push send failed: ${err.message ?? String(error)}`);
      }
    }
  }

  private loadSubs(): void {
    try {
      if (existsSync(this.subsFile)) {
        const data: unknown = JSON.parse(readFileSync(this.subsFile, 'utf-8'));
        if (Array.isArray(data)) {
          for (const s of data) {
            if (s && typeof s === 'object' && 'endpoint' in s && 'keys' in s) {
              this.subscriptions.push(s as PushSubscription);
            }
          }
          this.logger.log(
            `Loaded ${this.subscriptions.length} push subscriptions`,
          );
        }
      }
    } catch {
      // corrupt file -> start fresh
    }
  }

  private saveSubs(): void {
    try {
      const dir = this.subsFile.slice(0, this.subsFile.lastIndexOf('/'));
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.subsFile, JSON.stringify(this.subscriptions));
    } catch (error) {
      this.logger.error(
        `Failed to persist push subscriptions: ${String(error)}`,
      );
    }
  }
}
