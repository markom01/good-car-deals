import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { CronService } from './scraper/cron.service';
import { DealClassifierService } from './analysis/deal-classifier.service';
import { PrismaService } from './prisma/prisma.service';

// BigInt is not serializable by JSON.stringify by default.
// Prisma uses BigInt for auto-increment IDs, so we need to convert to number for JSON responses.

(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);
    app.use(helmet());
    // CORS_ORIGIN: comma-separated allowlist (e.g. the Vercel frontend).
    // Unset → allow all origins (public read-only API).
    const corsOrigin = process.env.CORS_ORIGIN?.split(',').map((s) => s.trim());
    app.enableCors({ origin: corsOrigin ?? true });

    const prismaService = app.get(PrismaService);
    const cronService = app.get(CronService);

    // ── Scrape-only mode (used by GitHub Action) ──────────────
    // Run: node dist/src/main.js --scrape
    if (process.argv.includes('--scrape')) {
      console.log('Scrape-only mode: clearing old listings...');
      await prismaService.listing.deleteMany({});
      console.log('Running scrape...');
      await cronService.handleWeeklyScrape();
      console.log('Scrape complete');
      await prismaService.$disconnect();
      process.exit(0);
    }

    // ── Classify-only mode (backfill / post-deploy relabel) ──────
    // Run: node dist/src/main.js --classify
    if (process.argv.includes('--classify')) {
      console.log('Classify-only mode: re-classifying listings in place...');
      const dealClassifierService = app.get(DealClassifierService);
      const n = await dealClassifierService.classifyDeals();
      console.log(`Classified ${n}`);
      await prismaService.$disconnect();
      process.exit(0);
    }

    // ── Normal server startup ─────────────────────────────────
    await app.listen(process.env.PORT ?? 3001);
    console.log('Server listening on port', process.env.PORT ?? 3001);

    // Skip initial scrape if SKIP_STARTUP_SCRAPE is set
    // (GitHub Action handles scraping instead)
    if (process.env.SKIP_STARTUP_SCRAPE === 'true') {
      console.log('SKIP_STARTUP_SCRAPE set — skipping initial scrape');
      return;
    }

    // Run initial scrape in background (non-blocking)
    console.log('Clearing old listings...');
    const deleted = await prismaService.listing.deleteMany({});
    console.log(`Deleted ${deleted.count} old listings`);

    console.log('Running initial scrape...');
    await cronService.handleWeeklyScrape();
    console.log('Initial scrape complete');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

void bootstrap();
