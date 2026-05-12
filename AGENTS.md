# GOOD CAR DEALS KNOWLEDGE BASE

**Generated:** 2026-05-12
**Stack:** NestJS 11 (API) + Next.js 16 (Frontend) + PostgreSQL + Prisma 7
**Monorepo:** npm workspaces — `packages/shared`, `good-car-deals-api`, `good-car-deals-frontend`
**Deployment:** Render (API) + Vercel (Frontend) + Neon (Database) + Local scheduled task (Scraper)

## OVERVIEW

Scrapes classified car listings from `polovniautomobili.com`, classifies deals by score, serves via REST API, displays in Next.js. Brand/model configured via env vars.

**Key constraint**: polovniautomobili.com blocks ALL cloud IPs (403). Scraper must run from a residential IP.

## DEPLOYMENT ARCHITECTURE

```
Local PC (Windows Task Scheduler — weekly Sunday 00:00)
  └─ scrape-local.bat
       └─ NestJS CLI --scrape mode → impit scrapes polovniautomobili.com (home IP)
            └─ Saves 362+ listings → Neon PostgreSQL (free tier)
                 └─ Render (free) serves NestJS API → port 10000
                      └─ Vercel (free) serves Next.js frontend → CDN
```

| Layer | Hosting | URL | Notes |
|-------|---------|-----|-------|
| Frontend | Vercel (free) | https://good-car-deals-frontend.vercel.app | Static pages via Next.js |
| API | Render (free tier) | https://good-car-deals-api.onrender.com | Spins down after 15 min idle, wakes on request |
| Database | Neon (free tier) | Frankfurt region | 0.5 GB, 100 CU-hours/mo |
| Scraper | Windows Task Scheduler | Local machine | Runs from home IP to avoid Cloudflare 403 |

## STRUCTURE

```
good car deals/
├── good-car-deals-api/          # NestJS backend — REST + scraping
├── good-car-deals-frontend/     # Next.js App Router frontend
├── packages/shared/             # Single `Listing` interface
├── scrape-local.bat             # Windows batch file — runs scraper locally
├── .github/workflows/scrape.yml # GitHub Action (won't work — cloud IP blocked)
├── render.yaml                  # Render Blueprint (API service)
├── vercel.json                  # Vercel monorepo config
└── .sisyphus/                   # Plans, drafts, evidence (orchestration tooling)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| REST endpoints | `good-car-deals-api/src/deals/` | Controller + service |
| Scraping logic | `good-car-deals-api/src/scraper/` | HTTP client (impit), HTML parser (cheerio) |
| Deal classification | `good-car-deals-api/src/analysis/` | `deal-classifier.service.ts` |
| DB schema | `good-car-deals-api/prisma/schema.prisma` | Single `Listing` model |
| Frontend pages | `good-car-deals-frontend/src/app/` | App Router (layout, page) |
| UI components | `good-car-deals-frontend/src/components/` | Custom + shadcn/ui primitives |
| Shared types | `packages/shared/src/index.ts` | `Listing` interface |
| Dev run | Root `package.json` — `npm run dev` | concurrently runs API + frontend |
| Startup behavior | `good-car-deals-api/src/main.ts` | `--scrape` flag, `SKIP_STARTUP_SCRAPE` env var |

## CONVENTIONS

- **API**: Standard NestJS module pattern — `*.module.ts`, `*.controller.ts`, `*.service.ts` per domain
- **Frontend**: Next.js App Router, component colocation under `src/components/`
- **Styling**: Tailwind CSS v4 (CSS-first config via `globals.css`, no `tailwind.config.ts`)
- **UI**: shadcn/ui (Radix Luma style) + Lucide icons
- **Data**: TanStack React Query v5 for client-side data fetching
- **DB**: Prisma with PostgreSQL — `BigInt` IDs, snake_case column mapping via `@map()`
- **Scraping**: `impit` for HTTP + TLS fingerprint impersonation, `cheerio` for HTML parsing
- **Residential proxy**: Optional — set `SCRAPER_PROXY_URL` env var if using a proxy service
- **Monorepo**: npm workspaces, shared types package consumed from source (no build step)

## KEY ENVIRONMENT VARIABLES

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | Render + .env | Neon PostgreSQL connection string |
| `SKIP_STARTUP_SCRAPE=true` | Render | Don't scrape on Render (gets 403) |
| `SCRAPER_TARGET_URL` | .env | polovniautomobili.com search URL |
| `SCRAPER_BRAND` | .env | Car brand to search |
| `SCRAPER_MODEL` | .env | Car model to search |
| `NEXT_PUBLIC_API_URL` | Vercel | Frontend → API URL |

## ANTI-PATTERNS (THIS PROJECT)

- **Committed `.env`**: `good-car-deals-api/.env` contains live DB password — add to API `.gitignore`
- **Root Python scrapers**: `scraper.py`, `deal_finder.py`, `discovery.py` — dead code, NestJS scraper is canonical
- **Committed CSV/text debug output**: `output.csv`, `check_final.csv`, `inspect*.txt` — ephemeral artifacts
- **No frontend tests**: API has Jest, frontend has zero test files
- **Unrelated `ThrottleStop/` dir**: Intel CPU utility config in repo root — remove or gitignore

## COMMANDS

```bash
# Development
npm run dev                    # Run API + frontend concurrently

# Production scrape (run locally from home IP)
.\scrape-local.bat

# API (good-car-deals-api/)
npm run start:dev              # Watch mode
npm run build                  # nest build
npm run test                   # Jest unit tests
npm run test:e2e               # E2E tests
npm run lint                   # ESLint

# Frontend (good-car-deals-frontend/)
npm run dev                    # next dev
npm run build                  # next build
npm run lint                   # ESLint
```

## NOTES

- API runs on port 3001, frontend on port 3000 (Next.js default)
- Render free tier web service: 750 hrs/month, spins down after 15 min idle (cold start ~30s)
- Render startup: `prisma db push` (sync schema) → `node dist/src/main.js` (start server, skip scrape)
- `BigInt` from Prisma is patched via `toJSON()` in `main.ts` for serialization
- Shared `@good-car-deals/shared` has no build step — TS source consumed directly
- Neon DB: `postgresql://neondb_owner:***@ep-***.eu-central-1.aws.neon.tech/neondb?sslmode=require`
- Supabase was attempted but pooler (Supavisor) has a "Tenant or user not found" configuration issue
- GitHub Actions scraper also gets 403 — only home IP scraping works
