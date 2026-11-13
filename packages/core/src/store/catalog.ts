import type { CatalogEntry, StoreResult } from './types';
import { BUILTIN_MODELS } from './builtin';

/*
 * The built-in catalog (CATALOG owns this module and store/builtin/*.ts): original procedural
 * models, CC0 "3D Editor built-in". Ids are lowercase words joined by underscores ('coffee_table',
 * as store/types.ts asks); lookups also accept the store id ('builtin:coffee_table'), dashes or
 * spaces between the words and any letter case.
 */

/** Provider name of the built-in models (store ids 'builtin:<id>'). */
export const BUILTIN_PROVIDER = 'builtin';

/** Licence and attribution of every built-in model. */
export const BUILTIN_LICENSE = {
  spdx: 'CC0-1.0',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: '3D Editor built-in',
} as const;

/** The built-in models (store/builtin/index.ts assembles them; tests may add their own). */
export const BUILTIN_CATALOG: CatalogEntry[] = [...BUILTIN_MODELS];

/** A catalog id in its canonical spelling: lower case, words joined by underscores. */
export function normalizeCatalogId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * The built-in model with id `id` ('coffee_table', 'builtin:coffee_table', 'coffee-table' or
 * 'Coffee Table'), or null (also for another provider's store id).
 */
export function getCatalogEntry(id: string): CatalogEntry | null {
  let key = id.trim();
  const colon = key.indexOf(':');
  if (colon >= 0) {
    if (key.slice(0, colon).trim().toLowerCase() !== BUILTIN_PROVIDER) return null;
    key = key.slice(colon + 1);
  }
  key = normalizeCatalogId(key);
  if (!key) return null;
  return BUILTIN_CATALOG.find((e) => normalizeCatalogId(e.id) === key) ?? null;
}

/** A built-in model as a store search result. */
export function builtinResult(entry: CatalogEntry): StoreResult {
  return {
    id: `${BUILTIN_PROVIDER}:${entry.id}`,
    provider: BUILTIN_PROVIDER,
    name: entry.name,
    category: entry.category,
    tags: [...entry.tags],
    thumbnail_url: null,
    license: { ...BUILTIN_LICENSE },
    author: BUILTIN_LICENSE.attribution,
    source_url: null,
    dimensions_m: [...entry.dimensions_m],
    triangles: entry.triangles,
    formats: ['builtin'],
    downloadable: true,
  };
}
