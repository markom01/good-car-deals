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
  isNew,
}: QueryFunctionContext & {
  pageParam?: number;
  pageSizeParam?: number;
  isNew?: boolean;
}): Promise<DealsPage> {
  const url = new URL(`${API_URL}/deals`);
  url.searchParams.set('page', String(pageParam ?? 1));
  url.searchParams.set('pageSize', String(pageSizeParam ?? 50));
  if (isNew) {
    url.searchParams.set('new', 'true');
  }
  const res = await fetch(url.toString(), {
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch deals: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function useDeals({
  page = 1,
  pageSize = 3000,
  initialData,
  isNew = false,
  ...queryOptions
}: {
  page?: number;
  pageSize?: number;
  initialData?: DealsPage;
  isNew?: boolean;
} & Omit<UseQueryOptions<DealsPage>, 'queryKey' | 'queryFn'> = {}) {
  return useQuery<DealsPage>({
    queryKey: ['deals', page, pageSize, isNew],
    queryFn: (ctx) =>
      fetchDeals({
        ...ctx,
        pageParam: page,
        pageSizeParam: pageSize,
        isNew,
      }),
    retry: 1,
    retryDelay: 30000,
    initialData,
    // Force a fresh fetch whenever the page changes — data is paginated, so
    // stale cache from a different page must never be shown.
    staleTime: 0,
    ...queryOptions,
  });
}
