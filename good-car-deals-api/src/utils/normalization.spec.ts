import {
  normalizeMileage,
  normalizePrice,
  extractModel,
  parseEngineCc,
  parsePowerKw,
  plateOriginFromTags,
  normalizePlateOrigin,
  parseFeedTimestamp,
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
  });

  it('should handle single word titles', () => {
    expect(extractModel('BMW')).toBeNull();
  });
});

describe('plateOriginFromTags', () => {
  it('maps domestic and foreign plate tags', () => {
    expect(plateOriginFromTags(['Domaće tablice'])).toBe('domestic');
    expect(plateOriginFromTags(['Garancija', 'Strane tablice'])).toBe(
      'foreign',
    );
    // "Nije registrovan" is an unregistered import — same price exclusion.
    expect(plateOriginFromTags(['Nije registrovan'])).toBe('foreign');
    expect(plateOriginFromTags(['Garancija', 'Nije registrovan'])).toBe(
      'foreign',
    );
  });

  it('treats "Na ime kupca" as an unregistered import', () => {
    // Detail pages show "Registrovan do: Nije registrovan" for these, even
    // though the feed reports registrationInPrice=true.
    expect(plateOriginFromTags(['Garancija', 'Na ime kupca'])).toBe('foreign');
    expect(plateOriginFromTags(['Na ime kupca'], true)).toBe('foreign');
    expect(plateOriginFromTags(['Na ime kupca'])).toBe('foreign');
  });

  it('does not guess when the tag is absent', () => {
    expect(plateOriginFromTags(['Garancija'])).toBeNull();
    expect(plateOriginFromTags([])).toBeNull();
    expect(plateOriginFromTags(undefined)).toBeNull();
  });

  it('treats registrationInPrice=false without domestic tag as foreign', () => {
    // Unregistered import: no "Domaće tablice" tag, registration not in price.
    expect(plateOriginFromTags(['Na ime kupca'], false)).toBe('foreign');
    expect(plateOriginFromTags(['Garancija'], false)).toBe('foreign');
    expect(plateOriginFromTags([], false)).toBe('foreign');
    expect(plateOriginFromTags(undefined, false)).toBe('foreign');
  });

  it('does not treat registrationInPrice=false as foreign when domestic tag present', () => {
    // Domestic car where registration is paid separately — still domestic.
    expect(plateOriginFromTags(['Domaće tablice'], false)).toBe('domestic');
  });

  it('ignores registrationInPrice when tags are present and unrecognised', () => {
    expect(plateOriginFromTags(['Garancija'], true)).toBeNull();
    expect(plateOriginFromTags(['Garancija'], undefined)).toBeNull();
  });
});

describe('normalizePlateOrigin', () => {
  it('keeps known values and nulls everything else', () => {
    expect(normalizePlateOrigin('domestic')).toBe('domestic');
    expect(normalizePlateOrigin('foreign')).toBe('foreign');
    expect(normalizePlateOrigin('strane')).toBeNull();
    expect(normalizePlateOrigin(null)).toBeNull();
    expect(normalizePlateOrigin(undefined)).toBeNull();
  });
});

describe('parseFeedTimestamp', () => {
  it('reads offset-less feed times as Europe/Belgrade wall clock', () => {
    // Winter (CET, +01:00)
    expect(parseFeedTimestamp('2026-11-05 19:25:03')?.toISOString()).toBe(
      '2026-11-05T18:25:03.000Z',
    );
    // Summer (CEST, +02:00)
    expect(parseFeedTimestamp('2026-07-15 12:00:00')?.toISOString()).toBe(
      '2026-07-15T10:00:00.000Z',
    );
  });

  it('keeps explicit offsets and rejects empty input', () => {
    expect(parseFeedTimestamp('2026-11-05T19:25:03Z')?.toISOString()).toBe(
      '2026-11-05T19:25:03.000Z',
    );
    expect(parseFeedTimestamp('2026-11-05T19:25:03+01:00')?.toISOString()).toBe(
      '2026-11-05T18:25:03.000Z',
    );
    expect(parseFeedTimestamp(null)).toBeNull();
    expect(parseFeedTimestamp('')).toBeNull();
  });
});
