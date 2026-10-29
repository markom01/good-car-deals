export interface AppConfig {
  database: string;
  scraper: {
    targetUrl: string;
    cronSchedule: string;
    brand: string;
    model: string;
    proxyUrl?: string;
  };
  willhaben: {
    enabled: boolean;
    pollIntervalMs: number;
    filter: string;
  };
  push: {
    vapidPublicKey?: string;
    vapidPrivateKey?: string;
    vapidEmail?: string;
    enabled: boolean;
  };
}

export default (): AppConfig => ({
  database: process.env.DATABASE_URL!,
  scraper: {
    targetUrl: process.env.SCRAPER_TARGET_URL!,
    cronSchedule: process.env.SCRAPER_CRON_SCHEDULE!,
    brand: process.env.SCRAPER_BRAND!,
    model: process.env.SCRAPER_MODEL!,
    proxyUrl: process.env.SCRAPER_PROXY_URL,
  },
  willhaben: {
    enabled: process.env.WILLHABEN_ENABLED === 'true',
    pollIntervalMs: Number(process.env.WILLHABEN_POLL_INTERVAL_MS ?? 5000),
    filter: process.env.WILLHABEN_FILTER ?? '',
  },
  push: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidEmail: process.env.VAPID_EMAIL,
    enabled: process.env.PUSH_ENABLED === 'true',
  },
});
