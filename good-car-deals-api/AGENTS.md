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
│   ├── scraper.service.ts      # 15-page loop, dedup, upsert to DB
│   ├── cron.service.ts         # @Cron(EVERY_WEEK), orchestrates scrape→save→classify
│   └── scraper.module.ts
├── analysis/            # Deal classification
│   ├── deal-classifier.service.ts   # 2-method scoring (OLS + cell-median)
│   └── deal-stats.ts               # Pure math: IQR trim, OLS fit, tiers, percentiles
├── deals/               # REST endpoint
│   ├── deals.controller.ts    # GET /deals
│   ├── deals.service.ts       # Sorted by pricePerYear asc
│   └── deals.module.ts
├── utils/               # Standalone helpers
│   └── normalization.ts       # Mileage, price, model, age, pricePerYear
├── app.module.ts        # Root — imports Config, Schedule, Prisma, Scraper, Analysis, Deals
└── main.ts              # BigInt.toJSON polyfill, CORS, --scrape mode, SKIP_STARTUP_SCRAPE
```

## SCRAPING PIPELINE

1. **HttpService** — `impit` with Chrome TLS fingerprint. 3 retries with exponential backoff. Retries on timeout, 403, 503, network errors. `buildSearchPage(page)` constructs `polovniautomobili.com` URL with brand + model params. Supports optional `SCRAPER_PROXY_URL` for residential proxy.
2. **HtmlParserService** — `cheerio` parses listing cards. Handles two card types: featured `<section>` and regular `<article>`. Extracts title, URL, price, year, mileage, fuel, engine, power, transmission, location. Falls back through specs → info div → title regex for year.
3. **ScraperService** — Loops pages 1-15 with 1s delay between requests. Deduplicates by `listingUrl`. Upserts into DB. 1 page failure doesn't stop the rest.
4. **CronService** — `@Cron(CronExpression.EVERY_WEEK)`. Orchestrates scrape → save → classify. Errors don't crash the app, existing DB data preserved.
5. **Startup** — With `SKIP_STARTUP_SCRAPE=true`, skips scraping (Render gets 403). With `--scrape` flag, runs scrape-only mode and exits.

## DEAL CLASSIFICATION

v2 comps-relative scoring in `deal-classifier.service.ts` + pure math in `src/analysis/deal-stats.ts`:

- **Per-model expected price** — Rows group by the persisted `model` column (no title re-extraction). Per group, try an OLS fit `price ≈ intercept + coefAge·age + coefKm·km [+ coefKw·kW + coefDiesel + coefAuto]` on Tukey-IQR-trimmed rows (min 12 survivors, singular-matrix and wrong-sign guards; `n` = rows actually used). Optional engine-trim terms behind guards: `coefKw` needs ≥12 rows with kW (2+ distinct values; coefficient must be > 0 else dropped), `coefDiesel`/`coefAuto` dummies need ≥10 rows in BOTH classes. Rows trimmed by the trim are still scored — no cap. Rows without a kW value are scored at the fit sample's **mean kW** (mean-imputation, not kw=0, which would understate their expected price).
- **Cell-median fallback** — Fit fails (thin group) → per-row expected price from `year±1` comps, split to `km±20%` when ≥3 rows survive the split, else the plain `year±1` median; below 3 comps → `UNRATED`.
- **Deviation → score → tier** — `deviationPct = (expected − ask) / expected × 100` (positive = cheaper than expected); tiers: `≥ +10` GREAT DEAL, `[+4, +10)` GOOD DEAL, `(−4, +4)` FAIR PRICE, `(−10, −4]` HIGH PRICE, `≤ −10` OVERPRICED. `dealScore` = market percentile of the deviation across all rated listings (global, 0 = worst, 50 = median deal, 100 = single best; integer ranks → up to a few listings can share a score). Missing year/km/price or non-positive expected price → `UNRATED` with score 0.
- **Persistence** — Each pass writes `dealType`, `dealScore`, `expectedPrice`, `deviationPct` (+ keeps `pricePerYear` for display/sort compat).
- **CLI** — Re-run classification without scraping: `node dist/src/main.js --classify` (one-shot, mutates DB labels in place, then exits).
- **Deploy note** — Render boot (`prisma db push` + `SKIP_STARTUP_SCRAPE=true`) picks up the v2 columns automatically; first `/deals` after deploy returns [] until `node dist/src/main.js --classify` runs.

## KEY FILES

| File                              | Role                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.module.ts`                   | Root module, imports ConfigModule.forRoot (with validate), ScheduleModule.forRoot, ThrottlerModule, Prisma, Scraper, Analysis, Deals; registers global ThrottlerGuard |
| `main.ts`                         | `BigInt.prototype.toJSON`, `helmet()`, CORS with optional `CORS_ORIGIN` allowlist, `--scrape` CLI flag, `SKIP_STARTUP_SCRAPE` env var                                 |
| `cron.service.ts`                 | `@Cron(CronExpression.EVERY_WEEK)` — entry point for full pipeline                                                                                                    |
| `src/config/validation.schema.ts` | 5 required env vars (DATABASE_URL, SCRAPER_TARGET_URL, SCRAPER_BRAND, SCRAPER_MODEL, SCRAPER_CRON_SCHEDULE) + optional SCRAPER_PROXY_URL, CORS_ORIGIN                 |
| `prisma/schema.prisma`            | Single `Listing` model — BigInt id, snake_case via `@map()`, table `listings`, indexes on dealScore/dealType/model/scrapedAt                                          |

