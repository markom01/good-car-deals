import { useQuery, type QueryFunctionContext } from '@tanstack/react-query';
import type { Listing } from '@good-car-deals/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

async function fetchDeals({ signal }: QueryFunctionContext): Promise<Listing[]> {
  const res = await fetch(`${API_URL}/deals`, { signal });
  if (!res.ok) {
    throw new Error(`Failed to fetch deals: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function useDeals() {
  return useQuery({
    queryKey: ['deals'],
    queryFn: fetchDeals,
  });
}