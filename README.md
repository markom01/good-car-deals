# Good Car Deals

Scrapes classified car listings from [polovniautomobili.com](https://www.polovniautomobili.com), classifies them by deal score, and displays results in a modern web UI. Targets configurable car brand/model via env vars.

## Stack

| Layer             | Technology                                              | Hosting                           |
| ----------------- | ------------------------------------------------------- | --------------------------------- |
| **Frontend**      | Next.js 16 (App Router) + React 19 + TypeScript         | **Vercel** (free)                 |
| **Styling**       | Tailwind CSS v4 + shadcn/ui (Radix Luma) + Lucide icons |                                   |
| **Data Fetching** | TanStack React Query v5                                 |                                   |
| **Backend**       | NestJS 11 (Express) + TypeScript                        | **Render** (free, spins down)     |
| **Database**      | PostgreSQL via Prisma 7                                 | **Neon** (free, 0.5 GB)           |
| **Scraping**      | impit (Firefox + HTTP/3) + cheerio (HTML)               | **Render** (built-in, no proxies) |
| **Monorepo**      | npm workspaces                                          |                                   |

## Project Structure

```
good car deals/
├── good-car-deals-api/          # NestJS backend
│   ├── src/
│   │   ├── deals/               # REST endpoints (GET /deals)
│   │   ├── scraper/             # HTTP client, HTML parser
│   │   ├── analysis/            # Deal scoring/classification
│   │   ├── prisma/              # Database service
│   │   └── config/              # Env validation
│   ├── prisma/schema.prisma     # Listing model
│   └── test/                    # E2E tests
├── good-car-deals-frontend/     # Next.js frontend
│   ├── src/
│   │   ├── app/                 # App Router (layout, page)
│   │   ├── components/          # DealCard, DealList + shadcn/ui primitives
│   │   ├── hooks/               # use-deals (React Query)
│   │   └── lib/                 # Utils, QueryClient provider
│   └── public/
├── packages/shared/             # Shared Listing interface
├── docs/                        # Design docs (deal score v2)
├── scrape-local.bat             # Local scraper launcher (Windows)
└── render.yaml                  # Render Blueprint (API service)
```

## Deployment Architecture

```
Local PC (weekly scheduled task, home IP)
  └─ scrape-local.bat → impit (Chrome TLS fingerprint) scrapes polovniautomobili.com
       └─ Saves to Neon PostgreSQL
            └─ Render serves NestJS API (SKIP_STARTUP_SCRAPE=true, no scraping there)
                 └─ Vercel serves Next.js frontend (CDN)
```

- **Scraping runs from a residential IP only** — polovniautomobili.com blocks all cloud providers (403), so Render/GitHub Actions cannot scrape. Run `.\scrape-local.bat` weekly (or let the local scheduled task do it).
- **API on Render** has `SKIP_STARTUP_SCRAPE=true`; the in-app weekly cron only fires where scraping is possible (locally).
- **Frontend on Vercel** fetches from Render API via `NEXT_PUBLIC_API_URL`.

## Getting Started (Local Dev)

**Prerequisites**: Node.js ≥20 (Nest 11 engines; Next.js 16 requires ≥20.9)

```bash
npm install
npm run dev        # API (port 3001) + frontend (port 3000)
```

## Available Scripts

```bash
npm run dev              # API + frontend concurrently
npm run build            # Build API for production
.\scrape-local.bat       # Scrape listings from home IP → save to Neon DB

# API
cd good-car-deals-api
npm run start:dev        # Watch mode
npm run build            # nest build
npm run test             # Unit tests
npm run lint             # ESLint

# Frontend
cd good-car-deals-frontend
npm run dev              # Next.js dev server
npm run build            # next build
npm run test             # vitest (DealCard tests)
npm run lint             # ESLint
```

## How It Works

1. **Scrape (local, weekly)** — `impit` with a Chrome TLS fingerprint fetches 15 pages of classified listings from the home IP (cloud IPs get 403).
2. Each listing is parsed (title, price, year, mileage, etc.) and upserted into Neon PostgreSQL via Prisma.
3. **Deal scoring (v2)** — per-model expected price from an OLS fit (age/km/kW terms, IQR-trimmed, mean-imputed kW) with a cell-median fallback; `deviationPct` → 5-tier badge + 0–100 market-percentile score (`src/analysis/deal-stats.ts`).
4. Classified listings are served at `GET /deals`, sorted by `dealScore` desc.
5. Render API runs on the free tier (spins down after 15 min idle, wakes on request — first hit after idle may take ~30s).
6. The frontend fetches from the API using TanStack React Query and renders deal cards with score badges, plus loading/error/empty states.
7. SEO: full metadata (OG/Twitter) in `layout.tsx`, static `robots.txt` + `sitemap.xml`.

## API Routes

| Route         | Description                                                                      |
| ------------- | -------------------------------------------------------------------------------- |
| `GET /`       | Hello                                                                            |
| `GET /health` | Health check (status, DB, uptime)                                                |
| `GET /deals`  | Good deals, sorted by `dealScore` desc (`?sort=pricePerYear` for price/year asc) |

## Production URLs

| Service  | URL                                            |
| -------- | ---------------------------------------------- |
| Frontend | https://good-car-deals-frontend.vercel.app     |
| API      | https://good-car-deals-api.onrender.com        |
| Health   | https://good-car-deals-api.onrender.com/health |
