# GOOD CAR DEALS KNOWLEDGE BASE

**Generated:** 2026-10-28
**Stack:** NestJS 11.2 (API) + Next.js 16 (Frontend) + PostgreSQL + Prisma 7
**Monorepo:** npm workspaces — `packages/shared`, `good-car-deals-api`, `good-car-deals-frontend`
**Deployment:** Render (API) + Vercel (Frontend) + Neon (Database) + Local scheduled task (Scraper)

## OVERVIEW

Scrapes classified car listings from `polovniautomobili.com` site-wide (all brands), classifies deals by score, serves via REST API, displays in Next.js. Model is read per listing from the feed ("Opel Astra").

**Key constraint**: polovniautomobili.com blocks ALL cloud IPs (403). Scraper must run from a residential IP.

## DEPLOYMENT ARCHITECTURE

```
Local PC (Windows Task Scheduler — weekly Sunday 00:00)
  └─ NestJS CLI --scrape mode → impit scrapes polovniautomobili.com (home IP)
       └─ Saves ~2.5k listings → Neon PostgreSQL (free tier)
            └─ Render (free) serves NestJS API → port 10000
                 └─ Vercel (free) serves Next.js frontend → CDN
```

| Layer    | Hosting                | URL                                        | Notes                                          |
| -------- | ---------------------- | ------------------------------------------ | ---------------------------------------------- |
| Frontend | Vercel (free)          | https://good-car-deals-frontend.vercel.app | Static pages via Next.js                       |
| API      | Render (free tier)     | https://good-car-deals-api.onrender.com    | Spins down after 15 min idle, wakes on request |
| Database | Neon (free tier)       | Frankfurt region                           | 0.5 GB, 100 CU-hours/mo                        |
| Scraper  | Windows Task Scheduler | Local machine                              | Runs from home IP to avoid Cloudflare 403      |

## STRUCTURE

```
good car deals/
├── good-car-deals-api/          # NestJS backend — REST + scraping
├── good-car-deals-frontend/     # Next.js App Router frontend
├── packages/shared/             # Single `Listing` interface
├── docs/superpowers/specs/      # Design docs (deal score v3, generation-only)
├── render.yaml                  # Render Blueprint (API service)
└── vercel.json                  # Vercel monorepo config (API deploys disabled)
```

## WHERE TO LOOK

| Task                | Location                                  | Notes                                          |
| ------------------- | ----------------------------------------- | ---------------------------------------------- |
| REST endpoints      | `good-car-deals-api/src/deals/`           | Controller + service                           |
| Scraping logic      | `good-car-deals-api/src/scraper/`         | JSON API client (Next.js data + core API)      |
| Deal classification | `good-car-deals-api/src/analysis/`        | `deal-classifier.service.ts` + `deal-stats.ts` |
| DB schema           | `good-car-deals-api/prisma/schema.prisma` | Single `Listing` model, 4 secondary indexes    |
| Frontend pages      | `good-car-deals-frontend/src/app/`        | App Router (layout, page, robots, sitemap)     |
| UI components       | `good-car-deals-frontend/src/components/` | Custom + shadcn/ui primitives                  |
| Shared types        | `packages/shared/src/index.ts`            | `Listing` interface                            |
| Dev run             | Root `package.json` — `npm run dev`       | concurrently runs API + frontend               |
| Startup behavior    | `good-car-deals-api/src/main.ts`          | `--scrape` flag, `SKIP_STARTUP_SCRAPE` env var |

## CONVENTIONS

- **API**: Standard NestJS module pattern — `*.module.ts`, `*.controller.ts`, `*.service.ts` per domain
- **Frontend**: Next.js App Router, component colocation under `src/components/`
- **Styling**: Tailwind CSS v4 (CSS-first config via `globals.css`, no `tailwind.config.ts`)
- **UI**: shadcn/ui (Radix Luma style) + Lucide icons
- **Data**: TanStack React Query v5 for client-side data fetching
- **DB**: Prisma with PostgreSQL — `BigInt` IDs, snake_case column mapping via `@map()`
- **Scraping**: `impit` transport → Next.js `/_next/data` search JSON feed only (`pageSize=200`, the site maximum); the per-ad detail API is no longer called — the feed already returns `status === 'active'` rows. The site caps deep pagination at **page 750** and re-serves page 1 past it, so `scrapeAndSaveResumable` aborts with `scrape_progress.status = 'capped'` when a page brings zero new URLs.
- **Deal scoring**: v2 comps-relative — per-model log-price OLS/cell-median expected price (clamped to observed age/km + price band) → % deviation (capped ±50) → 5-tier badge + 0–100 score (`good-car-deals-api/src/analysis/deal-stats.ts`); model groups split into generation groups when the offline artifact resolves one generation with ≥10 usable rows (`generation-resolver.ts`; holdout sweep: MdAPE 10.04–10.06 at 6–10 comps vs 10.63 model-only and 10.30 at 40)
- **Card benchmark**: `deals.service.ts` pools expected prices by resolved generation across **all years** of that generation (no year window) and requires ≥3 comps. `resolveGeneration` falls back to the **nearest generation** for boundary/gap years (e.g. Laguna 2001 → Mk2) so every resolvable model gets a benchmark; only models absent from the artifact show no average.
- **Residential proxy**: Optional — set `SCRAPER_PROXY_URL` env var if using a proxy service
- **Monorepo**: npm workspaces, shared types package consumed from source (no build step)
- **API security**: `helmet` on the Express app, `@nestjs/throttler` global guard (100 req/min per IP), optional `CORS_ORIGIN` allowlist (unset = allow all)
- **Tests**: API = Jest 30 + ts-jest (97 unit + 15 e2e); Frontend = Vitest + Testing Library (DealCard)

