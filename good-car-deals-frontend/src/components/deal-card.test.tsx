import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Listing } from '@good-car-deals/shared';
import { DealCard } from './deal-card';

afterEach(cleanup);

const baseListing: Listing = {
  id: BigInt(1),
  title: 'Opel Vectra C 1.9 CDTI',
  model: 'Vectra C',
  year: 2004,
  price: '3.500 €',
  priceNumeric: 3500,
  mileageKm: 210000,
  fuelType: 'Diesel',
  engineCc: 1910,
  powerKw: 88,
  transmission: 'Manual',
  dealScore: 72,
  dealType: 'GOOD DEAL',
  pricePerYear: 350,
} as unknown as Listing;

describe('DealCard', () => {
  it('renders title, model line, price and score', () => {
    render(<DealCard deal={baseListing} />);
    expect(screen.getByText('Opel Vectra C 1.9 CDTI')).toBeInTheDocument();
    expect(
      screen.getByText(/Vectra C · 2004 · 210,000 km/),
    ).toBeInTheDocument();
    expect(screen.getByText('3,500')).toBeInTheDocument();
    expect(screen.getByText('72')).toBeInTheDocument();
  });

  it('links out to the listing', () => {
    const withUrl = {
      ...baseListing,
      listingUrl: 'https://polovniautomobili.com/example',
    } as Listing;
    render(<DealCard deal={withUrl} />);
    const link = screen.getByRole('link', { name: /view listing/i });
    expect(link).toHaveAttribute(
      'href',
      'https://polovniautomobili.com/example',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows N/A for missing values instead of crashing', () => {
    const sparse = {
      ...baseListing,
      model: null,
      year: null,
      mileageKm: null,
      priceNumeric: null,
      dealScore: null,
      listingUrl: null,
    } as unknown as Listing;
    render(<DealCard deal={sparse} />);
    expect(screen.getAllByText('N/A').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
