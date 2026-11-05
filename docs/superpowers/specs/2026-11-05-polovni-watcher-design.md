# Polovniautomobili deal watcher (repurposed willhaben watcher)

**Date:** 2026-11-05
**Status:** Approved for planning (pending user confirmation of this document)
**Repo:** good-car-deals (NestJS 11 API on Render + Next.js frontend on Vercel + Neon Postgres)

## Intent and why

The user wants a push notification the moment a brand-new polovniautomobili listing
shows the best deal in the catalog — deal score exactly 100. Today listings only
reach the app through the weekly Sunday full scrape run from the user's local PC;
a genuinely hot car can sit hours in the feed unscored and unnoticed when the PC
is off.

The API already contains a willhaben watcher that does exactly this loop for the
Austrian market: poll a JSON feed on an interval → track seen ad IDs in the DB →
classify the feed item → if a threshold is met, send a web push. This project
repurposes that watcher to watch polovniautomobili instead. Watcher location
stays the remote Render server (user decision); the local weekly scrape stays as
the full-catalog reconciliation/backfill (non-goal to change it).

## Goals

1. **Detect** new polovniautomobili listings site-wide (all brands) by polling
   feed page 1 on an interval from the Render API, using the existing
   `ApiClientService` / impit transport / build-id retry machinery.
2. **Persist** new rows into the `listings` table by reusing
   `ScraperService.saveListings` unchanged — it applies all the scrape-time
   guards users decided on: foreign-plate skip, `year >= 2000`, price band,
   `mileageKm <= 300000`, upsert keyed on `listingUrl`.
3. **Classify** each newly saved row so it gets `expectedPrice`,
   `deviationPct`, `dealType`, and `dealScore` immediately — see
   "Targeted classification" below.
4. **Buzz** via the existing `PushService.notifyNewAd` for every new row whose
   classified `dealScore` equals exactly 100. Score 100 = hard threshold;
   not ">= 100" (impossible) and not 95.
5. **Exclude** any listing that `saveListings` filters out (they never reach the
   DB, so they can never qualify — do not buzz on skipped rows).
6. **Replace** the willhaben watcher entirely (user decision): after cutover the
   willhaben feed, filter parsing, and `WILLHABEN_*` env handling are deleted,
   not toggled off. No coexistence.

## Non-goals / anti-goals

- No high-frequency site-wide crawl from the watcher. Page 1 of the feed only
  (≤ 200 ads per poll). The weekly local `--scrape` stays unchanged for
  reconciliation and backfill.
- No buzz for bumps or price edits on already-seen ads. Once an ad ID is in the
  seen set, it is dead to the watcher. Price-drop re-scoring of known ads is a
  possible later follow-up, out of scope.
- No per-model or per-brand watchlist configuration. The threshold is
  site-wide score == 100. (WILLHABEN_FILTER-style query parsing dies with the
  willhaben code.)
- No frontend changes required for the core goal: new rows surface through the
  existing ISR `revalidate: 60` flow; the push goes through the existing
  `push-subscribe` UI component and service worker. A "new since last visit"
  badge is a possible later extra, not part of this.
- No schema fix for the pre-existing slug-duplication bug (a title edit rewrites
  the listing URL slug, and the `listingUrl`-keyed upsert then creates a
  duplicate row). Candidate follow-up: store the feed `adId` on `Listing` and
  upsert by it. Recorded here so the builder does not pull it into this build.

## Observed facts from the feed (recon, 2026-11-05)

Each item in `searchResults.results` (fetched via the site's `/_next/data` JSON
endpoint, which `ApiClientService` already consumes) carries:

- `id` (e.g. 30608712) — stable ad identifier, the seen-set key.
- `indexedAt` = `"2026-11-05 09:12:24"` — the ad's index timestamp; feed freshness
  data exists per listing even though `RawListingData`/`SearchResult` types
  don't declare these fields yet. Types get extended, not guessed around.
- `updatedAt` = same string, changes on ad edits/bumps (ignored for newness).
- `searchLiftedAt` for featured/lifted ads (ignored).
- Default search page carries `"sort":"basic"` and silently 308-redirects any
  invalid `sort` value back to `sort=basic` (verified against `sort=date`,
  `sort=datum`, `sort=newest`, `sort=priceAsc`; `docs/research/polovniautomobili-api.md`
  lists `sort=newest`, which the site no longer accepts). The full dropdown
  enum was extracted from the site's JS bundle:
  `basic`, `price_asc`, `price_desc`, `year_asc`, `year_desc`,
  `mileage_asc`, `mileage_desc`, `title_asc`, `title_desc`,
  `renew_date_asc`, `renew_date_desc`, `credit_installment_asc`,
  `credit_installment_desc`, `leasing_installment_asc`,
  `leasing_installment_desc`. The SEO path `/auto-oglasi/najnoviji` is parsed
  as a brand query, not a sort — useless for the watcher.