## KEY ENVIRONMENT VARIABLES

| Variable                   | Where         | Purpose                                                                         |
| -------------------------- | ------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Render + .env | Neon PostgreSQL connection string                                               |
| `SKIP_STARTUP_SCRAPE=true` | Render        | Don't scrape on Render (gets 403)                                               |
| `SCRAPER_TARGET_URL`       | .env          | polovniautomobili.com search URL                                                |
| `SCRAPER_BRAND`            | .env          | Unused — scrape is site-wide (kept optional for old deploys)                    |
| `SCRAPER_MODEL`            | .env          | Unused — model comes from the feed per listing (kept optional)                  |
| `CORS_ORIGIN`              | Render        | Optional comma-separated allowlist (unset = allow all)                          |
| `NEXT_PUBLIC_API_URL`      | Vercel        | Frontend → API URL                                                              |
| `NEXT_PUBLIC_SITE_URL`     | Vercel        | Canonical site URL for metadata/robots/sitemap (defaults to the vercel.app URL) |

## ANTI-PATTERNS (THIS PROJECT)

- **Secrets in git history**: An old commit contains the Neon connection string (removed from the working tree in 1f12bc6, but history is unrewritten). **Rotate the Neon password** at console.neon.tech, then optionally run a history rewrite (`git filter-repo`) before force-pushing.
- **Scraper on cloud**: Any cloud-hosted scrape (Render, GitHub Actions) gets 403 — never move scraping off the local machine without a residential proxy (`SCRAPER_PROXY_URL`).
- **Auto-fixing lint scripts**: API lint must not `--fix` (was silently rewriting files; removed on purpose).
- **`npm install` inside a workspace with a stale lockfile**: npm can leave a root-hoisted version + nested copy split (dual-package hazard broke e2e). After version changes, clean `node_modules` in all workspaces and reinstall from scratch.
- **Upgrading Nest to v12 without planning**: v12 runtime packages are ESM-only (`type: module`, no CJS entry) — needs a full ESM migration (package `type: module`, NodeNext + `.js` relative imports, Jest ESM or Vitest). Deferred deliberately; TS 7 (Go rewrite) deferred for the same reason.
- **Committed debug artifacts**: `.sisyphus/evidence/*`, `scripts/check-db.js`, `output.csv`, `inspect*.txt` are all gitignored now — keep it that way.

## COMMANDS

```bash
# Development
npm run dev                    # Run API + frontend concurrently

# Production scrape (run locally from home IP)
npm run start:dev -- --scrape   # or run via local scheduled task with --scrape flag

# API (good-car-deals-api/)
npm run start:dev              # Watch mode
npm run build                  # nest build
npm run test                   # Jest unit tests (97)
npm run test:e2e               # E2E tests (15)
npm run lint                   # ESLint (no --fix)

# Reclassify existing DB rows without scraping
node dist/src/main.js --classify

# Frontend (good-car-deals-frontend/)
npm run dev                    # next dev
npm run build                  # next build
npm run test                   # vitest run
npm run lint                   # ESLint
```

## NOTES

- API runs on port 3001, frontend on port 3000 (Next.js default)
- Render free tier web service: 750 hrs/month, spins down after 15 min idle (cold start ~30s); Render startup: `prisma db push` (sync schema) → `node dist/src/main.js` (start server, skip scrape)
- `BigInt` from Prisma is patched via `toJSON()` in `main.ts` for serialization
- Shared `@good-car-deals/shared` has no build step — TS source consumed directly
- Neon DB: Frankfurt region, 0.5 GB free tier. `listings` has secondary indexes on `deal_score`, `deal_type`, `model`, `scraped_at` (added 2026-10-28)
- Supabase was attempted but pooler (Supavisor) has a "Tenant or user not found" configuration issue
- Keep-alive ping for the Render cold start was deliberately deferred: an always-warm API holds a Neon connection open and burns the 100 CU-hours/mo free budget
- Frontend has loading/error/empty states in `deal-list.tsx`, full metadata (OG/Twitter) + static `robots.txt` + `sitemap.xml`, and Vitest tests — the old "WHAT'S MISSING" gaps are closed except accessibility polish and streaming/ISR
