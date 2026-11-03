import { describe, expect, it } from 'vitest';
import { estimateSerbiaImportCostsEur } from '@good-car-deals/shared';

describe('estimateSerbiaImportCostsEur', () => {
  it('matches the worked €10,000 import example (no origin proof)', () => {
    const est = estimateSerbiaImportCostsEur(10000);

    // customsValue = 10,000 + 500 = 10,500; duty 12.5% = 1,312.50
    expect(est.dutyEur).toBeCloseTo(1312.5, 2);
    // VAT base = 10,500 + 1,312.50 + 174 = 11,986.50; VAT 20% = 2,397.30
    expect(est.vatEur).toBeCloseTo(2397.3, 2);
    // total added ≈ 4,973.80; total realistic ≈ 14,973.80
    expect(est.totalAddedEur).toBeCloseTo(4973.8, 2);
    expect(est.totalRealisticEur).toBeCloseTo(14973.8, 2);
  });

  it('uses 0% duty when origin proof is provided', () => {
    const withProof = estimateSerbiaImportCostsEur(10000, { dutyRate: 0 });
    const without = estimateSerbiaImportCostsEur(10000);

    expect(withProof.dutyEur).toBe(0);
    expect(withProof.totalRealisticEur).toBeLessThan(without.totalRealisticEur);
  });

  it('honors overridden transport and fixed fees', () => {
    const a = estimateSerbiaImportCostsEur(10000, { transportEur: 0 });
    const b = estimateSerbiaImportCostsEur(10000, { transportEur: 1000 });
    expect(b.totalAddedEur).toBeGreaterThan(a.totalAddedEur);
  });
});
