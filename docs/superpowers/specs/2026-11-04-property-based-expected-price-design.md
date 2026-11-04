# Property-based expected price — design

**Date:** 2026-11-04 · **Status:** implemented
**Scope:** `good-car-deals-api` (classifier, pure math, Prisma schema), `packages/shared`, `good-car-deals-frontend` (deal card copy).

## Intent / why

Today the expected price for a listing is the trimmed median of its model+generation pool, shifted only by mileage (Theil–Sen slope). Two consequences:

1. Every other listing property is ignored. A 1.9 TDI 66 kW and a 1.4 petrol+TNG 55 kW Golf 4 of the same year share one pool and differ only by odometer. The current card even ranks the TNG car above the TDI (€1,781 vs €1,686) because 50,000 km is the only signal used.
2. The user cannot see why the number is what it is. "Generation benchmark" is implementation language.

The goal is a single, explainable number per listing: **the typical asking price for a car with these properties, in this market snapshot.** The buyer compares the ask to that number. The score stays a price-vs-expected verdict.

## Goals

- Compute `expectedPrice` from the listing's own properties: age, mileage, power, fuel, transmission, and its model+generation market level.
- Cover at least 90% of classifiable listings with a number backed by at least 10 comparable listings.
- Beat the current generation benchmark on held-out accuracy by at least 2 percentage points of MdAPE.
- Keep the number explainable on the card: what it is and how many ads it used.
- No new runtime dependencies, no ML libraries, no scraping changes.

## Non-goals

- **No prediction range / typical range.** Measured and rejected; see Appendix B.
- No transaction-price claim. The data is asking prices from one weekly snapshot.
- No body style, trim, equipment, condition, service history, seller type, or days-on-market terms. Those fields are not scraped.
- No location/region effect in this pass.
- No percentile score rewrite; tiers and `dealScore = clamp(round(50 + dev))` stay as they are.
- No change to the `/deals` gate (GREAT + GOOD only).

## Anti-goals

- Do not present the number as "fair value" or "what you should pay". It is a typical asking price.
- Do not hide uncertainty behind a range that is only calibrated on average.
- Do not fit per-row or per-trim regressions on groups that cannot support them.
- Do not change scrape cadence or storage volume.

## Evidence

Pilot on the live table: 57,110 usable rows, random 80/20 split, seed 7, log-price model, per-group IQR trim.

| estimator                                          | MdAPE      | coverage |
| -------------------------------------------------- | ---------- | -------- |
| current generation benchmark (`benchmarkExpected`) | 14.8%      | 97%      |
| age + km + ln(kW) + fuel + automatic               | **11.24%** | 100%     |
| same, minus fuel + automatic                       | 11.47%     | 100%     |
| same, plus engine cc                               | 11.25%     | 100%     |
| ln(km) instead of km                               | 11.39%     | 100%     |
| age²                                               | 11.57%     | 100%     |
| age × km                                           | 11.26%     | 100%     |

Engine cc is collinear with power and adds nothing. Nonlinear age/km terms do not pay on this data. The simple form wins.

Group-size behaviour after hierarchical shrinkage (group → model → global, k = 8):

| kept comps in group | MdAPE |
| ------------------- | ----- |
| 1–4                 | 30.6% |
| 5–9                 | 16.9% |
| 10–19               | 11.9% |
| 20–49               | 11.2% |
| 50+                 | 10.7% |

Gate at 10 comps excluding the scored row (≥ 11 kept rows in the group) covers **94.4% of generation-resolved rows**; at 20 comps (≥ 21 kept) it covers 89.5%. The user chose **10**.

(Pilot "coverage 100%" in the table above means the model can predict every row; the production gate still hides thin groups.)

Pilot coefficients (log price): age −8.4%/year, km −0.63% per 10,000 km, power elasticity 0.40, automatic +7.1%, diesel +2.5%, petrol+TNG/CNG −6.4%, hybrid +2.4%, electric absorbed by group intercept. Signs and magnitudes match the hedonic literature.

Sanity check on the motivating pair (same model, same generation, same year):

| car                              | pilot expected |
| -------------------------------- | -------------- |
| Golf 4 1.9 TDI 66 kW, 350,000 km | €1,551         |
| Golf 4 1.4 TNG 55 kW, 300,000 km | €1,362         |

The TDI is worth more despite 50,000 more km. That is the behaviour the current benchmark cannot produce.

## Core design

### 1. Eligibility and groups

Two levels of eligibility:

- **Fit row**: `priceNumeric > 0`, integer `year` in `[1950, currentYear]`, `mileageKm > 0`, non-empty `model`, non-null `generation`, `powerKw > 0`, non-empty `fuelType`, non-empty `transmission`.
- **Scorable row**: `priceNumeric > 0`, valid `year`, `mileageKm > 0`, non-empty `model`, non-null `generation`. Missing optional properties are imputed:
  - `powerKw` missing → group mean of `ln(powerKw)` from fit rows.
  - `fuelType` missing/unknown → petrol base category.
  - `transmission` missing → manual base category.

