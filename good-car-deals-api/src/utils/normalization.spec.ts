import {
  normalizeMileage,
  normalizePrice,
  extractModel,
  parseEngineCc,
  parsePowerKw,
} from './normalization';

// Test data (no external dependencies)
const testListings = [
  { title: 'Opel Corsa D 1.2', price: '4.500', year: '2018' },
  { title: 'BMW 320d', price: '12.500', year: '2019' },
  { title: 'Audi A3 1.6', price: '8.900', year: '2017' },
  { title: 'VW Golf 2.0 TDI', price: '9.500', year: '2018' },
  { title: 'Mercedes C200', price: '15.000', year: '2016' },
];

describe('normalizeMileage', () => {
  it('should normalize mileage with dots (360.000 km)', () => {
    expect(normalizeMileage('360.000 km')).toBe(360000);
  });

  it('should normalize mileage with dots (120.000 km)', () => {
    expect(normalizeMileage('120.000 km')).toBe(120000);
  });

  it('should normalize mileage without km unit', () => {
    expect(normalizeMileage('360.000')).toBe(360000);
  });

  it('should return null for invalid mileage', () => {
    expect(normalizeMileage('N/A')).toBeNull();
    expect(normalizeMileage('')).toBeNull();
    expect(normalizeMileage(null)).toBeNull();
  });
});

describe('normalizePrice', () => {
  it('should normalize price with dots (4.500 EUR)', () => {
    const result = normalizePrice('4.500 EUR');
    expect(result.numeric).toBe(4500);
    expect(result.raw).toBe('4.500 EUR');
  });

  it('should normalize price with dots (12.500)', () => {
    const result = normalizePrice('12.500');
    expect(result.numeric).toBe(12500);
  });

  it('should return null for invalid price', () => {
    expect(normalizePrice('Price on request').numeric).toBeNull();
    expect(normalizePrice('').numeric).toBeNull();
    expect(normalizePrice(null).numeric).toBeNull();
  });
});

describe('parseEngineCc', () => {
  it('parses "1956 cm3" to 1956', () => {
    expect(parseEngineCc('1956 cm3')).toBe(1956);
  });

  it('parses "1598" to 1598', () => {
    expect(parseEngineCc('1598')).toBe(1598);
  });

  it('returns null for empty/garbage', () => {
    expect(parseEngineCc('')).toBeNull();
    expect(parseEngineCc('aka')).toBeNull();
  });

  it('parses liter notation "1.6L" to 1600', () => {
    expect(parseEngineCc('1.6L')).toBe(1600);
  });

  it('parses dot-thousands "1.956 cm3" to 1956', () => {
    expect(parseEngineCc('1.956 cm3')).toBe(1956);
  });
});

describe('parsePowerKw', () => {
  it('parses "81 kW" to 81', () => {
    expect(parsePowerKw('81 kW')).toBe(81);
  });

  it('returns null for non-numeric', () => {
    expect(parsePowerKw('')).toBeNull();
  });
});

describe('extractModel', () => {
  it('should extract model from test data', () => {
    let passed = 0;
    for (const listing of testListings) {
      const result = extractModel(listing.title);
      if (result && result.length > 0) {
        passed++;
      }
    }
    expect(passed / testListings.length).toBeGreaterThan(0.8);
  });

  it('should handle empty titles', () => {
    expect(extractModel('')).toBeNull();
    expect(extractModel(null as unknown as string)).toBeNull();
  });

  it('should handle single word titles', () => {
    expect(extractModel('BMW')).toBeNull();
  });
});
