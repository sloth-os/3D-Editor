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
 * downloaded. Models that take parameters of their own (a sofa's seats, a house's floors: store.add
 * `params`) list them in their search results and details, and an insert checks them first.
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

const paramsCache = new WeakMap<CatalogEntry, Record<string, unknown> | null>();

/**
 * A built-in model's own parameters (store.add `params`) as JSON schema properties, null when it
 * takes none.
 */
export function modelParams(entry: CatalogEntry): Record<string, unknown> | null {
  if (!entry.params) return null;
  const cached = paramsCache.get(entry);
  if (cached !== undefined) return cached;
  const schema = safeJsonSchema(entry.params) as { properties?: Record<string, unknown> } | null;
  const props = schema?.properties && Object.keys(schema.properties).length ? schema.properties : null;
  paramsCache.set(entry, props);
  return props;
}

/** One parameter as a short text from its JSON schema: "floors (integer 1–4, default 2): Storeys". */
function paramText(name: string, schema: unknown): string {
  const p = (schema && typeof schema === 'object' ? schema : {}) as Record<string, unknown>;
  const parts: string[] = [];
  // bounds as zod writes them for any integer (the safe-integer range) say nothing
  const bound = (v: unknown) =>
    typeof v === 'number' && Math.abs(v) < Number.MAX_SAFE_INTEGER ? v : undefined;
  const min = bound(p.minimum);
  const max = bound(p.maximum);
  if (Array.isArray(p.enum)) parts.push(`one of ${p.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  else if (typeof p.type === 'string')
    parts.push(
      min !== undefined && max !== undefined
        ? `${p.type} ${min}–${max}`
        : min !== undefined
          ? `${p.type} ≥ ${min}`
          : max !== undefined
            ? `${p.type} ≤ ${max}`
            : p.type,
    );
  if (p.default !== undefined) parts.push(`default ${JSON.stringify(p.default)}`);
  const what = typeof p.description === 'string' && p.description ? `: ${p.description}` : '';
  return `${name}${parts.length ? ` (${parts.join(', ')})` : ''}${what}`;
}

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
      const params = entry ? modelParams(entry) : null;
      return {
        model: { ...model, thumbnail_url: null, ...(params ? { params } : {}) },
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
    const params = modelParams(entry);
    return {
      model: { ...builtinResult(entry), id: `${BUILTIN_PROVIDER}:${entry.id}` },
      description: entry.description || null,
      ...(params ? { params } : {}),
    };
  }

  /**
   * Checks `params` by the model's own schema (as store.add does, strict: unknown names refused)
   * before anything is inserted: INVALID_PARAMS with what is wrong and the parameters it takes.
   */
  checkParams(id: string, params: Record<string, unknown>): void {
    const entry = this.entry(id);
    const full = `${BUILTIN_PROVIDER}:${entry.id}`;
    const names = Object.keys(params);
    const props = modelParams(entry);
    if (!entry.params || !props) {
      if (names.length)
        throw new ToolError(`${full} takes no params (got ${names.join(', ')})`, 'INVALID_PARAMS');
      return;
    }
    const r = entry.params.strict().safeParse(params);
    if (r.success) return;
    const problems = r.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ');
    const takes = Object.entries(props)
      .map(([name, schema]) => paramText(name, schema))
      .join('; ');
    throw new ToolError(`Invalid params for ${full}: ${problems}. It takes: ${takes}`, 'INVALID_PARAMS');
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
