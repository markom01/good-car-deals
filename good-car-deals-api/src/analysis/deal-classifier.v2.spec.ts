import { classifyGroups, type ClassifierRow } from './deal-classifier.service';
import { MAX_DEVIATION_PCT } from './deal-stats';

// Real artifact-style names: Opel Astra generations are 'F', 'G', 'H', 'J',
// 'K', 'L' in generation-periods.json. Short names also expose the collision
// defect — 'MK1' and 'J' are shared by hundreds of other models.
const GEN_A = 'J';
const GEN_B = 'K';

// Rows for one generation share model 'Opel Astra' + a generation string.
// Flat prices per generation so IQR keeps all 12 rows (a 100-step ramp would
// drop four extremes, leaving 8 kept rows below the 10-comp gate).
function genRow(
  id: number,
  year: number,
  km: number,
  price: number,
  generation: string = GEN_A,
  model = 'Opel Astra',
): ClassifierRow {
  return {
    id,
    model,
    generation,
    priceNumeric: price,
    year,
    age: 2026 - year,
    mileageKm: km,
    powerKw: 100,
    fuelType: 'Dizel',
    transmission: 'Manuelni 5 brzina',
  };
}

describe('classifyGroups (property-based expected price)', () => {
  it('two generations of one model never mix: benchmarks differ per group', () => {
    const g1 = Array.from({ length: 12 }, (_, i) =>
      genRow(1 + i, 2009 + i, 100_000 + i * 10_000, 10_000, GEN_A),
    );
    const g2 = Array.from({ length: 12 }, (_, i) =>
      genRow(10 + i, 2016 + i, 100_000 + i * 10_000, 5_000, GEN_B),
    );
    const out = classifyGroups([...g1, ...g2]);
    const a = out.find((r) => r.id === 1)!;
    const b = out.find((r) => r.id === 10)!;
    expect(a.expectedPrice).not.toBeNull();
    expect(b.expectedPrice).not.toBeNull();
    // Both rows are the same model and the same odometer; only the
    // generation differs, so the benchmarks must reflect the price level.
    expect(a.expectedPrice! / b.expectedPrice!).toBeGreaterThan(1.05);
    expect(a.dealType).not.toBe('UNRATED');
    expect(b.dealType).not.toBe('UNRATED');
    expect(a.sampleSize).toBe(11);
    expect(b.sampleSize).toBe(11);
  });

  it('same generation name under different models → separate benchmarks', () => {
    const peugeot = Array.from({ length: 12 }, (_, i) =>
      genRow(500 + i, 2013, 100_000 + i * 10_000, 9_000, 'MK1', 'Peugeot 208'),
    );
    const duster = Array.from({ length: 12 }, (_, i) =>
      genRow(510 + i, 2013, 100_000 + i * 10_000, 5_000, 'MK1', 'Dacia Duster'),
    );
    const out = classifyGroups([...peugeot, ...duster]);
    const p = out.find((r) => r.id === 500)!;
    const d = out.find((r) => r.id === 510)!;
    expect(p.expectedPrice).not.toBeNull();
    expect(d.expectedPrice).not.toBeNull();
    expect(p.dealType).not.toBe('UNRATED');
    expect(d.dealType).not.toBe('UNRATED');
    expect(p.expectedPrice! / d.expectedPrice!).toBeGreaterThan(1.05);
    expect(p.sampleSize).toBe(11);
    expect(d.sampleSize).toBe(11);
  });

  it('pool below 11 kept rows → every row UNRATED (10-comp gate)', () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      genRow(20 + i, 2010 + i, 120_000 + i * 5_000, 10_000),
    );
    const out = classifyGroups(rows);
    expect(out).toHaveLength(10);
    for (const r of out) {
      expect(r).toMatchObject({
        dealType: 'UNRATED',
        dealScore: 0,
        expectedPrice: null,
        deviationPct: null,
        sampleSize: null,
      });
    }
  });

  it('unresolved model → UNRATED; resolved siblings of same model still rated', () => {
    const rated = Array.from({ length: 12 }, (_, i) =>
      genRow(30 + i, 2009 + i, 100_000 + i * 10_000, 10_000),
    );
    const unresolved: ClassifierRow = {
      id: 99,
      model: 'Dacia Nonexistent',
      generation: null,
      priceNumeric: 5000,
      year: 2018,
      age: 8,
      mileageKm: 100_000,
      powerKw: null,
      fuelType: null,
      transmission: null,
    };
    const out = classifyGroups([...rated, unresolved]);
    expect(out.find((r) => r.id === 99)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
      expectedPrice: null,
      deviationPct: null,
      sampleSize: null,
    });
    for (const r of rated) {
      expect(out.find((x) => x.id === r.id)!.dealType).not.toBe('UNRATED');
    }
  });

  it('reports comps excluding the scored row', () => {
    const rows = Array.from({ length: 11 }, (_, i) =>
      genRow(700 + i, 2012, 100_000 + i * 10_000, 10_000),
    );
    const out = classifyGroups(rows);
    for (const r of out) {
      expect(r.sampleSize).toBe(10);
      expect(r.expectedPrice).not.toBeNull();
    }
  });

  it('absolute rubric (50 + dev), not a market percentile', () => {
    const flat = Array.from({ length: 12 }, (_, i) =>
      genRow(40 + i, 2012, 150_000, 8_000),
    );
    const cheap = genRow(200, 2012, 150_000, 6_800); // dev +15% → score 65
    const dear = genRow(201, 2012, 150_000, 9_000); // dev -12.5% → score 38
    const out = classifyGroups([...flat, cheap, dear]);

    expect(out.find((r) => r.id === 200)!.deviationPct).toBeCloseTo(15, 5);
    expect(out.find((r) => r.id === 200)!.dealScore).toBe(65);
    expect(out.find((r) => r.id === 201)!.deviationPct).toBeCloseTo(-12.5, 5);
    expect(out.find((r) => r.id === 201)!.dealScore).toBe(38);
    for (const r of flat) {
      expect(out.find((x) => x.id === r.id)!.dealScore).toBe(50);
      expect(out.find((x) => x.id === r.id)!.sampleSize).toBe(11);
    }
  });

  it('charges less for higher km at equal ask within a group', () => {
    const low = Array.from({ length: 12 }, (_, i) =>
      genRow(50 + i, 2012, 90_000 + i * 10_000, 9_000),
    );
    const high = Array.from({ length: 12 }, (_, i) =>
      genRow(60 + i, 2012, 210_000 + i * 10_000, 7_500),
    );
    const out = classifyGroups([...low, ...high]);
    const a = out.find((r) => r.id === 50)!;
    const b = out.find((r) => r.id === 60)!;
    expect(a.expectedPrice).not.toBeNull();
    expect(b.expectedPrice).not.toBeNull();
    expect(b.expectedPrice!).toBeLessThan(a.expectedPrice!);
    expect(a.sampleSize).toBe(23);
    expect(b.sampleSize).toBe(23);
  });

  it('GREAT requires both pct and euro legs: 8% of a 3_000 benchmark passes GOOD', () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      genRow(60 + i, 2012, 150_000, 3_000),
    );
    const probe = genRow(400, 2012, 150_000, 2_760); // dev 8%, devEur 240
    const out = classifyGroups([...pool, probe]);
    const r = out.find((x) => x.id === 400)!;
    expect(r.deviationPct).toBeCloseTo(8, 5);
    expect(r.dealType).toBe('GOOD DEAL');
    expect(r.dealScore).toBe(58);
    expect(r.sampleSize).toBe(12);
  });

  it('price-null / km-null / year-null rows inside a healthy group → UNRATED', () => {
    const healthy = Array.from({ length: 12 }, (_, i) =>
      genRow(70 + i, 2009 + i, 100_000 + i * 10_000, 10_000 - i * 100),
    );
    const stalePrice: ClassifierRow = {
      id: 904,
      model: 'Opel Astra',
      generation: GEN_A,
      priceNumeric: null,
      year: 2015,
      age: 11,
      mileageKm: 120_000,
      powerKw: null,
      fuelType: null,
      transmission: null,
    };
    const noKm: ClassifierRow = {
      id: 903,
      model: 'Opel Astra',
      generation: GEN_A,
      priceNumeric: 5_000,
      year: 2012,
      age: 14,
      mileageKm: null,
      powerKw: null,
      fuelType: null,
      transmission: null,
    };
    const noYear: ClassifierRow = {
      id: 902,
      model: 'Opel Astra',
      generation: GEN_A,
      priceNumeric: 5_000,
      year: null,
      age: null,
      mileageKm: 150_000,
      powerKw: null,
      fuelType: null,
      transmission: null,
    };
    const out = classifyGroups([...healthy, stalePrice, noKm, noYear]);
    for (const id of [904, 903, 902]) {
      expect(out.find((r) => r.id === id)).toMatchObject({
        dealType: 'UNRATED',
        dealScore: 0,
        expectedPrice: null,
        deviationPct: null,
        sampleSize: null,
      });
    }
    for (const r of healthy) {
      expect(out.find((x) => x.id === r.id)!.dealType).not.toBe('UNRATED');
    }
  });

  it(`caps deviations at ±${MAX_DEVIATION_PCT}%`, () => {
    const pool = Array.from({ length: 12 }, (_, i) =>
      genRow(80 + i, 2012, 150_000, 3_000),
    );
    const freeCar = genRow(951, 2012, 150_000, 1);
    const overpriced = genRow(952, 2012, 150_000, 100_000);
    const out = classifyGroups([...pool, freeCar, overpriced]);
    expect(out.find((r) => r.id === 951)!.deviationPct).toBe(MAX_DEVIATION_PCT);
    expect(out.find((r) => r.id === 952)!.deviationPct).toBe(
      -MAX_DEVIATION_PCT,
    );
    expect(out.find((r) => r.id === 951)!.dealType).toBe('GREAT DEAL');
    expect(out.find((r) => r.id === 952)!.dealType).toBe('OVERPRICED');
    expect(out.find((r) => r.id === 951)!.sampleSize).toBe(12);
    expect(out.find((r) => r.id === 952)!.sampleSize).toBe(12);
  });
});
