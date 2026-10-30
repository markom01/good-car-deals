import {
  fitPriceModel,
  expectedPrice,
  dealScoreFromDeviation,
  classifyTier,
  cellMedianExpected,
  clampExpected,
  capDeviation,
  percentileScores,
  MAX_DEVIATION_PCT,
  type PriceRow,
} from './deal-stats';

interface FitRow {
  age: number;
  km: number;
  price: number;
}

// Deterministic log-linear generator:
// price = 9600 * exp(-0.09*age - 0.0009*km + noise), km in thousands.
// The log-price fit must recover the exponential coefficients.
function makeRows(): FitRow[] {
  const rows: FitRow[] = [];
  for (let i = 0; i < 30; i++) {
    const age = 8 + Math.floor(i / 3); // 8..17, 3 rows per age
    const km = 80 + (i % 3) * 110; // 80k..300k in thousands of km
    const noise = (i % 5) * 0.004 - 0.008; // deterministic ±0.8%
    rows.push({
      age,
      km,
      price: Math.round(9600 * Math.exp(-0.09 * age - 0.0009 * km + noise)),
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

describe('percentileScores', () => {
  it('maps rank position to 0..100 (median ≈ 50)', () => {
    expect(percentileScores([10, 0, -5, 20])).toEqual([67, 33, 0, 100]);
  });

  it('ties get adjacent ranks, scores stay distinct', () => {
    expect(percentileScores([5, 5, 10])).toEqual([0, 50, 100]);
  });

  it('single rated row sits mid-market (50)', () => {
    expect(percentileScores([7])).toEqual([50]);
  });

  it('empty input → empty output', () => {
    expect(percentileScores([])).toEqual([]);
  });
});

describe('fitPriceModel (log-price regression path)', () => {
  const rows = makeRows();
  it('recovers both exponential depreciation coefficients within 1%', () => {
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.n).toBe(30);
    expect(m.coefAge / -0.09).toBeGreaterThan(0.99);
    expect(m.coefAge / -0.09).toBeLessThan(1.01);
    expect(m.coefKm / -0.0009).toBeGreaterThan(0.99);
    expect(m.coefKm / -0.0009).toBeLessThan(1.01);
  });
  it('returns null when rows < 12', () =>
    expect(fitPriceModel(rows.slice(0, 11))).toBeNull());
  it('returns null on degenerate fit (price independent of age+km → coefficients ~0 → sign guard)', () => {
    expect(fitPriceModel(makeFlatRows(20))).toBeNull(); // age coef 0 → guard fires
  });
  it('handles km outliers without crashing when one comp is a part-out', () => {
    expect(
      fitPriceModel([...rows, { age: 12, km: 1200000, price: 100 }]),
    ).not.toBeNull();
  });
  it('keeps expected prices sane for extreme age/km (no collapse toward zero)', () => {
    const m = fitPriceModel(rows)!;
    const exp = expectedPrice(m, 30, 600000);
    expect(Number.isFinite(exp)).toBe(true);
    expect(exp).toBeGreaterThan(100); // raw-price linear fit went negative here
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

describe('clampExpected', () => {
  const prices = [
    1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000,
  ];

  it('clamps outside the IQR-trimmed observed price range', () => {
    expect(clampExpected(50, prices)).toBe(1000);
    expect(clampExpected(50000, prices)).toBe(11000);
  });

  it('ignores a part-out when setting the floor', () => {
    const tight = [5000, 5200, 5400, 5600, 5800, 6000, 6200];
    expect(clampExpected(50, [...tight, 100])).toBe(5000);
  });

  it('leaves in-band expectations untouched', () => {
    expect(clampExpected(5000, prices)).toBe(5000);
  });

  it('no prices → value unchanged', () => {
    expect(clampExpected(1234, [])).toBe(1234);
  });
});

describe('capDeviation', () => {
  it(`caps at ±${MAX_DEVIATION_PCT}`, () => {
    expect(capDeviation(-3681)).toBe(-MAX_DEVIATION_PCT);
    expect(capDeviation(80)).toBe(MAX_DEVIATION_PCT);
    expect(capDeviation(12.5)).toBe(12.5);
  });
});

describe('fitPriceModel power/fuel/transmission terms', () => {
  // Base generator (same as makeRows) + multiplicative engine trim terms:
  // price = 9600 * exp(-0.09*age - 0.0009*km + 0.004*kw + 0.05*diesel + 0.08*auto + noise).
  // kw cycles 55..95 (5 values), diesel = 20/30 rows, auto = 10/30 rows
  // ((i*7)%10 < 4 — hits the ≥10-per-class boundary exactly).
  function makePowerRows(): {
    age: number;
    km: number;
    price: number;
    kw: number;
    diesel: boolean;
    auto: boolean;
  }[] {
    const rows = [];
    for (let i = 0; i < 30; i++) {
      const age = 8 + Math.floor(i / 3);
      const km = 80 + (i % 3) * 110;
      const kw = 55 + (i % 5) * 10;
      const diesel = i % 3 !== 0;
      const auto = (i * 7) % 10 < 4;
      const noise = (i % 5) * 0.004 - 0.008;
      rows.push({
        age,
        km,
        kw,
        diesel,
        auto,
        price: Math.round(
          9600 *
            Math.exp(
              -0.09 * age -
                0.0009 * km +
                0.004 * kw +
                0.05 * Number(diesel) +
                0.08 * Number(auto) +
                noise,
            ),
        ),
      });
    }
    return rows;
  }

  it('recovers power, diesel and auto terms when both classes ≥ 10 rows', () => {
    const m = fitPriceModel(makePowerRows())!;
    expect(m).not.toBeNull();
    expect(m.coefKw).toBeGreaterThan(0.0035);
    expect(m.coefKw).toBeLessThan(0.0045);
    expect(m.coefDiesel).toBeGreaterThan(0.04);
    expect(m.coefDiesel).toBeLessThan(0.06);
    expect(m.coefAuto).toBeGreaterThan(0.07);
    expect(m.coefAuto).toBeLessThan(0.09);
  });

  it('expectedPrice applies kw/diesel/auto attrs (matches generator within 3%)', () => {
    const m = fitPriceModel(makePowerRows())!;
    // Row i=5: age=9, km=300, kw=75, diesel=true, auto=false.
    const gen = 9600 * Math.exp(-0.09 * 9 - 0.0009 * 300 + 0.004 * 75 + 0.05);
    const exp = expectedPrice(m, 9, 300, { kw: 75, diesel: true, auto: false });
    expect(Math.abs(exp - gen) / gen).toBeLessThanOrEqual(0.03);
  });

  it('expectedPrice without attrs mean-imputes kW (kw=0 would understate)', () => {
    const m = fitPriceModel(makePowerRows())!;
    // kw cycles 55..95 → fit-sample mean 75.
    expect(m.meanKw).toBeCloseTo(75, 6);
    const imputed = Math.exp(
      m.intercept + m.coefAge * 9 + m.coefKm * 190 + m.coefKw! * 75,
    );
    expect(expectedPrice(m, 9, 190)).toBeCloseTo(imputed, 6);
    expect(expectedPrice(m, 9, 190, { kw: null })).toBeCloseTo(imputed, 6);
    // Explicit kw still applied verbatim, not imputed.
    const explicit = Math.exp(
      m.intercept + m.coefAge * 9 + m.coefKm * 190 + m.coefKw! * 90,
    );
    expect(expectedPrice(m, 9, 190, { kw: 90 })).toBeCloseTo(explicit, 6);
  });

  it('wrong-sign power term is dropped and the fit falls back to age+km', () => {
    const rows = makePowerRows().map((r) => ({
      ...r,
      price: Math.round(r.price * Math.exp(-0.008 * r.kw)), // kills the positive kw signal
    }));
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.coefKw).toBeUndefined();
    expect(m.coefAge).toBeLessThan(0);
  });

  it('dummy class below 10 rows is dropped, power term survives', () => {
    const rows = makePowerRows().map((r, i) => ({
      ...r,
      auto: i % 15 === 0, // only 2 automatics
    }));
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.coefAuto).toBeUndefined();
    expect(m.coefKw).toBeGreaterThan(0.0035);
  });

  it('diesel class below 10 rows is dropped, auto term survives', () => {
    const rows = makePowerRows().map((r, i) => ({
      ...r,
      diesel: i % 15 === 0, // only 2 diesels
    }));
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.coefDiesel).toBeUndefined();
    expect(m.coefAuto).toBeGreaterThan(0.07);
    expect(m.coefKw).toBeGreaterThan(0.0035);
  });

  it('dummy guard runs on the kwRows fit sample, not on all usable rows', () => {
    // kw present for i<13 (kwRows = 13): within that sample diesel has 8/5
    // and auto 5/8 rows per class — both dummies fail the ≥10 guard even
    // though the FULL 30-row sample qualifies (20/10 diesel, 10/20 auto).
    // The fit must be kw-only on the 13 kwRows.
    const rows = makePowerRows().map((r, i) =>
      i < 13 ? r : { ...r, kw: null as unknown as number },
    );
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.coefKw).toBeGreaterThan(0.0035);
    expect(m.coefDiesel).toBeUndefined();
    expect(m.coefAuto).toBeUndefined();
    expect(m.n).toBe(13);
  });

  it('singular full spec (diesel collinear with kw) falls back to plain age+km', () => {
    // diesel ≡ (kw === 95) with binary kw {55,95}: the dummy column is an
    // exact linear function of [1, kw] → singular normal-equations matrix
    // → the plain age+km spec on ALL usable rows is the fallback. Small km
    // values keep elimination rounding far below the 1e-9 pivot threshold.
    const rows: {
      age: number;
      km: number;
      price: number;
      kw: number;
      diesel: boolean;
      auto: boolean;
    }[] = [];
    for (let i = 0; i < 30; i++) {
      const age = 8 + Math.floor(i / 3);
      const km = 1 + (i % 3);
      const kw = i % 2 ? 95 : 55;
      const diesel = kw === 95;
      const noise = (i % 5) * 0.004 - 0.008;
      rows.push({
        age,
        km,
        kw,
        diesel,
        auto: i % 3 === 0,
        price: Math.round(
          9600 *
            Math.exp(
              -0.09 * age -
                0.0009 * km +
                0.004 * kw +
                0.08 * Number(diesel) +
                noise,
            ),
        ),
      });
    }
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.coefKw).toBeUndefined();
    expect(m.coefDiesel).toBeUndefined();
    expect(m.coefAuto).toBeUndefined();
    expect(m.n).toBe(30);
    expect(m.coefAge).toBeLessThan(0);
  });

  it('kw term used only when ≥ 12 rows carry kw (fit stays on all rows)', () => {
    const rows = makePowerRows().map((r, i) =>
      i < 8 ? r : { ...r, kw: null as unknown as number },
    );
    const m = fitPriceModel(rows)!;
    expect(m).not.toBeNull();
    expect(m.coefKw).toBeUndefined();
    expect(m.n).toBe(30);
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
