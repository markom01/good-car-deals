import {
  computeExpectedPrices,
  fuelCategory,
  isAutomatic,
} from './expected-price';

describe('fuelCategory', () => {
  it.each([
    ['Dizel', 'diesel'],
    ['Benzin', 'petrol'],
    ['Benzin + Gas (TNG)', 'gas'],
    ['Benzin + Metan (CNG)', 'gas'],
    ['Hibridni pogon (dizel)', 'hybrid'],
    ['Hibridni pogon (benzin)', 'hybrid'],
    ['Električni pogon', 'electric'],
    [null, 'petrol'],
    ['Nepoznato', 'petrol'],
  ])('%s → %s', (label, expected) => {
    expect(fuelCategory(label)).toBe(expected);
  });
});

describe('isAutomatic', () => {
  it.each([
    ['Automatski 6 brzina', true],
    ['Manuelni 5 brzina', false],
    [null, false],
    ['', false],
  ])('%s → %s', (label, expected) => {
    expect(isAutomatic(label)).toBe(expected);
  });
});

// --- computeExpectedPrices tests (Task 2) ---

const CURRENT_YEAR = new Date().getFullYear();

function row(overrides = {}) {
  return {
    id: 1,
    model: 'Test Model',
    generation: 'G1',
    price: 10_000,
    age: CURRENT_YEAR - 2015,
    km: 100_000,
    powerKw: 100,
    fuelType: 'Benzin',
    transmission: 'Manuelni 5 brzina',
    ...overrides,
  };
}

describe('computeExpectedPrices (property-based model)', () => {
  it('recovers a known age/km log-price surface (leave-one-out)', () => {
    const fit = Array.from({ length: 12 }, (_, i) => {
      const age = i;
      const km = [
        160_000, 50_000, 150_000, 60_000, 140_000, 70_000, 130_000, 80_000,
        120_000, 90_000, 110_000, 100_000,
      ][i];
      return row({
        id: i + 1,
        age,
        km,
        price: Math.exp(9 - 0.02 * age - 0.01 * (km / 10_000)),
      });
    });
    const out = computeExpectedPrices(fit);
    for (let i = 0; i < fit.length; i++) {
      expect(out[i].expectedPrice).not.toBeNull();
      expect(
        Math.abs(Math.log(out[i].expectedPrice) - Math.log(fit[i].price)),
      ).toBeLessThan(1e-6);
    }
  });

  it('does not price a row with its own ask', () => {
    const fit = Array.from({ length: 12 }, (_, i) =>
      row({ id: i + 1, age: i, km: 50_000 + i * 10_000, price: 10_000 }),
    );
    const before = computeExpectedPrices(fit).find((r) => r.id === 1);
    const changed = fit.map((r) => (r.id === 1 ? { ...r, price: 10_100 } : r));
    const after = computeExpectedPrices(changed).find((r) => r.id === 1);
    expect(before.expectedPrice).not.toBeNull();
    expect(after.expectedPrice).not.toBeNull();
    expect(after.expectedPrice).toBeCloseTo(before.expectedPrice, 9);
  });

  it('needs 10 comps excluding the scored row', () => {
    const eleven = Array.from({ length: 11 }, (_, i) =>
      row({ id: i + 1, age: i, km: 50_000 + i * 10_000, price: 10_000 }),
    );
    expect(
      computeExpectedPrices(eleven).every(
        (r) => r.expectedPrice !== null && r.sampleSize === 10,
      ),
    ).toBe(true);

    const ten = eleven.slice(0, 10);
    expect(
      computeExpectedPrices(ten).every(
        (r) => r.expectedPrice === null && r.sampleSize === null,
      ),
    ).toBe(true);
  });

  it('clamps an extreme probe to the observed price band', () => {
    const fit = Array.from({ length: 12 }, (_, i) =>
      row({
        id: i + 1,
        age: 5 + i,
        km: 50_000 + i * 10_000,
        price: 5_000 + i * 400,
      }),
    );
    const prices = fit.map((r) => r.price);
    const probe = row({ id: 99, age: 80, km: 900_000 });
    const out = computeExpectedPrices(fit, [probe])[0];
    expect(out.expectedPrice).not.toBeNull();
    expect(out.expectedPrice).toBeGreaterThanOrEqual(Math.min(...prices));
    expect(out.expectedPrice).toBeLessThanOrEqual(Math.max(...prices));
  });

  it('imputes missing power, fuel, and transmission', () => {
    const fit = Array.from({ length: 12 }, (_, i) =>
      row({ id: i + 1, age: 10, km: 100_000, price: 10_000 }),
    );
    const probe = row({
      id: 99,
      powerKw: null,
      fuelType: null,
      transmission: null,
    });
    const out = computeExpectedPrices(fit, [probe])[0];
    expect(out.expectedPrice).not.toBeNull();
    expect(out.expectedPrice).toBeCloseTo(10_000, 2);
    expect(out.sampleSize).toBe(12);
  });

  it('handles an all-electric group without a singular fit', () => {
    const fit = Array.from({ length: 12 }, (_, i) =>
      row({
        id: i + 1,
        age: 10,
        km: 100_000,
        price: 20_000,
        fuelType: 'Električni pogon',
      }),
    );
    const out = computeExpectedPrices(fit);
    expect(out.every((r) => r.expectedPrice !== null)).toBe(true);
    expect(out.every((r) => Number.isFinite(r.expectedPrice))).toBe(true);
  });

  it('charges more for power and diesel within a group', () => {
    const powerFit = Array.from({ length: 12 }, (_, i) => {
      const powerKw = 80 + i * 5;
      return row({
        id: i + 1,
        age: 10,
        km: 100_000,
        powerKw,
        price: Math.exp(9 + 0.4 * Math.log(powerKw)),
      });
    });
    const [lowPower, highPower] = computeExpectedPrices(powerFit, [
      row({ id: 90, powerKw: 80 }),
      row({ id: 91, powerKw: 135 }),
    ]);
    expect(lowPower.expectedPrice).not.toBeNull();
    expect(highPower.expectedPrice).not.toBeNull();
    expect(highPower.expectedPrice).toBeGreaterThan(
      lowPower.expectedPrice * 1.15,
    );

    const fuelFit = [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: i + 1, fuelType: 'Dizel', price: 10_000 }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        row({ id: i + 7, fuelType: 'Benzin', price: 9_000 }),
      ),
    ];
    const [diesel, petrol] = computeExpectedPrices(fuelFit, [
      row({ id: 92, fuelType: 'Dizel' }),
      row({ id: 93, fuelType: 'Benzin' }),
    ]);
    expect(diesel.expectedPrice).not.toBeNull();
    expect(petrol.expectedPrice).not.toBeNull();
    expect(diesel.expectedPrice).toBeGreaterThan(petrol.expectedPrice);
  });

  it('is deterministic', () => {
    const fit = Array.from({ length: 12 }, (_, i) =>
      row({ id: i + 1, age: i, km: 50_000 + i * 10_000 }),
    );
    expect(computeExpectedPrices(fit)).toEqual(computeExpectedPrices(fit));
  });
});
