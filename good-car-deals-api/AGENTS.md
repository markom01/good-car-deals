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
│   └── deal-classifier.service.ts   # 2-method scoring
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

Two methods in `deal-classifier.service.ts`:

- **Price-per-year ranking** — Sorts by `priceNumeric / age` ascending. Top 20% = GOOD DEAL, 20-50% = DECENT DEAL, bottom 50% = OVERPRICED.
- **Market average comparison** — Calculates model-level avg price/year (needs 3+ listings). <80% of avg = GOOD DEAL (Market), <95% = DECENT DEAL (Market). Overrides rank-based result when better.
- **Deal score** — `max(0, 100 - pricePerYear / 100)`.

## KEY FILES

| File | Role |
|------|------|
| `app.module.ts` | Root module, imports ConfigModule.forRoot (with validate), ScheduleModule.forRoot, Prisma, Scraper, Analysis, Deals |
| `main.ts` | `BigInt.prototype.toJSON`, `enableCors()`, `--scrape` CLI flag, `SKIP_STARTUP_SCRAPE` env var |
| `cron.service.ts` | `@Cron(CronExpression.EVERY_WEEK)` — entry point for full pipeline |
| `src/config/validation.schema.ts` | 5 required env vars (DATABASE_URL, SCRAPER_TARGET_URL, SCRAPER_BRAND, SCRAPER_MODEL, SCRAPER_CRON_SCHEDULE) |
| `prisma/schema.prisma` | Single `Listing` model — BigInt id, snake_case via `@map()`, table `listings` |

## TESTS

- **Unit** — `*.spec.ts` co-located with source. Jest 30, ts-jest, `rootDir: src`.
- **E2E** — `test/*.e2e-spec.ts` with Supertest. Config: `test/jest-e2e.json`.
- **Setup** — `src/.jest/set-env.ts` loads test env vars before suite.

Current test files: `html-parser.service.spec.ts`, `http.service.spec.ts`, `deal-classifier.service.spec.ts`, `normalization.spec.ts`, `app.controller.spec.ts`. E2E: `app.e2e-spec.ts`, `deals.e2e-spec.ts`, `e2e-qa.e2e-spec.ts`, `full-flow.e2e-spec.ts`.

## GOTCHAS

- **No persistence** — Startup deletes ALL listings and rescrapes. DB is a fresh snapshot every boot.
- **BigInt serialization** — `main.ts` patches `BigInt.prototype.toJSON` to `Number()` so Prisma BigInt IDs survive `JSON.stringify`.
- **Cloudflare bypass** — `impit` with `browser: 'chrome'` TLS fingerprint. Still may get 403s on aggressive runs.
- **Model averages require density** — Market comparison only fires for models with 3+ listings in the current scrape.
- **Cron + startup are same path** — Both call `handleWeeklyScrape()`. Startup always runs it synchronously during `bootstrap()`.
- **Committed .env** — `.env` contains live DB credentials. Not in `.gitignore`.
- **Scraper is site-specific** — Parser selectors target `polovniautomobili.com` DOM. Will break if site redesigns.
- **Cloud IPs blocked** — polovniautomobili.com blocks all cloud providers (403). Run scraper locally with `.\scrape-local.bat` or `--scrape` flag. Optionally set `SCRAPER_PROXY_URL` for a residential proxy.
