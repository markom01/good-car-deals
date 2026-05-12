import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HttpService } from '../scraper/http.service';
import { HtmlParserService } from '../scraper/html-parser.service';
import { AppModule } from '../app.module';

describe('Real Flow E2E Test - Scrape → Parse', () => {
  let httpService: HttpService;
  let htmlParserService: HtmlParserService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    httpService = module.get<HttpService>(HttpService);
    htmlParserService = module.get<HtmlParserService>(HtmlParserService);
  }, 60000);

  describe('Real E2E Flow', () => {
    it('should scrape and parse real data from website (LIVE HTTP)', async () => {
      // Step 1: Fetch real HTML from website
      const url = httpService.buildSearchUrl(1);
      console.log(`\n  Fetching: ${url.substring(0, 60)}...`);

      const html = await httpService.fetchPage(url);
      expect(html).toBeDefined();
      expect(html.length).toBeGreaterThan(1000);

      // Step 2: Parse the HTML
      const listings = htmlParserService.parsePage(html);
      console.log(`  Parsed ${listings.length} listings from real HTML`);

      // Verify we got real data
      expect(listings.length).toBeGreaterThan(0);
      expect(listings[0]).toHaveProperty('title');
      expect(listings[0]).toHaveProperty('price');
      expect(listings[0]).toHaveProperty('year');

      console.log(`  Sample: "${listings[0].title}" - ${listings[0].price}`);
    }, 60000);

    it('should normalize scraped data correctly', async () => {
      // Get a real page
      const html = await httpService.fetchPage(httpService.buildSearchUrl(1));
      const listings = htmlParserService.parsePage(html);

      // Test normalization on real data
      for (const listing of listings.slice(0, 3)) {
        const normalized = htmlParserService.normalizeMileage(listing.mileageKm);
        console.log(`  Mileage: "${listing.mileageKm}" -> ${normalized}`);
        expect(normalized).toBeDefined();
      }
    }, 60000);
  });
});