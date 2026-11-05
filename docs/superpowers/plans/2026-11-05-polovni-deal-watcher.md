# Polovniautomobili Deal Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose the willhaben watcher so the Render-hosted API polls polovniautomobili feed page 1 (newest-first) every 10 minutes, saves+classifies brand-new listings, and web-pushes a notification for each new listing whose deal score is exactly 100.

**Architecture:** The `willhaben-watcher` NestJS module becomes `deal-watcher`. Poll fetches the site's Next.js data feed with `sort=renew_date_desc&pageSize=200` through the existing `ApiClientService`; a row is "new" only when its ad ID is unseen **and** its `listingUrl` is not yet in `listings`; the existing `ScraperService.saveListings` persists rows unmodified; the watcher classifies saved rows against a fit snapshot that `classifyDeals()` persists per run (no per-poll refit); rows with `dealScore === 100` go through the existing `PushService.notifyNewAd`. The weekly local scrape and the rest of the API stay untouched.

**Tech Stack:** NestJS 11, Prisma 7 + Neon Postgres (`prisma db push`, no checked-in migrations), web-push, impit transport, Jest 30 (colocated `*.spec.ts`), ts-jest.

**Spec:** `docs/superpowers/specs/2026-11-05-polovni-watcher-design.md` (approved). Read it first; this plan argues from it.

## Global Constraints

- Watcher feed URL params exactly: `sort=renew_date_desc`, `pageSize=200`, page 1 only. Any other value for `sort` is 308-redirected to `basic` by the site — the value must be spelled exactly.
- Buzz gate: `dealScore === SCORE_BUZZ_THRESHOLD` where `const SCORE_BUZZ_THRESHOLD = 100` lives in one place (watcher service).
- Newness rule: unseen ad ID **AND** `listingUrl` not already in `listings` (pre-check query on the batch, `findMany` with `select: { listingUrl: true }`).
- `ScraperService.saveListings` must not be modified — reused as-is (it carries the foreign-plate skip, `year >= 2000`, price band, `mileageKm <= 300000` filters and upserts keyed on `listingUrl`).
- `computeExpectedPrices` must not be modified — new snapshot functions reuse its internal helpers; identical math is proven by an equivalence test.
- Poll failures are logged and skipped, never crash the interval loop; a failed fetch must NOT mark any of that batch's IDs as seen (nor flush).
- Seen IDs flush synchronously at the end of every successful poll to `SeenPolovniAd` (batch `createMany` + `skipDuplicates`).
- Delete the willhaben code entirely at cutover: `willhaben-watcher` module files, `SeenWillhabenAd` model, `WILLHABEN_*` env keys. No coexistence.
- Project style: `prisma db push` (no migrations), snake_case columns via `@map`, BigInt IDs, `helmet`+throttle are existing globals; API lint must not use `--fix`.
- e2e/tests referencing the old watcher path (`/willhaben-watcher/*`) are updated to `/deal-watcher/*`.
- Env keys (Render + local `.env`, never committed): `DEAL_WATCHER_ENABLED=true`, `DEAL_WATCHER_POLL_INTERVAL_MS=600000`.

## Review Focus

Inputs the spec implies but task tests must pin:

1. **HTML/Cloudflare body instead of JSON feed** → poll logs one error, returns zero counts, none of the batch marked seen, next interval retries. (Pinned: Task 4, "skips marking seen on failed fetch".)
2. **Duplicate ad rows within one poll batch** (same `adId`, different title slug) → dedupe by `adId` before the pre-check/save; one save, one classification per ad. (Pinned: Task 4, "dedupes by adId".)
3. **Missing or malformed classification snapshot** → `scoreNewRows` returns rows with all v2 fields null, logs a warning, poll continues with zero buzzes. (Pinned: Task 3, "when no snapshot exists".)
4. **BigInt leakage into push payload** → payload `id` is the FEED ad id as a string (`String(adId)`), never a Prisma BigInt; a BigInt throw would abort all buzzes for the poll. (Pinned: Task 4 buzz payload test.)
5. **Push not configured / zero subscriptions** → `notifyNewAd` is a no-op; poll still completes, classification still persisted, seen still flushed. (Pinned: Task 4, "poll completes with push disabled".)

---

### Task 1: Prisma schema — seen-set + snapshot tables

**Files:**

- Modify: `good-car-deals-api/prisma/schema.prisma`

**Interfaces:**

