# GOOD CAR DEALS KNOWLEDGE BASE

**Generated:** 2026-05-12
**Stack:** NestJS 11 (API) + Next.js 16 (Frontend) + PostgreSQL + Prisma 7
**Monorepo:** npm workspaces — `packages/shared`, `good-car-deals-api`, `good-car-deals-frontend`

## OVERVIEW

Scrapes classified car listings from `polovniautomobili.com`, classifies deals by score, serves via REST API, displays in Next.js. Brand/model configured via env vars.

## STRUCTURE

```
good car deals/
├── good-car-deals-api/          # NestJS backend — REST + scraping + cron
├── good-car-deals-frontend/     # Next.js App Router frontend
├── packages/shared/             # Single `Listing` interface
└── .sisyphus/                   # Plans, drafts, evidence (orchestration tooling)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| REST endpoints | `good-car-deals-api/src/deals/` | Controller + service |
| Scraping logic | `good-car-deals-api/src/scraper/` | HTTP client, HTML parser, cron |
| Deal classification | `good-car-deals-api/src/analysis/` | `deal-classifier.service.ts` |
| DB schema | `good-car-deals-api/prisma/schema.prisma` | Single `Listing` model |
| Frontend pages | `good-car-deals-frontend/src/app/` | App Router (layout, page) |
| UI components | `good-car-deals-frontend/src/components/` | Custom + shadcn/ui primitives |
| Shared types | `packages/shared/src/index.ts` | `Listing` interface |
| Dev run | Root `package.json` — `npm run dev` | concurrently runs API + frontend |

## CONVENTIONS

- **API**: Standard NestJS module pattern — `*.module.ts`, `*.controller.ts`, `*.service.ts` per domain
- **Frontend**: Next.js App Router, component colocation under `src/components/`
- **Styling**: Tailwind CSS v4 (CSS-first config via `globals.css`, no `tailwind.config.ts`)
- **UI**: shadcn/ui (Radix Luma style) + Lucide icons
- **Data**: TanStack React Query v5 for client-side data fetching
- **DB**: Prisma with PostgreSQL — `BigInt` IDs, snake_case column mapping via `@map()`
- **Scraping**: `impit` for HTTP, `cheerio` for HTML parsing, `@nestjs/schedule` for cron
- **Monorepo**: npm workspaces, shared types package consumed from source (no build step)

## ANTI-PATTERNS (THIS PROJECT)

- **Committed `.env`**: `good-car-deals-api/.env` contains live DB password — add to API `.gitignore`
- **Root Python scrapers**: `scraper.py`, `deal_finder.py`, `discovery.py` — dead code, NestJS scraper is canonical
- **Committed CSV/text debug output**: `output.csv`, `check_final.csv`, `inspect*.txt` — ephemeral artifacts
- **No frontend tests**: API has Jest, frontend has zero test files
- **Unrelated `ThrottleStop/` dir**: Intel CPU utility config in repo root — remove or gitignore

## COMMANDS

```bash
npm run dev                    # Run API + frontend concurrently
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
- On startup, API clears all listings and rescrapes fresh — no persistent data across restarts
- `BigInt` from Prisma is patched via `toJSON()` in `main.ts` for serialization
- Shared `@good-car-deals/shared` has no build step — TS source consumed directly
