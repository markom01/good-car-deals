import {
  useQuery,
  type QueryFunctionContext,
  type UseQueryOptions,
} from '@tanstack/react-query';
import type { DealsPage, Listing } from '@good-car-deals/shared';
import { API_URL } from '@/lib/fetch-deals';

async function fetchDeals({
  signal,
  pageParam,
  pageSizeParam,
}: QueryFunctionContext & {
  pageParam?: number;
  pageSizeParam?: number;
}): Promise<DealsPage> {
  const res = await fetch(
    `${API_URL}/deals?page=${pageParam ?? 1}&pageSize=${pageSizeParam ?? 50}`,
    {
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch deals: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function useDeals({
  page = 1,
  pageSize = 3000,
  initialData,
  ...queryOptions
}: {
  page?: number;
  pageSize?: number;
  initialData?: DealsPage;
} & Omit<UseQueryOptions<DealsPage>, 'queryKey' | 'queryFn'> = {}) {
  return useQuery<DealsPage>({
    queryKey: ['deals', page, pageSize],
    queryFn: (ctx) =>
      fetchDeals({ ...ctx, pageParam: page, pageSizeParam: pageSize }),
    retry: 1,
    retryDelay: 30000,
    initialData,
    // Force a fresh fetch whenever the page changes — data is paginated, so
    // stale cache from a different page must never be shown.
    staleTime: 0,
    ...queryOptions,
  });
}
