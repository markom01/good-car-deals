import { classifyGroups, type ClassifierRow } from './deal-classifier.service';
import { MAX_DEVIATION_PCT } from './deal-stats';

// Market generator is log-linear:
// price = 14000 * exp(-0.075*age - 0.0016*kmThousands).
// Rows carry RAW odometer km (mileageKm), the generator converts to thousands.
function genPrice(age: number, kmThousands: number): number {
  return Math.round(14000 * Math.exp(-0.075 * age - 0.0016 * kmThousands));
}

function makeMarketRows(): ClassifierRow[] {
  const rows: ClassifierRow[] = [];
  for (let i = 0; i < 20; i++) {
    const age = 5 + (i % 10); // 5..14, two rows per age
    const kmThousands = 40 + (i % 10) * 22; // 40..238, unaligned with age cycle
    rows.push({
      id: i + 1,
      model: 'Astra J',
      priceNumeric: Math.round(genPrice(age, kmThousands) + ((i % 5) * 8 - 16)),
      year: 2026 - age,
      age,
      mileageKm: kmThousands * 1000,
    });
  }
  return rows;
}

const BELOW_ID = 900;
const PARTOUT_ID = 901;

// 12.5% below generator → dev ≈ +12.5 → score 100 → tops the board.
function belowMarketRow(): ClassifierRow {
  const age = 8;
  const kmThousands = 120;
  const gen = genPrice(age, kmThousands);
  return {
    id: BELOW_ID,
    model: 'Astra J',
    priceNumeric: Math.round(gen * 0.875),
    year: 2026 - age,
    age,
    mileageKm: kmThousands * 1000,
  };
}

// Cheap part-out: extreme km drives its own low expected price; priced
// ~12% below that low expected → finite deviation, doesn't top the board.
function partOutRow(): ClassifierRow {
  const age = 12;
  const kmThousands = 850; // km-driven low expected
  const gen = genPrice(age, kmThousands);
  return {
    id: PARTOUT_ID,
    model: 'Astra J',
    priceNumeric: Math.round(gen * 0.88),
    year: 2026 - age,
    age,
    mileageKm: kmThousands * 1000,
  };
}

function noYearRow(): ClassifierRow {
  return {
    id: 902,
    model: 'Astra J',
    priceNumeric: 5000,
    year: null,
    age: null,
    mileageKm: 150000,
  };
}

function noKmRow(): ClassifierRow {
  return {
    id: 903,
    model: 'Astra J',
    priceNumeric: 5000,
    year: 2012,
    age: 14,
    mileageKm: null,
  };
}

// 12 usable rows per group is enough for the regression path.
function makeGroupRows(model: string, factor: number): ClassifierRow[] {
  const rows: ClassifierRow[] = [];
  for (let i = 0; i < 12; i++) {
    const age = 6 + (i % 7) * 2; // 6..18, only even ages
    const kmThousands = 60 + ((i * 13) % 9) * 18; // 60..204, unaligned cycle
    rows.push({
      id: (model === 'Astra J' ? 700 : 712) + i,
      model,
      priceNumeric: Math.round(
        genPrice(age, kmThousands) * factor + ((i % 5) * 8 - 16),
      ),
      year: 2026 - age,
      age,
      mileageKm: kmThousands * 1000,
    });
  }
  return rows;
}

