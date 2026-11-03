# GOOD CAR DEALS API

## OVERVIEW

NestJS 11 backend — scrapes `polovniautomobili.com`, classifies deals by score, serves via REST on port 3001.

## STRUCTURE

```
src/
├── config/              # Env config + class-validator schema
│   ├── configuration.ts        # AppConfig interface, env → config
│   └── validation.schema.ts    # EnvVariable class, validate()
├── prisma/              # Prisma 7 service + module
│   ├── prisma.service.ts       # Wraps PrismaClient
│   └── prisma.module.ts
├── scraper/             # HTTP client, HTML parser, cron
│   ├── http.service.ts         # impit (Chrome TLS fingerprint), retries, page URL builder, proxy support
│   ├── html-parser.service.ts  # cheerio, featured/regular listing parsing
│   ├── scraper.service.ts      # Resumable page loop, dedup, upsert to DB, pagination-cap guard
│   ├── cron.service.ts         # @Cron(EVERY_WEEK), orchestrates scrape→save→classify
│   └── scraper.module.ts
├── analysis/            # Deal classification
│   ├── deal-classifier.service.ts   # Grouping + scoring (OLS + cell-median)
│   ├── deal-stats.ts                # Pure math: IQR trim, OLS fit, tiers, percentiles
│   ├── generation-resolver.ts       # Offline artifact → one generation or null
│   └── generation-periods.json      # Model generations (auto-parts-db artifact)
├── deals/               # REST endpoint
│   ├── deals.controller.ts    # GET /deals
│   ├── deals.service.ts       # Sorted by dealScore (or pricePerYear) + flat generation benchmark
│   └── deals.module.ts
├── utils/               # Standalone helpers
│   └── normalization.ts       # Mileage, price, model, age, pricePerYear
├── app.module.ts        # Root — imports Config, Schedule, Prisma, Scraper, Analysis, Deals
└── main.ts              # BigInt.toJSON polyfill, CORS, --scrape mode, SKIP_STARTUP_SCRAPE
```

## SCRAPING PIPELINE

1. **HttpService** — `impit` with Chrome TLS fingerprint. 3 retries with exponential backoff. Retries on timeout, 403, 503, network errors. `fetchPage` returns HTML, `fetchJson` returns parsed JSON; non-2xx throws `HttpError` with `status`. Supports optional `SCRAPER_PROXY_URL` for residential proxy.
2. **ApiClientService** — primary data source. `fetchSearchPage(page)` calls the site's Next.js data endpoint `/_next/data/<buildId>/auto-oglasi/pretraga.json` (buildId read from `__NEXT_DATA__`, refreshed once on 404) with `pageSize=200` (the site maximum; 250 silently falls back to 25) and maps JSON results into `RawListingData`. The feed already returns only `status === 'active'` ads, so there is no per-ad detail call at all.
3. **ScraperService** — Loops pages `start..min(pageCount, SCRAPER_MAX_PAGES)` (default cap 500) with 1s delay between requests. **Resumable**: `scrapeAndSaveResumable()` saves each page as it arrives, records `lastPage`/`pageCount` in the `scrape_progress` table after every page, and on the next run continues at `lastPage + 1` when the previous run was interrupted (`status = running`). A finished run (`status = done`) starts fresh. **Deep-pagination guard**: the site caps pagination at page 750 and re-serves page 1 past it, so a page that brings zero new `listingUrl`s aborts the run and marks `status = capped` instead of saving duplicates; at `pageSize=200` the whole ~70k catalogue fits under that cap. `SCRAPER_START_PAGE` seeds a fresh run when earlier pages already exist in the DB (e.g. filling a gap without refetching the rest). Stale rows (`scrapedAt < startedAt`) are deleted only after a complete, unseeded run. Deduplicates by `listingUrl` (`/auto-oglasi/<id>/<slug>`; the slug is generated from the title and canonicalised by the site — a URL without a slug renders the search page). Stores the feed's `brand` + `model` as a brand-scoped label ("Opel Astra") so comps never mix brands. 1 page failure doesn't stop the rest.
4. **CronService** — `@Cron(CronExpression.EVERY_WEEK)`. Orchestrates scrape → save → classify. Errors don't crash the app, existing DB data preserved.
5. **Startup** — With `SKIP_STARTUP_SCRAPE=true`, skips scraping. With `--scrape` flag, runs the resumable scrape-only mode (no pre-delete) and exits.

## DEAL CLASSIFICATION

v3 generation-only scoring in `deal-classifier.service.ts` + pure math in `src/analysis/deal-stats.ts`:

