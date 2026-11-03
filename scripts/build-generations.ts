import * as fs from 'fs';
import * as path from 'path';

// Reads auto-parts-db (MIT) brands data and emits a committed generation-periods.json
// usable by the deal classifier to split regression/comparison pools by vehicle
// generation instead of by model alone.
//
// Source: auto-parts-db (MIT) — node_modules/auto-parts-db/dist/esm/data/brands.js
//   142 brands, 2,379 models, 4,642 generations, real codes (e.g. "Mk1 (348)").
//
// The brands.js bundle is ESM (`export const brands = [...]`). Read it as text and
// strip the wrapper so the script runs under both CJS and ESM ts-node without
// import-resolution friction.

const SRC = path.resolve(
  __dirname,
  '..',
  'node_modules',
  'auto-parts-db',
  'dist',
  'esm',
  'data',
  'brands.js',
);
const OUT = path.resolve(
  process.cwd(),
  'good-car-deals-api/src/analysis/generation-periods.json',
);

interface GenRaw {
  name: string;
  yearFrom: number | null;
  yearTo: number | null;
}
interface ModelRaw {
  name: string;
  generations: GenRaw[];
}
interface BrandRaw {
  brand: string;
  models: ModelRaw[];
}

function stripEsmWrapper(raw: string): string {
  return raw
    .replace(/^export\s+const\s+brands\s*=\s*/, '')
    .replace(/;\s*$/, '')
    .trim();
}

function main(): void {
  const raw = fs.readFileSync(SRC, 'utf8');
  const brands: BrandRaw[] = JSON.parse(stripEsmWrapper(raw));

  const outBrands = brands.map(({ brand, models }) => {
    let modelCount = 0;
    let genCount = 0;
    let currentCount = 0;
    const outModels = models.map(({ name, generations }) => {
      modelCount++;
      const outGens = generations.map((g) => {
        genCount++;
        if (g.yearTo === null) currentCount++;
        if (g.yearFrom !== null && g.yearTo !== null && g.yearFrom > g.yearTo) {
          console.warn(
            `invalid range ${brand} ${name} ${g.name}: ${g.yearFrom}-${g.yearTo}`,
          );
        }
        return { name: g.name, yearFrom: g.yearFrom, yearTo: g.yearTo };
      });
      return { name, generations: outGens };
    });
    return { brand, models: outModels };
  });

  const modelCount = outBrands.reduce((s, b) => s + b.models.length, 0);
  const genCount = outBrands.reduce(
    (s, b) => s + b.models.reduce((m, md) => m + md.generations.length, 0),
    0,
  );

  const payload = {
    source: 'auto-parts-db',
    sourceUrl: 'https://github.com/auto-parts-db/auto-parts-db',
    license: 'MIT',
    generatedAt: new Date().toISOString(),
    brandCount: outBrands.length,
    modelCount,
    generationCount: genCount,
    brands: outBrands,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');

  console.log(`wrote ${OUT}`);
  console.log(
    `brands=${payload.brandCount} models=${payload.modelCount} generations=${payload.generationCount}`,
  );
}

main();
