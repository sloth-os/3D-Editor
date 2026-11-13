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
 * Sketchfab (sketchfab.com) through its Data API v3: searching needs no token
 * (/v3/search?type=models&downloadable=true, each model with its own licence), downloading does:
 * /v3/models/<uid>/download with `Authorization: Token <SKETCHFAB_TOKEN>` answers temporary URLs
 * of a .glb (preferred) or of a ZIP archive of the glTF files. Without a token the models are listed
 * with needs_key and store_add answers NEEDS_KEY. Age-restricted models are left out.
 */

export const SKETCHFAB_API = 'https://api.sketchfab.com/v3';
/** Results per search request (the API's maximum). */
const SEARCH_PAGE = 24;
/** Search requests one page may take (a category the API cannot filter thins the answers). */
const MAX_REQUESTS = 4;

/** The store's categories → Sketchfab's (null: filtered here, from the models' categories). */
const CATEGORY_SLUG: Record<StoreCategory, string | null> = {
  people: 'people',
  animals: 'animals-pets',
  furniture: 'furniture-home',
  props: null,
  food: 'food-drink',
  vehicles: 'cars-vehicles',
  nature: 'nature-plants',
  architecture: 'architecture',
  street: 'places-travel',
  sports: 'sports-fitness',
};
/** Sketchfab categories → the store's (the first that maps wins). */
const FROM_SLUG: Record<string, StoreCategory> = {
  people: 'people',
  'animals-pets': 'animals',
  'furniture-home': 'furniture',
  'food-drink': 'food',
  'cars-vehicles': 'vehicles',
  'nature-plants': 'nature',
  architecture: 'architecture',
  'places-travel': 'street',
  'sports-fitness': 'sports',
  'electronics-gadgets': 'props',
  'fashion-style': 'props',
  music: 'props',
  'science-technology': 'props',
  'weapons-military': 'props',
  'art-abstract': 'props',
  'cultural-heritage-history': 'props',
};

/** Sketchfab licences by label and slug (search results carry the label and uid only). */
const LICENSES: { slug: string; label: string; spdx: string }[] = [
  { slug: 'cc0', label: 'CC0 Public Domain', spdx: 'CC0-1.0' },
  { slug: 'by', label: 'CC Attribution', spdx: 'CC-BY-4.0' },
  { slug: 'by-sa', label: 'CC Attribution-ShareAlike', spdx: 'CC-BY-SA-4.0' },
  { slug: 'by-nd', label: 'CC Attribution-NoDerivs', spdx: 'CC-BY-ND-4.0' },
  { slug: 'by-nc', label: 'CC Attribution-NonCommercial', spdx: 'CC-BY-NC-4.0' },
  { slug: 'by-nc-sa', label: 'CC Attribution-NonCommercial-ShareAlike', spdx: 'CC-BY-NC-SA-4.0' },
  { slug: 'by-nc-nd', label: 'CC Attribution-NonCommercial-NoDerivs', spdx: 'CC-BY-NC-ND-4.0' },
  { slug: 'free-st', label: 'Free Standard', spdx: 'LicenseRef-Sketchfab-Free-Standard' },
  { slug: 'st', label: 'Standard', spdx: 'LicenseRef-Sketchfab-Standard' },
  { slug: 'ed', label: 'Editorial', spdx: 'LicenseRef-Sketchfab-Editorial' },
];

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});

/** The SPDX id and URL of a Sketchfab licence object ({uid, label} or {slug, label, url}). */
export function sketchfabLicense(raw: unknown): { spdx: string; url: string | null } {
  const l = obj(raw);
  const slug = str(l.slug);
  const label = str(l.label) ?? str(l.fullName);
  const known = LICENSES.find((x) => x.slug === slug || x.label === label);
  const spdx = known?.spdx ?? normalizeLicense(label);
  const url =
    licenseUrl(spdx) ?? (spdx.startsWith('LicenseRef-Sketchfab') ? 'https://sketchfab.com/licenses' : null);
  return { spdx, url: url ?? str(l.url) };
}