describe('classifyGroups', () => {
  it('regression path: scores the cheap-but-consistent row BEST, part-out row scored not crashed', () => {
    const rows = [...makeMarketRows(), belowMarketRow(), partOutRow()];
    const out = classifyGroups(rows);
    const top = [...out].sort((a, b) => b.dealScore - a.dealScore)[0];
    expect(top.dealType).toBe('GREAT DEAL');
    const partout = out.find((r) => r.id === PARTOUT_ID)!;
    expect(Number.isFinite(partout.deviationPct!)).toBe(true);
  });

  it('thin group (4 rows): cell median path used, all rows get finite expectedPrice or UNRATED', () => {
    const rows: ClassifierRow[] = [
      {
        id: 810,
        model: 'Astra K thin',
        priceNumeric: 5200,
        year: 2011,
        age: 15,
        mileageKm: 180000,
      },
      {
        id: 811,
        model: 'Astra K thin',
        priceNumeric: 5400,
        year: 2012,
        age: 14,
        mileageKm: 200000,
      },
      {
        id: 812,
        model: 'Astra K thin',
        priceNumeric: 5600,
        year: 2012,
        age: 14,
        mileageKm: 220000,
      },
      {
        id: 813,
        model: 'Astra K thin',
        priceNumeric: 5300,
        year: 2013,
        age: 13,
        mileageKm: 190000,
      },
    ];
    const out = classifyGroups(rows);
    expect(out).toHaveLength(4);
    for (const r of out) {
      expect(r.dealType).not.toBe('UNRATED');
      expect(r.expectedPrice).not.toBeNull();
      expect(Number.isFinite(r.expectedPrice!)).toBe(true);
    }
  });

  it('year-null and km-null rows → UNRATED with dealScore 0 even inside a healthy group', () => {
    const rows = [
      ...makeMarketRows(),
      belowMarketRow(),
      partOutRow(),
      noYearRow(),
      noKmRow(),
    ];
    const out = classifyGroups(rows);
    const unrated = (id: number) => out.find((r) => r.id === id)!;
    expect(unrated(902)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
    });
    expect(unrated(903)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
    });
  });

  it('price-null row inside a healthy group → UNRATED (no stale label)', () => {
    const stalePriceRow: ClassifierRow = {
      id: 904,
      model: 'Astra J',
      priceNumeric: null,
      year: 2015,
      age: 11,
      mileageKm: 120000,
    };
    const out = classifyGroups([
      ...makeMarketRows(),
      belowMarketRow(),
      partOutRow(),
      stalePriceRow,
    ]);
    expect(out.find((r) => r.id === 904)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
      expectedPrice: null,
      deviationPct: null,
    });
  });

  it('dealScore is a market percentile: distinct per rated row, best dev → 100, UNRATED stays 0', () => {
    const out = classifyGroups([
      ...makeMarketRows(),
      belowMarketRow(),
      partOutRow(),
      noYearRow(),
    ]);
    const rated = out.filter((r) => r.deviationPct !== null);
    const scores = rated.map((r) => r.dealScore);
    expect(new Set(scores).size).toBe(scores.length); // no ties
    const best = [...rated].sort(
      (a, b) => b.deviationPct! - a.deviationPct!,
    )[0];
    expect(best.dealScore).toBe(100);
    const worst = [...rated].sort((a, b) => a.dealScore - b.dealScore)[0];
    expect(worst.dealScore).toBe(0);
    expect(out.find((r) => r.id === 902)!.dealScore).toBe(0);
  });

  it('two model groups never share a fit (Astra J + Astra H rows with different price levels)', () => {
    const jRows = makeGroupRows('Astra J', 1);
    const hRows = makeGroupRows('Astra H', 1.5);
    const out = classifyGroups([...jRows, ...hRows]);
    expect(out).toHaveLength(24);
    for (const r of out) {
      const src = r.id >= 712 ? hRows : jRows;
      const row = src.find((s) => s.id === r.id)!;
      const ownGen =
        genPrice(row.age!, row.mileageKm! / 1000) * (r.id >= 712 ? 1.5 : 1);
      expect(Math.abs(r.expectedPrice! - ownGen)).toBeLessThanOrEqual(
        0.1 * ownGen,
      );
    }
  });

  it('extreme age/km row keeps a sane expected price inside the group band', () => {
    const market = makeMarketRows();
    const extreme: ClassifierRow = {
      id: 950,
      model: 'Astra J',
      priceNumeric: 1500,
      year: 2006,
      age: 20,
      mileageKm: 500000,
    };
    const out = classifyGroups([...market, extreme]);
    const r = out.find((x) => x.id === 950)!;
    const prices = market.map((m) => m.priceNumeric!);
    expect(r.expectedPrice).not.toBeNull();
    // Raw-price OLS predicted near-zero here; log fit + boundary clamping keep
    // the expectation inside the observed comparable market.
    expect(r.expectedPrice!).toBeGreaterThan(1000);
    expect(r.expectedPrice!).toBeLessThanOrEqual(Math.max(...prices));
  });

  it(`caps deviations at ±${MAX_DEVIATION_PCT}%`, () => {
    const market = makeMarketRows();
    const freeCar: ClassifierRow = {
      id: 951,
      model: 'Astra J',
      priceNumeric: 1,
      year: 2018,
      age: 8,
      mileageKm: 120000,
    };
    const overpriced: ClassifierRow = {
      id: 952,
      model: 'Astra J',
      priceNumeric: 100000,
      year: 2018,
      age: 8,
      mileageKm: 120000,
    };
    const out = classifyGroups([...market, freeCar, overpriced]);
    expect(out.find((r) => r.id === 951)!.deviationPct).toBe(MAX_DEVIATION_PCT);
    expect(out.find((r) => r.id === 952)!.deviationPct).toBe(
      -MAX_DEVIATION_PCT,
    );
    expect(out.find((r) => r.id === 951)!.dealType).toBe('GREAT DEAL');
    expect(out.find((r) => r.id === 952)!.dealType).toBe('OVERPRICED');
  });

  it('powerKw term: high-kw row priced without premium looks cheap, low-kw row priced at high-kw level looks expensive', () => {
    // 10 age/km pairs; within each pair age+km are identical while kw is
    // 60 vs 105 and the price carries the kw premium multiplicatively →
    // the kw coefficient is cleanly identified (no collinearity with age/km).
    const rows: ClassifierRow[] = [];
    let id = 1;
    for (let p = 0; p < 10; p++) {
      const age = 5 + p;
      const kmThousands = 40 + ((p * 7) % 10) * 22; // unaligned with age
      for (const kw of [60, 105]) {
        rows.push({
          id: id++,
          model: 'Astra J',
          priceNumeric: Math.round(
            genPrice(age, kmThousands) *
              Math.exp(0.004 * kw) *
              (1 + ((p % 5) * 0.002 - 0.004)),
          ),
          year: 2026 - age,
          age,
          mileageKm: kmThousands * 1000,
          powerKw: kw,
        });
      }
    }
    // Probe A: 105 kW engine priced at the plain age+km generator (no premium)
    // → kw-adjusted expectation is higher → positive deviation (cheap).
    const probeHigh: ClassifierRow = {
      ...belowMarketRow(),
      powerKw: 105,
      priceNumeric: Math.round(genPrice(8, 120)),
    };
    // Probe B: 60 kW engine priced WITH the 105 kW premium
    // → kw-adjusted expectation is the plain one → negative deviation.
    const probeLow: ClassifierRow = {
      ...belowMarketRow(),
      id: 906,
      powerKw: 60,
      priceNumeric: Math.round(genPrice(8, 120) * Math.exp(0.004 * 105)),
    };
    const out = classifyGroups([...rows, probeHigh, probeLow]);
    const a = out.find((r) => r.id === BELOW_ID)!;
    const b = out.find((r) => r.id === 906)!;
    expect(a.deviationPct! - b.deviationPct!).toBeGreaterThan(5);
    // kw term pushed the 105 kW expectation above the plain generator price
    // and above the 60 kW expectation (absolute coefficient size is pinned
    // in deal-stats.spec; here only ordering matters).
    expect(a.expectedPrice!).toBeGreaterThan(genPrice(8, 120));
    expect(a.expectedPrice!).toBeGreaterThan(b.expectedPrice!);
  });
});
