import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CronService } from './scraper/cron.service';
import { PrismaService } from './prisma/prisma.service';

// BigInt is not serializable by JSON.stringify by default.
// Prisma uses BigInt for auto-increment IDs, so we need to convert to number for JSON responses.

(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);
    app.enableCors();

    // Start listening immediately so Render health check passes
    await app.listen(process.env.PORT ?? 3001);
    console.log('Server listening on port', process.env.PORT ?? 3001);

    // Run initial scrape in background (non-blocking)
    const prismaService = app.get(PrismaService);
    const cronService = app.get(CronService);

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
