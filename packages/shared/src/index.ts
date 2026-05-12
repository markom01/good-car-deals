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
  dealType: string | null;
  dealScore: number | null;
  pricePerYear: number | null;
  scrapedAt: string;
  updatedAt: string;
}