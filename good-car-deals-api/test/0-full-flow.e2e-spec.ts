import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ScraperService } from '../src/scraper/scraper.service';
import { DealClassifierService } from '../src/analysis/deal-classifier.service';
import { PrismaService } from '../src/prisma/prisma.service';

// BigInt serialization fix for Prisma
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

/**
 * Full Flow E2E Test - Fresh Scrape (1 page) → Save → Classify → Verify
 *
 * The scrape is bounded to a single page via `maxListings: 1` so the test does
 * not crawl the whole site (which would hit a live residential IP and time out
 * in CI / cloud environments that polovniautomobili.com blocks with 403).
 *
 * Run with: npx jest --config ./test/jest-e2e.json --testPathPattern="full-flow"
 */
describe('Full Flow E2E - Fresh Scrape → Save → Classify → Verify', () => {
  let app: INestApplication<App>;
  let scraperService: ScraperService;
  let dealClassifierService: DealClassifierService;
  let prismaService: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    scraperService = moduleFixture.get<ScraperService>(ScraperService);
    dealClassifierService = moduleFixture.get<DealClassifierService>(
      DealClassifierService,
    );
    prismaService = moduleFixture.get<PrismaService>(PrismaService);

    // Start from a clean slate so each run classifies only what this test scraped.
    await prismaService.listing.deleteMany();
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  it('should run full flow: scrape → save → classify → verify via API', async () => {
    console.log('\n=== FULL FLOW TEST ===');

    // Step 1: Scrape — bounded to one page so the e2e stays fast and does not
    // depend on a residential IP or deep pagination.
    console.log('Step 1: Scraping one page of data...');
    const listings = await scraperService.scrapeTargetModel({
      maxListings: 1,
    });
    console.log(`  Scraped ${listings.length} listings`);

    // Step 2: Save to DB
    console.log('Step 2: Saving to database...');
    const saved = await scraperService.saveListings(listings);
    console.log(`  Saved ${saved.length} listings to DB`);

    // Step 3: Classify all scraped listings so /deals has rated deals to return
    // (bounded scrape keeps the e2e fast; on a fresh DB this is only ~200 rows).
    console.log('Step 3: Classifying deals...');
    const classified = await dealClassifierService.classifyDeals();
    console.log(`  Classified ${classified} listings`);

    // Step 4: Verify via API
    console.log('Step 4: Verifying via GET /deals...');
    const response = await request(app.getHttpServer())
      .get('/deals')
      .expect(200);

    const deals = response.body.data;
    console.log(`  API returned ${deals.length} deals`);

    // Log sample
    console.log('\n  Sample deals:');
    for (const deal of deals.slice(0, 5)) {
      console.log(
        `    - ${deal.title} | ${deal.price} | ${deal.year}y | ${deal.dealType}`,
      );
    }

    // Verify
    expect(deals.length).toBeGreaterThan(0);
    const classifiedCount = deals.filter(
      (d: any) => d.dealType !== null,
    ).length;
    console.log(`\n  Classified: ${classifiedCount}/${deals.length}`);

    expect(classifiedCount).toBeGreaterThan(0);
    console.log('\n=== FULL FLOW COMPLETE ===');
  }, 300000);
});
