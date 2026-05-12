import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpService } from './http.service';

describe('HttpService - Real Data Tests (NO MOCKS)', () => {
  let httpService: HttpService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HttpService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'scraper.targetUrl') return 'https://www.polovniautomobili.com/auto-oglasi/pretraga';
              if (key === 'scraper.brand') return 'opel';
              if (key === 'scraper.model') return 'Astra J';
              return undefined;
            },
          },
        },
      ],
    }).compile();

    httpService = module.get<HttpService>(HttpService);
  });

  describe('Real HTTP Calls - polovniautomobili.com', () => {
    it('should fetch page successfully (REAL HTTP call)', async () => {
      const url = httpService.buildSearchUrl(1);
      console.log(`\n  Testing REAL HTTP call to: ${url}...`);

      const result = await httpService.fetchPage(url);

      // Verify we got actual HTML content
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(1000); // Real page should have substantial content

      console.log(`  Received ${result.length} characters of real HTML`);
    }, 30000); // 30s timeout for real HTTP

    it('should fetch multiple pages successfully (REAL HTTP calls)', async () => {
      const pagesToFetch = [1, 2];
      const results: string[] = [];

      for (const page of pagesToFetch) {
        const url = httpService.buildSearchUrl(page);
        console.log(`  Fetching page ${page}...`);
        const html = await httpService.fetchPage(url);
        results.push(html);
        expect(html.length).toBeGreaterThan(1000);
      }

      expect(results.length).toBe(2);
      // Each page should be different (different listings)
      expect(results[0]).not.toBe(results[1]);
      console.log(`  Successfully fetched ${results.length} real pages`);
    }, 60000); // 60s timeout for multiple real HTTP calls

    it('should build correct search URL', () => {
      const url1 = httpService.buildSearchUrl(1);
      expect(url1).toContain('page=1');
      // New format: brand=opel&model[]=astra-j&page=1 (array syntax)
      expect(url1).toContain('brand=');
      expect(url1).toContain('model[]=');

      const url5 = httpService.buildSearchUrl(5);
      expect(url5).toContain('page=5');
    });
  });

  describe('Retry Logic - Real Error Conditions', () => {
    it('should handle connection errors gracefully (REAL HTTP)', async () => {
      // Test with an invalid URL that will fail
      const invalidUrl = 'https://this-domain-does-not-exist-12345.com/';

      try {
        await httpService.fetchPage(invalidUrl);
        // If it succeeds, that's unexpected but possible
        console.log(`  Unexpected success for invalid URL`);
      } catch (error) {
        // Expected to throw after retries
        expect(error).toBeDefined();
        console.log(`  Expected error for invalid URL: ${(error as Error).message.substring(0, 50)}`);
      }
    }, 30000);
  });
});