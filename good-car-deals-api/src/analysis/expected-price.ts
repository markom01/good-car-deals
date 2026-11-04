/**
 * Feature mapping and constants shared by the property-based expected-price model.
 * Pure module: no Nest, no Prisma, no runtime dependencies beyond TypeScript.
 */

/** Number of comparable listings required behind an expected price (excluding the scored row). */
export const EXPECTED_PRICE_MIN_COMPS = 10;

/** Hierarchical shrinkage weight (group -> model -> global). */
export const SHRINKAGE_K = 8;

export type FuelCategory = 'petrol' | 'diesel' | 'gas' | 'hybrid' | 'electric';

/**
 * Maps a Serbian fuel label to a canonical category.
 * Order matters: hybrid is checked before diesel so
 * 'Hibridni pogon (dizel)' maps to hybrid, not diesel.
 */
export function fuelCategory(label: string | null | undefined): FuelCategory {
  const s = (label ?? '').toLowerCase();

  if (s.includes('elektri') || s.includes('electric')) return 'electric';
  if (s.includes('hibrid') || s.includes('hybrid')) return 'hybrid';
  if (
    s.includes('gas') ||
    s.includes('metan') ||
    s.includes('tng') ||
    s.includes('cng')
  )
    return 'gas';
  if (s.includes('dizel') || s.includes('diesel')) return 'diesel';
  return 'petrol';
}

/**
 * Returns true when a transmission label denotes an automatic transmission.
 */
export function isAutomatic(transmission: string | null | undefined): boolean {
  const s = (transmission ?? '').toLowerCase();
  return s.includes('automat');
}
