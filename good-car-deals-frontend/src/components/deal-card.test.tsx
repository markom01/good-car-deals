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
  expectedPrice: 4000,
  deviationPct: 12.6,
  expectedPriceSampleSize: 42,
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

  it('flags foreign-plated import cars', () => {
    const imported = { ...baseListing, plateOrigin: 'foreign' } as Listing;
    render(<DealCard deal={imported} />);
    expect(screen.getByText('Foreign plates')).toBeInTheDocument();
    expect(
      screen.getByText(/import duty and registration not included/i),
    ).toBeInTheDocument();
  });

  it('does not flag domestic cars', () => {
    const domestic = { ...baseListing, plateOrigin: 'domestic' } as Listing;
    render(<DealCard deal={domestic} />);
    expect(screen.queryByText('Foreign plates')).not.toBeInTheDocument();
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

  it('shows the typical asking price and comp count', () => {
    render(<DealCard deal={baseListing} />);
    const badge = screen.getByText('13%');
    expect(badge).toHaveAttribute('data-variant', 'default');
    expect(screen.getByText(/below typical asking price/)).toBeInTheDocument();
    expect(
      screen.getByText(/€4,000 · based on 42 similar ads/),
    ).toBeInTheDocument();
  });

  it('says above typical for a negative deviation', () => {
    const overpriced = { ...baseListing, priceNumeric: 6000 } as Listing;
    render(<DealCard deal={overpriced} />);
    expect(screen.getByText('-50%')).toHaveAttribute(
      'data-variant',
      'destructive',
    );
    expect(screen.getByText(/above typical asking price/)).toBeInTheDocument();
  });

  it('hides the price line when expectedPrice is null', () => {
    const unrated = {
      ...baseListing,
      expectedPrice: null,
      deviationPct: null,
    } as Listing;
    render(<DealCard deal={unrated} />);
    expect(screen.queryByText(/typical asking price/)).not.toBeInTheDocument();
  });

  it('omits the comp clause when the sample size is missing', () => {
    const noCount = {
      ...baseListing,
      expectedPriceSampleSize: null,
    } as Listing;
    render(<DealCard deal={noCount} />);
    expect(screen.getByText('€4,000')).toBeInTheDocument();
    expect(screen.queryByText(/based on/)).not.toBeInTheDocument();
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