Group key stays `model \0 generation`. Model key is the raw `model` string. Groups without a resolved generation are UNRATED and never pooled (unchanged).

**IQR trim per group.** For groups with at least 8 fit rows, drop prices outside `Q1 − 1.5·IQR … Q3 + 1.5·IQR`. Groups below 8 keep every row. Trimmed rows are still scored; they just do not influence the fit or the observed band.

### 2. Features

Global slope vector over 8 features:

```
x = [ age, km / 10,000, ln(powerKw), diesel, gas, hybrid, electric, automatic ]
```

- `age = currentYear − year`.
- Fuel dummies: petrol is the base. Mapping from stored labels:
  - `Dizel` → diesel
  - contains `Gas` or `Metan` → gas
  - contains `Hibrid` → hybrid (includes plug-in)
  - contains `Elektri` → electric
  - otherwise petrol
- `automatic = transmission.startsWith('Automatski')`.
- Engine cc is intentionally excluded.

Continuous features are clamped to the group's observed fit-sample min/max before prediction. This prevents log-price extrapolation (the old design saw `e^-232` predictions from age/km extrapolation) and keeps a 600,000 km car valued at the group's highest observed odometer, not at zero.

### 3. Fit

Target is `ln(price)`. Fit is a fixed-effects (within-group) OLS:

1. For each group, compute feature means and `ln(price)` mean over kept rows.
2. Accumulate the 8×8 normal equations on demeaned rows.
3. Add a tiny ridge (`1e-8 × mean diagonal`) so a feature with zero within-group variance (e.g. electric in an all-electric model group) gets coefficient 0 instead of making the system singular.
4. Solve with Gaussian elimination. On failure or non-finite coefficients, log and fall back to `β = 0` (intercept-only estimates) for the run.
5. Residual `r_i = ln(price_i) − β·x_i`.

Then hierarchical intercepts:

```
global        μ = Σ r_i / Σ n_g
model base    b_m = (Σ_g r + k·μ) / (n_m + k)
group base    b_g = (Σ_g r + k·b_m) / (n_g + k)
k = 8
```

A group's own residual sum and row count feed its intercept; the model level pools generations of the same model; the global level catches everything else. This is empirical-Bayes-style partial pooling, not a hard fallback: large groups barely move, thin groups borrow strength.

### 4. Per-row prediction (leave-one-out)

The scored row must not price itself. For row `i` with residual `r_i`:

```
μ₋ᵢ = (Σr − r_i) / (N − 1)
b_m,₋ᵢ = (Σ_m r − r_i + k·μ₋ᵢ) / (n_m − 1 + k)
b_g,₋ᵢ = (Σ_g r − r_i + k·b_m,₋ᵢ) / (n_g − 1 + k)
expected_i = exp(b_g,₋ᵢ + β·x_i,clamped)
```

If the row was trimmed out of the fit, it does not appear in `Σ_g r`; the subtraction is skipped and the counts are unchanged. Implement this with explicit `wasKept` arithmetic, not by refitting.

Then:

- **Gate:** `n_g,₋ᵢ ≥ 10` kept rows. Below → UNRATED, `expectedPrice = null`, `deviationPct = null`, sample size null.
- **Band clamp:** clamp `expected_i` to the group's kept price `[min, max]`. If a group has fewer than 8 fit rows it never passes the gate, so the band always comes from a trimmed sample.
- **Deviation:** `dev = capDeviation((expected − ask) / expected × 100)`, cap ±50 (unchanged).
- **Tier and score:** `classifyTier(dev, dev/100 × expected)` and `dealScoreFromDeviation(dev)` (unchanged).

### 5. Persistence

Add one nullable column so the card can state the evidence:

```prisma
/// Number of comparable listings behind expected_price, excluding the row itself.
expectedPriceSampleSize Int? @map("expected_price_sample_size")
```

`expectedPrice` and `deviationPct` already exist. The classifier writes all three; rows below the gate write nulls. `pricePerYear` stays for display/sort compatibility.

Migration: `prisma db push` (Render boot already does this) or `npx prisma db push` locally. Nullable column, no backfill required before classification.

### 6. API and shared type

- `DealsService.getDeals` already spreads the Prisma row; the new field flows through unchanged.
- `packages/shared/src/index.ts`:
  - `expectedPrice`: update comment to "Typical asking price for a car with these properties, stored by the classifier."
  - `deviationPct`: "Ask vs expected price; positive = cheaper than typical."
  - add `expectedPriceSampleSize?: number | null`.
- Update the stale `deals.service.ts` doc comment ("generation benchmark (mileage-adjusted per listing)").

