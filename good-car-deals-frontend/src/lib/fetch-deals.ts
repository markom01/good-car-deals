import type { DealsPage, Listing } from '@good-car-deals/shared';

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const DEFAULT_PAGE_SIZE = 2000; // Keep under 2MB Next.js data cache limit

/**
 * Server-side fetch of /deals. Cached (force-cache) and revalidated every 60s
 * via ISR (`next.revalidate`), so the page serves stale-while-revalidate and
 * the backend isn't hammered on every request. Paginated so the payload stays
 * well under Next.js's 2MB data-cache limit.
 */
export async function fetchServerDeals({
  page = 1,
  pageSize = DEFAULT_PAGE_SIZE,
}: { page?: number; pageSize?: number } = {}): Promise<DealsPage> {
  const res = await fetch(
    `${API_URL}/deals?page=${page}&pageSize=${pageSize}`,
    {
      cache: 'force-cache',
      next: { revalidate: 60 },
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch deals: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export type { Listing };
