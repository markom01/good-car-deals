export type PlateOrigin = 'domestic' | 'foreign';

export { estimateSerbiaImportCostsEur } from './import-costs';
export type { SerbiaImportCostEstimateEur } from './import-costs';

export interface Listing {
  id: number;
  listingUrl: string;
  title: string;
  price: string;
  priceNumeric: number | null;
  priceNote: string | null;
  year: number | null;
  age: number | null;
  mileageKm: number | null;
  model: string | null;
  /** Generation resolved from the offline artifact, or null when ambiguous. */
  generation?: string | null;
  dealType: string | null;
  dealScore: number | null;
  pricePerYear: number | null;
  scrapedAt: string;
  updatedAt: string;
  /** Mileage-adjusted generation benchmark, stored by the classifier. */
  expectedPrice: number | null;
  /** Ask vs benchmark, stored by the classifier; positive = cheaper than benchmark. */
  deviationPct: number | null;
  fuelType?: string | null;
  engineCc?: number | null;
  powerKw?: number | null;
  transmission?: string | null;
  location?: string | null;
  /** "Poreklo vozila": domestic plates vs foreign plates (import car). */
  plateOrigin?: PlateOrigin | null;
}
