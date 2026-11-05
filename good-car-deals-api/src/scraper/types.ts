/**
 * Shared types for the scraper layer.
 * Production scraping uses JSON API endpoints only (no HTML parsing).
 */

export interface RawListingData {
  title: string;
  /** Brand and model as reported by the site's feed (scrape is site-wide). */
  brand?: string;
  model?: string;
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
  /** "Poreklo vozila" derived from the feed tags. */
  plateOrigin?: 'domestic' | 'foreign' | null;
  /** When the site first indexed this ad (from the feed's indexedAt field). */
  indexedAt?: string | null;
}

export interface SearchResult {
  id?: string | number;
  title?: string;
  year?: number;
  mileage?: number | null;
  fuel?: string;
  engineVolume?: number | null;
  power?: number | null;
  gearBox?: string;
  price?: number | null;
  city?: string;
  status?: string;
  brand?: string;
  model?: string;
  tags?: string[];
  indexedAt?: string;
  updatedAt?: string;
}

export interface FeedAd {
  adId: string;
  indexedAt: string | null;
  updatedAt: string | null;
  raw: RawListingData;
}

export interface SearchPayload {
  pageProps?: {
    searchResults?: {
      pageCount?: number;
      results?: SearchResult[];
    };
  };
}

export interface SearchPage {
  listings: RawListingData[];
  pageCount: number;
}
