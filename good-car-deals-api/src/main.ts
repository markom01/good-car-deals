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

    // ── Scrape-only mode (used by the local scheduled task) ───
    // Run: node dist/src/main.js --scrape
    // Resumes from the last saved page if a previous run was interrupted.
    if (process.argv.includes('--scrape')) {
      console.log('Running scrape (resumable)...');
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

    // ── Leak cleanup (delete pre-fix rows so the watcher re-saves them) ──
    // Run: node dist/src/main.js --delete-leaks
    if (process.argv.includes('--delete-leaks')) {
      console.log('Deleting pre-fix unregistered-import leaks...');
      const leakUrls = [
        'https://www.polovniautomobili.com/auto-oglasi/30138875/peugeot-308-15-hdi',
        'https://www.polovniautomobili.com/auto-oglasi/30357876/audi-a3-quattro-dsg',
        'https://www.polovniautomobili.com/auto-oglasi/30707170/opel-mokka-cosmo-aut-kam',
        'https://www.polovniautomobili.com/auto-oglasi/30499878/volvo-xc60-moze-zamena',
        'https://www.polovniautomobili.com/auto-oglasi/30609246/peugeot-308-16ehdi-pano-top',
        'https://www.polovniautomobili.com/auto-oglasi/30744938/volkswagen-golf-6-20-tdi-high-line',
        'https://www.polovniautomobili.com/auto-oglasi/30745472/peugeot-2008-15-hdi-allure-nav',
        'https://www.polovniautomobili.com/auto-oglasi/30745470/ford-kuga-20d-titanium-4wd',
        'https://www.polovniautomobili.com/auto-oglasi/30745561/peugeot-3008',
        'https://www.polovniautomobili.com/auto-oglasi/20560520/ford-focus-16tdci',
        'https://www.polovniautomobili.com/auto-oglasi/30745254/volkswagen-passat-b7-20tdi-dsg-holand',
      ];
      let n = 0;
      for (const url of leakUrls) {
        const r = await prismaService.listing.deleteMany({
          where: { listingUrl: url },
        });
        n += r.count;
        // Also drop the seen-tracking row so the watcher re-saves it.
        // seenPolovniAd uses adId (the numeric part of the URL).
        const adId = url.split('/auto-oglasi/')[1]?.split('/')[0];
        if (adId) {
          await prismaService.seenPolovniAd.deleteMany({ where: { id: adId } });
        }
      }
      console.log(`Deleted ${n} leaky listings`);
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
    console.log('Running initial scrape (resumable)...');
    await cronService.handleWeeklyScrape();
    console.log('Initial scrape complete');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

void bootstrap();
