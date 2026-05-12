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
    this.baseUrl =
      this.configService.get<string>('scraper.targetUrl')!;
  }

  /**
   * Parse a single page HTML and extract all listings
   * @param html - The page HTML content
   * @returns Array of raw listing data
   */
  parsePage(html: string): RawListingData[] {
    const $ = cheerio.load(html);
    const listings: RawListingData[] = [];

    // Find all listing cards (featured use <section>, regular use <article>)
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

    return data;
  }

  /**
   * Extract title and URL from listing
   */
  private extractTitleLink(
    listing: CheerioElement,
    listingType: 'featured' | 'regular',
  ): { title: string; url: string } | null {
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
      const url = href.startsWith('/')
        ? `${baseUrl}${href}`
        : href;
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
    const pricePatterns = [
      /(\d{1,3}\.\d{3})/, // 1.000, 12.000, 123.000
      /(\d+)/, // Simple number
    ];

    let price = '';
    let note = '';

    for (const pattern of pricePatterns) {
      const matches = priceText.match(new RegExp(pattern.source, 'g'));
      if (matches) {
        for (const match of matches) {
          const cleaned = match.replace(/\./g, '');
          const num = parseInt(cleaned, 10);
          if (!isNaN(num) && num >= 100 && num <= 999999) {
            price = String(num);
            break;
          }
        }
        if (price) break;
      }
    }

    // Extract note (everything after + sign)
    const noteMatch = priceText.match(/\+\s*(.+)$/);
    if (noteMatch) {
      note = noteMatch[1].trim();
    }

    return { price, note };
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
