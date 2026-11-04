import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ScraperService } from '../src/scraper/scraper.service';
import { DealClassifierService } from '../src/analysis/deal-classifier.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { resolveGeneration } from '../src/analysis/generation-resolver';

// BigInt serialization fix for Prisma
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

const FIXTURE_MODEL = 'Volkswagen Golf 7';
const FIXTURE_YEAR = 2016;

// resolveGeneration('Volkswagen Golf 7', 2016) === 'Mk7 (Type 5G)'
function fixtureRows() {
  return Array.from({ length: 12 }, (_, i) => {
    const price = i === 0 ? 3_000 : 12_000 + i * 100;
    return {
      listingUrl: `https://test.local/fixture/${i}`,
      title: `Volkswagen Golf 7 fixture ${i}`,
      price: String(price),
      priceNumeric: BigInt(price),
      year: FIXTURE_YEAR,
      age: 10,
      mileageKm: 150_000 + i * 10_000,
      model: FIXTURE_MODEL,
      fuelType: 'Dizel',
      engineCc: 1598,
      powerKw: 85,
      transmission: 'Manuelni 5 brzina',
      plateOrigin: 'domestic',
    };
  });
}

/**
 * Full Flow E2E Test - Fresh Scrape → Save → Classify → Verify
 * Run with: npx jest --config ./test/jest-e2e.json --testPathPatterns="full-flow"
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

    // Step 2b: Seed a deterministic 12-row comp group for the 10-comp gate.
    console.log('Step 2b: Seeding a deterministic 12-row comp group...');
    await prismaService.listing.createMany({ data: fixtureRows() });

    // Step3: Classify deals (bounded to keep the e2e fast)
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
      console.log(
        `    - ${deal.title} | ${deal.price} | ${deal.year}y | ${deal.dealType}`,
      );
    }

    // Verify
    expect(deals.length).toBeGreaterThan(0);

    // Fetch the full page set so the fixture deal cannot fall off the
    // default 50-row page, then assert it got an expected price.
    const allDeals = (
      await request(app.getHttpServer()).get('/deals?pageSize=3000').expect(200)
    ).body.data;
    const fixtureDeal = allDeals.find((d: any) =>
      d.listingUrl.endsWith('/fixture/0'),
    );
    expect(fixtureDeal).toBeDefined();
    expect(fixtureDeal.expectedPrice).not.toBeNull();
    expect(fixtureDeal.expectedPriceSampleSize).toBeGreaterThanOrEqual(11);
    expect(['GREAT DEAL', 'GOOD DEAL']).toContain(fixtureDeal.dealType);

    const classifiedCount = deals.filter(
      (d: any) => d.dealType !== null,
    ).length;
    console.log(`\n  Classified: ${classifiedCount}/${deals.length}`);

    expect(classifiedCount).toBeGreaterThan(0);
    console.log('\n=== FULL FLOW COMPLETE ===');
  }, 300000);
});
