# GOOD CAR DEALS FRONTEND

**Generated:** 2026-05-12
**Stack:** Next.js 16 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui (Radix Luma)

## OVERVIEW

Next.js 16 App Router frontend for "Good Car Deals". Fetches classified car listings from the NestJS API and renders them as scored deal cards. All data fetching is client-side via TanStack React Query. Also hosts a demo/static `/wheelrank` page.

## STRUCTURE

```
src/
├── app/
│   ├── layout.tsx         # Root layout: Geist font, Providers wrapper, full metadata (OG/Twitter)
│   ├── page.tsx           # Home page: heading + DealList
│   ├── robots.ts          # Static robots.txt (allow all + sitemap pointer)
│   ├── sitemap.ts         # Static sitemap.xml
│   ├── wheelrank/         # Demo page: carousel of mock deals (next/image, mock-deals.ts)
│   └── globals.css        # Tailwind v4 entry, CSS vars, @theme inline
├── components/
│   ├── ui/                # shadcn primitives: button, card, badge, separator, carousel, empty, skeleton
│   ├── deal-card.tsx      # Presentational card: title, price, score, badge, link
│   ├── deal-card.test.tsx # Vitest + Testing Library tests (3)
│   ├── deal-list.tsx      # Client component, calls useDeals(), loading/error/empty/grid states
│   └── index.ts           # Re-exports DealCard, DealList
├── hooks/
│   ├── use-deals.ts       # React Query hook: GET /deals, queryKey ['deals']
│   └── index.ts
└── lib/
    ├── providers.tsx      # QueryClientProvider (5min staleTime, retry 2)
    ├── utils.ts           # cn() helper (clsx + tailwind-merge)
    └── index.ts
```

## COMPONENT HIERARCHY

```
RootLayout (server)
  └─ Providers (client)           # RQ provider wrapper
       └─ HomePage (server)
            └─ DealList (client)  # useDeals() -> map to DealCard[]
                 └─ DealCard[]    # Pure presentation, typed Listing prop
```

DealList is the only client boundary. Everything above stays as server components. DealCard composes shadcn Card + Badge + Button primitives.

## DATA FLOW

1. `useDeals()` calls `fetch(API_URL + "/deals")` via React Query `useQuery`.
2. `API_URL` defaults to `http://localhost:3001`, overridable via `NEXT_PUBLIC_API_URL`.
3. Query key: `["deals"]`. No pagination, filtering, or sorting on the client.
4. Config: staleTime 5 min, retry 2, refetchOnWindowFocus false.
5. No caching layer beyond React Query in-memory defaults. No persistence.
6. DealList renders: skeleton grid while loading, error card with retry on failure, "no deals" Empty state when the array is empty.

## CONFIG

| Setting        | Value                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| Port           | 3000 (Next.js default)                                                                                       |
| API base       | NEXT_PUBLIC_API_URL or localhost:3001                                                                        |
| Tailwind       | CSS-first via globals.css `@import "tailwindcss"` + `@theme inline` (no tailwind.config.ts)                  |
| PostCSS        | `@tailwindcss/postcss` plugin only                                                                           |
| shadcn style   | radix-luma, baseColor taupe, CSS vars, RSC enabled                                                           |
| shadcn aliases | @/components, @/lib/utils, @/hooks, @/components/ui                                                          |
| Font           | Geist (variable via next/font)                                                                               |
| TypeScript     | strict, path aliases match shadcn aliases                                                                    |
| Tests          | Vitest + jsdom + @testing-library/react (`npm run test`; config `vitest.config.ts`, setup `vitest.setup.ts`) |

## WHAT'S MISSING

- **Accessibility**: No aria labels, no focus management, no keyboard nav beyond native elements.
- **Streaming/ISR**: All data client-side; no Suspense streaming or ISR caching of /deals.
- **Deeper test coverage**: Only DealCard is tested; DealList, useDeals hook, and the wheelrank page are untested.
- **Monorepo sharing**: No shared UI components or design tokens across packages. Only the `Listing` type is shared.

## NOTES

- `carousel.tsx` (wheelrank) carries a scoped `eslint-disable` for set-state-in-effect — embla's reInit requires it; don't "fix" blindly.
- Canonical URLs in metadata/robots/sitemap come from `NEXT_PUBLIC_SITE_URL`, defaulting to the vercel.app domain.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
