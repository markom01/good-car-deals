/**
 * Data Normalization Utilities
 * Port of Python scraper.py and deal_finder.py normalization logic
 */

/**
 * Normalize mileage string to integer
 * Input: "360.000 km" → 360000
 * Input: "N/A" → null
 * Input: null → null
 */
export function normalizeMileage(mileageStr: string | null): number | null {
  if (!mileageStr) return null;

  // Remove dots, "km" text, trim
  const cleaned = mileageStr.replace(/\./g, '').replace(/km/gi, '').trim();

  const parsed = parseInt(cleaned, 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Normalize price string to numeric value
 * Input: "4.500 EUR" → { raw: "4.500 EUR", numeric: 4500 }
 * Input: "Price on request" → { raw: "Price on request", numeric: null }
 * Input: null → { raw: "", numeric: null }
 */
export function normalizePrice(priceStr: string | null): {
  raw: string;
  numeric: number | null;
} {
  if (!priceStr) {
    return { raw: '', numeric: null };
  }

  // Remove dots (thousand separators), commas, EUR, RSD
  const cleaned = priceStr
    .replace(/\./g, '')
    .replace(/,/g, '')
    .replace(/EUR/gi, '')
    .replace(/RSD/gi, '')
    .trim();

  const parsed = parseInt(cleaned, 10);
  return {
    raw: priceStr,
    numeric: isNaN(parsed) ? null : parsed,
  };
}

/**
 * Extract model from title
 * Input: "Brand Model 1.2" → "Model"
 * Input: "Brand Model" → "Model"
 * Input: "" → null
 */
export function extractModel(title: string): string | null {
  if (!title) return null;

  // General pattern: look for "Brand Model" after the first word
  // e.g., "Brand Model 1.2" → "Model" (words 2-3)
  const words = title.trim().split(/\s+/);
  if (words.length >= 2) {
    // Skip first word (brand), return next word + possible suffix
    const modelWords: string[] = [];
    for (let i = 1; i < words.length; i++) {
      const word = words[i];
      // Stop at numbers (engine size like "1.2", "1.3")
      if (/^\d+(\.\d+)?$/.test(word)) {
        break;
      }
      modelWords.push(word);
      // Stop after 2 words (e.g., "Model Name")
      if (modelWords.length >= 2) break;
    }
    if (modelWords.length > 0) {
      return modelWords.join(' ');
    }
  }

  return null;
}

/**
 * Parse engine displacement string to cubic centimeters
 * Input: "1956 cm3" → 1956
 * Input: "1.956 cm3" → 1956 (dot-thousands separator)
 * Input: "1.6L" → 1600 (liter notation, decimal × 1000)
 * Input: "1598" → 1598
 * Input: "" / garbage → null
 */
export function parseEngineCc(engineVolume: string | null): number | null {
  if (!engineVolume) return null;

  const trimmed = engineVolume.trim();

  // Liter notation: decimal liters → cc (×1000)
  if (/l$/i.test(trimmed)) {
    const liters = parseFloat(trimmed.replace(/l/i, ''));
    return isNaN(liters) ? null : Math.round(liters * 1000);
  }

  // cc / plain digits: dots are thousands separators here, not decimals
  const cleaned = trimmed.replace(/\./g, '');
  const match = cleaned.match(/\d+/);

  if (!match) return null;

  const parsed = parseInt(match[0], 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Parse power string to kilowatts
 * Input: "81 kW" → 81
 * Input: "" / garbage → null
 */
export function parsePowerKw(powerKw: string | null): number | null {
  if (!powerKw) return null;
  const parsed = parseInt(powerKw.match(/-?\d+(\.\d+)?/)?.[0] ?? '', 10);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Calculate age from year
 * Uses dynamic current year calculation (NOT hardcoded)
 * Input: 2018 → currentYear - 2018
 * Input: null → null
 * Input: future year → null (can't be in the future)
 */
export function calculateAge(year: number | null | undefined): number | null {
  if (year === null || year === undefined) return null;

  const currentYear = new Date().getFullYear();

  // Invalid if year is in the future or too old (>100 years)
  if (year > currentYear || year < currentYear - 100) {
    return null;
  }

  return currentYear - year;
}

/**
 * Calculate price per year (deals metric)
 * Formula: priceNumeric / age
 * Returns null if price or age is invalid
 */
export function calculatePricePerYear(
  priceNumeric: number | null,
  year: number | null,
): number | null {
  if (priceNumeric === null || priceNumeric === undefined) return null;
  if (year === null || year === undefined) return null;

  const age = calculateAge(year);
  if (age === null || age <= 0) return null;

  return priceNumeric / age;
}
