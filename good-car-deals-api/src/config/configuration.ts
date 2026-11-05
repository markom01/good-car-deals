export interface AppConfig {
  database: string;
  scraper: {
    targetUrl: string;
    cronSchedule: string;
    /** Unused since the scrape went site-wide. */
    brand?: string;
    model?: string;
    proxyUrl?: string;
  };
  push: {
    vapidPublicKey?: string;
    vapidPrivateKey?: string;
    vapidEmail?: string;
    enabled: boolean;
  };
  dealWatcher: {
    enabled: boolean;
    pollIntervalMs: number;
  };
  dealWatcherNewWindowHours: number;
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
  push: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidEmail: process.env.VAPID_EMAIL,
    enabled: process.env.PUSH_ENABLED === 'true',
  },
  dealWatcher: {
    enabled: process.env.DEAL_WATCHER_ENABLED === 'true',
    pollIntervalMs: Number(process.env.DEAL_WATCHER_POLL_INTERVAL_MS ?? 600000),
  },
  dealWatcherNewWindowHours: Number(process.env.NEW_LISTING_WINDOW_HOURS ?? 1),
});