/** The thumbnail closest to 256 px wide (at least 200 when there is one). */
function thumbnailOf(m: Json): string | null {
  const images = Array.isArray(obj(m.thumbnails).images) ? (obj(m.thumbnails).images as unknown[]) : [];
  let best: { url: string; width: number } | null = null;
  for (const raw of images) {
    const i = obj(raw);
    const url = str(i.url);
    const width = typeof i.width === 'number' ? i.width : 0;
    if (!url) continue;
    const score = (w: number) => (w >= 200 ? w - 256 : 10_000 - w);
    if (!best || Math.abs(score(width)) < Math.abs(score(best.width))) best = { url, width };
  }
  return best?.url ?? null;
}

/** A search result (or model) of the API as a store result. */
export function sketchfabResult(m: Json, hasToken: boolean): StoreResult | null {
  const uid = str(m.uid);
  if (!uid || !/^[a-f0-9]{32}$/i.test(uid) || m.isAgeRestricted === true) return null;
  const name = str(m.name) ?? uid;
  const user = obj(m.user);
  const author = str(user.displayName) ?? str(user.username);
  const { spdx, url } = sketchfabLicense(m.license);
  const sourceUrl = str(m.viewerUrl) ?? `https://sketchfab.com/3d-models/${uid}`;
  const categories = Array.isArray(m.categories)
    ? m.categories.map((c) => str(obj(c).slug) ?? str(obj(c).name)).filter((c): c is string => !!c)
    : [];
  const archives = obj(m.archives);
  return {
    id: `sketchfab:${uid}`,
    provider: 'sketchfab',
    name,
    category: categories.map((c) => FROM_SLUG[c]).find(Boolean) ?? null,
    tags: Array.isArray(m.tags)
      ? m.tags.map((t) => str(obj(t).name) ?? str(t)).filter((t): t is string => !!t)
      : [],
    thumbnail_url: thumbnailOf(m),
    license: {
      spdx,
      url,
      attribution: clip(
        `"${name}"${author ? ` by ${author}` : ''} (${sourceUrl}), licensed under ${spdx}`,
        2000,
      ),
    },
    author: author ? clip(author, 400) : null,
    source_url: sourceUrl,
    dimensions_m: null,
    triangles: typeof m.faceCount === 'number' && m.faceCount > 0 ? m.faceCount : null,
    formats: archives.glb || !Object.keys(archives).length ? ['glb'] : ['gltf'],
    downloadable: m.isDownloadable !== false,
    ...(hasToken ? {} : { needs_key: 'SKETCHFAB_TOKEN' }),
  };
}

export class SketchfabProvider implements ModelProvider {
  readonly id = 'sketchfab' as const;
  readonly name = 'Sketchfab';

  /** Thumbnails of the models search results listed (no model request per thumbnail). */
  private readonly seen = new SeenThumbnails();

  constructor(private readonly token: string | null) {}

  missingKey(): string | null {
    return this.token ? null : 'SKETCHFAB_TOKEN';
  }

  searchesWithoutKey(): boolean {
    return true;
  }

  async search(q: ProviderQuery, env: ProviderEnv): Promise<ProviderPage> {
    const slug = q.category ? CATEGORY_SLUG[q.category] : null;
    const hits: ProviderHit[] = [];
    let offset = q.offset;
    let end: number | null = offset;
    for (let n = 0; n < MAX_REQUESTS && hits.length < q.limit && end !== null; n++) {
      const url = new URL(`${SKETCHFAB_API}/search`);
      url.searchParams.set('type', 'models');
      url.searchParams.set('downloadable', 'true');
      if (q.text) url.searchParams.set('q', q.text);
      if (slug) url.searchParams.set('categories', slug);
      url.searchParams.set('count', String(SEARCH_PAGE));
      if (offset > 0) url.searchParams.set('cursor', String(offset));
      const page = obj(
        await storeFetchJson(url, {
          what: 'Sketchfab search',
          timeoutMs: env.timeoutMs,
          maxBytes: MAX_INDEX_BYTES,
          signal: env.signal,
          fetchImpl: env.fetch,
        }),
      );
      const results = Array.isArray(page.results) ? page.results : [];
      results.forEach((raw, i) => {
        if (hits.length >= q.limit) return;
        const model = sketchfabResult(obj(raw), !!this.token);
        if (model) this.seen.remember(model.id.slice('sketchfab:'.length), model.thumbnail_url);
        if (!model || (q.category && model.category !== q.category)) return;
        hits.push({
          model,
          score: relevance(q.words, { name: model.name, tags: model.tags, category: model.category }),
          next: offset + i + 1,
        });
      });
      // the API's cursor is the offset of the next page (a non-numeric one cannot be resumed)
      const next = str(obj(page.cursors).next);
      const nextOffset = next !== null && /^\d+$/.test(next) ? Number(next) : null;
      if (hits.length >= q.limit) {
        end = hits[hits.length - 1].next < offset + results.length ? hits[hits.length - 1].next : nextOffset;
        break;
      }
      end = results.length && nextOffset !== null && nextOffset > offset ? nextOffset : null;
      if (end !== null) offset = end;
    }
    return { hits, end };
  }

