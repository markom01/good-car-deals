# GOOD CAR DEALS FRONTEND

**Generated:** 2026-05-12
**Stack:** Next.js 16 + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui (Radix Luma)

## OVERVIEW

Next.js 16 App Router frontend for "Good Car Deals". Fetches classified car listings from the NestJS API and renders them as scored deal cards. All data fetching is client-side via TanStack React Query.

## STRUCTURE

```
src/
├── app/
│   ├── layout.tsx         # Root layout: Geist font, Providers wrapper, flex column
│   ├── page.tsx           # Home page: heading + DealList
│   └── globals.css        # Tailwind v4 entry, CSS vars, @theme inline
├── components/
│   ├── ui/                # shadcn primitives: button, card, badge, separator
│   ├── deal-card.tsx      # Presentational card: title, price, score, badge, link
│   ├── deal-list.tsx      # Client component, calls useDeals(), renders grid
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
6. DealList returns null while loading or on error. No loading, error, or empty states.

## CONFIG

| Setting | Value |
|---------|-------|
| Port | 3000 (Next.js default) |
| API base | NEXT_PUBLIC_API_URL or localhost:3001 |
| Tailwind | CSS-first via globals.css `@import "tailwindcss"` + `@theme inline` (no tailwind.config.ts) |
| PostCSS | `@tailwindcss/postcss` plugin only |
| shadcn style | radix-luma, baseColor taupe, CSS vars, RSC enabled |
| shadcn aliases | @/components, @/lib/utils, @/hooks, @/components/ui |
| Font | Geist (variable via next/font) |
| TypeScript | strict, path aliases match shadcn aliases |

## WHAT'S MISSING

- **Tests**: No test files, no test runner.
- **Error states**: DealList returns null silently. No error boundary, no loading skeleton, no retry UI.
- **Empty state**: No "no deals found" when array is empty.
- **Loading**: No Suspense fallback or loading.tsx.
- **Metadata**: Basic title/description only. No OG, no structured data.
- **Accessibility**: No aria labels, no focus management, no keyboard nav.
- **Performance**: No image optimization, no streaming, no ISR. All data client-side.
- **Monorepo sharing**: No shared UI components or design tokens across packages. Only the `Listing` type is shared.