- First feed item observed had an `indexedAt` from today, consistent with
  newest-first behavior for fresh ads.
- No dedicated "newest listings" REST endpoint exists:
  `core.polovniautomobili.com/api/v1/classifieds/car/{category}/{domain}`
  answers 404/500 for every domain tried (`newest`, others — see
  `docs/research/polovniautomobili-api.md`), and the home-page feed
  (`home-page-classifieds/car/desktop`, 200 OK, 648 curated items, 24/page)
  serves only `homeFeatured` promo picks without timestamps — a real newest
  stream exists only via the Next.js search feed above.

`PushService` facts: subscriptions persist in the Neon `pushSubscription` table,
VAPID keys are already set on Render, sends use TTL 60s, and expired subs
(410/404/401) are cleaned up. `classifyDeals()` is a full-DB pass (58k rows,
batched 500-row updates) — too heavy to run per poll; that is why the watcher
scores against a persisted fit snapshot instead (Architecture below).

## Architecture

The `willhaben-watcher` module (`good-car-deals-api/src/willhaben-watcher/`)
becomes the deal watcher. Suggested rename: `deal-watcher` (module, service,
controller, endpoints `/deal-watcher/poll`, `/deal-watcher/status`) since
willhaben specifics are deleted. Wiring differences from the willhaben version:

- **Seen IDs + what counts as "new":** new Prisma model
  `SeenPolovniAd { id String @id }` (single ID key, snake_case mapping to match
  existing convention). The `seenWillhabenAd` model and its rows are dropped
  after cutover (data = willhaben IDs, useless once retired).

  The seen set alone is NOT the newness signal: `indexedAt` moves on bumps and
  edits too, and builder recon showed ~12 re-indexed old ads resurfacing on
  page 1 per poll — treating every unseen page-1 ID as new would false-buzz a
  score-100 old ad once every few hours. A row counts as **new** only when
  (1) its ad ID is not in the seen set, AND (2) its `listingUrl` is not yet a
  row in `listings` (cheap `findMany` pre-check on the poll batch, ≤200 URLs).
  The seen set remains as the dedupe guard against re-processing the same
  poll page; the DB pre-check is what establishes first-time-in-catalog.

- **Seen flush:** seen IDs flush synchronously at the end of every poll
  (existing batch-500 helper reused, just invoked per poll instead of on a
  background timer). Rationale: a crash mid-poll with unflushed IDs loses
  nothing — those IDs fail the `listings` pre-check on the next poll and are
  never mis-buzzed — while a crash before the old 30-min flush could never
  re-buzz because row-existence covers it either way.
- **Feed fetch:** reuse `ApiClientService.fetchSearchPage(1)` (build id refresh,
  impit, retry, proxy support). Page 1 only; ignore `pageCount` past 1.
  Extend `SearchResult` with `id` and `indexedAt` (and note `updatedAt`) so the
  payload's built-in freshness data stops being throwaway.
- **Newest-first ordering:** the watcher's feed URL appends the site's
  newest-first sort, `&sort=renew_date_desc` (verified live: top-30 covers only
  ~10 minutes of feed activity, and the ordering is pure newest-date desc up to
  a couple of featured-ads pin positions; invalid sort names get silently
  normalized back to `basic` by the site, so the constant must be spelled
  exactly). With the site max `pageSize` of 200, page 1 therefore reaches back
  ~65 minutes per pull against a 10-min poll interval — about 6× headroom, so
  new ads cannot realistically scroll off page 1 between polls. The
  seen-set + `listings` pre-check decides newness; ordering jitter from pinned
  featured ads does not affect correctness, only which row appears first.
- **Persist:** reuse `ScraperService.saveListings(listings)` for the subset
  that passes the newness pre-check. It upserts keyed on `listingUrl`.
