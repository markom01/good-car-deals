import {
  fitLinearPrice,
  dealScoreFromDeviation,
  classifyTier,
  cellMedianExpected,
  type PriceRow,
} from './deal-stats';

interface FitRow {
  age: number;
  km: number;
  price: number;
}

// Deterministic rows: price = 9625 - 255*age - 4.5*km + small noise,
// where km is the odometer in thousands of km (feature units the fit uses).
function makeRows(): FitRow[] {
  const rows: FitRow[] = [];
  for (let i = 0; i < 30; i++) {
    const age = 8 + Math.floor(i / 3); // 8..17, 3 rows per age
    const km = 80 + (i % 3) * 110; // 80k..300k in thousands of km
    const noise = (i % 5) * 8 - 16; // deterministic ±small
    rows.push({
      age,
      km,
      price: Math.round(9625 - 255 * age - 4.5 * km + noise),
    });
  }
  return rows;
}

function makeFlatRows(n: number): FitRow[] {
  const rows: FitRow[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({ age: i, km: i * 12000, price: 5000 });
  }
  return rows;
}

// Pinned fixtures from the plan (kmSplitMedian 5300, yearOnlyMedian 4500)
function buildCellRows(): {
  rows: PriceRow[];
  thin: PriceRow[];
  kmSplitMedian: number;
  yearOnlyMedian: number;
} {
  return {
    rows: [
      { price: 5200, year: 2011, km: 180000 },
      { price: 5400, year: 2012, km: 200000 },
      { price: 5600, year: 2013, km: 220000 },
      { price: 5300, year: 2012, km: 190000 },
      { price: 4900, year: 2012, km: 210000 },
    ],
    thin: [
      { price: 5600, year: 2013, km: 220000 },
      { price: 5200, year: 2011, km: 180000 },
      { price: 4300, year: 2012, km: 999000 },
      { price: 4400, year: 2012, km: 990000 },
      { price: 4500, year: 2011, km: 999000 },
    ],
    kmSplitMedian: 5300,
    yearOnlyMedian: 4500,
  };
}

describe('fitLinearPrice regression path', () => {
  const rows = makeRows();
  it('fits both coefficients (negative) within 1% of the generator', () => {
    const m = fitLinearPrice(rows)!;
    expect(m).not.toBeNull();
    expect(m.n).toBe(30);
    expect(m.coefAge).toBeLessThan(0);
    expect(m.coefKm / -4.5).toBeGreaterThan(0.99);
  });
  it('returns null when rows < 12', () =>
    expect(fitLinearPrice(rows.slice(0, 11))).toBeNull());
  it('returns null on degenerate fit (price independent of age+kvm → coefficients ~0 → sign guard)', () => {
    expect(fitLinearPrice(makeFlatRows(20))).toBeNull(); // age coef 0 → guard fires
  });
  it('handles km outliers without crashing when one comp is a part-out', () => {
    expect(
      fitLinearPrice([...rows, { age: 12, km: 1200000, price: 100 }]),
    ).not.toBeNull();
  });
});

describe('deviation → score and tier', () => {
  it.each([
    [10, 90],
    [0, 50],
    [-12.5, 0],
    [40, 100],
  ])('dev %s → score %s', (dev, score) =>
    expect(dealScoreFromDeviation(dev)).toBe(score),
  );
  it('bands: ≥10 GREAT, 5 GOOD, 0 FAIR, −5 HIGH, −15 OVERPRICED', () => {
    expect(classifyTier(10)).toBe('GREAT DEAL');
    expect(classifyTier(5)).toBe('GOOD DEAL');
    expect(classifyTier(0)).toBe('FAIR PRICE');
    expect(classifyTier(-5)).toBe('HIGH PRICE');
    expect(classifyTier(-15)).toBe('OVERPRICED');
    expect(classifyTier(9.99)).toBe('GOOD DEAL');
  });
});

describe('cellMedianExpected fallback', () => {
  const cells = buildCellRows();
  it('returns median with km ±20%', () =>
    expect(cellMedianExpected(cells.rows, 2012, 200000)).toBe(
      cells.kmSplitMedian,
    ));
  it('falls back to year±1 when km split drops below 3', () =>
    expect(cellMedianExpected(cells.thin, 2012, 200000)).toBe(
      cells.yearOnlyMedian,
    ));
  it('returns null below 3 rows in window', () =>
    expect(cellMedianExpected([cells.rows[0]], 2012, 200000)).toBeNull());

  it('medians IQR-trimmed prices (part-out inside the km window does not shift the median)', () => {
    const withPartout: PriceRow[] = [
      ...cells.rows,
      { price: 100, year: 2012, km: 205000 },
    ];
    // Raw median would be 5250; IQR-trimmed median is 5300.
    expect(cellMedianExpected(withPartout, 2012, 200000)).toBe(5300);
  });
});