- Produces: Prisma models `SeenPolovniAd { id String @id }` and `ClassificationSnapshot { id DateTime @default(now()) @id, payload Json }` (Column mapping snake_case, mirroring the existing `SeenWillhabenAd` style); Prisma client gains `prisma.seenPolovniAd` and `prisma.classificationSnapshot`.
- `SeenWillhabenAd` model is deleted in this task.

- [ ] **Step 1: Read the current `seenWillhabenAd` block** in `schema.prisma` and note its exact `@map` conventions.

- [ ] **Step 2: Edit the schema** — add `SeenPolovniAd` and `ClassificationSnapshot` (fields as produced above; both tables mapped to `seen_polovni_ads` / `classification_snapshots`), delete the `SeenWillhabenAd` model.

- [ ] **Step 3: Validate and push**

Run: `cd good-car-deals-api && npx prisma validate && npx prisma db push`
Expected: schema valid, push succeeds against the local/dev DB from `.env`.

- [ ] **Step 4: Verify client surface**

Run: `cd good-car-deals-api && node -e "const g=require('@prisma/client').Prisma; console.log(!!g.dmmf.datamodel.models.find(m=>m.name==='SeenPolovniAd'), !!g.dmmf.datamodel.models.find(m=>m.name==='ClassificationSnapshot'), !g.dmmf.datamodel.models.find(m=>m.name==='SeenWillhabenAd'))"`
Expected: `true true true`

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/prisma/schema.prisma
git commit -m "feat(prisma): seenPolovniAd + classificationSnapshot models, drop seenWillhabenAd"
```

---

### Task 2: Feed client — `fetchNewestAds` with newest sort

**Files:**

- Modify: `good-car-deals-api/src/scraper/types.ts`
- Modify: `good-car-deals-api/src/scraper/api-client.service.ts`
- Test: `good-car-deals-api/src/scraper/api-client.service.spec.ts`

**Interfaces:**

- Consumes: existing `fetchWithBuildRetry`, `dataUrlFrom(originalUrl, page)`, `searchUrl` (from `SCRAPER_TARGET_URL`), `toRawListing`, existing `SearchResult`/`RawListingData` types.
- Produces (Task 4 consumes):
  - In `types.ts`: `SearchResult` gains optional fields `indexedAt?: string; updatedAt?: string;` (`id` already exists there).
  - In `types.ts`: `export interface FeedAd { adId: string; indexedAt: string | null; updatedAt: string | null; raw: RawListingData; }`
  - In `ApiClientService`: `fetchNewestAds(page = 1): Promise<FeedAd[]>` — clones `searchUrl`, sets `sort=renew_date_desc` and `pageSize=200`, then uses the existing build-id retry path; maps each `status === 'active'` result to `FeedAd` with `toRawListing(result)`.

- [ ] **Step 1: Write the failing tests** in `api-client.service.spec.ts` ( جديدةdescribe `fetchNewestAds`):

```typescript
describe('fetchNewestAds', () => {
  it(
    'requests sort=renew_date_desc and pageSize=200 and maps ads with ids/indexedAt' /* use the same mocked HttpService pattern as existing tests; feed fixture = two active
     results + one inactive, with id + indexedAt fields */,
  );
  it('does not mutate the shared searchUrl between calls');
  it('deduplicates FeedAds by adId within a page');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd good-car-deals-api && npm run test -- src/scraper/api-client.service.spec.ts`
Expected: FAIL — `fetchNewestAds is not a function`.

- [ ] **Step 3: Implement** `fetchNewestAds(page = 1): Promise<FeedAd[]>` in `api-client.service.ts`. Build the URL on a `new URL(...)` copy of `searchUrl`; never mutate the class member. Reuse `dataUrlFrom(urlCopy.toString(), page)` inside `fetchWithBuildRetry`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd good-car-deals-api && npm run test -- src/scraper/api-client.service.spec.ts`
Expected: PASS (all tests in the file, old + new).

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/src/scraper/types.ts good-car-deals-api/src/scraper/api-client.service.ts good-car-deals-api/src/scraper/api-client.service.spec.ts
git commit -m "feat(scraper): newest-first feed client for deal watcher"
```

---

### Task 3: Fit snapshot — build, persist, and score new rows without a refit

**Files:**

- Modify: `good-car-deals-api/src/analysis/expected-price.ts`
- Test: `good-car-deals-api/src/analysis/expected-price.spec.ts`
- Modify: `good-car-deals-api/src/analysis/deal-classifier.service.ts`
- Test: `good-car-deals-api/src/analysis/deal-classifier.service.spec.ts`

**Interfaces:**

- Consumes: internals of `computeExpectedPrices` (fit phase: `featureVector`, `featureMeans`, ridge solve, group base terms and price bands; predict phase: clamp to observed price band; the deal type / score mapping used by `classifyGroups` — read `expected-price.ts` and `deal-classifier.service.ts` fully before writing), `resolveGeneration`, Prisma `classificationSnapshot` table.
- Produces (Task 4 consumes):
  - In `expected-price.ts`: `export interface FitSnapshot { ... shape mirrors what the name implies ... }` — payload contains the fitted coefficient vector, feature means, a `Record<groupKey, GroupSnapshot>` keyed by `Normalized`${model} g${generation}``` with per-group base term + price band, and `scorePool: number[]` (all deviationPct values from the rated pool, ascending).
  - `export function buildFitSnapshot(args: { fitRows: ExpectedPriceRow[]; scorePool: number[] }): FitSnapshot`
  - `export function predictFromSnapshot(snapshot: FitSnapshot, predictRows: ExpectedPriceRow[]): ExpectedPriceResult[]`
  - Export any internal helpers needed for this (e.g. `featureVector`, `featureMeans`, the group-fit solver) rather than duplicating math. Do not alter existing exported behavior.
  - In `DealClassifierService`:
    - `classifyDeals()`: after persisting per-row updates, also persists the snapshot — `prisma.classificationSnapshot.deleteMany({})` then `create` with `{ payload: buildFitSnapshot({ fitRows, scorePool: ratedDeviationPcts }) }` (use the same `rows` already fetched; one row per run).
    - `scoreNewRows(rows: ClassifierRow[]): Promise<ScoredRow[]>` — loads the latest snapshot (or returns inputs with v2 fields null + a warn log when none/malformed exists), maps rows via `resolveGeneration`, scores through `predictFromSnapshot`, derives `dealType` + `dealScore` with the exact same mapping `classifyGroups` uses (reuse its internal label/percentile logic — export a helper, don't copy), and returns `{ id, dealType, dealScore, expectedPrice, deviationPct, sampleSize }` per row.

- [ ] **Step 1: Write the failing tests** in `expected-price.spec.ts`:

```typescript
describe('fit snapshot', () => {
  it(
    'predictFromSnapshot matches computeExpectedPrices exactly on a held-out subset (1e-9)',
    /* fixture: synthetic dataset covering >=2 generations x >=15 rows each with
        age/km/power/fuel/transmission spread; call computeExpectedPrices on the full
        set, buildFitSnapshot on the same full set (scorePool may be [] for this
        test — it is a classifier-layer input, not a pricing input), then
        predictFromSnapshot on a held-out subset; compare
        expectedPrice per id within 1e-9 */
  );
});

describe('scoreNewRows', () => {
  it(
    'returns v2 fields null and logs when no snapshot exists' /* mock prisma.classificationSnapshot.findFirst -> null */,
  );
  it(
    'scores rows deterministically against the stored scorePool' /* mock snapshot with known small yardstick pool; assert dealScore/dealType values */,
  );
  it(
    'survives a malformed payload (returns null v2 fields, warn log)' /* payload = {version: 1} without groups */,
  );
});
```

Note in the classifier spec: `classifyDeals` snapshot-persist step is covered by the full-pass test — extend one existing `classifyDeals` test to assert `prisma.classificationSnapshot.deleteMany` + `create` were called once with a payload containing `scorePool` and at least one group entry.

- [ ] **Step 2: Run to verify they fail**

Run: `cd good-car-deals-api && npm run test -- src/analysis/expected-price.spec.ts src/analysis/deal-classifier.service.spec.ts`
Expected: FAIL — `buildFitSnapshot` / `scoreNewRows` not defined.

- [ ] **Step 3: Implement** per the Interfaces block. The `FitSnapshot` JSON payload may reach ~1 MB (57k floats at full precision — acceptable for a Neon `Json` column; numbers round-trip binary64 exactly through `JSON.stringify`/`parse`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd good-car-deals-api && npm run test -- src/analysis/expected-price.spec.ts src/analysis/deal-classifier.service.spec.ts`
Expected: PASS including the 1e-9 equivalence test.

- [ ] **Step 5: Commit**

```bash
git add good-car-deals-api/src/analysis/expected-price.ts good-car-deals-api/src/analysis/expected-price.spec.ts good-car-deals-api/src/analysis/deal-classifier.service.ts good-car-deals-api/src/analysis/deal-classifier.service.spec.ts
git commit -m "feat(analysis): persisted fit snapshot + snapshot scoring for incremental rows"
```

---

### Task 4: Deal watcher — module, poll flow, classification gate, buzz

**Files:**

- Create: `good-car-deals-api/src/deal-watcher/deal-watcher.service.ts`
- Create: `good-car-deals-api/src/deal-watcher/deal-watcher.module.ts`
- Create: `good-car-deals-api/src/deal-watcher/deal-watcher.controller.ts`
- Create: `good-car-deals-api/src/deal-watcher/deal-watcher.service.spec.ts`
- Delete: `good-car-deals-api/src/willhaben-watcher/` (all three files)
- Modify: `good-car-deals-api/src/app.module.ts` (swap `WillhabenWatcherModule` → `DealWatcherModule`)
- Modify: `good-car-deals-api/src/scraper/scraper.module.ts` (export `ApiClientService` and `ScraperService` if not already exported)

**Interfaces:**

- Consumes: `ApiClientService.fetchNewestAds(page=1)` (Task 2), `ScraperService.saveListings(FeedAd-raws)` returning `Prisma.Listing[]` (existing), `DealClassifierService.scoreNewRows(rows)` (Task 3), `PushService.notifyNewAd({ id, title, price, published, link })` (existing), `prisma.seenPolovniAd` (Task 1).
- Produces:
  - `WillhabenWatcherService` logic replaced by `DealWatcherService` with the same shape as today's watcher: `onModuleInit` loads `seenPolovniAd` rows into an in-memory `Set<string>`, starts the interval when `DEAL_WATCHER_ENABLED === 'true'`, logs otherwise; `onModuleDestroy` clears the interval.
  - `poll(): Promise<{ found: number; newAds: number; buzzed: number }>`:
    1. `found = ads.length` from `fetchNewestAds(1)`.
    2. Dedupe by `adId` within the batch.
    3. Pre-check: `prisma.listing.findMany({ where: { listingUrl: { in: urls } }, select: { listingUrl: true } })` → keep only unseen-and-not-in-DB `FeedAd`s (`newAds` = that count).
    4. `const saved = await scraperService.saveListings(kept Ads' raws)` (returns only rows that cleared the scrape filters).
    5. Classify saved rows: convert to `ClassifierRow` (same mapping `classifyDeals` uses minus generation — `scoreNewRows` resolves it), call `scoreNewRows`; for each returned row with `dealScore === SCORE_BUZZ_THRESHOLD`, map back to its `adId`/`indexedAt` (by `listingUrl`) and `pushService.notifyNewAd({ id: String(adId), title, price: String(priceNumeric), published: indexedAt, link: listingUrl })`; count `buzzed`. A `scoreNewRows` rejection is caught, logged, and yields zero buzzes (rows stay unclassified in DB; seen flush still proceeds).
    6. Mark ALL batch ad IDs (seen or not, saved or filtered-out) into the seen set; flush synchronously via `prisma.seenPolovniAd.createMany({ data: [...], skipDuplicates: true })`. A flush failure is logged, and the pending IDs are retained in memory for the next poll.
  - `const SCORE_BUZZ_THRESHOLD = 100` at the top of the service.
  - Controller: `@Controller('deal-watcher')` with `@Get('status')` → `{ ok: true }` and `@Post('poll')` → `poll()`.
  - Env config: `DEAL_WATCHER_ENABLED === 'true'` gate; `DEAL_WATCHER_POLL_INTERVAL_MS` number, default `600000`.

- [ ] **Step 1: Write the failing tests** in `deal-watcher.service.spec.ts` (mock `ApiClientService`, `ScraperService`, `DealClassifierService`, `PushService`, `PrismaService`):

```typescript
describe('DealWatcherService.poll', () => {
  it(
    'saves only rows that are unseen and not in the DB, and classifies+buzzes score-100 rows',
  ); // one ad at score 100, one at 95 -> notifyNewAd called once with payload id as string
  it('dedupes by adId before pre-check/save'); // two FeedAds with same adId -> saveListings called with one raw
  it('treats rows already in the DB as not new even when unseen'); // pre-check findMany returns a matching listingUrl -> saveListings not called with it, still marked seen
  it('skips marking seen when fetchNewestAds rejects'); // apiClient mock throws HttpError(403) -> seenPolovniAd.createMany not called, result counts zero
  it(
    'completes the poll when scoreNewRows rejects (zero buzzes, seen flushed)',
  ); // classifier mock rejects -> buzzed=0, flush happens
  it('completes the poll when push is disabled'); // push mock resolves without sending -> classification results still returned, flush happens, buzzed counts notify calls only
  it('flushes all batch ids to seenPolovniAd synchronously at poll end');
  it(
    'does not fetch when disabled and still answers POST poll' /* onModuleInit with DEAL_WATCHER_ENABLED=false -> interval not started; direct poll() works */,
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd good-car-deals-api && npm run test -- src/deal-watcher/deal-watcher.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `DealWatcherService` + module + controller per Interfaces; delete `src/willhaben-watcher/`; update `app.module.ts`; make `scraper.module.ts` export the two providers if it does not already.

- [ ] **Step 4: Run to verify it passes**

Run: `cd good-car-deals-api && npm run test -- src/deal-watcher/deal-watcher.service.spec.ts src/app.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A good-car-deals-api/src/deal-watcher good-car-deals-api/src/willhaben-watcher good-car-deals-api/src/app.module.ts good-car-deals-api/src/scraper/scraper.module.ts
git commit -m "feat(deal-watcher): repurpose willhaben watcher to polovni newest-feed watcher"
```

---

### Task 5: Repo-wide rename sweep + full suite + lint

**Files:**

- Modify: any `good-car-deals-api/test/*.e2e-spec.ts` still referencing `willhaben-watcher`
- Modify: `good-car-deals-api/.env.example` if watcher keys exist there
- Modify: `AGENTS.md` watcher row (`willhaben watcher` → deal watcher path/behavior note)

- [ ] **Step 1: Find references**

Run: `grep -rni "willhaben" good-car-deals-api/src good-car-deals-api/test AGENTS.md && (grep -ni "willhaben" good-car-deals-api/.env.example 2>/dev/null; true)`
Expected: nothing left except `AGENTS.md` mention to be edited in Step 2 and the .env.example key block.

- [ ] **Step 2: Update e2e + docs + example env** — replace `/willhaben-watcher/poll|status` with `/deal-watcher/poll|status`; replace `WILLHABEN_*` env keys in `.env.example` with `DEAL_WATCHER_*`; update the `AGENTS.md` row that names the willhaben watcher endpoints to the deal-watcher endpoints (one-line behavior note: poll feed page 1 newest-first, buzz score-100 via web push).

- [ ] **Step 3: Run the full API suite + build + lint**

Run: `cd good-car-deals-api && npm run test && npm run test:e2e && npm run build && npm run lint`
Expected: PASS clean; lint must not rewrite files.

- [ ] **Step 4: Frontend untouched but verify its suite still passes**

Run: `cd good-car-deals-frontend && npm run test`
Expected: PASS (no watcher coupling; sanity only).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(deal-watcher): rename sweep, e2e + docs, env keys"
```

---

### Task 6: Cutover runbook (no code; execute after merge)

**Files:**

- No source changes. Render dashboard + local commands only.

- [ ] **Step 1: Bootstrap the snapshot locally (writes into Neon via `.env`):**

```bash
cd good-car-deals-api && node dist/src/main.js --classify
```

Expected: logs `Classification complete`, then a snapshot row exists in Neon (`classification_snapshots`).

- [ ] **Step 2: Set Render env** — add `DEAL_WATCHER_ENABLED=true` and `DEAL_WATCHER_POLL_INTERVAL_MS=600000`; after the first successful poll below, delete `WILLHABEN_ENABLED`, `WILLHABEN_FILTER`, `WILLHABEN_POLL_INTERVAL_MS`.

- [ ] **Step 3: Deploy (merge to main) and smoke-test the feed reachability:**

```bash
curl -sX POST https://good-car-deals-api.onrender.com/deal-watcher/poll
```

Expected per the spec's decision branch: HTTP 200 with `{ found: 200, newAds: 0..20, buzzed: 0 }` → continue (first poll after cutover finds most page-1 ads already in `listings`, so `newAds` should be small). A 403/HttpError in the Render logs → STOP: re-open the residential-proxy discussion with the user before any further watcher work.

- [ ] **Step 4: One live buzz spot-check** — wait for the next poll cycle; confirm the API logs show a poll with `newAds > 0` and (if any score-100 appeared) a push send; frontend cards update on next ISR revalidation.

- [ ] **Step 5: Record outcome in `AGENTS.md` deployment table row for the watcher** (poll interval, env, smoke result).

---

## Worktree note

Execute in a git worktree off current `HEAD`. The user's unrelated in-progress changes (`schema.prisma`, `scraper/*` edits, tests, `plan.md`, `todo.md`) are uncommitted in the main tree and will NOT appear in the worktree; merging this branch back happens after that is resolved (user's call).
