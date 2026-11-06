import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { useDeals } from './use-deals';

const baseListing = {
  id: BigInt(1),
  title: 'Opel Vectra C 1.9 CDTI',
  model: 'Vectra C',
  year: 2004,
  price: '3.500 €',
  priceNumeric: 3500,
  mileageKm: 210000,
  dealScore: 72,
  dealType: 'GOOD DEAL',
} as never;

const jsonResponse = (data: unknown, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
});

let mockFetch: ReturnType<typeof vi.fn>;

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, retryDelay: 0 },
    },
  });
}

const wrapper =
  (client: QueryClient) =>
  ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

beforeEach(() => {
  mockFetch = vi.fn() as ReturnType<typeof vi.fn>;
  mockFetch.mockResolvedValue(
    jsonResponse({ data: [baseListing], total: 1, page: 1, pageSize: 50 }),
  );
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useDeals', () => {
  it('fetches /deals from the API and returns the listings', async () => {
    const client = createClient();
    const { result } = renderHook(() => useDeals(), {
      wrapper: wrapper(client),
    });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3001/deals?page=1&pageSize=3000',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.current.data?.data).toEqual([baseListing]);
  });

  it('surfaces an error when the API fails', async () => {
    mockFetch.mockResolvedValue(jsonResponse(null, { ok: false, status: 500 }));

    const client = createClient();
    const { result } = renderHook(() => useDeals({ retry: false }), {
      wrapper: wrapper(client),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isLoading).toBe(false);
  });
});