- **Generation-only benchmark** — `generation-resolver.ts` maps `model` + `year` to exactly one generation from the offline artifact (`generation-periods.json`). Boundary/gap years fall back to the **nearest generation**; models absent from the artifact resolve to `null`. Rows are grouped by the composite key `model\0generation` (artifact generation names are model-relative, e.g. 'MK1' collides across 455+ models). Rows with unresolved generation → `UNRATED`, no benchmark, never pooled.
- **Expected price per row** — Per group, `expectedPrice` = the generation's IQR-trimmed median ask price, mileage-adjusted by a robust Theil–Sen slope fitted on the group's `{ price, km }` rows (stride subsampling at > 500 rows, no RNG). Adjustment targets the row's own odometer and clamps to the IQR-trimmed price range. Slope `≥ 0`, non-finite, or degenerate km span → plain trimmed median (no adjustment). Group scored only when its usable pool ≥ `GENERATION_MIN_RATED` (5); below → every row in the group `UNRATED`. No model-wide pooling, no year±1 cell, no cross-generation comps.
- **Deviation → score → tier** — `deviationPct = (expected − ask) / expected × 100` (positive = cheaper than expected), **capped at ±50** (`MAX_DEVIATION_PCT`) before scoring. Score is absolute, not percentile: `dealScore = clamp(round(50 + dev × 4), 0, 100)`. Tier euro gates: `GREAT DEAL` = dev ≥ 10% AND devEur ≥ €500; `GOOD DEAL` = dev ≥ 4% AND devEur ≥ €200 (devEur = dev × expected / 100, from capped dev); one-level demotion when the euro leg fails (GREAT → GOOD → FAIR); `FAIR PRICE` = (−4, +4); `HIGH PRICE` = (−10, −4]; `OVERPRICED` = ≤ −10. Missing year/km/price or non-positive expected price → `UNRATED` with score 0.
- **Persistence** — Each pass writes `dealType`, `dealScore`, `expectedPrice`, `deviationPct` (+ keeps `pricePerYear` for display/sort compat).
- **CLI** — Re-run classification without scraping: `node dist/src/main.js --classify` (one-shot, mutates DB labels in place, then exits).
- **Deploy note** — Render boot (`prisma db push` + `SKIP_STARTUP_SCRAPE=true`) picks up the v3 columns automatically; first `/deals` after deploy returns [] until `node dist/src/main.js --classify` runs.

## KEY FILES

| File                              | Role                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.module.ts`                   | Root module, imports ConfigModule.forRoot (with validate), ScheduleModule.forRoot, ThrottlerModule, Prisma, Scraper, Analysis, Deals; registers global ThrottlerGuard |
| `main.ts`                         | `BigInt.prototype.toJSON`, `helmet()`, CORS with optional `CORS_ORIGIN` allowlist, `--scrape` CLI flag, `SKIP_STARTUP_SCRAPE` env var                                 |
| `cron.service.ts`                 | `@Cron(CronExpression.EVERY_WEEK)` — entry point for full pipeline                                                                                                    |
| `src/config/validation.schema.ts` | 3 required env vars (DATABASE_URL, SCRAPER_TARGET_URL, SCRAPER_CRON_SCHEDULE) + optional SCRAPER_BRAND/SCRAPER_MODEL (unused), SCRAPER_PROXY_URL, CORS_ORIGIN         |
| `prisma/schema.prisma`            | Single `Listing` model — BigInt id, snake_case via `@map()`, table `listings`, indexes on dealScore/dealType/model/scrapedAt                                          |

## TESTS

- **Unit** — `*.spec.ts` co-located with source. Jest 30, ts-jest, `rootDir: src`.
- **E2E** — `test/*.e2e-spec.ts` with Supertest. Config: `test/jest-e2e.json`.
- **Setup** — `src/.jest/set-env.ts` loads test env vars before suite.

Current test files: `app.controller.spec.ts`, `deal-classifier.v2.spec.ts`, `deal-stats.spec.ts`, `generation-resolver.spec.ts`, `deals.service.spec.ts`, `http.service.spec.ts`, `http.service.liveness.spec.ts`, `scraper.service.spec.ts`, `normalization.spec.ts`. E2E: `app.e2e-spec.ts`, `deals.e2e-spec.ts`, `e2e-qa.e2e-spec.ts`, `full-flow.e2e-spec.ts` (full-flow does LIVE scraping from the local IP).

## GOTCHAS

- **No persistence on scrape** — When startup scrape is enabled (no `SKIP_STARTUP_SCRAPE`), ALL listings are deleted and rescraped: DB is a fresh snapshot per boot. Render sets `SKIP_STARTUP_SCRAPE=true`, so the deployed DB accumulates instead.
- **BigInt serialization** — `main.ts` patches `BigInt.prototype.toJSON` to `Number()` so Prisma BigInt IDs survive `JSON.stringify`.
- **Cloudflare bypass** — `impit` with `browser: 'chrome'` TLS fingerprint. Still may get 403s on aggressive runs.
- **Card benchmark needs density** — the `/deals` card average only fires when the listing's resolved generation has 3+ rated comps; unresolved generations show no average.
- **Cron + startup are same path** — Both call `handleWeeklyScrape()`. Startup always runs it synchronously during `bootstrap()`.
- **`.env` is gitignored** — Never commit it; it holds the live Neon credentials (password rotation still pending — see root AGENTS.md anti-patterns).
- **Scraper is site-specific** — Parser selectors target `polovniautomobili.com` DOM. Will break if site redesigns.
- **Cloud IPs blocked** — polovniautomobili.com blocks all cloud providers (403). Scraping runs from a residential IP only (local scheduled task); never from Render/GitHub Actions. Optionally set `SCRAPER_PROXY_URL` for a residential proxy.
- **Nest 12 is ESM-only** — Do NOT bump @nestjs/* to v12 without the full ESM migration plan (root AGENTS.md anti-patterns). v11.2.x is the current maintained 11 line; `@nestjs/config` stays v4 and `@nestjs/schedule` stays v6 (their v12s are ESM-only too).
- **Rate limit interplay** — Global ThrottlerGuard allows 100 req/min per IP; e2e suites stay under it, and `full-flow` does live scraping, so keep suites under ~100 requests/min or tests will 429.