### 7. Frontend card

Replace the benchmark line in `deal-card.tsx`:

```
[+47%]  below typical asking price
        €1,686 · based on 160 similar Golf 4 ads
```

Rules:

- Badge keeps the existing colour logic and rounded percentage.
- When `expectedPriceSampleSize` is null (older API rows), hide the "based on N" clause, not the price.
- Do not repeat year/km/fuel/power in this line; they are already in the card header.
- No range, no confidence badge, no "generation" word.
- Update `deal-card.test.tsx` assertions: new copy, sample-size line, hidden line when `expectedPrice` is null.

### 8. Reclassification and rollout

1. Deploy schema (nullable column) and API code.
2. Run `node dist/src/main.js --classify` from a machine with DB access. This rewrites every row with the new model.
3. Deploy the frontend copy.

Between steps 1 and 2 the DB holds old benchmark values. The card copy would be technically wrong for that window; keep it short and classify immediately after the API deploy.

No startup classification on Render (unchanged). Cron on the local machine continues to classify after each scrape.

## Edge cases

- **Group has 10 kept rows, scored row kept** → 9 comps → UNRATED. The gate is comps excluding self, by design.
- **Scored row trimmed out** → `n_g` comps remain; gate applies to those.
- **Model with two generations** → separate group intercepts, shared model-level prior and global slopes.
- **All rows in a group are diesel** → diesel coefficient is not identified inside that group; the group intercept already carries the diesel level. Correct, not a bug.
- **Electric-only groups** → electric coefficient 0, group intercept carries the level.
- **Unknown model in the generation artifact** → UNRATED (unchanged).
- **Price on request / missing km/year** → UNRATED (unchanged).
- **Future model year (data error)** → not a fit row; scorable only if within `[1950, currentYear]`, otherwise UNRATED.
- **Solve failure** → intercept-only degraded mode, every passed-gate row still gets a number; log an error.
- **Single-row group** → gate fails; UNRATED.

## Acceptance criteria

Measured by a holdout script on the live table (80/20 random split, fixed seed, production algorithm):

1. MdAPE ≤ 12.0% across scored holdout rows.
2. At least 2.0 percentage points better than the current generation benchmark **on the intersection** — rows both estimators score — so coverage differences do not flatter the new model. Report each estimator's own coverage beside the delta.
3. At least 90% of **generation-resolved scorable rows** pass the 10-comp gate. Unresolved-generation rows are a separate, pre-existing limitation and are excluded from this denominator.
4. For every group-size bucket 10–19, 20–49, 50+, median `actual / predicted` lies in `[0.95, 1.05]`.
5. UNRATED share after a full classify pass is ≤ 21% of all rows. Of that, roughly 15.6% is the existing unresolved-generation share (48,526 of 57,478 rows resolve); the gate adds about 4.7 points (5.6% of resolved rows).
6. Deterministic to floating-point tolerance (`1e-9`) for the same rows in the same order. The classifier fetches with `orderBy: { id: 'asc' }` and accumulates sums in that order; no RNG.
7. `npm run test`, `npm run test:e2e`, and frontend `npm run test` pass.

## Testing

**New pure module** (name left to the builder, e.g. `expected-price.ts`):

- OLS recovers known coefficients on synthetic two-group data.
- Ridge keeps a zero-variance feature at 0.
- Shrinkage: a 2-row group prediction sits closer to its model mean than its raw mean.
- Leave-one-out: changing the scored row's own price does not change its expected price.
- Gate: 10 comps scores, 9 does not.
- Clamp: a 600,000 km row never predicts outside the group band; age/km inputs are clamped to observed bounds.
- Fuel mapping covers every stored category.
- Degenerate solve returns finite intercept-only predictions.

**Existing tests**:

- Rewrite `deal-classifier.v2.spec.ts` fixtures for the new expected values and gate. The current 6-row fixtures sit below the gate and must grow to 11+ rows or assert UNRATED.
- Remove `benchmarkExpected` and its tests from production code; move the baseline copy into the committed holdout tool (see below) so the 2 pp comparison stays reproducible.
- `deals.service.spec.ts` type fixtures gain `expectedPriceSampleSize`.
- Remove the `limit` argument from `classifyDeals`: only a unit test used it, and a fixed-effects fit over N most recent rows is meaningless. Classification always fits and persists all rows.

**E2E fixture (required).** The current `test/0-full-flow.e2e-spec.ts` scrapes one page (~200 rows site-wide) and asserts `/deals` is non-empty. With a 10-comp gate, no single `model\0generation` group reaches 10 rows, so `/deals` returns `[]` and the suite fails. Keep the live one-page scrape for pipeline coverage, then insert a deterministic fixture after the scrape and before `classifyDeals`:

