import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ScraperService } from '../src/scraper/scraper.service';
import { DealClassifierService } from '../src/analysis/deal-classifier.service';

// BigInt serialization fix for Prisma
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

/**
 * Full Flow E2E Test - Fresh Scrape → Save → Classify → Verify
 * Run with: npx jest --config ./test/jest-e2e.json --testPathPatterns="full-flow"
 */
describe('Full Flow E2E - Fresh Scrape → Save → Classify → Verify', () => {
  let app: INestApplication<App>;
  let scraperService: ScraperService;
  let dealClassifierService: DealClassifierService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    scraperService = moduleFixture.get<ScraperService>(ScraperService);
    dealClassifierService = moduleFixture.get<DealClassifierService>(DealClassifierService);
  }, 120000);

  afterAll(async () => {
    await app.close();
  });

  it('should run full flow: scrape → save → classify → verify via API', async () => {
    console.log('\n=== FULL FLOW TEST ===');

    // Step1: Scrape
    console.log('Step 1: Scraping fresh data...');
    const listings = await scraperService.scrapeTargetModel();
    console.log(`  Scraped ${listings.length} listings`);

    // Step2: Save to DB
    console.log('Step 2: Saving to database...');
    const saved = await scraperService.saveListings(listings);
    console.log(`  Saved ${saved.length} listings to DB`);

    // Step3: Classify
    console.log('Step 3: Classifying deals...');
    const classified = await dealClassifierService.classifyDeals();
    console.log(`  Classified ${classified} listings`);

    // Step4: Verify via API
    console.log('Step 4: Verifying via GET /deals...');
    const response = await request(app.getHttpServer())
      .get('/deals')
      .expect(200);

    const deals = response.body;
    console.log(`  API returned ${deals.length} deals`);

    // Log sample
    console.log('\n  Sample deals:');
    for (const deal of deals.slice(0, 5)) {
      console.log(`    - ${deal.title} | ${deal.price} | ${deal.year}y | ${deal.dealType}`);
    }

    // Verify
    expect(deals.length).toBeGreaterThan(0);
    const classifiedCount = deals.filter((d: any) => d.dealType !== null).length;
    console.log(`\n  Classified: ${classifiedCount}/${deals.length}`);

    expect(classifiedCount).toBeGreaterThan(0);
    console.log('\n=== FULL FLOW COMPLETE ===');
  }, 300000);
});