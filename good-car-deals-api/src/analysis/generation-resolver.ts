import generationPeriods from './generation-periods.json';

interface ArtifactGeneration {
  name: string;
  yearFrom: number;
  yearTo: number | null;
}

interface ArtifactModel {
  name: string;
  generations: ArtifactGeneration[];
}

interface ArtifactBrand {
  brand: string;
  models: ArtifactModel[];
}

const artifact = generationPeriods as unknown as { brands: ArtifactBrand[] };

/**
 * Fold a market label to a comparable key: strip diacritics, lowercase,
 * drop everything that is not a letter or digit.
 * "Škoda Octavia" → "skodaoctavia".
 */
export function normalizeModelLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

interface IndexedModel {
  norm: string;
  generations: ArtifactGeneration[];
}

const modelsByBrand = new Map<string, IndexedModel[]>();

for (const brand of artifact.brands) {
  modelsByBrand.set(
    normalizeModelLabel(brand.brand),
    brand.models.map((m) => ({
      norm: normalizeModelLabel(m.name),
      generations: m.generations,
    })),
  );
}

// Longest brand first so "Mercedes-Benz" wins over a shorter prefix.
const brandKeys = [...modelsByBrand.keys()].sort((a, b) => b.length - a.length);

const MIN_YEAR = 1950;

function findModel(brandKey: string, rest: string): IndexedModel | null {
  const models = modelsByBrand.get(brandKey) ?? [];

  const exact = models.find((m) => m.norm === rest);
  if (exact) return exact;

  // Trim suffix such as "Golf 7" → "golf" + "7", "A4 20" → "a4" + "20".
  // Only 1-3 trailing alphanumerics are accepted; anything longer is a
  // trim/engine token and must not be guessed away.
  const padded = models
    .filter((m) => m.norm.length >= 2 && rest.startsWith(m.norm))
    .filter((m) => {
      const suffix = rest.slice(m.norm.length);
      return /^[a-z0-9]{1,3}$/.test(suffix);
    })
    .sort((a, b) => b.norm.length - a.norm.length);

  return padded[0] ?? null;
}

/**
 * Resolve a listing to exactly one generation, or `null` when the answer
 * would be a guess. Boundary years where two generations overlap stay
 * unresolved on purpose — a wrong split is worse than no split.
 *
 * @param modelLabel listing model as stored ("Audi A3", "Golf 7")
 * @param year model year of the listing
 */
export function resolveGeneration(
  modelLabel: string | null | undefined,
  year: number | null | undefined,
): string | null {
  if (!modelLabel || year === null || year === undefined) return null;
  if (!Number.isInteger(year) || year < MIN_YEAR || year > 2100) return null;

  const norm = normalizeModelLabel(modelLabel);
  if (!norm) return null;

  let brandKey: string | null = null;
  for (const key of brandKeys) {
    if (norm.startsWith(key)) {
      brandKey = key;
      break;
    }
  }
  if (!brandKey) return null;

  const model = findModel(brandKey, norm.slice(brandKey.length));
  if (!model) return null;

  const matches = model.generations.filter(
    (g) => year >= g.yearFrom && (g.yearTo === null || year <= g.yearTo),
  );

  if (matches.length === 1) return matches[0].name;

  // Year sits on a generation boundary (in several ranges) or in a gap
  // (in none). Pick the nearest generation so every card gets a benchmark
  // instead of a suppressed average. Overlaps prefer the narrower span;
  // gaps prefer the smallest distance to a range edge.
  const candidates = model.generations.map((g) => {
    let dist = 0;
    if (year < g.yearFrom) dist = g.yearFrom - year;
    else if (g.yearTo !== null && year > g.yearTo) dist = year - g.yearTo;
    return {
      g,
      dist,
      span: g.yearTo === null ? Infinity : g.yearTo - g.yearFrom,
    };
  });

  candidates.sort(
    (a, b) =>
      a.dist - b.dist ||
      a.span - b.span ||
      (a.g.yearFrom ?? 0) - (b.g.yearFrom ?? 0),
  );

  return candidates.length > 0 ? candidates[0].g.name : null;
}
