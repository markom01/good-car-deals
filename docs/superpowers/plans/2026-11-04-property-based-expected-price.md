# Property-Based Expected Price Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mileage-only generation benchmark with a property-based expected asking price, gated at 10 comparable listings excluding the scored row.

**Architecture:** A new pure module fits a within-group log-price OLS over age, km, power, fuel, and transmission, then partially pools group intercepts through model and global levels. The classifier calls it once per pass, persists `expectedPrice`, `deviationPct`, and a new `expectedPriceSampleSize`, and leaves the existing tier/score rubric untouched. The card shows "typical asking price" plus the comp count; no range is shown.

**Tech Stack:** NestJS 11, Prisma 7, PostgreSQL, TypeScript, Jest 30, Vitest, Next.js 16.

**Spec:** `docs/superpowers/specs/2026-11-04-property-based-expected-price-design.md`

## Global Constraints

- Gate is **10 comparable rows excluding the scored row**. A group needs 11 kept fit rows for a row inside the fit sample to score.
- `EXPECTED_PRICE_MIN_COMPS = 10`; shrinkage `SHRINKAGE_K = 8`.
- Target is `ln(price)`; features are `[age, km/10_000, ln(powerKw), diesel, gas, hybrid, electric, automatic]`, petrol is the base fuel.
- No engine cc, no nonlinear age/km terms, no interactions.
- IQR-trim a group's fit rows only when it has at least 8 fit rows.
- Clamp age, km, and ln(power) to the group's observed fit-sample bounds; clamp expected price to the group's observed price band.
- No prediction range or confidence interval. No "fair value" wording.
- Card wording is **"typical asking price"**. Never "generation benchmark".
- Tier and score rules stay unchanged: deviation capped at ±50, `dealScore = clamp(round(50 + dev), 0, 100)`.
- No new runtime dependencies, no ML libraries, no scraping changes.
- Determinism: sort fit rows by `id`, classifier fetches with `orderBy: { id: 'asc' }`, compare floats with `1e-9`.
- The classifier always fits and persists all rows; no `limit` argument.
- Schema change is one nullable column: `expectedPriceSampleSize Int? @map("expected_price_sample_size")`.
- Run API unit tests with `npm run test` from `good-car-deals-api/`; frontend tests with `npm run test` from `good-car-deals-frontend/`.
- Do not run `prisma db push` against the production Neon database from this plan. Use the e2e test database URL explicitly.

## Review Focus

1. **Gate off-by-one:** a group with exactly 10 fit rows including the scored row must produce UNRATED; 11 must produce `sampleSize = 10`. Tests in Tasks 2–4.
2. **Extrapolation:** a 900,000 km / 80-year-old probe must stay inside the group's observed price band, never produce a near-zero or `e^-232` value. Test in Task 2.
3. **Hybrid label:** `Hibridni pogon (dizel)` must map to hybrid, not diesel; the mapping order is electric → hybrid → gas → diesel → petrol. Test in Task 1.
4. **Self-pricing:** changing a row's own ask must not change its expected price; the row is excluded from its group, model, and global sums. Test in Task 2.
5. **Degenerate features:** a missing-power row must be imputed and still score, and an all-electric group must not make the OLS singular. Tests in Task 2.

---

## File Structure

| File                                                              | Responsibility                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `good-car-deals-api/src/analysis/expected-price.ts` (new)         | Fuel/transmission mapping, feature vector, within-group OLS, hierarchical intercepts, leave-one-out prediction, gate, clamps. No Nest, no Prisma. |
| `good-car-deals-api/src/analysis/expected-price.spec.ts` (new)    | Unit tests for the pure module.                                                                                                                   |
| `good-car-deals-api/src/analysis/deal-classifier.service.ts`      | Maps DB rows to `ExpectedPriceRow`, calls the pure module, persists results.                                                                      |
| `good-car-deals-api/src/analysis/deal-classifier.v2.spec.ts`      | Pure classifier tests, rewritten for the new gate and features.                                                                                   |
| `good-car-deals-api/src/analysis/deal-classifier.service.spec.ts` | Service persistence tests, 12-row fixtures, no `limit`.                                                                                           |
| `good-car-deals-api/src/analysis/deal-stats.ts`                   | Keeps tier/score/deviation/IQR helpers; drops the legacy Theil–Sen benchmark.                                                                     |
| `good-car-deals-api/src/analysis/deal-stats.spec.ts`              | Drops legacy benchmark tests; keeps rubric and IQR tests.                                                                                         |
| `good-car-deals-api/prisma/schema.prisma`                         | Adds the nullable sample-size column.                                                                                                             |
| `packages/shared/src/index.ts`                                    | Adds `expectedPriceSampleSize` and updates comments.                                                                                              |
| `good-car-deals-api/src/deals/deals.service.ts`                   | Doc comment only; the spread already carries the new field.                                                                                       |
| `good-car-deals-frontend/src/components/deal-card.tsx`            | New "typical asking price" line and comp count.                                                                                                   |
| `good-car-deals-frontend/src/components/deal-card.test.tsx`       | Copy and sample-size assertions.                                                                                                                  |
| `good-car-deals-api/test/0-full-flow.e2e-spec.ts`                 | Deterministic 12-row fixture so `/deals` is non-empty under the gate.                                                                             |
| `good-car-deals-api/tools/evaluate-expected-price.ts` (new)       | Committed 80/20 holdout evaluator with the legacy baseline copy.                                                                                  |
| `AGENTS.md`, `good-car-deals-api/AGENTS.md`                       | Update the deal-scoring description and gotchas.                                                                                                  |

