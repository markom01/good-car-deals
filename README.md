# Good Car Deals

Scrapes classified car listings from [polovniautomobili.com](https://www.polovniautomobili.com), classifies them by deal score, and displays results in a modern web UI. Targets configurable car brand/model via env vars.

## Stack

| Layer | Technology | Hosting |
|-------|-----------|---------|
| **Frontend** | Next.js 16 (App Router) + React 19 + TypeScript | **Vercel** (free) |
| **Styling** | Tailwind CSS v4 + shadcn/ui (Radix Luma) + Lucide icons | |
| **Data Fetching** | TanStack React Query v5 | |
| **Backend** | NestJS 11 (Express) + TypeScript | **Render** (free, spins down) |
| **Database** | PostgreSQL via Prisma 7 | **Neon** (free, 0.5 GB) |
| **Scraping** | impit (Firefox + HTTP/3) + cheerio (HTML) | **Render** (built-in, no proxies) |
| **Monorepo** | npm workspaces | |

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
├── scrape-local.bat             # Local scraper launcher (Windows)
└── .github/workflows/           # CI workflows
```

## Deployment Architecture

```
Render API (Firefox + HTTP/3 fingerprint)
  └─ impit scrapes polovniautomobili.com (bypasses Cloudflare)
       └─ Saves to Neon PostgreSQL
            └─ Render serves NestJS API
                 └─ Vercel serves Next.js frontend (CDN)
```

- **Scraper runs directly on Render** using Firefox TLS fingerprint + HTTP/3 (QUIC) — bypasses Cloudflare without proxies.
- **API on Render** has `SKIP_STARTUP_SCRAPE=true` to avoid re-scraping on cold start. Weekly cron via `@nestjs/schedule` keeps data fresh.
- **Frontend on Vercel** fetches from Render API via `NEXT_PUBLIC_API_URL`.

## Getting Started (Local Dev)

**Prerequisites**: Node.js ≥18

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
npm run lint             # ESLint
```

## How It Works

1. **Scraper** runs on Render via `@nestjs/schedule` (weekly cron) and on every cold start.
2. Uses **impit** with **Firefox TLS fingerprint + HTTP/3 (QUIC)** to bypass Cloudflare.
3. Each listing is parsed (title, price, year, mileage, etc.) and stored in Neon PostgreSQL via Prisma.
4. The `DealClassifierService` calculates a **deal score** based on price-per-year and market comparison.
5. Classified listings are served at `GET /deals`, sorted by score descending.
6. Render API runs 24/7 on free tier (spins down after 15 min idle, wakes on request).
7. The frontend fetches from the API using TanStack React Query and renders a deal list with score badges.

## API Routes

| Route | Description |
|-------|-------------|
| `GET /` | Hello |
| `GET /health` | Health check (status, DB, uptime) |
| `GET /deals` | All listings sorted by deal score |

## Production URLs

| Service | URL |
|---------|-----|
| Frontend | https://good-car-deals-frontend.vercel.app |
| API | https://good-car-deals-api.onrender.com |
| Health | https://good-car-deals-api.onrender.com/health |


