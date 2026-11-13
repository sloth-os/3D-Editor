import {
  BUILTIN_PROVIDER,
  builtinResult,
  getCatalogEntry,
  safeJsonSchema,
  searchCatalog,
  type CatalogEntry,
  type CatalogSearchOptions,
  type StoreResult,
} from '@3d-editor/core';
import { NotFoundError, ToolError } from '../../mcp/agent';
import { relevance } from '../relevance';
import type { DownloadPlan, ModelProvider, ProviderDetails, ProviderPage, ProviderQuery } from './types';

/*
 * The built-in catalog of core (original procedural models, CC0): searched in memory, inserted with
 * the core operator store.add, thumbnails rendered by the server (thumbnails.ts). Nothing is
 * downloaded.
 */

/** The catalog the provider reads (core's; tests pass their own). */
export interface BuiltinCatalog {
  search(query: string, opts: CatalogSearchOptions): StoreResult[];
  get(id: string): CatalogEntry | null;
}

export const CORE_CATALOG: BuiltinCatalog = {
  search: (query, opts) => searchCatalog(query, opts),
  get: (id) => getCatalogEntry(id),
};

export class BuiltinProvider implements ModelProvider {
  readonly id = 'builtin' as const;
  readonly name = 'Built-in models';

  constructor(private readonly catalog: BuiltinCatalog = CORE_CATALOG) {}

  missingKey(): string | null {
    return null;
  }

  searchesWithoutKey(): boolean {
    return true;
  }

  async search(q: ProviderQuery): Promise<ProviderPage> {
    // one more than asked tells whether there is a next page
    const found = this.catalog.search(q.text, {
      category: q.category,
      limit: q.limit + 1,
      offset: q.offset,
    });
    const page = found.slice(0, q.limit);
    const hits = page.map((model, i) => {
      const entry = this.catalog.get(model.id);
      return {
        model: { ...model, thumbnail_url: null },
        score: relevance(q.words, {
          name: model.name,
          synonyms: entry?.synonyms,
          tags: model.tags,
          category: model.category,
          description: entry?.description,
        }),
        next: q.offset + i + 1,
      };
    });
    return { hits, end: found.length > q.limit ? q.offset + q.limit : null };
  }

  entry(id: string): CatalogEntry {
    const entry = this.catalog.get(id);
    if (!entry) throw new NotFoundError(`No built-in model '${id}' (store_search lists the models)`);
    return entry;
  }

  async details(id: string): Promise<ProviderDetails> {
    const entry = this.entry(id);
    const schema = entry.params
      ? (safeJsonSchema(entry.params) as { properties?: Record<string, unknown> } | null)
      : null;
    return {
      model: { ...builtinResult(entry), id: `${BUILTIN_PROVIDER}:${entry.id}` },
      description: entry.description || null,
      ...(schema?.properties && Object.keys(schema.properties).length ? { params: schema.properties } : {}),
    };
  }

  async thumbnail(): Promise<null> {
    return null;
  }

  async plan(id: string): Promise<DownloadPlan> {
    throw new ToolError(
      `builtin:${id} is built by code, nothing is downloaded: insert it with store_add`,
      'INVALID_PARAMS',
    );
  }
}
