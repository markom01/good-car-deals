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
│   ├── deal-classifier.service.ts   # Classification + persistence (property-based expected price)
│   ├── deal-classifier.v2.spec.ts   # Pure classifier tests
│   ├── deal-classifier.service.spec.ts # Service persistence tests
│   ├── expected-price.ts            # Fit/predict math (OLS, shrinkage, LOO, gate)
│   ├── expected-price.spec.ts       # Unit tests for expected-price model
│   ├── deal-stats.ts                # Tier/score/deviation/IQR helpers only
│   ├── deal-stats.spec.ts           # Rubric + IQR tests
│   ├── generation-resolver.ts       # Offline artifact → one generation or null
│   └── generation-periods.json      # Model generations (auto-parts-db artifact)
├── deals/               # REST endpoint
│   ├── deals.controller.ts    # GET /deals
│   ├── deals.service.ts       # Reads stored expected price/comps, no recompute
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

v4 property-based expected pricing in `deal-classifier.service.ts` + `expected-price.ts` + `deal-stats.ts`:

- **Expected price per row** — `expected-price.ts` fits a within-group log-price OLS over `[age, km/10_000, ln(powerKw), diesel, gas, hybrid, electric, automatic]` (petrol base), partially pools group intercepts through model → global (k=8), predicts with leave-one-out (the scored row is excluded from its own group, model, and global sums). Group = `model\0generation` from `generation-resolver.ts`. IQR-trim fit rows when ≥8 fit rows exist. Clamp age/km/ln(power) to group bounds; clamp expected price to group price band. **No prediction range.**
- **Gate** — a row scores only when its group has ≥10 kept comps **excluding the row** (`EXPECTED_PRICE_MIN_COMPS = 10`). Thin groups are `UNRATED` with no average.
- **Deviation → score → tier** — unchanged: `deviationPct = (expected − ask) / expected × 100` capped at ±50, `dealScore = clamp(round(50 + dev), 0, 100)`, tier euro gates unchanged.
- **Persistence** — Each pass writes `dealType`, `dealScore`, `expectedPrice`, `deviationPct`, plus `expectedPriceSampleSize` (comps excluding the row) (+ keeps `pricePerYear` for display/sort compat).
- **CLI** — Re-run classification without scraping: `node dist/src/main.js --classify` (one-shot, mutates DB labels in place, then exits).
- **Deploy note** — Render boot (`prisma db push` + `SKIP_STARTUP_SCRAPE=true`) adds the nullable `expected_price_sample_size` column automatically; first `/deals` after deploy returns [] until `node dist/src/main.js --classify` runs. Deploy the frontend copy **after** the reclassify pass so the card never labels old benchmark values as "typical asking price".

## KEY FILES

| File                              | Role                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.module.ts`                   | Root module, imports ConfigModule.forRoot (with validate), ScheduleModule.forRoot, ThrottlerModule, Prisma, Scraper, Analysis, Deals; registers global ThrottlerGuard |
| `main.ts`                         | `BigInt.prototype.toJSON`, `helmet()`, CORS with optional `CORS_ORIGIN` allowlist, `--scrape` CLI flag, `SKIP_STARTUP_SCRAPE` env var                                 |
| `cron.service.ts`                 | `@Cron(CronExpression.EVERY_WEEK)` — entry point for full pipeline                                                                                                    |
| `expected-price.ts`               | Fit/predict math: within-group log-price OLS, hierarchical shrinkage, leave-one-out, gate, clamps (no Nest/Prisma)                                                    |
| `src/config/validation.schema.ts` | 3 required env vars (DATABASE_URL, SCRAPER_TARGET_URL, SCRAPER_CRON_SCHEDULE) + optional SCRAPER_BRAND/SCRAPER_MODEL (unused), SCRAPER_PROXY_URL, CORS_ORIGIN         |
| `prisma/schema.prisma`            | Single `Listing` model — BigInt id, snake_case via `@map()`, table `listings`, indexes on dealScore/dealType/model/scrapedAt                                          |

## TESTS

- **Unit** — `*.spec.ts` co-located with source. Jest 30, ts-jest, `rootDir: src`.
- **E2E** — `test/*.e2e-spec.ts` with Supertest. Config: `test/jest-e2e.json`.
- **Setup** — `src/.jest/set-env.ts` loads test env vars before suite.

Current test files: `app.controller.spec.ts`, `deal-classifier.v2.spec.ts`, `deal-classifier.service.spec.ts`, `deal-stats.spec.ts`, `expected-price.spec.ts`, `generation-resolver.spec.ts`, `deals.service.spec.ts`, `http.service.spec.ts`, `http.service.liveness.spec.ts`, `scraper.service.spec.ts`, `normalization.spec.ts`. E2E: `app.e2e-spec.ts`, `deals.e2e-spec.ts`, `e2e-qa.e2e-spec.ts`, `full-flow.e2e-spec.ts` (full-flow does LIVE scraping from the local IP).

## GOTCHAS

- **No persistence on scrape** — When startup scrape is enabled (no `SKIP_STARTUP_SCRAPE`), ALL listings are deleted and rescraped: DB is a fresh snapshot per boot. Render sets `SKIP_STARTUP_SCRAPE=true`, so the deployed DB accumulates instead.
- **BigInt serialization** — `main.ts` patches `BigInt.prototype.toJSON` to `Number()` so Prisma BigInt IDs survive `JSON.stringify`.
- **Cloudflare bypass** — `impit` with `browser: 'chrome'` TLS fingerprint. Still may get 403s on aggressive runs.
- **Expected price needs density** — the card shows no average when a listing's group has fewer than 10 comps excluding the row; unresolved generations show no average.
- **Cron + startup are same path** — Both call `handleWeeklyScrape()`. Startup always runs it synchronously during `bootstrap()`.
- **`.env` is gitignored** — Never commit it; it holds the live Neon credentials (password rotation still pending — see root AGENTS.md anti-patterns).
- **Scraper is site-specific** — Parser selectors target `polovniautomobili.com` DOM. Will break if site redesigns.
- **Cloud IPs blocked** — polovniautomobili.com blocks all cloud providers (403). Scraping runs from a residential IP only (local scheduled task); never from Render/GitHub Actions. Optionally set `SCRAPER_PROXY_URL` for a residential proxy.
- **Nest 12 is ESM-only** — Do NOT bump @nestjs/* to v12 without the full ESM migration plan (root AGENTS.md anti-patterns). v11.2.x is the current maintained 11 line; `@nestjs/config` stays v4 and `@nestjs/schedule` stays v6 (their v12s are ESM-only too).
- **Rate limit interplay** — Global ThrottlerGuard allows 100 req/min per IP; e2e suites stay under it, and `full-flow` does live scraping, so keep suites under ~100 requests/min or tests will 429.
