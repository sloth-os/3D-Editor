import type { StoreCategory, StoreResult } from '@3d-editor/core';
import { NotFoundError, ToolError } from '../../mcp/agent';
import { StoreUpstreamError, storeFetchJson } from '../http';
import { clip, licenseUrl, normalizeLicense } from '../licenses';
import { relevance } from '../relevance';
import {
  INDEX_TTL_MS,
  MAX_INDEX_BYTES,
  SeenThumbnails,
  type DownloadPlan,
  type ModelProvider,
  type ProviderDetails,
  type ProviderEnv,
  type ProviderHit,
  type ProviderPage,
  type ProviderQuery,
  type ThumbnailSource,
} from './types';

/*
 * Poly Pizza (poly.pizza, low-poly models under CC0 or CC-BY) through its API v1.1, which answers
 * only with an API key (POLYPIZZA_API_KEY, sent as `x-auth-token`): /search/<words>?Limit=&Page=
 * (results: ID, Title, Attribution, Thumbnail, Download (a .glb), Tri Count, Creator, Category,
 * Tags, Licence) and /model/<id>. The key also goes with the downloads from Poly Pizza's file
 * server, never to other hosts. Without the key the provider answers needs_key.
 */

export const POLYPIZZA_API = 'https://api.poly.pizza/v1.1';
/** Results per search request. */
const SEARCH_PAGE = 24;
const MAX_REQUESTS = 4;

/** Poly Pizza's category numbers (its search filter) and names (its results). */
const CATEGORIES: { id: number; name: string; category: StoreCategory | null }[] = [
  { id: 0, name: 'Food & Drink', category: 'food' },
  { id: 1, name: 'Clutter', category: 'props' },
  { id: 2, name: 'Weapons', category: 'props' },
  { id: 3, name: 'Transport', category: 'vehicles' },
  { id: 4, name: 'Furniture & Decor', category: 'furniture' },
  { id: 5, name: 'Objects', category: 'props' },
  { id: 6, name: 'Nature', category: 'nature' },
  { id: 7, name: 'Animals', category: 'animals' },
  { id: 8, name: 'Buildings', category: 'architecture' },
  { id: 9, name: 'People & Characters', category: 'people' },
  { id: 10, name: 'Scenes & Levels', category: null },
  { id: 11, name: 'Other', category: null },
];
/** The API category to filter by for a store category (null: filtered here). */
function apiCategory(c: StoreCategory): number | null {
  const ids = CATEGORIES.filter((x) => x.category === c).map((x) => x.id);
  return ids.length === 1 ? ids[0] : null;
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** Whether `url` is on one of Poly Pizza's own hosts (the key goes only there). */
export function isPolyPizzaHost(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h === 'poly.pizza' || h.endsWith('.poly.pizza');
  } catch {
    return false;
  }
}

/** A model of the API as a store result (null when it lacks an id or a .glb). */
export function polypizzaResult(m: Json): StoreResult | null {
  const id = str(m.ID) ?? (typeof m.ID === 'number' ? String(m.ID) : null);
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const name = str(m.Title) ?? id;
  const creator = typeof m.Creator === 'string' ? str(m.Creator) : str(obj(m.Creator).Username);
  const spdx = normalizeLicense(str(m.Licence) ?? str(m.License));
  const rawCategory = m.Category;
  const category =
    typeof rawCategory === 'number'
      ? (CATEGORIES.find((c) => c.id === rawCategory)?.category ?? null)
      : (CATEGORIES.find((c) => c.name.toLowerCase() === String(rawCategory ?? '').toLowerCase())?.category ??
        null);
  const tris = m['Tri Count'] ?? m.TriCount;
  const sourceUrl = `https://poly.pizza/m/${id}`;
  return {
    id: `polypizza:${id}`,
    provider: 'polypizza',
    name,
    category,
    tags: Array.isArray(m.Tags) ? m.Tags.filter((t): t is string => typeof t === 'string') : [],
    thumbnail_url: str(m.Thumbnail),
    license: {
      spdx,
      url: licenseUrl(spdx),
      attribution: clip(
        str(m.Attribution) ??
          `"${name}"${creator ? ` by ${creator}` : ''} (${sourceUrl}), licensed under ${spdx}`,
        2000,
      ),
    },
    author: creator ? clip(creator, 400) : null,
    source_url: sourceUrl,
    dimensions_m: null,
    triangles: typeof tris === 'number' && tris > 0 ? Math.round(tris) : null,
    formats: ['glb'],
    downloadable: !!str(m.Download),
  };
}

export class PolyPizzaProvider implements ModelProvider {
  readonly id = 'polypizza' as const;
  readonly name = 'Poly Pizza';

  /** Thumbnails of the models search results listed (no model request per thumbnail). */
  private readonly seen = new SeenThumbnails();

  constructor(private readonly key: string | null) {}

  missingKey(): string | null {
    return this.key ? null : 'POLYPIZZA_API_KEY';
  }

  searchesWithoutKey(): boolean {
    return false;
  }