- **Classify (snapshot, not refit):** a poll-local refit on one model's comps
  estimates the global OLS terms differently than `classifyDeals()` does over
  the whole table — and at the saturated score-100 edge those small
  coefficient differences flip a buzz on or off. So the watcher does not refit:

  1. `DealClassifierService.classifyDeals()` gains one side-effect: it persists
     a fit snapshot (global OLS coefficients + per-group base terms and group
     stats) into a small Neon table, e.g.
     `ClassificationSnapshot { id, computedAt DateTime, payload Json }`.
  2. The watcher loads the latest snapshot and scores each new row through the
     predict path of `computeExpectedPrices` (builder wires a predict-only
     entry point that takes cached beta/group stats instead of fit rows).
     Resulting v2 fields (`dealType`, `dealScore`, `expectedPrice`,
     `deviationPct`, `expectedPriceSampleSize`, `pricePerYear`) persist for the
     new rows only, mirroring `classifyDeals()`.
  3. **If no snapshot exists yet** (fresh deploy before any full classify run),
     the watcher logs and silently skips buzzing — a real score-100 that
     arrives in that window still gets scored by the Sunday pass, just without
     the instant buzz.

  The weekly local `--scrape` runs `classifyDeals()` and refreshes the
  snapshot; a standalone `--classify` (already supported in `main.ts`)
  bootstraps it after cutover without waiting for Sunday.

- **Buzz decision:** for every saved-and-classified new row with
  `dealScore === 100`: `pushService.notifyNewAd({ id, title, price,
published: indexedAt (ISO-ified), link: listingUrl })`. Push payload shape is
  unchanged, so the existing service worker handles it as-is.
- **Driving & config:** the poll loop stays an in-process `setInterval` on the
  Render instance, which the user's UptimeRobot monitor keeps continuously
  awake — the same condition that lets the current willhaben watcher fire at
  all. This deliberately reverses the repo's earlier "deferred keep-alive"
  stance; the always-warmed DB cost is the user's accepted tradeoff.
  `DEAL_WATCHER_ENABLED="true"` and `DEAL_WATCHER_POLL_INTERVAL_MS`
  (default `600000`; builder may tune 5–30 min) land on Render,
  `WILLHABEN_*` env vars are deleted after cutover.
- **Endpoint:** keep the manual `POST /deal-watcher/poll` for the smoke test and
  manual verification, mirroring the current `/poll` response shape
  (`{ found, newAds }`) extended with `buzzed` count for observability.

## Everything else left to the builder

- Exact module/file naming and whether the controller path uses a new prefix
  (`/deal-watcher/*`) or the old one (`/willhaben-watcher/*`) — new prefix
  preferred; update e2e tests accordingly (the current full-flow e2e spec
  references the watcher endpoints).
- Prisma migration semantics: project convention is `prisma db push` at Render
  startup (render.yaml) and no checked-in migrations; follow existing style.
- Budget/timeout hardening: one poll failure (HTTP error, HTML-instead-of-JSON
  body, Cloudflare challenge) should be logged and skipped, never crash the
  interval loop — reuse the retry patterns in `http.service.ts`.
- Buzz-threshold constant lives in one named constant
  (`SCORE_BUZZ_THRESHOLD = 100`) so a future tweak is a one-line change.

## The one decision branch the user already forces

Smoke-test step 1 (agreed): swap the feed URL/mapping and deploy to Render with
`DEAL_WATCHER_ENABLED=true`, then `POST /deal-watcher/poll` once manually.

- **HTTP 200** → direct feed access works from Render's IPs; proceed with the
  full build as designed. (Historical project note says cloud IPs were 403'd in
  full-scrape attempts; the user offered no proxy and asserts direct works —
  the one manual poll settles which is true today, cheaply.)
- **403 / blocked** → STOP building; the poll path needs a residential proxy
  (`SCRAPER_PROXY_URL` is already plumbed through `impit`) because the user
  refused to run the watcher locally and refused to buy a proxy in the same
  breath — re-open that conversation with the user before writing any more
  watcher code. This document does not preempt that decision.

## Buzz volume estimate

DB has 284 score-100 rows among ~58k listings (442 at ≥95, 650 at ≥90;
`score==100` is the very top). New-ad buzz rate ≈ 0.49% of new ads ≄ expected
on the order of tens per week once live, concentrated in the cheapest/most
liquid models. If output proves too loud the constant is one line; no
architecture change needed to re-threshold.

## Success check (one week after cutover)

- At least one real score-100 buzz received while the watcher was alive.
- Weekly scrape → classify full pass shows no listing classed score-100 later
  than its watch-window arrival minus one poll + classify cycle. With the
  newest-first sort this should be a no-hit check; a hit would mean new ads are
  scrolling past page 1 between polls, i.e. the poll interval needs to shrink.