  private async model(uid: string, env: ProviderEnv): Promise<Json> {
    if (!/^[a-f0-9]{32}$/i.test(uid)) throw new NotFoundError(`No Sketchfab model '${uid}'`);
    try {
      const r = await env.cache.json(
        `sketchfab/model/${uid}`,
        INDEX_TTL_MS,
        (signal) =>
          storeFetchJson(`${SKETCHFAB_API}/models/${uid}`, {
            what: `Sketchfab model ${uid}`,
            timeoutMs: env.timeoutMs,
            maxBytes: 4 * 1024 * 1024,
            signal,
            fetchImpl: env.fetch,
          }),
        { signal: env.signal },
      );
      return obj(r.value);
    } catch (err) {
      if (err instanceof StoreUpstreamError && err.status === 404)
        throw new NotFoundError(`No Sketchfab model '${uid}'`);
      throw err;
    }
  }

  async details(uid: string, env: ProviderEnv): Promise<ProviderDetails> {
    const m = await this.model(uid, env);
    const model = sketchfabResult(m, !!this.token);
    if (!model) throw new NotFoundError(`No Sketchfab model '${uid}' (or it is age-restricted)`);
    return {
      model,
      description: str(m.description) ? clip(str(m.description)!, 4000) : null,
      revision: str(m.updatedAt) ?? undefined,
    };
  }

  async thumbnail(uid: string, env: ProviderEnv): Promise<ThumbnailSource | null> {
    const url = this.seen.get(uid) ?? thumbnailOf(await this.model(uid, env));
    return url ? { url } : null;
  }

  async plan(uid: string, env: ProviderEnv): Promise<DownloadPlan> {
    const details = await this.details(uid, env);
    if (!details.model.downloadable)
      throw new ToolError(
        `Sketchfab model ${uid} cannot be downloaded (its author did not allow it)`,
        'NOT_DOWNLOADABLE',
      );
    if (!this.token)
      throw new ToolError(
        'Downloading Sketchfab models needs an API token: set SKETCHFAB_TOKEN (sketchfab.com → Settings → Password & API)',
        'NEEDS_KEY',
      );
    let links: Json;
    try {
      // temporary URLs (minutes): never cached
      links = obj(
        await storeFetchJson(`${SKETCHFAB_API}/models/${uid}/download`, {
          what: `the download of Sketchfab model ${uid}`,
          timeoutMs: env.timeoutMs,
          maxBytes: 1024 * 1024,
          signal: env.signal,
          fetchImpl: env.fetch,
          headers: { authorization: `Token ${this.token}` },
        }),
      );
    } catch (err) {
      if (err instanceof StoreUpstreamError && err.status === 401)
        throw new ToolError(
          'Sketchfab did not accept SKETCHFAB_TOKEN (HTTP 401): check the token',
          'NEEDS_KEY',
        );
      if (err instanceof StoreUpstreamError && err.status === 403)
        throw new ToolError(`Sketchfab model ${uid} cannot be downloaded (HTTP 403)`, 'NOT_DOWNLOADABLE');
      if (err instanceof StoreUpstreamError && err.status === 404)
        throw new NotFoundError(`No Sketchfab model '${uid}'`);
      throw err;
    }
    const glb = obj(links.glb);
    const gltf = obj(links.gltf);
    if (str(glb.url))
      return {
        format: 'glb',
        main: `${uid}.glb`,
        files: [
          { path: `${uid}.glb`, url: str(glb.url)!, bytes: typeof glb.size === 'number' ? glb.size : null },
        ],
      };
    if (str(gltf.url))
      return {
        format: 'gltf',
        main: '',
        files: [],
        archive: { url: str(gltf.url)!, bytes: typeof gltf.size === 'number' ? gltf.size : null },
      };
    throw new ToolError(`Sketchfab offers no glTF download of model ${uid}`, 'NOT_DOWNLOADABLE');
  }
}
