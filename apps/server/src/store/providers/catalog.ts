import type { StoreResult } from '@3d-editor/core';
import { z } from 'zod';
import { NotFoundError, ToolError } from '../../mcp/agent';
import { asCategory, guessCategory } from '../categories';
import { storeFetchJson } from '../http';
import { UNKNOWN_LICENSE, clip, licenseUrl, normalizeLicense } from '../licenses';
import { relevance } from '../relevance';
import { safeArchivePath } from '../zip';
import {
  INDEX_TTL_MS,
  MAX_INDEX_BYTES,
  pageOf,
  type DownloadPlan,
  type ModelProvider,
  type PlannedFile,
  type ProviderDetails,
  type ProviderEnv,
  type ProviderPage,
  type ProviderQuery,
  type ThumbnailSource,
} from './types';

/*
 * JSON model catalogs (STORE_CATALOG_URLS, comma-separated): a team publishes its own models as a
 * JSON file next to them. URLs in a catalog may be absolute or relative to the catalog file (and
 * glTF parts relative to the .gltf). Format (version 1):
 *
 *   {
 *     "version": 1,
 *     "name": "Studio props",
 *     "models": [
 *       {
 *         "id": "red-chair",                       letters, digits, '_' and '-' (unique per catalog)
 *         "name": "Red chair",
 *         "category": "furniture",                 a store category (optional: guessed)
 *         "tags": ["chair", "red"],                optional
 *         "description": "…",                      optional
 *         "thumbnail": "thumbs/red-chair.png",     optional (PNG, JPEG, GIF or WebP)
 *         "license": { "spdx": "CC-BY-4.0", "url": "…", "attribution": "Red chair by Ann" },
 *         "author": "Ann",                         optional
 *         "source_url": "https://…",               optional
 *         "dimensions_m": [0.5, 0.5, 0.9],         optional: width (X), depth (Y), height (Z)
 *         "triangles": 1200,                       optional
 *         "downloadable": true,                    optional (false: listed, never downloaded)
 *         "files": { "glb": "models/red-chair.glb" }
 *              or { "gltf": "models/lamp/lamp.gltf", "parts": ["lamp.bin", "textures/lamp.png"] }
 *              or { "obj": "models/box/box.obj", "parts": ["box.mtl", "box.png"] }
 *       }
 *     ]
 *   }
 *
 * `parts` may also map paths to URLs ({"lamp.bin": "https://…"}); without `parts` the .gltf/.obj
 * is read after downloading and the files it names (next to it, on its server) are fetched. Store
 * ids are 'catalog:<catalog>.<id>' (the catalog's name as lowercase words joined by '-'). A catalog
 * that fails to load does not stop the others; invalid models are skipped and reported in the
 * provider's status. Without an "attribution" one is written from the name, author, source and
 * licence (the credit a film shows).
 *
 * A catalog may live on the team's own network: its origin (the configured URL's) is reached
 * whatever its address, for its own models only. Every other URL in it must be on a public server
 * (loopback, private and link-local addresses are refused, also after redirects: http.ts
 * guardedFetch), so a catalog's content cannot make the server fetch, and the files route hand
 * back, anything of the server's network.
 */

const MODEL_ID = /^[A-Za-z0-9_-]{1,100}$/;

const licenseSchema = z.object({
  spdx: z.string().min(1).max(64),
  url: z.string().max(2000).nullable().optional(),
  attribution: z.string().max(2000).nullable().optional(),
});
const partsSchema = z.union([
  z.array(z.string().min(1).max(1000)).max(500),
  z.record(z.string(), z.string()),
]);
const filesSchema = z.union([
  z.object({ glb: z.string().min(1).max(2000) }),
  z.object({ gltf: z.string().min(1).max(2000), parts: partsSchema.optional() }),
  z.object({ obj: z.string().min(1).max(2000), parts: partsSchema.optional() }),
]);
const modelSchema = z.object({
  id: z.string().regex(MODEL_ID, 'letters, digits, _ and - (at most 100)'),
  name: z.string().min(1).max(200),
  category: z.string().optional(),
  tags: z.array(z.string().max(100)).max(100).optional(),
  description: z.string().max(4000).optional(),
  thumbnail: z.string().max(2000).optional(),
  license: licenseSchema.optional(),
  author: z.string().max(400).optional(),
  source_url: z.string().max(2000).optional(),
  dimensions_m: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
  triangles: z.number().int().nonnegative().optional(),
  downloadable: z.boolean().optional(),
  files: filesSchema,
});
const catalogSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).max(200),
  models: z.array(z.unknown()).max(20_000),
});