## TESTS

- **Unit** — `*.spec.ts` co-located with source. Jest 30, ts-jest, `rootDir: src`.
- **E2E** — `test/*.e2e-spec.ts` with Supertest. Config: `test/jest-e2e.json`.
- **Setup** — `src/.jest/set-env.ts` loads test env vars before suite.

Current test files: `app.controller.spec.ts`, `deal-classifier.service.spec.ts`, `deal-classifier.v2.spec.ts`, `deal-stats.spec.ts`, `deals.service.spec.ts`, `html-parser.service.spec.ts`, `http.service.spec.ts`, `http.service.liveness.spec.ts`, `scraper.service.spec.ts`, `normalization.spec.ts`. E2E: `app.e2e-spec.ts`, `deals.e2e-spec.ts`, `e2e-qa.e2e-spec.ts`, `full-flow.e2e-spec.ts` (full-flow does LIVE scraping from the local IP).

## GOTCHAS

- **No persistence on scrape** — When startup scrape is enabled (no `SKIP_STARTUP_SCRAPE`), ALL listings are deleted and rescraped: DB is a fresh snapshot per boot. Render sets `SKIP_STARTUP_SCRAPE=true`, so the deployed DB accumulates instead.
- **BigInt serialization** — `main.ts` patches `BigInt.prototype.toJSON` to `Number()` so Prisma BigInt IDs survive `JSON.stringify`.
- **Cloudflare bypass** — `impit` with `browser: 'chrome'` TLS fingerprint. Still may get 403s on aggressive runs.
- **Model averages require density** — Market comparison only fires for models with 3+ listings in the current scrape.
- **Cron + startup are same path** — Both call `handleWeeklyScrape()`. Startup always runs it synchronously during `bootstrap()`.
- **`.env` is gitignored** — Never commit it; it holds the live Neon credentials (password rotation still pending — see root AGENTS.md anti-patterns).
- **Scraper is site-specific** — Parser selectors target `polovniautomobili.com` DOM. Will break if site redesigns.
- **Cloud IPs blocked** — polovniautomobili.com blocks all cloud providers (403). Run scraper locally with `.\scrape-local.bat` or `--scrape` flag. Optionally set `SCRAPER_PROXY_URL` for a residential proxy.
- **Nest 12 is ESM-only** — Do NOT bump @nestjs/* to v12 without the full ESM migration plan (root AGENTS.md anti-patterns). v11.2.x is the current maintained 11 line; `@nestjs/config` stays v4 and `@nestjs/schedule` stays v6 (their v12s are ESM-only too).
- **Rate limit interplay** — Global ThrottlerGuard allows 100 req/min per IP; e2e suites stay under it, and `full-flow` does live scraping, so keep suites under ~100 requests/min or tests will 429.
