import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

type CheerioElement = cheerio.Cheerio<Element>;

export interface RawListingData {
  title: string;
  listingUrl: string;
  price: string;
  priceNote: string;
  year: string;
  mileageKm: string;
  fuelType: string;
  engineVolume: string;
  powerKw: string;
  transmission: string;
  location: string;
}

@Injectable()
export class HtmlParserService {
  private readonly baseUrl: string;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('scraper.targetUrl')!;
  }

  /**
   * Parse a single page HTML and extract all listings
   * @param html - The page HTML content
   * @returns Array of raw listing data
   */
  parsePage(html: string): RawListingData[] {
    const $ = cheerio.load(html);
    const listings: RawListingData[] = [];

    // Current markup (styled-components, no stable classes):
    // one <article> per ad, identified by the title anchor testid.
    const cards = $('article:has(a[data-testid="adCardDetailPageTitle"])');
    if (cards.length > 0) {
      cards.each((_, el) => {
        const $el = $(el);
        const listing = this.parseListing($el, this.detectType($el));
        // Skip cards without a usable URL (e.g. promo placeholders)
        if (listing.listingUrl) {
          listings.push(listing);
        }
      });

      console.log(`Parsed ${listings.length} listings from page`);
      return listings;
    }

    // Legacy markup fallback (pre-2026 DOM: section/article.classified)
    // Both have "classified" in their class attribute
    const allListings = $(
      'section[class*="classified"], article[class*="classified"]',
    );
    allListings.each((_, el) => {
      const $el = $(el);
      const classAttr = $el.attr('class') || '';
      // Determine type from class: ordinaryClassified → regular, otherwise → featured
      const listingType = classAttr.includes('ordinaryClassified')
        ? 'regular'
        : 'featured';
      const listing = this.parseListing($el, listingType);
      listings.push(listing);
    });

    console.log(`Parsed ${listings.length} listings from page`);
    return listings;
  }

  /**
   * Parse a single listing card
   * @param listing - Cheerio element for the listing
   * @param listingType - 'featured' or 'regular'
   * @returns Raw listing data
   */
  parseListing(
    listing: CheerioElement,
    listingType: 'featured' | 'regular',
  ): RawListingData {
    const data: RawListingData = {
      title: '',
      listingUrl: '',
      price: '',
      priceNote: '',
      year: '',
      mileageKm: '',
      fuelType: '',
      engineVolume: '',
      powerKw: '',
      transmission: '',
      location: '',
    };

    // Title and URL
    const titleLink = this.extractTitleLink(listing, listingType);
    if (titleLink) {
      data.title = titleLink.title;
      data.listingUrl = titleLink.url;
    }

    // Price
    const priceData = this.extractPrice(listing, listingType);
    data.price = priceData.price;
    data.priceNote = priceData.note;

    // Specs from second-row-info (year, fuel, engine, power, transmission)
    const specsData = this.extractSpecs(listing);
    data.year = specsData.year;
    data.fuelType = specsData.fuelType;
    data.engineVolume = specsData.engineVolume;
    data.powerKw = specsData.powerKw;
    data.transmission = specsData.transmission;

    // Mileage (regular listings only)
    if (listingType === 'regular') {
      data.mileageKm = this.extractMileage(listing);
    }

    // If year not found in specs, try div.info (regular listings only)
    if (!data.year && listingType === 'regular') {
      const infoElem = listing.find('div.info');
      if (infoElem.length > 0) {
        const infoText = infoElem.text();
        const infoYearMatch = infoText.match(/\b(19\d{2}|20\d{2})\b/);
        if (infoYearMatch) {
          data.year = infoYearMatch[1];
        }
      }
    }

    // If year still not found, try title fallback
    if (!data.year && data.title) {
      const titleYearMatch = data.title.match(/\b(19\d{2}|20\d{2})\b/);
      if (titleYearMatch) {
        data.year = titleYearMatch[1];
      }
    }

    // Location
    data.location = this.extractLocation(listing);

    // New markup: fill gaps from the remaining card text
    // (compact cards have no data-testid="adDescription" block)
    if (this.isNewMarkup(listing)) {
      this.fillFromCardText(listing, data);
    }

    return data;
  }

  /**
   * Extract search-result pagination URLs from a page
   * (the site's own canonical links, e.g. ...&page=2&sort=basic).
   * Used to discover follow-up pages without guessing slug rules.
   * @param html - The page HTML content
   * @returns Absolute, deduplicated page URLs sorted by page number
   */
  extractSearchPageUrls(html: string): string[] {
    const $ = cheerio.load(html);
    const baseUrl = this.baseUrl.replace(/\/auto-oglasi\/pretraga.*/, '');
    const byPage = new Map<number, string>();

    $('a[href*="/auto-oglasi/pretraga"]').each((_, el) => {
      const rawHref = $(el).attr('href');
      if (!rawHref || !/[?&]page=\d+/.test(rawHref)) {
        return;
      }
      const absolute = rawHref.startsWith('/')
        ? `${baseUrl}${rawHref}`
        : rawHref;
      const pageMatch = absolute.match(/[?&]page=(\d+)/);
      if (pageMatch) {
        const pageNum = parseInt(pageMatch[1], 10);
        if (!byPage.has(pageNum)) {
          byPage.set(pageNum, absolute);
        }
      }
    });

    return [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, url]) => url);
  }

  /**
   * Current markup uses data-testid anchors instead of stable classes.
   */
  private isNewMarkup(listing: CheerioElement): boolean {
    return listing.find('a[data-testid="adCardDetailPageTitle"]').length > 0;
  }

  /**
   * Detect card type in current markup: cards with a spec block
   * are the highlighted ("featured") variant, compact ones are regular.
   */
  private detectType(listing: CheerioElement): 'featured' | 'regular' {
    return listing.find('[data-testid="adDescription"]').length > 0
      ? 'featured'
      : 'regular';
  }

  /**
   * Canonical listing URL: strip tracking params (paPage, paSerial, …)
   * so the same ad dedupes across pages. Keeps the numeric ad id.
   */
  private canonicalizeUrl(href: string): string {
    if (!href) return '';
    // Extract base URL (e.g., "https://www.polovniautomobili.com") from config
    const baseUrl = this.baseUrl.replace(/\/auto-oglasi\/pretraga.*/, '');
    const path = href.split('?')[0];
    return path.startsWith('/') ? `${baseUrl}${path}` : path;
  }

  /**
   * Fill missing fields from the card's leftover text (title/price
   * blocks removed). Works for both full and compact card variants.
   */
  private fillFromCardText(
    listing: CheerioElement,
    data: RawListingData,
  ): void {
    const clone = listing.clone();
    clone.find('[data-testid="globalAdCardPriceTestId"]').remove();
    clone.find('a[data-testid="adCardDetailPageTitle"]').remove();
    clone.find('[data-testid="adCardImageCounter"]').remove();
    clone.find('img, script, style, svg').remove();
    const text = clone.text().replace(/\s+/g, ' ');

    // Structured spec items (title attributes are glue-free, e.g.
    // "2012. Karavan") — most reliable source for year and mileage.
    // domhandler Elements expose attributes directly, no cheerio needed.
    const descTitles: string[] = [];
    listing.find('[data-testid="adDescription"] div[title]').each((_, el) => {
      const title = (el as unknown as { attribs?: { title?: string } }).attribs
        ?.title;
      if (title) descTitles.push(title);
    });

    if (!data.year) {
      for (const item of descTitles) {
        const m = item.match(/(?<!\d)(19\d{2}|20\d{2})\./);
        if (m) {
          data.year = m[1];
          break;
        }
      }
      if (!data.year) {
        for (const item of descTitles) {
          const m = item.match(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/);
          if (m) {
            data.year = m[1];
            break;
          }
        }
      }
    }
    if (!data.mileageKm) {
      const kmItem = descTitles.find((item) => /km/i.test(item));
      if (kmItem) {
        data.mileageKm = kmItem.trim();
      }
    }

    // Year matching runs on a scrubbed copy: mileage/engine numbers can
    // fake ("1956 cm3") or glue onto ("kupovine2011") a year match.
    // Sibling divs concatenate without separators, so \b is useless —
    // use digit lookarounds instead.
    const yearText = text
      .replace(/(\d{1,3}(?:\.\d{3})+|\d+)\s*km/gi, ' ')
      .replace(/\d[\d.]*\s*cm\s*3/gi, ' ');

    if (!data.year) {
      // Serbian format is "2011." — prefer it, fall back to bare year
      const dottedYear = yearText.match(/(?<!\d)(19\d{2}|20\d{2})\./);
      const bareYear = yearText.match(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/);
      data.year = (dottedYear ?? bareYear)?.[1] ?? '';
    }
    if (!data.mileageKm) {
      // Prefer thousand-separated form first: card text concatenates
      // sibling divs ("…1598 cm3237.620 km"), so a naive [\d.]+ match
      // would glue the engine displacement onto the mileage.
      const groupedKm = text.match(/(\d{1,3}(?:\.\d{3})+)\s*km/i);
      if (groupedKm) {
        data.mileageKm = groupedKm[0].trim();
      } else {
        const kmMatch = text.match(/(\d+)\s*km/i);
        if (kmMatch) data.mileageKm = kmMatch[0].trim();
      }
    }
    if (!data.fuelType) {
      const fuelTypes = [
        'dizel',
        'benzin',
        'elektro',
        'hibrid',
        'metan',
        'tazni gas',
      ];
      for (const fuel of fuelTypes) {
        if (text.toLowerCase().includes(fuel)) {
          data.fuelType = fuel.charAt(0).toUpperCase() + fuel.slice(1);
          break;
        }
      }
    }
    if (!data.engineVolume) {
      const cm3Match = text.match(/(\d[\d.]*)\s*cm\s*3/i);
      if (cm3Match) {
        data.engineVolume = `${cm3Match[1]} cm3`;
      } else {
        const lMatch = text.match(/([\d.]+)\s*L/i);
        if (lMatch) data.engineVolume = lMatch[1] + 'L';
      }
    }
    if (!data.powerKw) {
      const powerMatch = text.match(/(\d+)\s*kW/i);
      if (powerMatch) data.powerKw = powerMatch[1] + ' kW';
    }
    if (!data.transmission) {
      if (text.toLowerCase().includes('automatski')) {
        data.transmission = 'Automatic';
      } else if (text.toLowerCase().includes('manuelni')) {
        data.transmission = 'Manual';
      }
    }
    if (!data.location) {
      const city = listing
        .find('[data-testid="adCardCity"]')
        .first()
        .text()
        .trim();
      if (city) data.location = city;
    }
  }

  /**
   * Extract title and URL from listing
   */
  private extractTitleLink(
    listing: CheerioElement,
    listingType: 'featured' | 'regular',
  ): { title: string; url: string } | null {
    // Current markup: stable data-testid anchor
    if (this.isNewMarkup(listing)) {
      const anchor = listing
        .find('a[data-testid="adCardDetailPageTitle"]')
        .first();
      const h2 = anchor.find('h2').first();
      const title = (h2.length > 0 ? h2.text() : anchor.text()).trim();
      const href = anchor.attr('href') || '';
      if (title && href) {
        return { title, url: this.canonicalizeUrl(href) };
      }
      return null;
    }

    let titleElem: CheerioElement | undefined;

    if (listingType === 'featured') {
      titleElem = listing.find('h2.brand-and-model a').first();
    } else {
      const textContent = listing.find('div.textContent h2').first();
      titleElem = textContent.find('a').first();
    }

    if (titleElem.length > 0) {
      const title = titleElem.text().trim();
      const href = titleElem.attr('href') || '';
      // Extract base URL (e.g., "https://www.polovniautomobili.com") from config
      const baseUrl = this.baseUrl.replace(/\/auto-oglasi\/pretraga.*/, '');
      const url = href.startsWith('/') ? `${baseUrl}${href}` : href;
      return { title, url };
    }

    return null;
  }

  /**
   * Extract price and price note from listing
   */
  private extractPrice(
    listing: CheerioElement,
    listingType: 'featured' | 'regular',
  ): { price: string; note: string } {
    // Current markup: stable data-testid price block.
    // The <small> tag holds the "+ ..." surcharge note — exclude it
    // from the price text so it can't pollute the numeric match.
    const priceBlock = listing
      .find('[data-testid="globalAdCardPriceTestId"]')
      .first();
    if (priceBlock.length > 0) {
      const smallText = priceBlock.find('small').text().trim();
      const clone = priceBlock.clone();
      clone.find('small').remove();
      const priceText = clone.text().trim();
      const note = smallText.replace(/^\+\s*/, '').trim();
      return { price: this.extractPriceNumber(priceText), note };
    }

    let priceText = '';

    if (listingType === 'featured') {
      const priceElem = listing.find('span.price').first();
      priceText = priceElem.text().trim();
    } else {
      const priceDiv = listing.find('div.price').first();
      const firstSpan = priceDiv.find('span').first();
      priceText =
        firstSpan.length > 0 ? firstSpan.text().trim() : priceDiv.text().trim();
    }

    // Extract price number (100-999999)
    return {
      price: this.extractPriceNumber(priceText),
      note: this.extractLegacyNote(priceText),
    };
  }

  /**
   * Extract numeric price from a price string ("3.590 €" → "3590").
   * Returns '' when no plausible price (100-999999) is found.
   */
  private extractPriceNumber(priceText: string): string {
    const pricePatterns = [
      /(\d{1,3}\.\d{3})/, // 1.000, 12.000, 123.000
      /(\d+)/, // Simple number
    ];

    for (const pattern of pricePatterns) {
      const matches = priceText.match(new RegExp(pattern.source, 'g'));
      if (matches) {
        for (const match of matches) {
          const cleaned = match.replace(/\./g, '');
          const num = parseInt(cleaned, 10);
          if (!isNaN(num) && num >= 100 && num <= 999999) {
            return String(num);
          }
        }
      }
    }

    return '';
  }

  /**
   * Extract surcharge note from legacy price text ("5.700 € + registracija").
   */
  private extractLegacyNote(priceText: string): string {
    // Extract note (everything after + sign)
    const noteMatch = priceText.match(/\+\s*(.+)$/);
    if (noteMatch) {
      return noteMatch[1].trim();
    }

    return '';
  }

  /**
   * Extract specs (year, fuel type, engine, power, transmission)
   */
  private extractSpecs(listing: CheerioElement): {
    year: string;
    fuelType: string;
    engineVolume: string;
    powerKw: string;
    transmission: string;
  } {
    const result = {
      year: '',
      fuelType: '',
      engineVolume: '',
      powerKw: '',
      transmission: '',
    };

    const specsElem = listing.find('div.second-row-info');
    if (specsElem.length === 0) {
      // Current markup: spec items carry the data in title attributes,
      // e.g. "2011. Karavan", "Dizel | 1686 cm3", "191.000 km".
      // fillFromCardText() parses these from the card text instead.
      return result;
    }

    const specsText = specsElem.text();

    // Extract year from second-row-info
    const yearMatch = specsText.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearMatch) {
      result.year = yearMatch[1];
    }

    // Extract fuel type
    const fuelTypes = [
      'dizel',
      'benzin',
      'elektro',
      'hibrid',
      'metan',
      'tazni gas',
    ];
    for (const fuel of fuelTypes) {
      if (specsText.toLowerCase().includes(fuel)) {
        result.fuelType = fuel.charAt(0).toUpperCase() + fuel.slice(1);
        break;
      }
    }

    // Extract engine volume
    const engineMatch = specsText.match(/([\d.]+)\s*L/i);
    if (engineMatch) {
      result.engineVolume = engineMatch[1] + 'L';
    }

    // Extract power
    const powerMatch = specsText.match(/([\d.]+)\s*kW/i);
    if (powerMatch) {
      result.powerKw = powerMatch[1] + ' kW';
    }

    // Extract transmission
    if (specsText.toLowerCase().includes('automatski')) {
      result.transmission = 'Automatic';
    } else if (specsText.toLowerCase().includes('manuelni')) {
      result.transmission = 'Manual';
    }

    return result;
  }

  /**
   * Extract mileage from listing (regular listings only)
   */
  private extractMileage(listing: CheerioElement): string {
    const infoDiv = listing.find('div.info');
    if (infoDiv.length === 0) {
      return '';
    }

    const setInfos = infoDiv.find('div.setInfo');
    for (let i = 0; i < setInfos.length; i++) {
      const setInfo = setInfos.eq(i);
      const titleAttr = setInfo.find('div.top').attr('title');
      if (titleAttr && titleAttr.toLowerCase().includes('km')) {
        return titleAttr; // e.g., "350.000 km"
      }
    }

    return '';
  }

  /**
   * Extract location from listing
   */
  private extractLocation(listing: CheerioElement): string {
    // Current markup: stable data-testid city block
    const cityElem = listing.find('[data-testid="adCardCity"]').first();
    if (cityElem.length > 0) {
      cityElem.find('i').remove();
      const city = cityElem.text().trim();
      if (city) return city;
    }

    const locationElem = listing.find('div.city');
    if (locationElem.length === 0) {
      return '';
    }

    // Remove icon elements
    locationElem.find('i').remove();
    return locationElem.text().trim();
  }

  /**
   * Normalize mileage string to integer
   * Input: "360.000 km" → 360000
   */
  normalizeMileage(mileageStr: string | null): number | null {
    if (!mileageStr) return null;

    // Remove dots, "km" text, trim
    const cleaned = mileageStr.replace(/\./g, '').replace(/km/gi, '').trim();

    const parsed = parseInt(cleaned, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Normalize price string to numeric value
   * Input: "4.500 EUR" → 4500
   */
  normalizePrice(priceStr: string | null): {
    raw: string;
    numeric: number | null;
  } {
    if (!priceStr) {
      return { raw: '', numeric: null };
    }

    // Remove dots (thousand separators), commas, EUR, RSD
    const cleaned = priceStr
      .replace(/\./g, '')
      .replace(/,/g, '')
      .replace(/EUR/gi, '')
      .replace(/RSD/gi, '')
      .trim();

    const parsed = parseInt(cleaned, 10);
    return {
      raw: priceStr,
      numeric: isNaN(parsed) ? null : parsed,
    };
  }
}
