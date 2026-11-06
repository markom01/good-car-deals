# Implementation plan — COMPLETE

## Task 4 — full-flow e2e bound to 1 listing (API) — DONE

- `scraper.service.ts`: `scrapeTargetModel()` now accepts `{ maxListings? }`; stops the page loop once enough unique listings are collected (default unlimited = no prod change).
- `full-flow.e2e-spec.ts`: scrape bounded to 1 page (`maxListings: 1`), clean DB slate via `listing.deleteMany()` in beforeAll, classify all scraped, verify `/deals` returns rated deals.
- Result: e2e runs in ~1.7s (was timing out crawling the whole site). API unit tests 87/87, lint clean, build OK.

## Task 2 — Streaming/ISR for /deals (frontend) — DONE

- `lib/fetch-deals.ts`: new server-side `fetchServerDeals()` (force-cache + `next.revalidate: 60`) + shared `API_URL`.
- `hooks/use-deals.ts`: imports `API_URL` from fetch-deals; `useDeals({ initialData? })` lets server pre-seed the client cache.
- `components/deal-list.tsx`: accepts `deals?` prop (passed as `initialData`), exports `DealListSkeleton` for reuse.
- `app/page.tsx`: async server component fetches deals, `export const revalidate = 60` (ISR), wraps `DealList` in `Suspense` fallback.
- `components/index.ts`: exports `DealListSkeleton`.
- Result: `/` shows `Revalidate 1m` in build output. Build OK, lint clean, 22 tests pass.

## Task 3 — Deeper test coverage (frontend) — DONE

- `hooks/use-deals.test.tsx`: useDeals fetches /deals and returns listings (mocked fetch + QueryClient).
- `app/wheelrank/page.test.tsx`: renders WheelRank hero + all 8 mock deal cards.
- `vitest.setup.ts`: added `IntersectionObserver` shim (embla carousel) alongside matchMedia/ResizeObserver.
- Result: 6 test files / 22 tests pass. (DealList was already tested.)