- 12 rows of one real model+generation present in the artifact (e.g. `Volkswagen Golf 7`, year 2016), varied price/km/power/fuel.
- 11 rows priced near market, 1 row priced far below so it becomes a GREAT DEAL.
- Unique `listingUrl` values under a `test.local` host.
- Assertions target that fixture row: `expectedPrice != null`, `expectedPriceSampleSize >= 10`, and it appears in `/deals`.

This is a deliberate exception to the "e2e reads real data only" convention: the gate makes live single-page data structurally insufficient.

**Holdout tool**: committed, outside the ignored `good-car-deals-api/scripts/` directory (for example `good-car-deals-api/tools/evaluate-expected-price.ts`). It prints dataset size, max `updatedAt`, seed, both estimators' MdAPE/coverage, the intersection delta, and calibration by group size and price decile. Acceptance numbers are recorded once at implementation time; later runs are diagnostics because the weekly table changes.

## Performance

One pass over ~57k rows: 8×8 normal equations plus O(N) prediction. Sub-second CPU; the existing Prisma fetch dominates. No new tables, no artifact files, no cron changes.

## Risks

- **Asking-price level.** Cheap cars sell faster, so a live-listing snapshot slightly overstates the market level; every car looks a bit cheaper than the true transaction market. Label says "typical asking price", not "value".
- **Residual segment error.** Even with a 10-comp gate, some model-year segments sit near 20% median error (pilot: Audi A4 2008, Peugeot 207 2007). The global 11–12% MdAPE hides this. Mitigation is the gate and honest wording; body/trim/condition fields are the real fix and are out of scope.
- **Single weekly snapshot.** No time trend, no price cuts, no days-on-market. Later scrapes accumulate; the model can add these when the data exists.
- **Model label quality.** Free-text `model` values are the market level key. The generation resolver splits most of them, but a mislabeled model still gets its own intercept. No new normalization logic is introduced here.

## My calls (check these while reading)

1. Gate at **10 comps excluding the scored row**, per user decision.
2. Shrinkage **k = 8**; pilot showed 8 better than 20.
3. **Linear age and km**, no cc, no interactions; measured.
4. **Log price**, hence multiplicative effects and positive predictions.
5. **No range**, per user decision and Appendix B.
6. Store `expectedPriceSampleSize` so the card can show evidence.
7. Card wording: **"typical asking price"**, never "value" or "fair price".
8. IQR trim only for groups with ≥ 8 fit rows; thin groups keep all rows.
9. Coverage is reported on generation-resolved scorable rows; unresolved generations stay a separate, pre-existing 15.6% bucket.
10. `classifyDeals` loses its `limit` argument; fit and persist always cover all rows.
11. E2E gains a deterministic 12-row fixture group; a one-page live scrape cannot reach the gate.

## Left to the builder

- File/module split for the pure fit/predict functions.
- Exact error message and logging for the degraded solve path.
- Test fixture values after the first real classify run.
- Whether the holdout tool lives under `good-car-deals-api/tools/` or another committed path.

## Appendix A — research notes

- Hedonic/semi-log used-car pricing with age, mileage, power, fuel, transmission: Prado 2009 (HAL, log age/mileage), NIST TN 1811 (functional form), Kihm 2016 (371k observations).
- SHAP studies rank age, brand, and engine power above fuel/transmission; matches the measured gains here.
- Partial pooling / empirical Bayes for thin groups: standard hierarchical shrinkage.
- CarGurus IMV: one value plus a deal rating, computed from current and previous comparable listings, adjusted for mileage/options/history. No range.
- KBB distinguishes **Typical Listing Price** (online asking prices) from **Fair Purchase Price / Fair Market Range** (actual transactions). Our data supports only the former.

## Appendix B — why no range

Residual-quantile interval tested on 11,380 held-out rows: global 80% interval `[0.78×, 1.32×]` hits 80.0% overall, but conditional coverage collapses.

| slice              | actual coverage of the 80% interval |
| ------------------ | ----------------------------------- |
| predicted ~€1,830  | 49%                                 |
| predicted ~€3,270  | 72%                                 |
| predicted €8k–€27k | 86–88%                              |
| 1–4 comps          | 33%                                 |
| 5–9 comps          | 58%                                 |
| petrol+TNG         | 66%                                 |

A single range would be wrong exactly where buyers need it. A real interval needs conformalized quantile regression with per-segment coverage checks and enough data per segment; that is a separate project. KBB can show a range because it uses transactions; we cannot.

## Appendix C — pilot coefficient output

`[age, km/10k, ln(kW), diesel, gas, hybrid, electric, auto]`:

```
[-0.0836, -0.0063, 0.3963, 0.0248, -0.0644, 0.0237, 0, 0.0707]
```

Pilot only; production coefficients will differ after the first full classify. Do not hardcode them in tests or UI.