---

### Task 1: Fuel and transmission mapping

**Files:**

- Create: `good-car-deals-api/src/analysis/expected-price.ts`
- Test: `good-car-deals-api/src/analysis/expected-price.spec.ts`

**Interfaces:**

- Produces: `EXPECTED_PRICE_MIN_COMPS = 10`, `SHRINKAGE_K = 8`, `type FuelCategory = 'petrol' | 'diesel' | 'gas' | 'hybrid' | 'electric'`, `fuelCategory(label: string | null | undefined): FuelCategory`, `isAutomatic(transmission: string | null | undefined): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { fuelCategory, isAutomatic } from './expected-price';

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
  ] as const)('%s → %s', (label, expected) => {
    expect(fuelCategory(label)).toBe(expected);
  });
});

describe('isAutomatic', () => {
  it.each([
    ['Automatski 6 brzina', true],
    ['Manuelni 5 brzina', false],
    [null, false],
    ['', false],
  ] as const)('%s → %s', (label, expected) => {
    expect(isAutomatic(label)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd good-car-deals-api && npx jest src/analysis/expected-price.spec.ts --runInBand`

Expected: FAIL — cannot find module `./expected-price`.

- [ ] **Step 3: Implement the mapping and constants**

Use lowercase substring checks in this exact order: `elektri`/`electric` → electric, `hibrid`/`hybrid` → hybrid, `gas`/`metan`/`tng`/`cng` → gas, `dizel`/`diesel` → diesel, otherwise petrol. Hybrid must be checked before diesel so `Hibridni pogon (dizel)` is hybrid. `isAutomatic` returns true when the lowercased label includes `automat`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd good-car-deals-api && npx jest src/analysis/expected-price.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/src/analysis/expected-price.ts good-car-deals-api/src/analysis/expected-price.spec.ts
git commit -m "feat(analysis): add expected-price feature mapping"
```

---

### Task 2: Fit and predict the expected price

**Files:**

- Modify: `good-car-deals-api/src/analysis/expected-price.ts`
- Modify: `good-car-deals-api/src/analysis/expected-price.spec.ts`

**Interfaces:**

- Consumes: `fuelCategory`, `isAutomatic`, `EXPECTED_PRICE_MIN_COMPS`, `SHRINKAGE_K`, `iqrTrimmed` from `./deal-stats`.
- Produces:

  ```ts
  export interface ExpectedPriceRow {
    id: number;
    model: string;
    generation: string;
    price: number;
    age: number;
    km: number;
    powerKw: number | null;
    fuelType: string | null;
    transmission: string | null;
  }
  export interface ExpectedPriceResult {
    id: number;
    expectedPrice: number | null;
    sampleSize: number | null;
  }
  export function computeExpectedPrices(
    fitRows: ExpectedPriceRow[],
    predictRows?: ExpectedPriceRow[],
  ): ExpectedPriceResult[];
  ```

- [ ] **Step 1: Write the failing tests**

Use this helper:

```ts
function row(overrides: Partial<ExpectedPriceRow> = {}): ExpectedPriceRow {
  return {
    id: 1,
    model: 'Test Model',
    generation: 'G1',
    price: 10_000,
    age: 10,
    km: 100_000,
    powerKw: 100,
    fuelType: 'Benzin',
    transmission: 'Manuelni 5 brzina',
    ...overrides,
  };
}
```

Add these tests:

```ts
it('recovers a known age/km log-price surface', () => {
  const fit = Array.from({ length: 12 }, (_, i) => {
    const age = i;
    const km = 50_000 + ((i * 7) % 12) * 10_000;
    return row({
      id: i + 1,
      age,
      km,
      price: Math.exp(9 - 0.1 * age - 0.05 * (km / 10_000)),
    });
  });
  const out = computeExpectedPrices(fit);
  for (let i = 0; i < fit.length; i++) {
    expect(out[i].expectedPrice).not.toBeNull();
    expect(
      Math.abs(Math.log(out[i].expectedPrice!) - Math.log(fit[i].price)),
    ).toBeLessThan(1e-6);
  }
});

