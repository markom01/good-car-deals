# Deal Score v2 — design

**Date:** 2026-10-27 · **Status:** awaiting approval
**Scope:** `good-car-deals-api` (classifier, scraper save, Prisma schema), `packages/shared`, API output shape. No frontend redesign.

## Intent / why

Current scoring (`max(0, 100 − pricePerYear/100)`, comps = mean price/year of first-two-title-words group) is broken in three ways:

1. **Saturated score**: any old cheap car scores 80–100; variance dies; ranking meaningless.
2. **Ignored mileage**: 90k km and 290k km listings compete equally. Scraper parses mileage but the model never uses it.
3. **Contaminated comps**: "Opel Astra" groups every generation and every year; mean, not median, so one part-out car (€1,700 at 222k km) drags the average.

External research (2026-10-27, sources in Appendix): industry standard is **price vs. model-predicted fair value from comparable listings**, expressed as % deviation, banded into tiers (CarGurus IMV + 5 deal ratings; iSeeCars market price model; US Patent 10546337 z-normalization). Deal score becomes a property of the listing _relative to its market cell_, not an absolute number.

## The correction from the human partner

Comps must key on **generation-inclusive model** — "Astra J", not "Astra". Site titles carry generation (`"Opel Astra J 1.7 CDTI"`); scraper search URL already uses it (`SCRAPER_MODEL=Astra J` → `model[]=Astra+J`).

**Decision (my call):** comp-cell key = `SCRAPER_MODEL` string (contains generation, e.g. "Astra J"). No `generation` title-parser utility (builder-check: no caller in single-model config — YAGNI); multi-model support is deferred and will need its own cell-key design when it arrives. Classifier stops overwriting the DB `model` column with the two-word title extract.

## Goals / non-goals / anti-goals

**Goals**

- Listings ranked and badged relative to an expected price computed from their own market cell.
- Mileage (and age) drive the expected price.
- Scraper persists fields it already parses: `fuelType`, `engineVolume`, `powerKw`, `transmission`, `location`.
- Existing weekly flow unchanged: scrape → save → classify.

**Non-goals (deferred)**: sold-listing capture (`delistedAt`), days-on-market term, price-change tracking, scam/verify badges, frontend spec chips for fuel/transmission.

**Anti-goals**: no ML dependencies (no tfjs/onnx); no forced percentile bucketing (Cars.com friction argument — if the whole market is cheap, most listings should read cheap); score must not saturate; no call-site changes in frontend components beyond additive fields.

## Core design

### 1. Expected price

Two estimators, chosen by row count for the model's whole dataset (all rows share the comp cell in single-model config):

- **Regression (primary, ≥ 12 usable rows):** OLS `price ~ intercept + age + mileageKm [+ powerKw + diesel + automatic]`, fit in plain TypeScript (Gaussian elimination, 3–6 params). Fit on IQR-trimmed prices (Q1 − 1.5·IQR … Q3 + 1.5·IQR). `expected(l) = a + b·age + c·km` plus the surviving optional terms. Optional engine-trim terms, each behind a guard so a thin column can't destabilize the base fit: `coefKw` only when ≥ 12 usable rows carry kW (≥ 2 distinct values; wrong-sign ≤ 0 drops the term, fit re-runs as plain age+km); `coefDiesel` / `coefAuto` dummies only when BOTH classes hold ≥ 10 rows (empirical 2026-10-28 Corsa D run: LOO-MAPE 16.2% → 13.9% with kW; kW beats engineCc which is collinear r=0.74; auto n=9 → correctly excluded by the guard). Scoring convention: rows without a kW value are scored at the fit sample's mean kW (mean-imputation — kw=0 would understate them); missing dummy attributes count as the 0 side (mild: unknown fuel ≈ petrol).
- **Cell median (fallback, 3–11 rows):** median of IQR-trimmed prices in the cell `model + generation + year ± 1, km ± 20%` (year cell mandatory; km split only if cell still ≥ 3 after split).

Below 3 usable rows → **UNRATED** (no dealType/score beyond "unrated").

**Fit guards (builder-check findings, my calls):**

- Rows trimmed out of the fit **still get scored** against the fit — with the km coefficient active, a low-km-expected part-out prices near its cell anyway. No extra clamp; if something is genuinely far below market it belongs at the top of a bargain board.
- Degenerate fit (negative km coefficient, non-invertible normal equations, or expected ≤ 0) → discard fit, fall back to cell median for all rows.
- `mileageKm`-null rows are never regression-usable and never reach `/deals` today — they get **UNRATED** in v2 too.
- `dev%` guarded against `expected ≤ 0` (division) by the degenerate-fit fallback above.
- Classifier query stops excluding `year`-null rows so they receive UNRATED instead of keeping stale labels.

### 2. Deal score

`dev% = (expected − ask) / expected × 100` — positive = below expected.

- **dealScore** = market percentile of `devPct` across all rated listings (global, integer 0–100): best deal → 100, median deal → 50, worst → 0. Tiers stay absolute (bands below); the score is the relative position in today's pool. Ascending `dealScore desc` sort puts the best deal first. Ties are expected at integer granularity (a few listings per point).
- **dealType** badge from devPct:
  - `GREAT DEAL`: devPct ≥ 10
  - `GOOD DEAL`: 4 ≤ devPct < 10
  - `FAIR PRICE`: −4 < devPct < 4
  - `HIGH PRICE`: −10 < devPct ≤ −4
  - `OVERPRICED`: devPct ≤ −10
  - `UNRATED`: < 3 comps
