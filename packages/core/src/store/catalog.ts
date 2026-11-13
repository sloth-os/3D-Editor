import type { CatalogEntry, StoreResult } from './types';

/*
 * The built-in catalog (CATALOG owns this module and store/builtin/*.ts): original procedural
 * models, CC0 "3D Editor built-in". FOUNDATION created the list (empty until CATALOG fills it), the
 * lookup by id and the conversion to a search result.
 */

/** Provider name of the built-in models (store ids 'builtin:<id>'). */
export const BUILTIN_PROVIDER = 'builtin';

/** Licence and attribution of every built-in model. */
export const BUILTIN_LICENSE = {
  spdx: 'CC0-1.0',
  url: 'https://creativecommons.org/publicdomain/zero/1.0/',
  attribution: '3D Editor built-in',
} as const;

/** The built-in models (CATALOG adds its entries here). */
export const BUILTIN_CATALOG: CatalogEntry[] = [];

/** The built-in model with id `id` ('oak_tree' or 'builtin:oak_tree'), or null. */
export function getCatalogEntry(id: string): CatalogEntry | null {
  const key = id.startsWith(`${BUILTIN_PROVIDER}:`) ? id.slice(BUILTIN_PROVIDER.length + 1) : id;
  return BUILTIN_CATALOG.find((e) => e.id === key) ?? null;
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
