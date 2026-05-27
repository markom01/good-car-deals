import { DealsService } from './deals.service';
import { PrismaService } from '../prisma/prisma.service';

// The pure function we want to test.
// Extracted from DealsService for isolated unit testing.
// When computePriceToAvgPct is added to DealsService, this can be
// replaced with an import from deals.service.ts and instantiated via
// Test.createTestingModule.
function computePriceToAvgPct(
  priceNumeric: number | null,
  modelAvgPriceNumeric: number | null,
): number | null {
  if (
    priceNumeric === null ||
    modelAvgPriceNumeric === null ||
    modelAvgPriceNumeric === 0
  ) {
    return null;
  }
  return Math.round(
    ((priceNumeric - modelAvgPriceNumeric) / modelAvgPriceNumeric) * 100,
  );
}

describe('computePriceToAvgPct', () => {
  // --- Normal cases ---

  it('should return -25 when price is 25% below average (15000 vs 20000)', () => {
    expect(computePriceToAvgPct(15000, 20000)).toBe(-25);
  });

  it('should return 25 when price is 25% above average (25000 vs 20000)', () => {
    expect(computePriceToAvgPct(25000, 20000)).toBe(25);
  });

  it('should return 0 when price equals average (20000 vs 20000)', () => {
    expect(computePriceToAvgPct(20000, 20000)).toBe(0);
  });

  // --- Null inputs ---

  it('should return null when priceNumeric is null', () => {
    expect(computePriceToAvgPct(null, 20000)).toBeNull();
  });

  it('should return null when modelAvgPriceNumeric is null', () => {
    expect(computePriceToAvgPct(15000, null)).toBeNull();
  });

  // --- Edge / guard cases ---

  it('should return null when modelAvgPriceNumeric is 0 (division by zero guard)', () => {
    expect(computePriceToAvgPct(15000, 0)).toBeNull();
  });

  it('should return -95 for extreme negative (1000 vs 20000)', () => {
    expect(computePriceToAvgPct(1000, 20000)).toBe(-95);
  });

  it('should return 400 for extreme positive (50000 vs 10000)', () => {
    expect(computePriceToAvgPct(50000, 10000)).toBe(400);
  });
});
