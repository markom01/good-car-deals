export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type DealsPage = {
  data: import('@good-car-deals/shared').Listing[];
  total: number;
  page: number;
  pageSize: number;
};

export async function fetchServerDeals({
  page = 1,
  pageSize = 50,
}: {
  page?: number;
  pageSize?: number;
}): Promise<DealsPage> {
  const res = await fetch(
    `${API_URL}/deals?page=${page}&pageSize=${pageSize}`,
    {
      cache: 'no-store',
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch deals: ${res.status} ${res.statusText}`);
  }
  return res.json();
}
