import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

// BigInt serialization fix for Prisma (must be before any imports that use JSON)
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

describe('GET /deals (Integration Tests - REAL DATA)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    prisma = moduleFixture.get<PrismaService>(PrismaService);

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /deals - Real Database Tests (NO MOCKS)', () => {
    it('should return REAL data from database', async () => {
      // Query real DB directly to verify data exists
      const realListings = await prisma.listing.findMany({
        take: 5,
      });

      console.log(`\n  Real DB has ${realListings.length} listings (sampled 5)`);

      // Now test the API endpoint
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      // Verify we got real data
      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeGreaterThan(0);

      console.log(`  API returned ${response.body.length} real listings`);

      // Verify response contains expected fields from real DB
      const firstDeal = response.body[0];
      expect(firstDeal).toHaveProperty('title');
      expect(firstDeal).toHaveProperty('price');
      expect(firstDeal).toHaveProperty('priceNumeric');
      expect(firstDeal).toHaveProperty('dealType');
    });

    it('should return deals sorted by pricePerYear (real DB query)', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals?sort=pricePerYear')
        .expect(200);

      const deals = response.body;

      // Verify real data is sorted by pricePerYear ascending
      for (let i = 1; i < deals.length; i++) {
        const prev = deals[i - 1].pricePerYear;
        const curr = deals[i].pricePerYear;

        // Skip if either is null (insufficient data)
        if (prev !== null && curr !== null) {
          expect(prev).toBeLessThanOrEqual(curr);
        }
      }

      console.log(`  Verified real deals are sorted by pricePerYear`);
    });

    it('should return deals with dealType field from real classification', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deals = response.body;

      // Count deals by dealType from REAL classified data
      const dealTypes: Record<string, number> = {};
      for (const deal of deals) {
        if (deal.dealType) {
          dealTypes[deal.dealType] = (dealTypes[deal.dealType] || 0) + 1;
        }
      }

      console.log('  Real dealType distribution:', JSON.stringify(dealTypes));

      // Verify we have some classified deals (not all null)
      const classifiedCount = Object.values(dealTypes).reduce((a, b) => a + b, 0);
      expect(classifiedCount).toBeGreaterThan(0);
    });

    it('should include all required fields in response (real data)', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deal = response.body[0];

      // Verify all expected fields exist in REAL data
      expect(deal).toHaveProperty('id');
      expect(deal).toHaveProperty('title');
      expect(deal).toHaveProperty('price');
      expect(deal).toHaveProperty('priceNumeric');
      expect(deal).toHaveProperty('year');
      expect(deal).toHaveProperty('mileageKm');
      expect(deal).toHaveProperty('dealType');
      expect(deal).toHaveProperty('dealScore');
      expect(deal).toHaveProperty('pricePerYear');
      expect(deal).toHaveProperty('listingUrl');

      console.log('  All required fields present in real data');
    });
  });

  describe('Sorting - Real Data', () => {
    it('should return deals sorted by dealScore descending by default', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deals = response.body;
      for (let i = 1; i < deals.length; i++) {
        const prev = deals[i - 1].dealScore;
        const curr = deals[i].dealScore;
        if (prev !== null && curr !== null) {
          expect(prev).toBeGreaterThanOrEqual(curr);
        }
      }
    });

    it('should return 400 for invalid sort parameter', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals?sort=invalid')
        .expect(400);
    });
  });

  describe('Edge Cases - Real Data', () => {
    it('should handle database with data', async () => {
      // Count real listings in DB
      const count = await prisma.listing.count();

      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      expect(response.body.length).toBe(count);
      console.log(`  DB has ${count} listings, API returned ${response.body.length}`);
    });

    it('should return proper JSON structure', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      // Verify it's valid JSON
      expect(Array.isArray(response.body)).toBe(true);

      // Verify each item is a proper object
      for (const item of response.body) {
        expect(typeof item).toBe('object');
        expect(item).not.toBeNull();
      }

      console.log('  Valid JSON structure returned');
    });
  });
});