  private headers(): Record<string, string> {
    if (!this.key)
      throw new ToolError(
        'Poly Pizza answers only with an API key: set POLYPIZZA_API_KEY (poly.pizza/settings/api)',
        'NEEDS_KEY',
      );
    return { 'x-auth-token': this.key };
  }

  private async get(
    url: URL | string,
    what: string,
    env: ProviderEnv,
    maxBytes = MAX_INDEX_BYTES,
  ): Promise<Json> {
    try {
      return obj(
        await storeFetchJson(url, {
          what,
          timeoutMs: env.timeoutMs,
          maxBytes,
          signal: env.signal,
          fetchImpl: env.fetch,
          headers: this.headers(),
        }),
      );
    } catch (err) {
      if (err instanceof StoreUpstreamError && (err.status === 401 || err.status === 403))
        throw new ToolError(`Poly Pizza did not accept POLYPIZZA_API_KEY (HTTP ${err.status})`, 'NEEDS_KEY');
      throw err;
    }
  }

  async search(q: ProviderQuery, env: ProviderEnv): Promise<ProviderPage> {
    const filter = q.category ? apiCategory(q.category) : null;
    const hits: ProviderHit[] = [];
    let end: number | null = q.offset;
    // pages of SEARCH_PAGE results: the page holding the offset first, then the following ones
    let page = Math.floor(q.offset / SEARCH_PAGE);
    let skip = q.offset % SEARCH_PAGE;
    for (let n = 0; n < MAX_REQUESTS && hits.length < q.limit && end !== null; n++, page++, skip = 0) {
      const url = new URL(`${POLYPIZZA_API}/search${q.text ? `/${encodeURIComponent(q.text)}` : ''}`);
      url.searchParams.set('Limit', String(SEARCH_PAGE));
      if (page > 0) url.searchParams.set('Page', String(page));
      if (filter !== null) url.searchParams.set('Category', String(filter));
      const answer = await this.get(url, 'Poly Pizza search', env);
      const results = Array.isArray(answer.results) ? answer.results : [];
      const total = typeof answer.total === 'number' ? answer.total : null;
      const base = page * SEARCH_PAGE;
      for (let i = skip; i < results.length && hits.length < q.limit; i++) {
        const model = polypizzaResult(obj(results[i]));
        if (model) this.seen.remember(model.id.slice('polypizza:'.length), model.thumbnail_url);
        if (!model || (q.category && model.category !== q.category)) continue;
        hits.push({
          model,
          score: relevance(q.words, { name: model.name, tags: model.tags, category: model.category }),
          next: base + i + 1,
        });
      }
      const scanned = hits.length >= q.limit ? hits[hits.length - 1].next : base + results.length;
      const more = results.length === SEARCH_PAGE && (total === null || base + results.length < total);
      end = scanned < base + results.length || more ? scanned : null;
    }
    return { hits, end };
  }

  /** The API's answer for a model (cached 24 h). */
  private async raw(id: string, env: ProviderEnv): Promise<Json> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new NotFoundError(`No Poly Pizza model '${id}'`);
    try {
      const r = await env.cache.json(
        `polypizza/model/${id}`,
        INDEX_TTL_MS,
        (signal) =>
          this.get(`${POLYPIZZA_API}/model/${id}`, `Poly Pizza model ${id}`, { ...env, signal }, 1024 * 1024),
        { signal: env.signal },
      );
      return r.value;
    } catch (err) {
      if (err instanceof StoreUpstreamError && err.status === 404)
        throw new NotFoundError(`No Poly Pizza model '${id}'`);
      throw err;
    }
  }

  private async model(id: string, env: ProviderEnv): Promise<StoreResult> {
    const model = polypizzaResult(await this.raw(id, env));
    if (!model) throw new NotFoundError(`No Poly Pizza model '${id}'`);
    return model;
  }

  async details(id: string, env: ProviderEnv): Promise<ProviderDetails> {
    const raw = await this.raw(id, env);
    const model = polypizzaResult(raw);
    if (!model) throw new NotFoundError(`No Poly Pizza model '${id}'`);
    return { model, description: str(raw.Description), revision: str(raw.Download) ?? undefined };
  }

  async thumbnail(id: string, env: ProviderEnv): Promise<ThumbnailSource | null> {
    const url = this.seen.get(id) ?? (await this.model(id, env)).thumbnail_url;
    if (!url) return null;
    return isPolyPizzaHost(url) ? { url, headers: this.headers() } : { url };
  }

  async plan(id: string, env: ProviderEnv): Promise<DownloadPlan> {
    const headers = this.headers();
    const url = str((await this.raw(id, env)).Download);
    if (!url) throw new ToolError(`Poly Pizza offers no download of model ${id}`, 'NOT_DOWNLOADABLE');
    return {
      format: 'glb',
      main: `${id}.glb`,
      files: [{ path: `${id}.glb`, url }],
      ...(isPolyPizzaHost(url) ? { headers, headersHost: new URL(url).hostname } : {}),
    };
  }
}
