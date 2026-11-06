import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import WheelRankPage from './page';

afterEach(cleanup);

describe('WheelRank page', () => {
  it('renders the hero heading, tagline and all mock deal cards', () => {
    render(<WheelRankPage />);

    expect(
      screen.getByRole('heading', { name: /wheelrank/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/used vehicle deals, ranked/i)).toBeInTheDocument();

    // Every mock deal gets a DealCard with its title.
    expect(screen.getByText('Opel Astra 1.6 CDTI 2018')).toBeInTheDocument();
    expect(screen.getByText('VW Golf 2.0 TDI 2020')).toBeInTheDocument();
    expect(screen.getByText('Škoda Octavia 1.5 TSI 2019')).toBeInTheDocument();
    expect(screen.getByText('Ford Focus 1.5 EcoBlue 2020')).toBeInTheDocument();
    expect(screen.getByText('Audi A3 2.0 TDI 2019')).toBeInTheDocument();
    expect(screen.getByText('BMW 320d xDrive 2017')).toBeInTheDocument();
    expect(screen.getByText('Renault Clio 1.5 dCi 2021')).toBeInTheDocument();
    expect(
      screen.getByText('Peugeot 308 1.5 BlueHDi 2022'),
    ).toBeInTheDocument();
  });
});
