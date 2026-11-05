import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '@good-car-deals/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DealList } from './deal-list';

const listing = (id: number): Listing =>
  ({
    id: BigInt(id),
    title: `Car ${id}`,
    model: 'Astra',
    year: 2010,
    price: '3.000 €',
    priceNumeric: 3000,
    mileageKm: 150000,
    dealScore: 70,
    dealType: 'GOOD DEAL',
    pricePerYear: 300,
  }) as unknown as Listing;

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

const wrapper = (client: QueryClient) => {
  function QueryWrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return QueryWrapper;
};

beforeEach(() => {
  mockFetch = vi.fn() as ReturnType<typeof vi.fn>;
  mockFetch.mockResolvedValue(
    jsonResponse({
      data: [listing(1), listing(2)],
      total: 2,
      page: 1,
      pageSize: 3000,
    }),
  );
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('DealList', () => {
  it('renders rows after loading from the API', async () => {
    const client = createClient();
    render(<DealList />, { wrapper: wrapper(client) });

    expect(screen.queryByText(/^Car \d+$/)).not.toBeInTheDocument();

    await screen.findByText('Car 1');
    expect(screen.getByText('Car 2')).toBeInTheDocument();
  });

  it('mounts only a window of rows, not all 2,000 cards', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
        data: Array.from({ length: 2000 }, (_, i) => listing(i + 1)),
        total: 2000,
        page: 1,
        pageSize: 3000,
      }),
    );

    const client = createClient();
    render(<DealList />, { wrapper: wrapper(client) });

    await screen.findByText('Car 1');

    const mounted = screen.getAllByText(/^Car \d+$/).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
  });

  it('shows skeletons while loading', async () => {
    // Delay the response so loading state is observable. DealList issues two
    // queries (active view + new-deal count), so resolve every pending call.
    const resolvers: Array<(v: unknown) => void> = [];
    mockFetch.mockImplementation(
      () =>
        new Promise((r) => {
          resolvers.push(r as (v: unknown) => void);
        }) as unknown as Promise<Response>,
    );

    const client = createClient();
    const { container } = render(<DealList />, { wrapper: wrapper(client) });

    expect(screen.queryByText(/^Car \d+$/)).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);

    await waitFor(() => expect(resolvers.length).toBeGreaterThan(0));
    resolvers.forEach((resolve) =>
      resolve(
        jsonResponse({ data: [listing(1)], total: 1, page: 1, pageSize: 3000 }),
      ),
    );
    await screen.findByText('Car 1');
  });

  it('shows the empty state when the API returns no deals', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ data: [], total: 0, page: 1, pageSize: 3000 }),
    );

    const client = createClient();
    render(<DealList />, { wrapper: wrapper(client) });

    await screen.findByText('No deals found');
  });
});