it('does not price a row with its own ask', () => {
  const fit = Array.from({ length: 12 }, (_, i) =>
    row({ id: i + 1, age: i, km: 50_000 + i * 10_000, price: 10_000 }),
  );
  const before = computeExpectedPrices(fit).find((r) => r.id === 1)!;
  const changed = fit.map((r) => (r.id === 1 ? { ...r, price: 10_100 } : r));
  const after = computeExpectedPrices(changed).find((r) => r.id === 1)!;
  expect(after.expectedPrice!).toBeCloseTo(before.expectedPrice!, 9);
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
  const probe = row({ id: 99, age: 80, km: 900_000 });
  const out = computeExpectedPrices(fit, [probe])[0];
  const prices = fit.map((r) => r.price);
  expect(out.expectedPrice!).toBeGreaterThanOrEqual(Math.min(...prices));
  expect(out.expectedPrice!).toBeLessThanOrEqual(Math.max(...prices));
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
  expect(out.expectedPrice!).toBeCloseTo(10_000, 2);
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
  expect(out.every((r) => Number.isFinite(r.expectedPrice!))).toBe(true);
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
  expect(highPower.expectedPrice!).toBeGreaterThan(
    lowPower.expectedPrice! * 1.15,
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
  expect(diesel.expectedPrice!).toBeGreaterThan(petrol.expectedPrice!);
});

it('is deterministic', () => {
  const fit = Array.from({ length: 12 }, (_, i) =>
    row({ id: i + 1, age: i, km: 50_000 + i * 10_000 }),
  );
  expect(computeExpectedPrices(fit)).toEqual(computeExpectedPrices(fit));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd good-car-deals-api && npx jest src/analysis/expected-price.spec.ts --runInBand`

Expected: FAIL — `computeExpectedPrices` is not exported.

- [ ] **Step 3: Implement `computeExpectedPrices`**

Algorithm, in this order:

1. Copy `fitRows`, sort by `id` ascending. Group by `${model}\u0000${generation}`.
2. For each group with at least 8 fit rows, call `iqrTrimmed(group.map(r => r.price))` and keep rows whose price is within `[lo, hi]`. Smaller groups keep every row. Record the kept row ids in a `Set`.
3. Build the feature vector `[age, km / 10_000, Math.log(powerKw), diesel, gas, hybrid, electric, automatic]`. A fit row requires `powerKw > 0`, non-empty `fuelType`, and non-empty `transmission`; skip rows that fail any of these. Predict rows may have nulls and are imputed in step 11.
4. Compute per-group feature means and mean `ln(price)` over kept rows. Accumulate the 8×8 demeaned normal equations `XTX` and `XTy`.
5. Add `ridge = 1e-8 * Math.max(1, maxDiagonal(XTX))` to each diagonal. Solve with Gaussian elimination and partial pivoting. If the solve fails, use `beta = new Array(8).fill(0)`.
6. For each kept row, `r_i = Math.log(price) - dot(beta, x_i)`.
7. Aggregate `groupSum`, `groupCount`, `modelSum`, `modelCount`, and global sums over kept rows. `mu = globalSum / globalCount`. `modelBase = (modelSum + k * mu) / (modelCount + k)`. `groupBase = (groupSum + k * modelBase) / (groupCount + k)`.
8. For each predict row, find its group stats. If absent, return `{ id, expectedPrice: null, sampleSize: null }`.
9. `wasKept = keptIds.has(row.id)`. `n = groupCount - (wasKept ? 1 : 0)`. If `n < EXPECTED_PRICE_MIN_COMPS`, return nulls.
10. Leave-one-out intercepts:
    - `muLoo = wasKept ? (globalSum - r_i) / (globalCount - 1) : mu`
    - `modelBaseLoo = wasKept ? ((modelSum - r_i) + k * muLoo) / ((modelCount - 1) + k) : modelBase`
    - `groupBaseLoo = wasKept ? ((groupSum - r_i) + k * modelBaseLoo) / ((groupCount - 1) + k) : groupBase`
11. Build the predict row's feature vector. Clamp `age` and `km` to the group's kept min/max. If `powerKw` is null, use the group's mean `ln(powerKw)`; otherwise clamp `ln(powerKw)` to the group's kept min/max. `fuelCategory(null)` returns petrol and `isAutomatic(null)` returns false, so missing fuel/transmission use the base categories.
12. `expected = Math.exp(groupBaseLoo + dot(beta, x))`; clamp to the group's kept `[minPrice, maxPrice]`.
13. If `expected` is non-finite or `<= 0`, return nulls. Otherwise return `{ id, expectedPrice: expected, sampleSize: n }`.

Use only `fitRows` for the fit statistics, even when `predictRows` is supplied. `predictRows` defaults to `fitRows`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd good-car-deals-api && npx jest src/analysis/expected-price.spec.ts --runInBand`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/src/analysis/expected-price.ts good-car-deals-api/src/analysis/expected-price.spec.ts
git commit -m "feat(analysis): add property-based expected price model"
```

---

### Task 3: Pure classifier integration

**Files:**

- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.ts`
- Modify: `good-car-deals-api/src/analysis/deal-classifier.v2.spec.ts`
- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.spec.ts`

**Interfaces:**

- Consumes: `computeExpectedPrices`, `ExpectedPriceRow`, `EXPECTED_PRICE_MIN_COMPS`.
- Produces: `ClassifierRow` gains `powerKw: number | null`, `fuelType: string | null`, `transmission: string | null`; `ClassifyResult` gains `sampleSize: number | null`; `classifyGroups(rows: ClassifierRow[]): ClassifyResult[]` uses the property-based model.

- [ ] **Step 1: Write/update the failing pure tests**

In `deal-classifier.v2.spec.ts`:

- Add `powerKw: 100`, `fuelType: 'Dizel'`, `transmission: 'Manuelni 5 brzina'` to `genRow`.
- Grow every rated fixture from 6 to 12 rows. The gate test becomes 10 rows → UNRATED (not 5).
- When growing a fixture, keep years at or below the current year (for example, group A `2009 + i`, group B `2014 + i`) so age stays non-negative.
- **Use flat prices within each 12-row generation/model fixture** (for example, every row at 10,000) instead of the old 100-step ramp. A 1,100-wide ramp has an IQR of ~350, so the trim drops four extremes, leaves 8 kept rows, and the 10-comp gate fails. The mileage test keeps its two flat levels (9,000 and 7,500); its 24-row pool survives the trim.
- Add:

```ts
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
```

- Keep the generation-separation, model-separation, rubric, mileage, null-row, and cap tests, with 12-row pools.
- Update the `UNRATED` assertions to include `sampleSize: null`. Every standalone `ClassifierRow` literal (`unresolved`, `stalePrice`, `noKm`, `noYear`) also needs `powerKw`, `fuelType`, and `transmission`; use `null` for the unusable rows.

In `deal-classifier.service.spec.ts`:

- Add `powerKw: number | null`, `fuelType: string | null`, `transmission: string | null` to `ListingInput`, and set `powerKw: 100`, `fuelType: 'Dizel'`, `transmission: 'Manuelni 5 brzina'` in `listing()`.
- Grow the rated fixture from 6 to 12 rows with flat 10,000 prices; the old 100-step ramp trims four extremes and the gate fails.
- Change the below-gate fixture from 4 to 10 rows.
- Update the stale-generation test to 12 rows.
- Leave the `respects the limit parameter` test in place for Task 4.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd good-car-deals-api && npx jest src/analysis/deal-classifier --runInBand`

Expected: FAIL — `ClassifierRow` has no power/fuel/transmission fields; `sampleSize` is missing; the old 5-row gate still scores.

- [ ] **Step 3: Implement the pure classifier changes**

- `ClassifierRow`: add the three nullable fields.
- `ClassifyResult`: add `sampleSize: number | null`.
- `UNRATED_RESULT`: set `sampleSize: null`.
- `scoreRow(id, expected, price, sampleSize)`: return `sampleSize` on rated rows.
- Delete `GENERATION_MIN_RATED`, `groupKey`, and the per-group loop in `classifyGroups`.
- `classifyGroups`:
  - Rows without `generation` or failing `isClassifiable` → `UNRATED_RESULT`.
  - Map scorable rows to `ExpectedPriceRow` with `age = new Date().getFullYear() - year!`.
  - Call `computeExpectedPrices(expectedRows)`.
  - For each result: null expected → `UNRATED_RESULT`; otherwise `scoreRow(..., result.sampleSize)`.
- In `classifyDeals`, map `powerKw`, `fuelType`, `transmission` into `ClassifierRow`. Do not change the query, the `limit` parameter, or the persisted columns yet.

- [ ] **Step 4: Run the API unit tests**

Run: `cd good-car-deals-api && npm run test`

Expected: PASS. The service spec still uses the old persistence fields and the `limit` test; both still work because Task 3 only changed the pure path.

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/src/analysis/deal-classifier.service.ts good-car-deals-api/src/analysis/deal-classifier.v2.spec.ts good-car-deals-api/src/analysis/deal-classifier.service.spec.ts
git commit -m "feat(analysis): classify with property-based expected price"
```

---

### Task 4: Persist the sample size and remove `limit`

**Files:**

- Modify: `good-car-deals-api/prisma/schema.prisma`
- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.ts`
- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.spec.ts`

**Interfaces:**

- Consumes: `ClassifyResult.sampleSize`.
- Produces: `ListingWithDeal.expectedPriceSampleSize: number | null`; `classifyDeals(): Promise<number>` with no parameters; Prisma field `expectedPriceSampleSize`.

- [ ] **Step 1: Add the Prisma column**

```prisma
  /// Number of comparable listings behind expected_price, excluding this row.
  expectedPriceSampleSize Int? @map("expected_price_sample_size")
```

Place it next to `expectedPrice` and `deviationPct`. Run `cd good-car-deals-api && npx prisma generate`.

- [ ] **Step 2: Write the failing service tests**

In `deal-classifier.service.spec.ts`:

- Remove the `respects the limit parameter` test.
- Assert the first `findMany` call is `{ orderBy: { id: 'asc' } }`.
- Assert the first update carries `expectedPriceSampleSize: 11`.
- Assert UNRATED updates carry `expectedPriceSampleSize: null`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd good-car-deals-api && npx jest src/analysis/deal-classifier.service.spec.ts --runInBand`

Expected: FAIL — the service still fetches without `orderBy`, still accepts `limit`, and does not persist `expectedPriceSampleSize`.

- [ ] **Step 4: Implement the persistence changes**

- `ListingWithDeal`: add `expectedPriceSampleSize: number | null`.
- `classifyDeals`:
  - Fetch with `{ orderBy: { id: 'asc' } }`.
  - Persist `expectedPriceSampleSize: r.sampleSize`.
  - Remove the `limit` parameter and its branches.
  - Log the gate as `${EXPECTED_PRICE_MIN_COMPS} comps excluding the row`.

- [ ] **Step 5: Run the API unit tests**

Run: `cd good-car-deals-api && npm run test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add good-car-deals-api/prisma/schema.prisma good-car-deals-api/src/analysis/deal-classifier.service.ts good-car-deals-api/src/analysis/deal-classifier.service.spec.ts
git commit -m "feat(analysis): persist expected price sample size"
```

---

### Task 5: Shared type and API comment

**Files:**

- Modify: `packages/shared/src/index.ts`
- Modify: `good-car-deals-api/src/deals/deals.service.ts`

**Interfaces:**

- Produces: `Listing.expectedPriceSampleSize?: number | null`.

- [ ] **Step 1: Update the shared type**

Add after `deviationPct`:

```ts
  /** Number of comparable listings behind expectedPrice, excluding this listing. */
  expectedPriceSampleSize?: number | null;
```

Update the `expectedPrice` comment to "Typical asking price for a car with these properties, stored by the classifier." Update `deviationPct` to "Ask vs expected price; positive = cheaper than typical."

- [ ] **Step 2: Update the deals service comment**

Replace the "generation benchmark (mileage-adjusted per listing)" paragraph with a sentence that the classifier stores the property-based expected price and its comp count, and the API recomputes nothing.

- [ ] **Step 3: Verify the API still compiles**

Run: `cd good-car-deals-api && npm run build`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts good-car-deals-api/src/deals/deals.service.ts
git commit -m "feat(shared): expose expected price sample size"
```

---

### Task 6: Frontend card copy and comp count

**Files:**

- Modify: `good-car-deals-frontend/src/components/deal-card.tsx`
- Modify: `good-car-deals-frontend/src/components/deal-card.test.tsx`

**Interfaces:**

- Consumes: `Listing.expectedPrice`, `Listing.deviationPct`, `Listing.expectedPriceSampleSize`.

- [ ] **Step 1: Write the failing tests**

Add `expectedPriceSampleSize: 42` to `baseListing`. Replace the old benchmark tests with:

```ts
it('shows the typical asking price and comp count', () => {
  render(<DealCard deal={baseListing} />);
  const badge = screen.getByText('+13%');
  expect(badge).toHaveAttribute('data-variant', 'default');
  expect(screen.getByText(/below typical asking price/)).toBeInTheDocument();
  expect(
    screen.getByText(/€4,000 · based on 42 similar Vectra C ads/),
  ).toBeInTheDocument();
});

it('says above typical for a negative deviation', () => {
  const overpriced = { ...baseListing, deviationPct: -8.4 } as Listing;
  render(<DealCard deal={overpriced} />);
  expect(screen.getByText('-8%')).toHaveAttribute(
    'data-variant',
    'destructive',
  );
  expect(screen.getByText(/above typical asking price/)).toBeInTheDocument();
});

it('hides the price line when expectedPrice is null', () => {
  const unrated = {
    ...baseListing,
    expectedPrice: null,
    deviationPct: null,
  } as Listing;
  render(<DealCard deal={unrated} />);
  expect(screen.queryByText(/typical asking price/)).not.toBeInTheDocument();
});

it('omits the comp clause when the sample size is missing', () => {
  const noCount = {
    ...baseListing,
    expectedPriceSampleSize: null,
  } as Listing;
  render(<DealCard deal={noCount} />);
  expect(screen.getByText('€4,000')).toBeInTheDocument();
  expect(screen.queryByText(/based on/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd good-car-deals-frontend && npx vitest run src/components/deal-card.test.tsx`

Expected: FAIL — old "generation benchmark" copy.

- [ ] **Step 3: Implement the card line**

Replace the benchmark block with a two-line block:

```tsx
{
  deal.deviationPct != null && deal.expectedPrice != null && (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Badge
          variant={
            deal.deviationPct > 0
              ? 'default'
              : deal.deviationPct < 0
                ? 'destructive'
                : 'ghost'
          }
        >
          {deal.deviationPct > 0 ? '+' : ''}
          {Math.round(deal.deviationPct)}%
        </Badge>
        <span className="text-muted-foreground text-xs">
          {deal.deviationPct > 0
            ? 'below typical asking price'
            : deal.deviationPct < 0
              ? 'above typical asking price'
              : 'at typical asking price'}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        €{formatNumber(deal.expectedPrice)}
        {deal.expectedPriceSampleSize != null && (
          <>
            {' '}· based on {deal.expectedPriceSampleSize} similar{' '}
            {deal.model ? `${deal.model} ` : ''}ads
          </>
        )}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run the frontend tests**

Run: `cd good-car-deals-frontend && npm run test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-frontend/src/components/deal-card.tsx good-car-deals-frontend/src/components/deal-card.test.tsx
git commit -m "feat(frontend): show typical asking price and comp count"
```

---

### Task 7: E2E fixture for the 10-comp gate

**Files:**

- Modify: `good-car-deals-api/test/0-full-flow.e2e-spec.ts`

**Interfaces:**

- Consumes: `PrismaService.listing.createMany`, `resolveGeneration('Volkswagen Golf 7', 2016) === 'Mk7 (Type 5G)'`.

- [ ] **Step 1: Add the fixture helper**

Add before the `describe` block:

```ts
const FIXTURE_MODEL = 'Volkswagen Golf 7';
const FIXTURE_YEAR = 2016;

function fixtureRows() {
  return Array.from({ length: 12 }, (_, i) => {
    const price = i === 0 ? 3_000 : 12_000 + i * 100;
    return {
      listingUrl: `https://test.local/fixture/${i}`,
      title: `Volkswagen Golf 7 fixture ${i}`,
      price: String(price),
      priceNumeric: BigInt(price),
      year: FIXTURE_YEAR,
      age: 10,
      mileageKm: 150_000 + i * 10_000,
      model: FIXTURE_MODEL,
      fuelType: 'Dizel',
      engineCc: 1598,
      powerKw: 85,
      transmission: 'Manuelni 5 brzina',
      plateOrigin: 'domestic',
    };
  });
}
```

- [ ] **Step 2: Insert the fixture after saving the scrape**

After `const saved = await scraperService.saveListings(listings);`, add:

```ts
console.log('Step 2b: Seeding a deterministic 12-row comp group...');
await prismaService.listing.createMany({ data: fixtureRows() });
```

- [ ] **Step 3: Assert the fixture deal**

After the existing `expect(deals.length).toBeGreaterThan(0);`, fetch the full page set so the fixture cannot fall off the default 50-row page, then assert:

```ts
const allDeals = (
  await request(app.getHttpServer())
    .get('/deals?pageSize=3000')
    .expect(200)
).body.data;
const fixtureDeal = allDeals.find((d: any) =>
  d.listingUrl.endsWith('/fixture/0'),
);
expect(fixtureDeal).toBeDefined();
expect(fixtureDeal.expectedPrice).not.toBeNull();
expect(fixtureDeal.expectedPriceSampleSize).toBeGreaterThanOrEqual(11);
expect(['GREAT DEAL', 'GOOD DEAL']).toContain(fixtureDeal.dealType);
```

- [ ] **Step 4: Run the e2e test against the test database**

```bash
cd good-car-deals-api
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/good_car_deals_e2e?schema=public" npx prisma db push
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/good_car_deals_e2e?schema=public" npx jest --config ./test/jest-e2e.json test/0-full-flow.e2e-spec.ts --runInBand
```

Expected: PASS. The live scrape requires a residential IP; if polovniautomobili.com returns 403, run this locally, not in CI.

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/test/0-full-flow.e2e-spec.ts
git commit -m "test(e2e): seed a comp group for expected-price gate"
```

---

### Task 8: Holdout evaluator

**Files:**

- Create: `good-car-deals-api/tools/evaluate-expected-price.ts`

**Interfaces:**

- Consumes: `computeExpectedPrices`, `ExpectedPriceRow`, `resolveGeneration`.
- Produces: a CLI that prints new-model MdAPE/coverage, legacy baseline MdAPE/coverage, intersection delta, gate coverage, and calibration by group size and price decile.

- [ ] **Step 1: Create the evaluator**

Use `pg` `Client` and `dotenv` (both already dependencies). Query:

```sql
select id, model, year, price_numeric::float8 as price, mileage_km,
       power_kw, fuel_type, transmission, updated_at
from listings
where price_numeric > 0
  and year between 1950 and extract(year from current_date)
  and mileage_km > 0
  and model is not null and model <> ''
order by id asc
```

Map each row with `resolveGeneration(model, year)`; drop unresolved rows. Age is `currentYear - year`. Use a seeded Fisher–Yates shuffle (`mulberry32(seed)`) and an 80/20 split. Fit on train with `computeExpectedPrices(train, test)`.

Copy the legacy baseline into the tool: `median`, `iqrTrimmed`, `theilSenSlope`, `adjustedBenchmark`, `benchmarkExpected`, grouped by `model\0generation`, fitted on train and applied to test. Keep the legacy gate at 5 comps so its coverage is honest.

Print one line each:

```
rows=<n> resolved=<n> seed=<seed> train=<n> test=<n> max updated_at=<iso>
new      MdAPE=<pct> coverage=<pct>
baseline MdAPE=<pct> coverage=<pct>
intersection n=<n> new=<pct> baseline=<pct> delta=<pp>
gate pass (resolved)=<pct>
group size 10-19: ratio=<median actual/predicted> n=<n>
group size 20-49: ratio=<...> n=<n>
group size 50+:   ratio=<...> n=<n>
price decile 1: ratio=<...> n=<n>
...
price decile 10: ratio=<...> n=<n>
```

- [ ] **Step 2: Run the evaluator**

```bash
cd good-car-deals-api
npx ts-node --transpile-only --compiler-options '{"module":"commonjs","moduleResolution":"node"}' tools/evaluate-expected-price.ts --seed=7
```

Expected: new MdAPE ≤ 12%, intersection delta ≥ 2 pp, gate pass ≥ 90% of resolved rows, overall UNRATED ≤ 21% (unresolved generation ~15.6% plus gate ~4.7%), and group-size ratios in `[0.95, 1.05]`. If a criterion fails, do not change the acceptance threshold; investigate the fit or the gate.

- [ ] **Step 3: Record the result and commit**

Paste the four acceptance numbers into the commit body.

```bash
git add good-car-deals-api/tools/evaluate-expected-price.ts
git commit -m "chore(analysis): add expected-price holdout evaluator"
```

---

### Task 9: Remove the legacy benchmark and update docs

**Files:**

- Modify: `good-car-deals-api/src/analysis/deal-stats.ts`
- Modify: `good-car-deals-api/src/analysis/deal-stats.spec.ts`
- Modify: `AGENTS.md`
- Modify: `good-car-deals-api/AGENTS.md`
- Modify: `docs/superpowers/specs/2026-11-04-property-based-expected-price-design.md`

**Interfaces:**

- Removes: `theilSenSlope`, `adjustedBenchmark`, `benchmarkExpected`, `median`, `THEIL_SEN_MAX_ROWS`, `MIN_SLOPE_ROWS`, `MIN_BENCHMARK_ROWS`.
- Keeps: `TierName`, `MAX_DEVIATION_PCT`, `capDeviation`, `deviationPct`, `dealScoreFromDeviation`, `classifyTier`, `iqrTrimmed`.

- [ ] **Step 1: Delete the legacy code and tests**

Remove the four exported functions and their constants from `deal-stats.ts`. Update the file header to say this module holds tier/score/deviation and IQR helpers; the expected-price model lives in `expected-price.ts`.

In `deal-stats.spec.ts`, remove the imports and `describe` blocks for `theilSenSlope` and `adjustedBenchmark / benchmarkExpected`. Add an IQR test:

```ts
it('trims a single high outlier', () => {
  const { kept } = iqrTrimmed([1000, 1000, 1000, 1000, 100000]);
  expect(kept).toEqual([1000, 1000, 1000, 1000]);
});
```

- [ ] **Step 2: Run the unit tests and build**

```bash
cd good-car-deals-api && npm run test && npm run build
cd good-car-deals-frontend && npm run test && npm run build
```

Expected: PASS. If a legacy helper is still imported, TypeScript fails the build; remove the import rather than restoring the helper.

- [ ] **Step 3: Update the root AGENTS deal-scoring bullet**

Replace the v2 comps-relative bullet with the v4 description: model+generation log-price OLS, features age/km/power/fuel/transmission, hierarchical shrinkage group→model→global, gate 10 comps excluding the row, IQR trim, no range, `expectedPriceSampleSize` persisted. Update the "Card benchmark" bullet to say the card shows the property-based expected price and comp count, and thin groups show no average.

- [ ] **Step 4: Update the API AGENTS classification section**

Rewrite the `DEAL CLASSIFICATION` bullets:

- Expected price per row comes from `expected-price.ts`; group = `model\0generation`; fit once per classify pass.
- Features and mapping; IQR trim at ≥8 fit rows; shrinkage k=8; leave-one-out; gate 10 comps excluding self; clamp to group feature/price bounds.
- Persistence includes `expectedPriceSampleSize`; tier/score rubric unchanged; no range.
- CLI and deploy notes stay; mention the nullable column and the post-deploy `--classify` run.
- Replace the "Card benchmark needs density" gotcha with "Expected price needs 10 comps excluding the row; thin groups are UNRATED."
- Add `expected-price.spec.ts` to the test list. Update any hardcoded test counts to the actual output.
- Update the KEY FILES table: `deal-classifier.service.ts` maps rows and persists results; `expected-price.ts` owns the fit/predict math; `deal-stats.ts` keeps only tier/score/deviation/IQR helpers.

- [ ] **Step 5: Mark the design implemented**

Change the design doc status line from `awaiting approval` to `implemented`.

- [ ] **Step 6: Run the full verification**

```bash
cd good-car-deals-api && npm run test && npm run build && npm run lint
cd good-car-deals-frontend && npm run test && npm run build
```

Expected: PASS. `npm run lint` in the API is read-only; it must not rewrite files.

- [ ] **Step 7: Commit**

```bash
git add good-car-deals-api/src/analysis/deal-stats.ts good-car-deals-api/src/analysis/deal-stats.spec.ts AGENTS.md good-car-deals-api/AGENTS.md docs/superpowers/specs/2026-11-04-property-based-expected-price-design.md
git commit -m "refactor(analysis): remove legacy generation benchmark"
```

---

## Rollout Order

1. Deploy the API and schema (Render boot runs `prisma db push`, which adds the nullable column).
2. Run `node dist/src/main.js --classify` from a machine with database access. This rewrites every row with the new expected price and sample size.
3. Deploy the frontend copy.

Do not deploy the frontend copy before the reclassify pass; for that window the card would label old benchmark values as "typical asking price".
