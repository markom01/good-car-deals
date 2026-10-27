import { classifyGroups, type ClassifierRow } from './deal-classifier.service';

// Market generator: price = 9625 - 255*age - 4.5*kmThousands + small noise.
// Rows carry RAW odometer km (mileageKm), generator converts to thousands.
function genPrice(age: number, kmThousands: number): number {
  return 9625 - 255 * age - 4.5 * kmThousands;
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
function makeGroupRows(model: string, offset: number): ClassifierRow[] {
  const rows: ClassifierRow[] = [];
  for (let i = 0; i < 12; i++) {
    const age = 6 + (i % 7) * 2; // 6..18, only even ages
    const kmThousands = 60 + ((i * 13) % 9) * 18; // 60..204, unaligned cycle
    rows.push({
      id: (model === 'Astra J' ? 700 : 712) + i,
      model,
      priceNumeric: Math.round(
        genPrice(age, kmThousands) + offset + ((i % 5) * 8 - 16),
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

  it('two model groups never share a fit (Astra J + Astra H rows with offset price levels)', () => {
    const jRows = makeGroupRows('Astra J', 0);
    const hRows = makeGroupRows('Astra H', 2000);
    const out = classifyGroups([...jRows, ...hRows]);
    expect(out).toHaveLength(24);
    for (const r of out) {
      const src = r.id >= 712 ? hRows : jRows;
      const row = src.find((s) => s.id === r.id)!;
      const ownGen =
        genPrice(row.age!, row.mileageKm! / 1000) + (r.id >= 712 ? 2000 : 0);
      expect(Math.abs(r.expectedPrice! - ownGen)).toBeLessThanOrEqual(
        0.1 * ownGen,
      );
    }
  });
});