interface CatalogModel {
  /** The catalog's slug. */
  catalog: string;
  /** The catalog's name. */
  catalogName: string;
  /** The catalog's URL (as configured). */
  base: string;
  model: z.infer<typeof modelSchema>;
}

interface LoadedCatalog {
  slug: string;
  url: string;
  name: string;
  models: CatalogModel[];
  /** Models skipped as invalid (first few reasons). */
  skipped: string[];
}

/** A catalog's slug from its name. */
export function catalogSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'catalog'
  );
}

/** Parses a catalog file (throws when it is not a version 1 catalog; skips invalid models). */
export function parseCatalog(raw: unknown, url: string): Omit<LoadedCatalog, 'slug'> {
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success)
    throw new ToolError(
      `the catalog ${url} is not a version 1 model catalog (${parsed.error.issues
        .slice(0, 2)
        .map((i) => `${i.path.join('.') || 'file'}: ${i.message}`)
        .join('; ')})`,
      'UPSTREAM',
    );
  const models: CatalogModel[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  parsed.data.models.forEach((raw, i) => {
    const m = modelSchema.safeParse(raw);
    if (!m.success) {
      if (skipped.length < 1000)
        skipped.push(
          `models[${i}]: ${m.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`,
        );
      return;
    }
    if (seen.has(m.data.id)) {
      skipped.push(`models[${i}]: duplicate id '${m.data.id}'`);
      return;
    }
    seen.add(m.data.id);
    models.push({ catalog: '', catalogName: parsed.data.name, base: url, model: m.data });
  });
  return { url, name: parsed.data.name, models, skipped };
}

/** `ref` resolved against `base` (absolute URLs stay). */
function resolve(ref: string, base: string): string {
  return new URL(ref, base).href;
}

