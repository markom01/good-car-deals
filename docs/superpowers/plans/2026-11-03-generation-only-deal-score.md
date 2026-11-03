# Generation-Only Deal Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OLS-regression deal classification with a generation-only benchmark: each listing is scored against the median ask price of its own resolved generation (mileage-adjusted), never against model-wide or cross-generation comps.

**Architecture:** Classification passes group rows strictly by `(model, resolved generation)`. Benchmark per row = generation median price adjusted to the row's odometer by a robust Theil–Sen slope (fallback: plain median). Deviation → fixed rubric score + tier. The `/deals` endpoint reuses stored values instead of recomputing.

**Tech Stack:** NestJS 11 API, Jest 30 + ts-jest, Prisma (no schema change), shared `Listing` type, Next.js DealCard.

**Spec:** docs/superpowers/specs methodology from research review 2026-11-02/03 (verbatim sources: plaidears.com/methodology, jitcar.com/market-value-methodology, app.oav.io/price-to-market, carveil.com/methodology, tech.cars.com deal badges, cardealscore.com grade guides) + `AGENTS.md` root conventions.

## Global Constraints

- **Generation-only**: a listing's benchmark never pools prices from another generation of the model. No year±1 cell, no model fallback. (`Jitcar`/`CarVeil` cell discipline applied at generation level.)
- Rows with unresolved generation (model absent from artifact, null/invalid year) → `UNRATED`, no benchmark, by design.
- Benchmark is the **ask-price** pool of the generation (industry default: CarVeil/PLAIDCARS median of asking prices).
- Score is **absolute, not percentile**: `dealScore = 50 + deltaPct * 4`, clamped `0..100` (CarDealScore score_v2 rubric). The global percentile scorer is removed.
- Tier bands with absolute-euro component (Jitcar's dual test): GREAT needs delta ≥ +10% **AND** ≥ €500; GOOD delta ≥ +4% **AND** ≥ €200; FAIR (−4, +4); HIGH (−10, −4]; OVERPRICED ≤ −10.
- Deviation cap ±50% retained (`MAX_DEVIATION_PCT`).
- Mileage-adjusted benchmark clamped to the generation pool's IQR-trimmed price range; slope ≥ 0 or degenerate km span → plain median (no adjustment).
- Generation scored only when its usable pool ≥ `GENERATION_MIN_RATED = 5` (PLAIDCARS gate; Jitcar uses 10, 5 keeps coverage on Serbian fleet).
- Theil–Sen on capped deterministic sample when pool > 500 rows (stride sampling) — Jitcar's bounded-repeatable-slope pattern, no RNG.
- Existing DB columns reused (`expectedPrice`, `deviationPct`, `dealScore`, `dealType`) — no Prisma migration.
- Jest fixtures: deterministic data only, no randomness (repo convention — pinned LCG / fixed arrays).

## Review Focus

Inputs most likely to bite, and their pinning tests:

1. **Generation under 5 usable rows** → every row UNRATED, no benchmark scored from a 3-row pool. (Task 2 test.)
2. **Two generations of one model must never mix**: same model, years landing in different generations, different price levels → expected prices differ per group; no row gets another generation's median. (Task 2 test.)
3. **Unresolved model/year** → UNRATED even though same model other years resolve. (Task 2 test.)
4. **High-mileage cheap car must not read as bargain once adjusted**: adjusted benchmark at 400k km below plain median, deviation shrinks vs the unadjusted one. (Task 1 test.)
5. **Non-positive/km-degenerate pools**: slope fit on rows with identical km → no adjustment, plain median, no crash. (Task 1 test.)

---

### Task 1: `deal-stats.ts` — Theil–Sen slope + adjusted benchmark, rubric tier

**Files:**

- Modify: `good-car-deals-api/src/analysis/deal-stats.ts`
- Test: `good-car-deals-api/src/analysis/deal-stats.spec.ts`

**Interfaces:**

- Produces (consumed by Task 2):
  - `theilSenSlope(rows: { km: number; price: number }[]): number | null` — median of pairwise slopes (Δprice/Δkm), capped deterministic sample at 500 rows via stride, `null` when fewer than 4 kept rows or all slopes non-finite.
  - `adjustedBenchmark(prices: number[], kmOf: number[], slope: number | null, targetKm: number): number` — median of IQR-trimmed `prices` adjusted by `slope * (targetKm − medianKm)` (median km = `median(kmOf)`); `slope === null` → plain trimmed median; result clamped to the IQR-trimmed price range.
  - `benchmarkExpected(rows: { price: number; km: number }[], targetKm: number): number | null` — orchestrates: trim prices, fit slope on kept rows, `null` when kept < 4 rows; slope ≥ 0 → null slope (plain median); returns `adjustedBenchmark`.
  - `classifyTier(dev: number, devEur: number): TierName` — new signature: GREAT `dev >= 10 && devEur >= 500`; GOOD `dev >= 4 && devEur >= 200`; FAIR `dev > -4`; HIGH `dev > -10`; else OVERPRICED.
  - Retained unchanged: `capDeviation`, `deviationPct`, `dealScoreFromDeviation`, `iqrTrimmed`, `median`, `MAX_DEVIATION_PCT`, `TierName`, `PriceModel` deletion comes in Task 3.
- Consumed: existing `iqrTrimmed`, `median`.

- [ ] **Step 1: Write the failing tests** (new describe blocks; delete none yet)

```ts
describe('theilSenSlope', () => {
  it('recovers exact slope on a deterministic line', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      km: 50_000 + i * 10_000,
      price: 10_000 - i * 100,
    }));
    expect(theilSenSlope(rows)).toBeCloseTo(-0.01, 6);
  });
  it('returns null below 4 rows', () => {
    expect(
      theilSenSlope([
        { km: 1, price: 1 },
        { km: 2, price: 2 },
        { km: 3, price: 3 },
      ]),
    ).toBeNull();
  });
  it('flat pricing → slope 0 (not null)', () => {
    expect(
      theilSenSlope([
        { km: 1, price: 5 },
        { km: 2, price: 5 },
        { km: 3, price: 5 },
        { km: 4, price: 5 },
      ]),
    ).toBe(0);
  });
});

describe('adjustedBenchmark / benchmarkExpected', () => {
  const pool = [
    { price: 5300, km: 100_000 },
    { price: 5400, km: 120_000 },
    { price: 5500, km: 140_000 },
    { price: 5600, km: 160_000 },
    { price: 5700, km: 180_000 },
  ];
  it('negative slope: high-km row benchmark below plain median', () => {
    const plain = median(pool.map((r) => r.price)); // 5500
    const adj = benchmarkExpected(pool, 260_000);
    expect(adj).not.toBeNull();
    expect(adj!).toBeLessThan(plain);
  });
  it('low-km row benchmark above plain median', () => {
    const adj = benchmarkExpected(pool, 60_000);
    expect(adj!).toBeGreaterThan(5500);
  });
  it('clamps to IQR range, adjusted benchmark cannot exceed observed band', () => {
    const out = benchmarkExpected(pool, 0);
    expect(out!).toBeLessThanOrEqual(Math.max(...pool.map((p) => p.price)));
  });
  it('zero-km spread → plain median (no crash, no adjustment)', () => {
    const flat = pool.map((r, i) => ({ price: 5000 + i * 10, km: 100_000 }));
    expect(benchmarkExpected(flat, 100_000)).toBe(
      median([5000, 5010, 5020, 5030, 5040]),
    );
  });
  it('null when kept rows < 4', () => {
    expect(benchmarkExpected(pool.slice(0, 3), 100_000)).toBeNull();
  });
});

describe('classifyTier (absolute-euro gate)', () => {
  it('GREAT needs both >=10% and >=500 EUR', () => {
    expect(classifyTier(12, 800)).toBe('GREAT DEAL');
    expect(classifyTier(12, 100)).toBe('GOOD DEAL');
    expect(classifyTier(6, 1000)).toBe('GOOD DEAL');
  });
  it('GOOD needs >=4% and >=200 EUR', () => {
    expect(classifyTier(4, 199)).toBe('FAIR PRICE');
  });
  it('penalty bands unchanged', () => {
    expect(classifyTier(-5, 0)).toBe('HIGH PRICE');
    expect(classifyTier(-11, 0)).toBe('OVERPRICED');
  });
});
```

- [ ] **Step 2: Run** `npm run test -- deal-stats.spec.ts` (from `good-car-deals-api/`). Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement** `theilSenSlope` (pairwise-slope median; when rows > 500, keep every ⌈n/500⌉-th), `adjustedBenchmark`, `benchmarkExpected`, update `classifyTier` signature per Interfaces block. Reuse `iqrTrimmed`/`median`; do not touch OLS code yet.

- [ ] **Step 4: Run** `npm run test -- deal-stats.spec.ts`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat(analysis): Theil-Sen mileage-adjusted generation benchmark + tier euro gates`

### Task 2: `deal-classifier.service.ts` — generation-only grouping, rewrite scoring loop

**Files:**

- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.ts`
- Test: `good-car-deals-api/src/analysis/deal-classifier.v2.spec.ts` (rewrite)
- Test: `good-car-deals-api/src/analysis/generation-resolver.spec.ts` (unchanged, run only)

**Interfaces:**

- Consumes (from Task 1): `benchmarkExpected`, `classifyTier(dev, devEur)`; (retained) `capDeviation`, `deviationPct`, `dealScoreFromDeviation`.
- Produces: `classifyGroups(rows: ClassifierRow[]): ClassifyResult[]` — same signature, new semantics:
  1. Group key = the row's `generation` as resolved upstream (`resolveGeneration(model, year)` in `classifyDeals`). Rows with null/empty generation → UNRATED immediately, never pooled.
  2. Per generation group: `usable = isClassifiable` rows; pool size < `GENERATION_MIN_RATED` (new const = 5) → all UNRATED.
  3. Per row: `benchmark = benchmarkExpected(poolPriceKm, r.mileageKm!)`; null benchmark → UNRATED. `expectedPrice = benchmark`; `deviationPct = capDeviation(((benchmark − price) / benchmark) * 100)` (existing `deviationPct(expected, price)`); `dealScore = dealScoreFromDeviation(dev)`; `dealType = classifyTier(dev, price − benchmark is ? no — devEur = (dev/100) * benchmark)` i.e. `devEur = (dev / 100) * benchmark` (positive euros below benchmark).
  4. `isClassifiable` drops `age` requirement (age no longer a scoring input); keeps positive price, positive km, year presence (year needed for upstream resolution; keep `year !== null` guard).
- Deleted in this task: `buildGroupKeys`, `generationGroupKey` usage for fitting, `GENERATION_MIN_COMPARABLES`, imports `fitPriceModel`, `expectedPrice`, `clampExpected`, `cellMedianExpected`, `percentileScores`, `null expectedPrice` semantics for UNRATED unchanged.

- [ ] **Step 1: Rewrite the spec** for generation-only semantics, keeping the deterministic fixture style:

```ts
describe('classifyGroups (generation-only)', () => {
  // Helper: rows for one generation share model 'Astra J' + generation 'Astra J (2009-2015)'
  const genRow = (
    id: number,
    year: number,
    km: number,
    price: number,
  ): ClassifierRow => ({
    id,
    model: 'Opel Astra',
    generation: 'Astra J (2009-2015)',
    priceNumeric: price,
    year,
    age: 2026 - year,
    mileageKm: km,
  });
  it('two generations of one model never mix: benchmarks differ per group', () => {
    const g1 = [...Array(6)].map((_, i) =>
      genRow(1, 2009 + i, 100_000 + i * 10_000, 10000 + i * 100),
    );
    const g2 = genRow(10, 2016, 100_000, 5000); // + 5 more rows like it, lower level
    // assert: a 100_000 km row in each group gets a different expectedPrice
  });
  it('pool below 5 usable rows → every row UNRATED (no 3-row scoring)', () => {
    /* 4 rows, all UNRATED, dealScore 0, expectedPrice null */
  });
  it('unresolved model → UNRATED; resolved siblings of same model still rated', () => {
    const unresolved = {
      id: 99,
      model: 'Dacia Nonexistent',
      generation: null,
      priceNumeric: 5000,
      year: 2018,
      age: 8,
      mileageKm: 100_000,
    };
    // unresolved UNRATED; existing rated Astra rows unaffected
  });
  it('unchanged generation: deviations and score are absolute (50 + dev*4), not percentile', () => {
    // fixture where best deviation is +15% → dealScore 100, worst −10% → score 0, mid 0% → 50
  });
  it('mileage-adjusted benchmark: 300k km row scores lower than the identical ask at 100k km', () => {
    // same generation, same price, different km → higher km row has smaller (or null) deviation
  });
  it('GREAT requires both pct and euro legs: 8% of a 3_000 benchmark passes GOOD', () => {
    // benchmark 3000, ask 2760 → dev 8% → devEur 240 → NOT GREAT (needs 500) → GOOD (≥4% && ≥200)
  });
  it('price-null / km-null / year rows inside healthy group → UNRATED', () => {
    /* keep existing assertions */
  });
});
```

- [ ] **Step 2: Run** `npm run test -- deal-classifier.v2.spec.ts`. Expected: FAIL (old percentile/model-fallback behavior).

- [ ] **Step 3: Implement the rewrite** in `deal-classifier.service.ts` per Interfaces block. `classifyDeals()` keeps: fetch-all, `resolveGeneration(model, year)` mapping (unchanged), `pricePerYear` persistence, chunked updates, summary log; deletes imports listed above; logs per-pass `UNRATED` count when a generation was skipped for pool size.

- [ ] **Step 4: Run** `npm run test -- deal-classifier.v2.spec.ts deal-stats.spec.ts generation-resolver.spec.ts`. Expected: PASS. New sign check: old tests asserting percentile semantics are gone.

- [ ] **Step 5: Commit** `feat(analysis): generation-only deal score (median + Theil-Sen mileage adjustment, absolute rubric)`

### Task 3: delete dead OLS/cell-median code

**Files:**

- Modify: `good-car-deals-api/src/analysis/deal-stats.ts` (drop `fitPriceModel`, `fitSpecModel`, `qrSolve`, `expectedPrice`, `clampExpected`, `percentileScores`, `cellMedianExpected`, `PriceModel`, `FitAttrs`, `FitResult`, `MIN_USABLE_*`, `MIN_DUMMY_CLASS`, and their spec blocks in `deal-stats.spec.ts`)

**Interfaces:** None produced — pure deletion. Only survivors: `TierName`, `PriceRow` (trim or retype to `{ price; km }` if unused elsewhere — check `grep` first), `MAX_DEVIATION_PCT`, `capDeviation`, `deviationPct`, `dealScoreFromDeviation`, `classifyTier`, `iqrTrimmed`, `median`, `theilSenSlope`, `adjustedBenchmark`, `benchmarkExpected`.

- [ ] **Step 1: grep** `_unused_ OLS survivors`: `grep -rn "fitPriceModel\|qrSolve\|cellMedianExpected\|percentileScores\|clampExpected\|expectedPrice(" good-car-deals-api/src --include="*.ts" | grep -v spec`. Expected: no non-spec callers left after Task 2.
- [ ] **Step 2: Delete** dead exports + their test blocks (keep the retained-function tests).
- [ ] **Step 3: Run** full unit suite `npm run test`. Expected: PASS, no unused-import lint errors (`npm run lint`).
- [ ] **Step 4: Commit** `refactor(analysis): remove OLS fit and cell-median fallback (generation-only scoring)`

### Task 4: `deals.service.ts` + shared type + card — display reuses stored benchmark

**Files:**

- Modify: `good-car-deals-api/src/deals/deals.service.ts`
- Modify: `good-car-deals-api/src/deals/deals.service.spec.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `good-car-deals-frontend/src/components/deal-card.tsx`
- Test: `good-car-deals-frontend/src/components/deal-card.test.tsx` (update assertions)

**Interfaces:**

- Consumes: stored `expectedPrice` (rowspecific adjusted benchmark), `deviationPct`, `dealScore`, `dealType` from DB (set by classifier).
- Produces (shared `Listing`): `expectedPrice: number | null`; `deviationPct: number | null`; **remove** `generationAvgPriceNumeric`, `generationMedianPriceNumeric`, `priceToGenerationAvgPct`. Card badge semantics: `deviationPct > 0` = cheaper than benchmark (deal), `< 0` = above.
- `deals.service.getDeals`: delete the `poolRows` query and per-listing median recompute; map stored fields straight through (`expectedPrice` served as the card's benchmark euro figure). Generation resolution query for `generation` display field may stay (cheap, per-row, artifact-only).

- [ ] **Step 1: Write failing service test** — fixtures with pre-set `expectedPrice/deviationPct/dealScore` rows: assert response includes them verbatim and that `generationMedianPriceNumeric` etc. are gone from the mapped shape.
- [ ] **Step 2: Run** `npm run test -- deals.service.spec.ts`. Expected: FAIL (fields currently recomputed/absent).
- [ ] **Step 3: Rewrite `getDeals`** per Interfaces block; update shared `Listing` (remove 3 fields, keep contract narrow).
- [ ] **Step 4: Update `deal-card.tsx`** — badge block reads `deal.deviationPct` (positive = deal, `default` variant when > 0; `destructive` when < 0), text "vs generation benchmark €{expectedPrice, mileage-adjusted}"; delete median/avg lines. Update Vitest assertions.
- [ ] **Step 5: Run** API `npm run test` + FE `npm run test` (from `good-car-deals-frontend/`) + `npm run build` (FE). Expected: PASS.
- [ ] **Step 6: Commit** `feat(api,fe): deal cards display stored generation benchmark; drop per-request median recompute`

### Task 5: full verify + reclassify cycle

- [ ] **Step 1: Full API suite** `npm run test` and `npm run test:e2e` (e2e needs DB/API stack up per repo README; `deals.e2e-spec` assertions on tier names may need band-gate updates if fixtures hit the euro gates — update fixture expectations, not bands).
- [ ] **Step 2: Build** `npm run build` (API). Expected: clean.
- [ ] **Step 3: One-shot reclassify** against dev DB: `node dist/src/main.js --classify`. Expect log: `Summary: GREAT: … UNRATED: …` — UNRATED share will rise (unresolved generations + pools < 5). Sanity-check GREAT count change vs previous pass and spot-check 2–3 rows: `prisma studio` or `node scripts/check-db.js`.
- [ ] **Step 4: Commit** docs if needed; final commit `chore: v3 generation-only deployment notes` (update root + API `AGENTS.md` DEAL CLASSIFICATION sections).

## Self-Review

- Spec coverage: generation-only grouping (Task 2), mileage adjustment (Tasks 1–2), absolute rubric + euro gates (Tasks 1–2), min-pool gate (Task 2), display consistency (Task 4), no model-wide / no cross-generation pooling anywhere (Tasks 2–4). Coverage noted in plan header.
- Types consistent: `benchmarkExpected({price,km}[], targetKm)` used exactly in Task 2; `classifyTier(dev, devEur)` matches both call sites; shared `Listing` fields match card reads.
- Review Focus inputs each have a pinning test in Task 1/2 steps.
- Proportionality: plan shorter than resulting code; no function bodies except test fixtures (allowed as spec-pinned values).
