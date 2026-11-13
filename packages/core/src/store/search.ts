import type { StoreCategory, StoreResult } from './types';

/*
 * Keyword search of the built-in catalog (CATALOG owns this module): scored matches of the query
 * against names, tags, synonyms and the category, with simple stemming. FOUNDATION wrote the
 * signature; until CATALOG implements it every search finds nothing.
 */

export interface CatalogSearchOptions {
  category?: StoreCategory | null;
  /** Most results (default 20). */
  limit?: number;
  /** Results to skip (paging). */
  offset?: number;
}

/** Built-in models matching `query` (empty: all, by name), best first. */
export function searchCatalog(_query: string, _opts: CatalogSearchOptions = {}): StoreResult[] {
  return [];
}
