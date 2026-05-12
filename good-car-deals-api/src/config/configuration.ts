export interface AppConfig {
  database: string;
  scraper: {
    targetUrl: string;
    cronSchedule: string;
    brand: string;
    model: string;
    proxyUrl?: string;
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
});
