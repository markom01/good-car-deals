# Deal Score v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the saturated `max(0, 100 − pricePerYear/100)` score with comps-relative scoring: per-model-group regression/cell-median expected price → % deviation → 5-tier badge + 0–100 score, and persist the fields the scraper already parses.

**Architecture:** Pure statistics module (`deal-stats.ts`) does IQR trim, 3×3 OLS via normal equations, and deviation→score/tier mapping. `DealClassifierService` orchestrates: fetch rows, group by `model` value, fit per group (regression ≥12 rows, else year±1/km±20% cell median, else UNRATED), persist `expectedPrice` + `deviationPct` + new labels. `deals.service` filters GREAT+GOOD; `main.ts` gains a `--classify` one-shot mode for post-deploy relabeling.

**Tech Stack:** NestJS 11, Prisma 7 (PostgreSQL), Jest 30, vanilla TS math (no new deps).

**Spec:** `docs/superpowers/specs/2026-10-27-deal-score-v2-design.md` — numbers below are copied from it verbatim; the spec is authoritative on the "why".

## Global Constraints

- Tier labels exact strings: `GREAT DEAL`, `GOOD DEAL`, `FAIR PRICE`, `HIGH PRICE`, `OVERPRICED`, `UNRATED`.
- Bands (devPct = `(expected − ask) / expected × 100`, positive = cheaper than expected): GREAT ≥ 10; GOOD ∈ [4, 10); FAIR ∈ (−4, 4); HIGH ∈ (−10, −4]; OVERPRICED ≤ −10; UNRATED when < 3 usable comps (on any path where expected cannot be computed).
- Score: `clamp(50 + devPct × 4, 0, 100)`; 0 when unrated.
- Regression guards (discard fit → use next estimator): fit rows < 12; singular normal equations (|pivot| < 1e-9); `coefAge >= 0` or `coefKm >= 0`; `expected ≤ 0` for any row → discard fit for that whole group.
- Fit rows = IQR-trimmed (Q1 − 1.5·IQR … Q3 + 1.5·IQR on price of usable rows); rows trimmed from the fit **still get scored**.
- Regression fits **per distinct `model` string in the DB** — never across model groups.
- Cell median fallback cell: `year ± 1` mandatory; `km ± 20%` split applied only if the post-split count ≥ 3.
- Usable row = `priceNumeric > 0`, `age > 0`, `mileageKm > 0`. Year-null, future-year (age ≤ 0), km-null rows → UNRATED, never skipped silently.
- `pricePerYear` stays computed and stored (display only, not a scoring input).
- Frontend components unchanged. `packages/shared` `Listing` fields are additive optional.
- No new npm dependencies. Playwright/fixtures: none needed.
- New scraped strings: `fuelType` (e.g. "Dizel"), `engineVolume` ("1956 cm3" → int `engineCc`), `powerKw` ("81 kW" → int), `transmission` ("Manual"), `location` ("Ruma") — store parsed values, trim strings, null on parse failure.

## Review Focus

- **Year-null / future-year rows (e.g. seller wrote 2027)** — must land UNRATED with a stored label, not vanish. Test in Task 4.
- **km-null rows** (featured cards skip mileage) — UNRATED, included in classifier query. Test in Task 4.
- **Part-out / outlier-cheap row** (€1,700 at 222k km) — trimmed from the fit but still scored; must appear on the board, not as `dev > +40%` crash. Test in Task 3 (unit) and Task 4.
- **Degenerate fit (negative-ish or non-invertible)** — must fall back to cell median, never positive km coefficient output. Test in Task 3.
- **`/deals` right after deploy, before `--classify` backlog run** — rows still labeled `GOOD DEAL (Market)` → empty array, no 500, no crash. Verified in Task 7 step.

---

### Task 1: Prisma schema columns

**Files:**

- Modify: `good-car-deals-api/prisma/schema.prisma:9-27`
- Create: `good-car-deals-api/prisma/migrations/<timestamp>_deal_v2_fields/`

**Interfaces:**

- Consumes: nothing.
- Produces: `Listing` columns `fuelType String? @map("fuel_type")`, `engineCc Int? @map("engine_cc")`, `powerKw Int? @map("power_kw")`, `transmission String?`, `location String?`, `expectedPrice Float? @map("expected_price")`, `deviationPct Float? @map("deviation_pct")`. Later tasks use these Prisma field names.

- [ ] **Step 1: Add the 7 optional columns to the `Listing` model** after `pricePerYear`. No indexes. Strings nullable, interpreted as "not parsed from this card".

