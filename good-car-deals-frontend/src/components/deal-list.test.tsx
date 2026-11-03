import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Listing } from '@good-car-deals/shared';
import { DealList } from './deal-list';
import { useDeals } from '@/hooks/use-deals';

vi.mock('@/hooks/use-deals', () => ({ useDeals: vi.fn() }));

const mockedUseDeals = vi.mocked(useDeals);

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

function mockState(state: {
  data?: Listing[];
  isLoading?: boolean;
  isError?: boolean;
  error?: Error | null;
}) {
  mockedUseDeals.mockReturnValue({
    data: state.data,
    isLoading: state.isLoading ?? false,
    isError: state.isError ?? false,
    error: state.error ?? null,
    refetch: vi.fn(),
  } as never);
}

afterEach(cleanup);

beforeEach(() => {
  mockedUseDeals.mockReset();
});

describe('DealList', () => {
  it('renders the first rows of the virtualized grid', () => {
    mockState({ data: Array.from({ length: 40 }, (_, i) => listing(i + 1)) });

    render(<DealList />);

    expect(screen.getByText('Car 1')).toBeInTheDocument();
    expect(screen.getByText('Car 2')).toBeInTheDocument();
  });

  it('mounts only a window of rows, not all 2,000 cards', () => {
    mockState({ data: Array.from({ length: 2000 }, (_, i) => listing(i + 1)) });

    render(<DealList />);

    const mounted = screen.getAllByText(/^Car \d+$/).length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(100);
  });

  it('shows skeletons while loading', () => {
    mockState({ isLoading: true });

    const { container } = render(<DealList />);

    expect(screen.queryByText(/^Car \d+$/)).not.toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length,
    ).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no deals', () => {
    mockState({ data: [] });

    render(<DealList />);

    expect(screen.getByText('No deals found')).toBeInTheDocument();
  });

  it('shows the error state with a retry button', () => {
    mockState({ isError: true, error: new Error('API down') });

    render(<DealList />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('API down')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /try again/i }),
    ).toBeInTheDocument();
  });
});