/** `raw` when it is an http(s) URL (a link shown to users), else null. */
function httpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/** The origin of a configured catalog URL (reached whatever its address, for its own models). */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export class CatalogProvider implements ModelProvider {
  readonly id = 'catalog' as const;
  readonly name = 'Model catalogs';

  constructor(private readonly urls: readonly string[]) {}

  missingKey(): string | null {
    return null;
  }

  searchesWithoutKey(): boolean {
    return true;
  }

  /** Every configured catalog (failed ones reported in `notes`). */
  private async catalogs(env: ProviderEnv): Promise<{ catalogs: LoadedCatalog[]; notes: string[] }> {
    const loaded = await Promise.allSettled(
      this.urls.map((url) =>
        env.cache.json(
          `catalog/${url}`,
          INDEX_TTL_MS,
          async (signal) => {
            const origin = originOf(url);
            return parseCatalog(
              await storeFetchJson(url, {
                what: `the model catalog ${url}`,
                timeoutMs: env.timeoutMs,
                maxBytes: MAX_INDEX_BYTES,
                signal,
                fetchImpl: (origin && env.fetchTrusting?.(origin)) || env.fetch,
              }),
              url,
            );
          },
          { signal: env.signal },
        ),
      ),
    );
    const catalogs: LoadedCatalog[] = [];
    const notes: string[] = [];
    const slugs = new Set<string>();
    loaded.forEach((r, i) => {
      if (r.status === 'rejected') {
        notes.push(`${this.urls[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        return;
      }
      const c = r.value.value;
      if (r.value.stale)
        notes.push(
          `${this.urls[i]}: using the copy from ${new Date(r.value.fetchedAt).toISOString()} (${r.value.stale})`,
        );
      if (c.skipped.length)
        notes.push(`${c.name}: ${c.skipped.length} invalid model(s) skipped (${c.skipped[0]})`);
      // unique slugs, in configuration order
      let slug = catalogSlug(c.name);
      for (let n = 2; slugs.has(slug); n++) slug = `${catalogSlug(c.name)}-${n}`;
      slugs.add(slug);
      catalogs.push({
        ...c,
        slug,
        models: c.models.map((m) => ({ ...m, catalog: slug, catalogName: c.name })),
      });
    });
    if (!catalogs.length && notes.length)
      throw new ToolError(`no model catalog loaded: ${notes.join('; ')}`, 'UPSTREAM');
    return { catalogs, notes };
  }

  private result(m: CatalogModel): StoreResult {
    const x = m.model;
    const spdx = x.license ? normalizeLicense(x.license.spdx) : UNKNOWN_LICENSE;
    const format = 'glb' in x.files ? 'glb' : 'gltf' in x.files ? 'gltf' : 'obj';
    let thumbnail: string | null;
    try {
      thumbnail = x.thumbnail ? resolve(x.thumbnail, m.base) : null;
    } catch {
      thumbnail = null;
    }
    const author = x.author?.trim() ? clip(x.author.trim(), 400) : null;
    const source = httpUrl(x.source_url);
    const credit = `"${x.name}"${author ? ` by ${author}` : ''} (${source ?? `model catalog ${m.catalogName}`})${
      spdx === UNKNOWN_LICENSE ? '' : `, licensed under ${spdx}`
    }`;
    return {
      id: `catalog:${m.catalog}.${x.id}`,
      provider: 'catalog',
      name: x.name,
      category: asCategory(x.category) ?? guessCategory(x.name, (x.tags ?? []).join(' ')),
      tags: [...(x.tags ?? [])],
      thumbnail_url: thumbnail,
      license: {
        spdx,
        url: httpUrl(x.license?.url) ?? licenseUrl(spdx),
        attribution: clip(x.license?.attribution?.trim() || credit, 2000),
      },
      author,
      source_url: source,
      dimensions_m: x.dimensions_m ? [...x.dimensions_m] : null,
      triangles: x.triangles ?? null,
      formats: [format],
      downloadable: x.downloadable !== false,
    };
  }

  private async find(id: string, env: ProviderEnv): Promise<CatalogModel> {
    const dot = id.indexOf('.');
    const slug = dot > 0 ? id.slice(0, dot) : '';
    const local = id.slice(dot + 1);
    const { catalogs } = await this.catalogs(env);
    const m = catalogs.find((c) => c.slug === slug)?.models.find((x) => x.model.id === local);
    if (!m) throw new NotFoundError(`No catalog model '${id}' (store_search lists the models)`);
    return m;
  }

  async search(q: ProviderQuery, env: ProviderEnv): Promise<ProviderPage> {
    const { catalogs, notes } = await this.catalogs(env);
    const ranked: { model: StoreResult; score: number }[] = [];
    for (const c of catalogs)
      for (const m of c.models) {
        const model = this.result(m);
        if (q.category && model.category !== q.category) continue;
        const score = relevance(q.words, {
          name: model.name,
          tags: model.tags,
          category: model.category,
          description: m.model.description,
        });
        if (q.words.length && score <= 0) continue;
        ranked.push({ model, score });
      }
    ranked.sort((a, b) => b.score - a.score);
    return { ...pageOf(ranked, q), note: notes.length ? notes.join('; ') : null };
  }

  async details(id: string, env: ProviderEnv): Promise<ProviderDetails> {
    const m = await this.find(id, env);
    const f = m.model.files;
    return {
      model: this.result(m),
      description: m.model.description ?? null,
      revision: JSON.stringify(f),
    };
  }

  async thumbnail(id: string, env: ProviderEnv): Promise<ThumbnailSource | null> {
    const m = await this.find(id, env);
    const url = this.result(m).thumbnail_url;
    return url ? { url, trustedOrigin: originOf(m.base) } : null;
  }

  async plan(id: string, env: ProviderEnv): Promise<DownloadPlan> {
    const m = await this.find(id, env);
    const x = m.model;
    if (x.downloadable === false)
      throw new ToolError(
        `catalog model '${id}' is listed only (its catalog does not allow downloading it)`,
        'NOT_DOWNLOADABLE',
      );
    const files = x.files;
    const mainRef = 'glb' in files ? files.glb : 'gltf' in files ? files.gltf : files.obj;
    const format = 'glb' in files ? 'glb' : 'gltf' in files ? 'gltf' : 'obj';
    let mainUrl: string;
    try {
      mainUrl = resolve(mainRef, m.base);
    } catch {
      throw new ToolError(`catalog model '${id}' has an invalid file URL`, 'UPSTREAM');
    }
    const main = decodeURIComponent(new URL(mainUrl).pathname.split('/').pop() || `${x.id}.${format}`);
    const planned: PlannedFile[] = [{ path: main, url: mainUrl }];
    const parts = 'parts' in files ? files.parts : undefined;
    if (Array.isArray(parts))
      for (const p of parts) {
        const path = safeArchivePath(p);
        if (!path)
          throw new ToolError(`catalog model '${id}': part '${p}' leaves the model's folder`, 'UPSTREAM');
        planned.push({ path, url: resolve(p, mainUrl) });
      }
    else if (parts)
      for (const [p, url] of Object.entries(parts)) {
        const path = safeArchivePath(p);
        if (!path)
          throw new ToolError(`catalog model '${id}': part '${p}' leaves the model's folder`, 'UPSTREAM');
        planned.push({ path, url: resolve(url, mainUrl) });
      }
    return {
      format,
      main,
      files: planned,
      discover: format !== 'glb' && !parts,
      trustedOrigin: originOf(m.base),
    };
  }
}