- [ ] **Step 2: Generate + apply migration**

Run: `cd good-car-deals-api && npx prisma migrate dev --name deal_v2_fields`
Expected: `ALTER TABLE "listings" ADD COLUMN` × 7, applied to the local DB (additive, keeps existing 363 rows).

- [ ] **Step 3: Verify**

Run: `npx prisma validate && node -e "const{PrismaClient}=require('@prisma/client');new PrismaClient().listing.findFirst({select:{fuelType:true,expectedPrice:true}}).then(r=>console.log('cols ok'))"`
Expected: `Schema is valid` then `cols ok`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations && git commit -m "feat(db): deal v2 columns (fuel, engine, power, transmission, location, expectedPrice, deviationPct)"
```

### Task 2: Persist parsed fields in scraper + parse helpers

**Files:**

- Modify: `good-car-deals-api/src/utils/normalization.ts` (append helpers)
- Test: `good-car-deals-api/src/utils/normalization.spec.ts` (existing file, append describes)
- Modify: `good-car-deals-api/src/scraper/scraper.service.ts:135-160` (upsert map)

**Interfaces:**

- Consumes: `RawListingData` already carries `fuelType, engineVolume, powerKw, transmission, location` as strings (`html-parser.service.ts:8`).
- Produces: `parseEngineCc(engineVolume: string | null): number | null` (`"1956 cm3"` → `1956`), `parsePowerKw(powerKw: string | null): number | null` (`"81 kW"` → `81`), string fields stored trimmed (`fuelType`, `transmission`, `location`); `null` when unparsable/empty.

- [ ] **Step 1: Write the failing tests** in `normalization.spec.ts`:

```typescript
describe('parseEngineCc', () => {
  it('parses "1956 cm3" to 1956', () =>
    expect(parseEngineCc('1956 cm3')).toBe(1956));
  it('parses "1598" to 1598', () => expect(parseEngineCc('1598')).toBe(1598));
  it('returns null for empty/garbage', () => {
    expect(parseEngineCc('')).toBeNull();
    expect(parseEngineCc('aka')).toBeNull();
  });
});
describe('parsePowerKw', () => {
  it('parses "81 kW" to 81', () => expect(parsePowerKw('81 kW')).toBe(81));
  it('returns null for non-numeric', () => expect(parsePowerKw('')).toBeNull());
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/utils/normalization.spec -t parseEngineCc`
      Expected: FAIL (`parseEngineCc is not a function` / import error).

- [ ] **Step 3: Implement** both helpers in `normalization.ts` (number extraction via `match(/-?\d+(\.\d+)?/)` → parseInt → null on no match).

- [ ] **Step 4: Wire into `saveListings`** — in both `update` and `create` of the upsert: `fuelType: raw.fuelType?.trim() || null`, `engineCc: parseEngineCc(raw.engineVolume)`, `powerKw: parsePowerKw(raw.powerKw)`, `transmission: raw.transmission?.trim() || null`, `location: raw.location?.trim() || null`.

- [ ] **Step 5: Run** — `npx jest src/utils/normalization.spec src/scraper/scraper.service.spec`
      Expected: PASS (if `scraper.service.spec` stubs the upsert and asserts keys, extend its expected object with the 5 new keys; do not weaken other assertions).

- [ ] **Step 6: Commit**

```bash
git add src/utils/normalization.ts src/utils/normalization.spec.ts src/scraper/scraper.service.ts src/scraper/scraper.service.spec.ts && git commit -m "feat(scraper): persist fuel, engine cc, power, transmission, location"
```

### Task 3: Pure statistics module `deal-stats.ts`

**Files:**

- Create: `good-car-deals-api/src/analysis/deal-stats.ts`
- Test: `good-car-deals-api/src/analysis/deal-stats.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - exports (used verbatim by Task 4/5): `export type TierName = 'GREAT DEAL' | 'GOOD DEAL' | 'FAIR PRICE' | 'HIGH PRICE' | 'OVERPRICED' | 'UNRATED'`

```typescript
export interface PriceRow {
  price: number;
  year: number;
  km: number;
} // age derived by caller
export interface PriceModel {
  intercept: number;
  coefAge: number;
  coefKm: number;
  n: number;
}
export function iqrTrimmed(values: number[]): {
  kept: number[];
  lo: number;
  hi: number;
};
export function fitLinearPrice(
  rows: { age: number; km: number; price: number }[],
): PriceModel | null;
export function expectedPrice(m: PriceModel, age: number, km: number): number;
export function deviationPct(expected: number, price: number): number;
export function dealScoreFromDeviation(dev: number): number;
export function classifyTier(dev: number): TierName;
export function median(values: number[]): number;
export function cellMedianExpected(
  rows: PriceRow[],
  targetYear: number,
  targetKm: number,
): number | null;
```

`TierName` is the exported type declared above (six union members incl. `'UNRATED'`).

- [ ] **Step 1: Write the failing spec** — pure Jest, no Nest module, no network:

```typescript
describe('fitLinearPrice regression path', () => {
  const rows = makeRows(); // helper: price = 9625 - 255*age - 4.5*km/1000 + small noise, 30 rows spanning age 8..17, km 80k..300k
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
  const cells = buildCellRows(); // helper in-plan: ≥3 rows year@2012 km around 200k
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
});
```

`buildCellRows` helper shape (plan pins the numbers so both sides agree):

- **Dense case** rows `{price, year, km}`: `{5200, 2011, 180000}`, `{5400, 2012, 200000}`, `{5600, 2013, 220000}`, `{5300, 2012, 190000}`, `{4900, 2012, 210000}`. Target 2012/200000 → km split keeps 3 rows → median(5400, 5300, 4900) = **5300** → assert `cellMedianExpected(rows, 2012, 200000)` = 5300.
- **Thin case** rows: `{5600, 2013, 220000}`, `{5200, 2011, 180000}`, `{4300, 2012, 999000}`, `{4400, 2012, 990000}`, `{4500, 2011, 999000}`. Target 2012/200000 → km split leaves 2 (<3) → fall back to year±1 → median(5600, 5200, 4300, 4400, 4500) = **4500** → assert 4500.
- **No-comp case**: pass `[{5200, 2011, 180000}]` with target 2012/200000 → km split count 0 <3; year±1 window count 1 <3 → null.

- [ ] **Step 2: Run** — `npx jest src/analysis/deal-stats.spec`
      Expected: FAIL (module not found).

- [ ] **Step 3: Implement `deal-stats.ts`**
- OLS: normal equations + 3×3 Gauss-Jordan with partial pivoting (`|pivot| < 1e-9` → singular). Coefficients = `S⁻¹ · T` — **multiply the inverse columns by the target vector T** (the spike's first-pass bug: never return a raw column of the inverse).
- Guards in `fitLinearPrice`: n < 12 → null; singular → null; `coefAge >= 0 || coefKm >= 0` → null.
- IQR trim happens inside `fitLinearPrice` (caller passes raw usable rows); `n` = row count actually used in the fit, exposed for logging; `iqrTrimmed` exported separately for direct testing.
- `dealScoreFromDeviation`: `Math.max(0, Math.min(100, Math.round(50 + dev * 4)))`.
- `deviationPct`: expects `expected > 0`; caller (Task 4) guarantees via degenerate-check before calling.

- [ ] **Step 4: Run** — `npx jest src/analysis/deal-stats.spec` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analysis/deal-stats.ts src/analysis/deal-stats.spec.ts && git commit -m "feat(analysis): pure deal-stats v2 (OLS fit, IQR trim, deviation scoring, tier bands)"
```

### Task 4: Classifier v2 rewrite

**Files:**

- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.ts` (full rework of `classifyDeals` pipeline, removal of `classifyListing`/`calculateModelAverages`/`calculateDealScore`/`extractModel`; keep `calculatePricePerYear`, `getClassifiedListings`, `getClassificationSummary` adapted)
- Test: Create: `good-car-deals-api/src/analysis/deal-classifier.v2.spec.ts` (pure, no Nest, no DB — drives the exported pure seam)

**Interfaces:**

- Consumes: Task 3 exports; Prisma model fields from Task 1.
- Produces:
  - pure seam for tests and orchestration: `classifyGroups(rows: ClassifierRow[]): ClassifyResult[]` — `ClassifierRow = { id: number; model: string | null; priceNumeric: number | null; year: number | null; age: number | null; mileageKm: number | null }`; `ClassifyResult = { id: number; dealType: TierName; dealScore: number; expectedPrice: number | null; deviationPct: number | null }`.
  - `classifyDeals(): Promise<number>` (same signature as today — `cron.service.ts:49` unchanged) and `getClassificationSummary` keys become `great | good | fair | high | overpriced | unrated`.

Implementation contract (spec §1–§2, Global Constraints): group rows by `model ?? ''`; within a group compute `usable = price>0 && age>0 && km>0`; try `fitLinearPrice` on usable (IQR trim inside); fit guard failure → `cellMedianExpected` per row (row own year/km as target); both fail or no expected>0 for that row → `UNRATED` score 0 `expectedPrice` `null`; else `deviationPct`, `dealScoreFromDeviation`, `classifyTier` and persist. **Do not overwrite `model` from title** (`model` column stays; remove the `extractModel` call at old line 61). Rows with `year === null`/`age <= 0`/`price <= 0`/`km === null` → UNRATED regardless of group. `classifyDeals` fetch query **stops filtering `year: { not: null }`** — fetch `priceNumeric: { not: null }` only.

- [ ] **Step 1: Write the failing spec** — fixtures pin the spec's real-world shapes:

```typescript
describe('classifyGroups', () => {
  it('regression path: scores the cheap-but-consistent row BEST, part-out row scored not crashed', () => {
    const rows = makeMarketRows(); // helper: 20 Astra J rows on generator 9625-255*age-4.5*km/1000, plus a 12%-below-generator row, plus one part-out row drawing its own km-driven low expected price
    const out = classifyGroups(rows);
    // The 12%-below-generator row (dev ≈ +12) tops the board as GREAT DEAL; the part-out row gets a finite deviation via its km term — no NaN, no crash.
    const top = [...out].sort((a, b) => b.dealScore - a.dealScore)[0];
    expect(top.dealType).toBe('GREAT DEAL');
    const partout = out.find((r) => r.id === PARTOUT_ID)!;
    expect(Number.isFinite(partout.deviationPct!)).toBe(true);
  });
  it('thin group (4 rows): cell median path used, all rows get finite expectedPrice or UNRATED', () => {
    /* rows = 4 per buildCellRows shapes; expect every UNRATED absent because ≥3 comps; assert expectedPrice !== null */
  });
  it('year-null and km-null rows → UNRATED with dealScore 0 even inside a healthy group', () => {
    const rows = [...makeMarketRows(), NO_YEAR_FIXTURE, NO_KM_FIXTURE];
    const out = classifyGroups(rows);
    const unrated = (id: number) => out.find((r) => r.id === id)!;
    expect(unrated(NO_YEAR_ID)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
    });
    expect(unrated(NO_KM_ID)).toMatchObject({
      dealType: 'UNRATED',
      dealScore: 0,
    });
  });
  it('two model groups never share a fit (Astra J + Astra H rows with offset price levels)', () => {
    // generate: J on base generator, H on generator + 2000€; H rows must see H-expected prices (±10%), not blended ones
  });
});
```

- [ ] **Step 2: Run** — `npx jest src/analysis/deal-classifier.v2.spec` → FAIL (`classifyGroups` not a function).

- [ ] **Step 3: Implement** — new `classifyGroups` + slim `classifyDeals` orchestration per the implementation contract. `getClassificationSummary` rewrite (6 new keys, prefix/`${}` matching).

- [ ] **Step 4: Run** — `npx jest src/analysis/deal-classifier.v2.spec src/analysis/deal-classifier.service.spec test/full-flow.e2e-spec.ts` then `npx nest build` → PASS (full-flow live e2e may hit live site; its scrape/parse assertions are unchanged; update only console formatting if it prints old distribution keys).

- [ ] **Step 5: Commit**

```bash
git add src/analysis/deal-classifier.service.ts src/analysis/deal-classifier.v2.spec.ts && git commit -m "feat(analysis): v2 classifier (per-model OLS + cell median, 5-tier bands, persisted expected/dev)"
```

### Task 5: Deals endpoint filter + shared model fields

**Files:**

- Modify: `good-car-deals-api/src/deals/deals.service.ts:24-44`
- Modify: `packages/shared/src/index.ts:1-19`
- Test: `good-car-deals-api/src/deals/deals.service.spec.ts` (existing file — extend)

**Interfaces:**

- Consumes: `dealType` values from Task 4.
- Produces: `Listing` gains additive optional fields `expectedPrice?: number | null`, `deviationPct?: number | null`, `fuelType?: string | null`, `engineCc?: number | null`, `powerKw?: number | null`, `transmission?: string | null`, `location?: string | null`. `getDeals` where-clause: `dealType: { in: ['GREAT DEAL', 'GOOD DEAL'] }`. `modelAvgPriceNumeric` (spec §4): per listing = mean of `expectedPrice` over all same-model rows with `expectedPrice` set and `|rowYear − listing.year| ≤ 1`, min 3 rows in the pool, else null; computed in TS after the main fetch (one extra `findMany({ where: { model, expectedPrice: { not: null } } , select: { model, year, expectedPrice }})`) — no SQL groupBy anymore. `priceToModelAvgPct` stays `((price − avg) / avg) × 100`.

- [ ] **Step 1: Extend `deals.service.spec`** — stub `prismaService.listing.findMany` with rows carrying the new dealType values + `expectedPrice`/`fuelType`/`engineCc`/`powerKw` (one row per new field to check the BigInt→Number mapping, including a null one); assert: GREAT/GOOD rows returned, `FAIR PRICE` row excluded, new fields mapped through, average computed from all `expectedPrice`-set rows within the merged model pool (same-model, year ±1 — not good-deals-only).

- [ ] **Step 2: Run** — `npx jest src/deals` → FAIL.

- [ ] **Step 3: Implement** — where-clause switch, year±1 TS pool for `modelAvgPriceNumeric` (per the Interfaces block), BigInt→Number mapping for the new Int/Float columns in the final map, `packages/shared` type paddings.

- [ ] **Step 4: Run** — `npx jest src/deals test/deals.e2e-spec.ts` → PASS (e2e distribution console prints change; update any exact-string expectations if present).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/index.ts good-car-deals-api/src/deals/deals.service.ts good-car-deals-api/src/deals/deals.service.spec.ts && git commit -m "feat(deals): endpoint gates GREAT+GOOD, exposes expectedPrice/deviation/v2 pooled average"
```

### Task 6: `--classify` one-shot mode

**Files:**

- Modify: `good-car-deals-api/src/main.ts:21-31`

**Interfaces:**

- Consumes: `DealClassifierService.classifyDeals()` (same signature).
- Produces: `--classify` argv flag — imports nothing new; mirrors `--scrape`:

- [ ] **Step 1: Implement** — add before/after the `--scrape` block (whichever ordering keeps bootstrap logic flat):

```typescript
// ── Classify-only mode (backfill / post-deploy relabel) ──────
// Run: node dist/src/main.js --classify
if (process.argv.includes('--classify')) {
  console.log('Classify-only mode: re-classifying listings in place...');
  const dealClassifierService = app.get(DealClassifierService);
  const n = await dealClassifierService.classifyDeals();
  console.log(`Classified ${n}`);
  await prismaService.$disconnect();
  process.exit(0);
}
```

Implementer note: import `DealClassifierService` from `./analysis/deal-classifier.service` at the top of `main.ts`. No scrape occurs in this mode; no wipe; no listen.

- [ ] **Step 2: Verify** — `npx nest build && node dist/src/main.js --classify && echo OK` (this **mutates the real DB labels in place** — expected, it is the §6 backfill) — Expected: `Summary: GREAT .../>0` line, exit 0, no server listening.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts && git commit -m "feat(main): --classify one-shot mode"
```

### Task 7: Docs + full pipeline verification

**Files:**

- Modify: `good-car-deals-api/AGENTS.md` (DEAL CLASSIFICATION section), `AGENTS.md` root (CONVENTIONS one-liner)

**Interfaces:** doc-only.

- [ ] **Step 1: Rewrite the DEAL CLASSIFICATION section** — describe v2: per-model OLS (intercept/age/km), cell-median fallback, UNRATED path, tier bands with exact thresholds, score formula, `--classify` backfill command.
- [ ] **Step 2: Run the pipeline** — `npm run test` (API root) → all PASS incl. new deals-stats/classifier suites; `test:e2e` with `SKIP_STARTUP_SCRAPE=true` env so boot does not wipe; spot check `curl localhost:3001/deals | head` if a dev server is up.
- [ ] **Step 3: Commit** — `git add AGENTS.md good-car-deals-api/AGENTS.md && git commit -m "docs: v2 classification runbook + thresholds"`
- [ ] **Step 4: Whole-plan sanity** — `npx tsc -p good-car-deals-api/tsconfig.json --noEmit && npx tsc -p good-car-deals-frontend/tsconfig.json --noEmit` → PASS; frontend untouched by default.
- [ ] **Step 5: Deploy note** — Render boot (`prisma db push` + `SKIP_STARTUP_SCRAPE=true`) picks up columns; first `/deals` after deploy returns [] until `node dist/src/main.js --classify` runs (spec §6). Add this line to the runbook text from Step 1.
