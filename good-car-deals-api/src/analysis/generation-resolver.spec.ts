import { normalizeModelLabel, resolveGeneration } from './generation-resolver';

describe('resolveGeneration', () => {
  it('folds diacritics and punctuation away', () => {
    expect(normalizeModelLabel('Škoda Octavia')).toBe('skodaoctavia');
    expect(normalizeModelLabel('Mercedes-Benz A 180')).toBe('mercedesbenza180');
  });

  it('resolves a mid-life year to one generation', () => {
    expect(resolveGeneration('Audi A3', 2015)).toBe('8V (Third Gen)');
  });

  it('resolves a transition year to the nearest generation', () => {
    // 8P ends 2013, 8V starts 2012 — overlap at 2013; narrower span wins.
    expect(resolveGeneration('Audi A3', 2013)).toBe('8V (Third Gen)');
    // 8V ends 2020, 8Y starts 2020 — overlap at 2020.
    expect(resolveGeneration('Audi A3', 2020)).toBe('8V (Third Gen)');
  });

  it('resolves a gap year to the nearest generation', () => {
    // Mk1 ends 2000, Mk2 starts 2002 — 2001 is equidistant, earlier wins.
    expect(resolveGeneration('Renault Laguna', 2001)).toBe('Mk2 (BG0)');
    // Mk2 ends 2006, Mk3 starts 2008 — 2007 is equidistant, earlier wins.
    expect(resolveGeneration('Renault Laguna', 2007)).toBe('Mk2 (BG0)');
  });

  it('resolves an overlap year to the narrower generation span', () => {
    // Mk7 Facelift 2017-2020 and Mk8 2019-: 2019 overlaps both.
    expect(resolveGeneration('Volkswagen Golf 7', 2019)).toBe('Mk7 (Facelift)');
  });

  it('uses the year, not the trailing model token', () => {
    expect(resolveGeneration('Volkswagen Golf 7', 2016)).toBe('Mk7 (Type 5G)');
    expect(resolveGeneration('Volkswagen Golf 7', 2018)).toBe('Mk7 (Facelift)');
  });

  it('returns null for labels the artifact cannot match', () => {
    expect(resolveGeneration('Mercedes Benz A 180', 2015)).toBeNull();
    expect(resolveGeneration('Unknownmobile X', 2015)).toBeNull();
    expect(resolveGeneration(null, 2015)).toBeNull();
    expect(resolveGeneration('Audi A3', null)).toBeNull();
  });

  it('resolves years outside every range to the nearest generation', () => {
    // 1970 predates every Audi A3 generation; nearest is 8L (from 1999).
    expect(resolveGeneration('Audi A3', 1970)).toBe('8L (First Gen)');
  });
});
