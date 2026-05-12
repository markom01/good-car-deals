import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

// BigInt serialization fix for Prisma
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};

/**
 * E2E Test - Real Data Flow
 *
 * Tests the full end-to-end flow:
 * 1. Real NestJS app bootstrap (no mocks)
 * 2. GET /deals returns REAL data from database
 * 3. All required fields present and sorted correctly
 */
describe('E2E Test - Real Data Flow', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /deals endpoint', () => {
    it('should return 200 with listings from database', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      expect(response.body).toBeDefined();
      expect(Array.isArray(response.body)).toBe(true);
      console.log(`\n  Returned ${response.body.length} listings`);

      // Log sample listings
      console.log(`\n  Sample listings found:`);
      for (const deal of response.body.slice(0, 5)) {
        console.log(`    - ${deal.title} | ${deal.price} | ${deal.year}y | ${deal.mileageKm}km | ${deal.dealType}`);
      }
      if (response.body.length > 5) {
        console.log(`    ... and ${response.body.length - 5} more`);
      }
    });

    it('should have all required fields in response', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deal = response.body[0];

      // Verify all required fields
      const requiredFields = [
        'id',
        'title',
        'price',
        'priceNumeric',
        'year',
        'mileageKm',
        'dealType',
        'dealScore',
        'pricePerYear',
        'listingUrl',
      ];

      for (const field of requiredFields) {
        expect(deal).toHaveProperty(field);
      }

      console.log(`  All ${requiredFields.length} required fields present`);
    });

    it('should be sorted by pricePerYear ascending', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deals = response.body;

      for (let i = 1; i < deals.length; i++) {
        const prev = deals[i - 1].pricePerYear;
        const curr = deals[i].pricePerYear;

        if (prev !== null && curr !== null) {
          expect(prev).toBeLessThanOrEqual(curr);
        }
      }

      console.log(`  Verified ${deals.length} deals sorted by pricePerYear`);
    });

    it('should have classified deal types', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deals = response.body;

      // Count deals with deal_type set
      const classifiedCount = deals.filter((d: { dealType: string | null }) => d.dealType !== null).length;

      console.log(`\n  Classified: ${classifiedCount}/${deals.length}`);

      // Just ensure SOME are classified (website doesn't always provide year in search results)
      expect(classifiedCount).toBeGreaterThan(0);
      expect(deals.length).toBeGreaterThan(0);
    });

    it('should handle null values correctly', async () => {
      const response = await request(app.getHttpServer())
        .get('/deals')
        .expect(200);

      const deals = response.body;

      for (const deal of deals) {
        expect(typeof deal).toBe('object');
        expect(typeof deal.title).toBe('string');
        expect(typeof deal.price).toBe('string');
      }

      console.log(`  Valid JSON structure for all ${deals.length} deals`);
    });
  });
});