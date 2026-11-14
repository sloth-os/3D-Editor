import type { StoreCategory, StoreResult } from '@3d-editor/core';
import { NotFoundError, ToolError } from '../../mcp/agent';
import { storeFetchJson } from '../http';
import { clip, licenseUrl } from '../licenses';
import { relevance } from '../relevance';
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
 * Poly Haven (polyhaven.com, every asset CC0) through its public API: /assets?t=models lists the
 * models (name, categories, tags, authors, polycount, dimensions in millimetres, thumbnail_url,
 * download_count …), /files/<id> their files: the glTF at '1k' textures with its `include` map
 * (the .bin buffer and the textures, each with url, size and md5), downloaded only on insert and
 * passed to core store.insert_files as its files. Requests name the client ('3D-Editor model
 * store'), as Poly Haven asks API users to.
 */

export const POLYHAVEN_API = 'https://api.polyhaven.com';
/** Texture resolutions tried, smallest useful first. */
const RESOLUTIONS = ['1k', '2k', '4k', '8k'];

/** Poly Haven categories → the store's (the first listed category of a model that maps wins). */
const CATEGORY_MAP: Record<string, StoreCategory> = {
  furniture: 'furniture',
  seating: 'furniture',
  table: 'furniture',
  shelves: 'furniture',
  bed: 'furniture',
  food: 'food',
  plants: 'nature',
  'potted plants': 'nature',
  flowers: 'nature',
  trees: 'nature',
  grass: 'nature',
  'ground cover': 'nature',
  nature: 'nature',
  rocks: 'nature',
  succulent: 'nature',
  buildings: 'architecture',
  structures: 'architecture',
  ships: 'vehicles',
  creature: 'animals',
  decorative: 'props',
  lighting: 'props',
  appliances: 'props',
  electronics: 'props',
  containers: 'props',
  dishes: 'props',
  props: 'props',
  tools: 'props',
  books: 'props',
  instrument: 'props',
  office: 'props',
  'wall decoration': 'props',
  vases: 'props',
  weapons: 'props',
  firearms: 'props',
  industrial: 'props',
};
/** Categories that decide before the general ones ('decorative' furniture is furniture). */
const CATEGORY_PRIORITY: readonly StoreCategory[] = [
  'food',
  'vehicles',
  'animals',
  'furniture',
  'architecture',
  'nature',
  'props',
];

interface Asset {
  id: string;
  name: string;
  categories: string[];
  tags: string[];
  authors: string[];
  polycount: number | null;
  dimensions: [number, number, number] | null;
  thumbnail: string | null;
  downloads: number;
  description: string | null;
  filesHash: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];

/** The store category of Poly Haven categories. */
export function polyhavenCategory(categories: readonly string[]): StoreCategory | null {
  const found = new Set(categories.map((c) => CATEGORY_MAP[c.toLowerCase()]).filter(Boolean));
  return CATEGORY_PRIORITY.find((c) => found.has(c)) ?? null;
}

/** The models of an /assets answer (invalid entries left out), most downloaded first. */
export function parsePolyhavenAssets(raw: unknown): Asset[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolError('the Poly Haven asset list is not an object', 'UPSTREAM');
  const out: Asset[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_.-]{1,120}$/.test(id) || !v || typeof v !== 'object') continue;
    const a = v as Record<string, unknown>;
    // type 2: models (the list may hold other types when the query parameter is ignored)
    if (a.type !== undefined && a.type !== 2) continue;
    const dims = Array.isArray(a.dimensions) ? a.dimensions.map(Number) : [];
    out.push({
      id,
      name: str(a.name) ?? id,
      categories: strings(a.categories),
      tags: strings(a.tags),
      authors: a.authors && typeof a.authors === 'object' ? Object.keys(a.authors as object) : [],
      polycount: typeof a.polycount === 'number' && a.polycount > 0 ? Math.round(a.polycount) : null,
      dimensions:
        dims.length === 3 && dims.every((d) => Number.isFinite(d) && d > 0)
          ? [dims[0] / 1000, dims[1] / 1000, dims[2] / 1000]
          : null,
      thumbnail: str(a.thumbnail_url),
      downloads: typeof a.download_count === 'number' ? a.download_count : 0,
      description: str(a.description),
      filesHash: str(a.files_hash),
    });
  }
  return out.sort((x, y) => y.downloads - x.downloads || x.name.localeCompare(y.name));
}