- Numbers chosen from published CarGurus-family cutoffs (Great ≈ −10%, Good ≈ −5%, Fair ≈ ±5%, Overpriced ≈ +10%), tightened Fair to ±4% for a small single-generation market. σ/z-score is used for sorting ties, not displayed bands — σ is unstable at 3–10 comps.

### 3. Persisted parser fields (schema additions)

`fuelType String?`, `engineCc Int?` (from `engineVolume`), `powerKw Int?`, `transmission String?`, `location String?` — parsed values `saveListings` currently discards. Also add `expectedPrice Float?`, `deviationPct Float?` for transparency/debug. Prisma migration `add_deal_v2_fields`; backfill script runs one scrape-less pass (existing rows gain expected/deviation/score on next classify).

### 4. API / shared types

`Listing` gains: `expectedPrice?: number | null`, `deviationPct?: number | null`, `fuelType?: string | null`, `powerKw?: number | null`, `transmission?: string | null`, `location?: string | null`. `modelAvgPriceNumeric`/`priceToModelAvgPct` fields stay (frontend still uses them); the averaging pool switches from **good-deals-only** to **all rows with a set expectedPrice** (removes selection bias → badge can no longer contradict the tier structurally), same year±1 cell restriction, min count 3. `deals.service` tier filter changes from `startsWith('GOOD DEAL')` to `dealType in (GREAT DEAL, GOOD DEAL)` — backend decides which tiers surface as "deals": GREAT + GOOD.

### 5. Mileage-adjusted deal quality (goal 2 satisfied)

Regression handles it directly: km coefficient prices each extra km across the generation; year coefficient prices aging. Where only cell-median exists, km ±20% split plays the mileage role. `pricePerYear` stays (display), no longer a scoring input.

### 6. Backfill / re-classification at deploy (builder-check finding)

No classify-only entry point exists today, and Render boots with `SKIP_STARTUP_SCRAPE=true`, so after deploy existing rows keep stale labels and `/deals` is empty until the next weekly scrape. Fix: add a `--classify` CLI flag in `main.ts` (mirrors `--scrape`: scrape-only mode → classify-only mode, then exit) — run once from a machine with DB access after `prisma db push`. Documented in the deploy runbook; no startup-time classification.

### 7. Feasibility check on live data (2026-10-27 spike) — GO

Ran the v2 math against the 363-row live `listings` table (spike: `/tmp/opencode/feasibility.cjs`, throwaway):

- Coverage: 361/363 rows fully usable (price + valid year + km > 0); regression threshold 12 → 30× margin. 2 excluded rows have data-error year=2027 (age ≤ 0 auto-excluded).
- Year cells: 12/13 year±1 windows hold ≥ 3 rows; km ±20% split available where counted toward the median fallback.
- OLS on 344 IQR-trimmed rows (bounds [2550, 7750] €, Q1 = 4500, Q3 = 5800): intercept 9,625 €, **−255 €/year**, **−4.51 €/1000 km**, R² 0.377. Both coefficients correctly signed — fit is usable.
- Expected-price sanity: 2010/200,000 km → 4,642 €; 2013/130,000 km → 5,723 € — sits sensibly in the observed price band.
- Tier spread (scored, n = 361): GREAT 83 · GOOD 45 · FAIR 85 · HIGH 51 · OVERPRICED 97 — no saturation; top of the board reads +12…+21% below expected, prices 3,850–4,599 €.
- Outliers bounded: 5 rows dev > +40%, 28 rows dev < −25% (kept visible on the board per decision #2, excluded from the fit via IQR).

**Consequence applied to §1**: regression fits **per `model`-group value** in the DB (one fit per distinct `model` string, e.g. all-"Astra J" rows today), so a future config change never mixes two markets in one fit. Same for cell-median fallback.

## Constraints

- No changes to scraping targets/frequency; weekly cron untouched; startup/wipe behavior untouched.
- BigInt·toJSON patch in `main.ts` covers new Float/Int columns naturally.
- Render boot runs `prisma db push` — deployment adds the new columns safely; `.env` untouched.
- Tests: extend `deal-classifier.service.spec.ts` (dev/score/bands/regression); `html-parser.service.spec.ts` already covers parsed fields; e2e `full-flow` assertions updated for new labels.

## Left to the builder

Exact SQL/migration naming, leaderboard of edge cases (year missing → UNRATED), and whether `getPage` sorting uses `dealScore desc` (recommended default stays).

---

## Appendix — research sources

- CarGurus IMV & deal ratings (help.cargurus, IMV one-pager, 10-K via baronauto1 summary): price vs IMV in 5 tiers, updated daily, comps = current + past listings incl. mileage/options/history.
- Cardog.app write-up (2025-11): engine thresholds cited ≈ Great −10%, Good −5..−10%, Fair ±5%, High +5..+10%, Overpriced > +10%; thresholds not officially published.
- US Patent 10546337: relative value = (fair − ask)/σ, percentile/figure-of-merit mapping, Bayesian dealer reputation modifier.
- US Patent 10108989 (Microsoft): per-trim depreciation curves + regression over mileage, condition, region, transmission, engine, options, days-to-sell.
- Cars.com (Digital Dealer, 2018): ML-priced badges, **no forced percentile bucketing** — "if 25 M3s are all Good, say so".
- iSeeCars methodology pages: market value from similar local listings (price, mileage, condition, features); days-on-market ≈ 31.5 d avg, ~7% price cuts; too-cheap = fraud signal.
- OAV.io: separate demand signals (days-on-lot) from the price verdict; "Unscored" when comps too thin.
- arXiv 2403.03812 (ProbSAINT): offer-duration-conditioned pricing; delisting-as-sale methodology from Sahibinden DSS paper (sold cars had lower price AND km).
