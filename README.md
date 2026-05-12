# Good Car Deals

Scrapes classified car listings from [polovniautomobili.com](https://www.polovniautomobili.com), classifies them by deal score, and displays results in a modern web UI. Targets configurable car brand/model via env vars.

## Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16 (App Router) + React 19 + TypeScript |
| **Styling** | Tailwind CSS v4 + shadcn/ui (Radix Luma) + Lucide icons |
| **Data Fetching** | TanStack React Query v5 |
| **Backend** | NestJS 11 (Express) + TypeScript |
| **Database** | PostgreSQL via Prisma 7 |
| **Scraping** | impit (HTTP) + cheerio (HTML) + @nestjs/schedule (cron) |
| **Monorepo** | npm workspaces |

## Project Structure

```
good car deals/
├── good-car-deals-api/          # NestJS backend
│   ├── src/
│   │   ├── deals/               # REST endpoints (GET /deals)
│   │   ├── scraper/             # HTTP client, HTML parser, weekly cron
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
└── .sisyphus/                   # AI orchestration tooling
```

## Getting Started

**Prerequisites**: Node.js ≥18, PostgreSQL running locally.

```bash
# Install all workspace dependencies
npm install

# Set up the API database config
cd good-car-deals-api
cp .env.example .env
# Edit .env with your PostgreSQL connection string

# Build the API (root dev script uses compiled JS)
npm run build

# Start API + frontend concurrently
cd ..
npm run dev
```

- **API**: http://localhost:3001
- **Frontend**: http://localhost:3000

## Available Scripts

```bash
# Root — run both
npm run dev              # API + frontend concurrently

# API
cd good-car-deals-api
npm run start:dev        # Watch mode
npm run build            # nest build
npm run test             # Unit tests
npm run test:e2e         # E2E tests
npm run lint             # ESLint

# Frontend
cd good-car-deals-frontend
npm run dev              # Next.js dev server
npm run build            # next build
npm run lint             # ESLint
```

## How It Works

1. **On startup**, the API clears all existing listings, then scrapes `polovniautomobili.com` for the configured car brand/model.
2. Each listing is parsed (title, price, year, mileage, etc.) and stored in PostgreSQL via Prisma.
3. The `DealClassifierService` calculates a **deal score** based on price-per-year and market comparison.
4. Classified listings are served at `GET /deals`, sorted by score descending.
5. A **weekly cron job** (`@nestjs/schedule`) rescrapes for fresh data.
6. The frontend fetches from the API using TanStack React Query and renders a deal list with score badges.

## API Routes

| Route | Description |
|-------|-------------|
| `GET /` | Hello |
| `GET /health` | Health check (status, DB, uptime) |
| `GET /deals` | All listings sorted by deal score |