/** The glTF of a /files answer at the smallest resolution from 1k up: main file and includes. */
export function polyhavenGltf(raw: unknown, id: string): { resolution: string; files: PlannedFile[] } {
  const gltf = (raw as { gltf?: Record<string, { gltf?: unknown }> } | null)?.gltf;
  if (!gltf || typeof gltf !== 'object')
    throw new ToolError(`Poly Haven has no glTF of '${id}'`, 'NOT_DOWNLOADABLE');
  const available = Object.keys(gltf).sort((a, b) => parseFloat(a) - parseFloat(b));
  const resolution = RESOLUTIONS.find((r) => gltf[r]?.gltf) ?? available.find((r) => gltf[r]?.gltf);
  const main = resolution ? (gltf[resolution].gltf as Record<string, unknown>) : null;
  const url = str(main?.url);
  if (!resolution || !main || !url)
    throw new ToolError(`Poly Haven has no glTF of '${id}'`, 'NOT_DOWNLOADABLE');
  const mainPath = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? `${id}.gltf`);
  const file = (path: string, f: Record<string, unknown>): PlannedFile | null => {
    const u = str(f.url);
    if (!u) return null;
    return {
      path,
      url: u,
      bytes: typeof f.size === 'number' ? f.size : null,
      md5: str(f.md5),
    };
  };
  const files: PlannedFile[] = [file(mainPath, main)!];
  const include =
    main.include && typeof main.include === 'object' ? (main.include as Record<string, unknown>) : {};
  for (const [path, f] of Object.entries(include)) {
    if (!f || typeof f !== 'object') continue;
    const planned = file(path, f as Record<string, unknown>);
    if (planned) files.push(planned);
  }
  return { resolution, files };
}

export class PolyHavenProvider implements ModelProvider {
  readonly id = 'polyhaven' as const;
  readonly name = 'Poly Haven';

  missingKey(): string | null {
    return null;
  }

  searchesWithoutKey(): boolean {
    return true;
  }

  private async assets(env: ProviderEnv): Promise<{ assets: Asset[]; note: string | null }> {
    const r = await env.cache.json(
      'polyhaven/assets',
      INDEX_TTL_MS,
      async (signal) =>
        parsePolyhavenAssets(
          await storeFetchJson(`${POLYHAVEN_API}/assets?t=models`, {
            what: 'the Poly Haven model list',
            timeoutMs: env.timeoutMs,
            maxBytes: MAX_INDEX_BYTES,
            signal,
            fetchImpl: env.fetch,
          }),
        ),
      { signal: env.signal },
    );
    return {
      assets: r.value,
      note: r.stale ? `using the model list from ${new Date(r.fetchedAt).toISOString()} (${r.stale})` : null,
    };
  }

  private async asset(id: string, env: ProviderEnv): Promise<Asset> {
    const { assets } = await this.assets(env);
    const a = assets.find((x) => x.id === id);
    if (!a) throw new NotFoundError(`No Poly Haven model '${id}' (store_search lists the models)`);
    return a;
  }

  private result(a: Asset): StoreResult {
    const authors = a.authors.join(', ');
    return {
      id: `polyhaven:${a.id}`,
      provider: 'polyhaven',
      name: a.name,
      category: polyhavenCategory(a.categories),
      tags: [...a.tags],
      thumbnail_url:
        a.thumbnail ??
        `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(a.id)}.png?width=256&height=256`,
      license: {
        spdx: 'CC0-1.0',
        url: licenseUrl('CC0-1.0'),
        attribution: clip(
          `"${a.name}"${authors ? ` by ${authors}` : ''}, Poly Haven (polyhaven.com), CC0`,
          2000,
        ),
      },
      author: authors ? clip(authors, 400) : null,
      source_url: `https://polyhaven.com/a/${encodeURIComponent(a.id)}`,
      dimensions_m: a.dimensions,
      triangles: a.polycount,
      formats: ['gltf'],
      downloadable: true,
    };
  }

  async search(q: ProviderQuery, env: ProviderEnv): Promise<ProviderPage> {
    const { assets, note } = await this.assets(env);
    const ranked: { model: StoreResult; score: number }[] = [];
    for (const a of assets) {
      const model = this.result(a);
      if (q.category && model.category !== q.category) continue;
      const score = relevance(q.words, {
        name: a.name,
        tags: [...a.tags, ...a.categories],
        category: model.category,
        description: a.description,
      });
      if (q.words.length && score <= 0) continue;
      ranked.push({ model, score });
    }
    // best first; the most downloaded first among equals (and for empty queries)
    ranked.sort((x, y) => y.score - x.score);
    return { ...pageOf(ranked, q), note };
  }

  async details(id: string, env: ProviderEnv): Promise<ProviderDetails> {
    const a = await this.asset(id, env);
    return { model: this.result(a), description: a.description, revision: a.filesHash ?? undefined };
  }

  async thumbnail(id: string, env: ProviderEnv): Promise<ThumbnailSource | null> {
    const a = await this.asset(id, env);
    return { url: this.result(a).thumbnail_url! };
  }

  async plan(id: string, env: ProviderEnv): Promise<DownloadPlan> {
    const a = await this.asset(id, env);
    const r = await env.cache.json(
      `polyhaven/files/${a.id}`,
      INDEX_TTL_MS,
      (signal) =>
        storeFetchJson(`${POLYHAVEN_API}/files/${encodeURIComponent(a.id)}`, {
          what: `the files of Poly Haven model ${a.id}`,
          timeoutMs: env.timeoutMs,
          maxBytes: 4 * 1024 * 1024,
          signal,
          fetchImpl: env.fetch,
        }),
      { signal: env.signal },
    );
    const { files } = polyhavenGltf(r.value, a.id);
    return { format: 'gltf', main: files[0].path, files };
  }
}
