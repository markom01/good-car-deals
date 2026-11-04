import { fuelCategory, isAutomatic } from './expected-price';

describe('fuelCategory', () => {
  it.each([
    ['Dizel', 'diesel'],
    ['Benzin', 'petrol'],
    ['Benzin + Gas (TNG)', 'gas'],
    ['Benzin + Metan (CNG)', 'gas'],
    ['Hibridni pogon (dizel)', 'hybrid'],
    ['Hibridni pogon (benzin)', 'hybrid'],
    ['Električni pogon', 'electric'],
    [null, 'petrol'],
    ['Nepoznato', 'petrol'],
  ])('%s → %s', (label, expected) => {
    expect(fuelCategory(label)).toBe(expected);
  });
});

describe('isAutomatic', () => {
  it.each([
    ['Automatski 6 brzina', true],
    ['Manuelni 5 brzina', false],
    [null, false],
    ['', false],
  ])('%s → %s', (label, expected) => {
    expect(isAutomatic(label)).toBe(expected);
  });
});
