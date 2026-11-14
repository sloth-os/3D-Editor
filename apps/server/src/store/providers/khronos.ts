import type { StoreResult } from '@3d-editor/core';
import { NotFoundError, ToolError } from '../../mcp/agent';
import { guessCategory } from '../categories';
import { storeFetchJson } from '../http';
import { UNKNOWN_LICENSE, clip, licenseUrl, mostRestrictive, normalizeLicense } from '../licenses';
import { relevance, words } from '../relevance';
import {
  INDEX_TTL_MS,
  MAX_INDEX_BYTES,
  type DownloadPlan,
  type ModelProvider,
  type ProviderDetails,
  type ProviderEnv,
  type ProviderPage,
  type ProviderQuery,
  type ThumbnailSource,
} from './types';

/*
 * The Khronos glTF sample models (github.com/KhronosGroup/glTF-Sample-Assets), read from GitHub's
 * raw file server: Models/model-index.json lists them (label, name, screenshot, tags, variants);
 * each model's Models/<name>/metadata.json holds its licences (legal[]: spdx/license, licenseUrl,
 * artist, owner, year, what) and a summary, read for the results a search shows (cached for a day,
 * on disk too). A model of several parts carries the most restrictive licence of them and the
 * attribution names every part's artist and owner; logos listed as legal entries (licence
 * LicenseRef-LegalMark-…, artist "Non-copyrightable logo") are trademark notices, not licences of
 * the model: the attribution says the model contains them. Technical test scenes (by name, see
 * TEST_SCENES) and models without a variant core imports (only Draco, Meshopt or KTX compressed)
 * are left out. Downloads prefer the glTF-Binary variant (one .glb file).
 */

export const KHRONOS_BASE = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/';
export const KHRONOS_INDEX_URL = `${KHRONOS_BASE}model-index.json`;
const KHRONOS_PAGE = 'https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/';
/** GitHub's page of the repository's files (licence texts are linked there, readable). */
const KHRONOS_FILES = 'https://github.com/KhronosGroup/glTF-Sample-Assets/blob/main/Models/';

/**
 * The repository's technical test scenes, by name: feature tests, comparison grids, material
 * spheres and minimal assets (a box, a triangle, a rigged test figure) made to check how a viewer
 * handles a glTF feature, not objects a scene would use. The index's tags cannot tell them apart:
 * 'core' means a model uses only core glTF features and 'testing' is on most real-world models too
 * (Avocado, Duck, Fox, Lantern, BoomBox, CesiumMilkTruck are tagged core and testing).
 */
const TEST_SCENES: readonly RegExp[] = [
  // feature tests and their grids (AlphaBlendModeTest … TransmissionThinwallTestGrid, IORTestGrid)
  /Test(Grid)?$/,
  // material comparisons, sphere grids and minimal assets
  /^Compare[A-Z]/,
  /Spheres/,
  /^Simple[A-Z]/,
  /^(Box|Cube|Triangle)([A-Z ]|$)/,
  /Cube$/,
  /Visibility$/,
  /^(Node|Mesh|Morph|Multi)[A-Z]/,
  /^Rigged[A-Z]/,
  // KHR_animation_pointer demos (PotOfCoalsAnimationPointer is a copy of PotOfCoals)
  /AnimationPointer/,
  /^(AnimatedTriangle|BoomBoxWithAxes|Cameras|CarbonFibre|ClearCoatCarPaint|ClearcoatWicker|DirectionalLight|LightsPunctualLamp|MultipleScenes|RecursiveSkeletons|SpecGlossVsMetalRough|TwoSidedPlane|USDShaderBallForGltf)$/,
];

/** Whether `name` is one of the repository's technical test scenes (see TEST_SCENES). */
export function isKhronosTestScene(name: string): boolean {
  return TEST_SCENES.some((re) => re.test(name));
}

/** Variants core imports, preferred first (one file; one file with embedded data; several files). */
const VARIANTS = ['glTF-Binary', 'glTF-Embedded', 'glTF'] as const;
/** Tags that say nothing about what a model shows (left out of the search words). */
const META_TAGS: ReadonlySet<string> = new Set([
  'test',
  'testing',
  'core',
  'pbrtest',
  'issues',
  'showcase',
  'video',
  'extension',
  'written',
]);
/** metadata.json files read at the same time for a page of search results. */
const METADATA_AT_ONCE = 8;

interface IndexModel {
  name: string;
  label: string;
  screenshot: string | null;
  tags: string[];
  variant: (typeof VARIANTS)[number];
  file: string;
}

interface Legal {
  spdx: string;
  url: string | null;
  artist: string | null;
  owner: string | null;
  year: string | null;
  what: string | null;
  /** A trademark notice (a logo the model shows), not a licence of the model. */
  trademark: boolean;
}

interface Metadata {
  legal: Legal[];
  summary: string | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The usable models of model-index.json (invalid entries and technical test scenes left out). */
export function parseKhronosIndex(raw: unknown): IndexModel[] {
  if (!Array.isArray(raw)) throw new ToolError('the Khronos model index is not a list', 'UPSTREAM');
  const out: IndexModel[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const name = str(r.name);
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name) || isKhronosTestScene(name)) continue;
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [];
    const variants =
      r.variants && typeof r.variants === 'object' ? (r.variants as Record<string, unknown>) : {};
    const variant = VARIANTS.find(
      (v) => typeof variants[v] === 'string' && /^[^/\\]+$/.test(variants[v] as string),
    );
    if (!variant) continue;
    out.push({
      name,
      label: str(r.label) ?? name,
      screenshot: str(r.screenshot),
      tags,
      variant,
      file: variants[variant] as string,
    });
  }
  return out;
}

/**
 * The licences and summary of a metadata.json. `model` (the model's name) resolves the licence URLs
 * the file gives relative to itself ('../../LICENSES/…') to the repository's pages; without it they
 * are left out.
 */
export function parseKhronosMetadata(raw: unknown, model?: string): Metadata {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = model ? `${KHRONOS_FILES}${encodeURIComponent(model)}/metadata.json` : null;
  const legal: Legal[] = [];
  for (const l of Array.isArray(r.legal) ? r.legal : []) {
    if (!l || typeof l !== 'object') continue;
    const x = l as Record<string, unknown>;
    const name = str(x.spdx) ?? str(x.license);
    const artist = str(x.artist);
    let url: string | null = null;
    const rawUrl = str(x.licenseUrl);
    if (rawUrl)
      try {
        const u = base ? new URL(rawUrl, base) : new URL(rawUrl);
        url = u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
      } catch {
        url = null;
      }
    legal.push({
      spdx: normalizeLicense(name),
      url,
      artist,
      owner: str(x.owner),
      year: str(x.year) ?? (typeof x.year === 'number' ? String(x.year) : null),
      what: str(x.what),
      trademark:
        /^LicenseRef-LegalMark-/i.test(name ?? '') || /^(non-)?copyrightable logo$/i.test(artist ?? ''),
    });
  }
  return { legal, summary: str(r.summary) };
}

/** Licence, attribution and author of a model from its metadata. */
export function khronosLicense(
  label: string,
  meta: Metadata,
): { license: StoreResult['license']; author: string | null } {
  const rights = meta.legal.filter((l) => !l.trademark);
  const marks = meta.legal.filter((l) => l.trademark);
  const strict = mostRestrictive(rights);
  const parts = rights.map((l) => {
    const who = l.artist ?? l.owner ?? 'unknown artist';
    const owner = l.owner && l.owner !== l.artist ? ` (© ${l.year ? `${l.year} ` : ''}${l.owner})` : '';
    return `${l.what ? `${l.what}: ` : ''}${who}${owner}, ${l.spdx}`;
  });
  const trademarks = marks.length
    ? ` Contains trademarks: ${marks.map((l) => `${l.what ?? 'a logo'}${l.owner ? ` (${l.owner})` : ''}`).join(', ')}.`
    : '';
  const artists = [...new Set(rights.map((l) => l.artist ?? l.owner).filter((a): a is string => !!a))];
  if (!strict)
    return {
      license: {
        spdx: UNKNOWN_LICENSE,
        url: null,
        attribution: trademarks ? clip(`"${label}", Khronos glTF Sample Assets.${trademarks}`, 2000) : null,
      },
      author: null,
    };
  return {
    license: {
      spdx: strict.spdx,
      url: licenseUrl(strict.spdx) ?? strict.url,
      attribution: clip(`"${label}", Khronos glTF Sample Assets. ${parts.join('; ')}.${trademarks}`, 2000),
    },
    author: artists.length ? clip(artists.join(', '), 400) : null,
  };
}

/** `fn` over `items`, at most `n` at a time, results in order. */
async function mapLimited<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const segment = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export class KhronosProvider implements ModelProvider {
  readonly id = 'khronos' as const;
  readonly name = 'Khronos glTF sample models';

  missingKey(): string | null {
    return null;
  }

  searchesWithoutKey(): boolean {
    return true;
  }

  private async index(env: ProviderEnv): Promise<{ models: IndexModel[]; note: string | null }> {
    const r = await env.cache.json(
      'khronos/model-index',
      INDEX_TTL_MS,
      async (signal) =>
        parseKhronosIndex(
          await storeFetchJson(KHRONOS_INDEX_URL, {
            what: 'the Khronos model index',
            timeoutMs: env.timeoutMs,
            maxBytes: MAX_INDEX_BYTES,
            signal,
            fetchImpl: env.fetch,
          }),
        ),
      { signal: env.signal },
    );
    return {
      models: r.value,
      note: r.stale ? `using the model index from ${new Date(r.fetchedAt).toISOString()} (${r.stale})` : null,
    };
  }

  private async model(id: string, env: ProviderEnv): Promise<IndexModel> {
    const { models } = await this.index(env);
    const m = models.find((x) => x.name === id);
    if (!m) throw new NotFoundError(`No Khronos sample model '${id}' (store_search lists the models)`);
    return m;
  }

  private async metadata(m: IndexModel, env: ProviderEnv): Promise<Metadata> {
    const r = await env.cache.json(
      `khronos/meta/${m.name}`,
      INDEX_TTL_MS,
      async (signal) =>
        parseKhronosMetadata(
          await storeFetchJson(`${KHRONOS_BASE}${encodeURIComponent(m.name)}/metadata.json`, {
            what: `the licence of Khronos model ${m.name}`,
            timeoutMs: env.timeoutMs,
            maxBytes: 1024 * 1024,
            signal,
            fetchImpl: env.fetch,
          }),
          m.name,
        ),
      { signal: env.signal },
    );
    return r.value;
  }

  private result(m: IndexModel, meta: Metadata | null): StoreResult {
    const legal = meta ? khronosLicense(m.label, meta) : null;
    return {
      id: `khronos:${m.name}`,
      provider: 'khronos',
      name: m.label,
      // from the label alone: a search's order must not change when licences arrive
      category: guessCategory(m.label),
      tags: [...m.tags],
      thumbnail_url: m.screenshot
        ? `${KHRONOS_BASE}${encodeURIComponent(m.name)}/${segment(m.screenshot)}`
        : null,
      license: legal?.license ?? { spdx: UNKNOWN_LICENSE, url: null, attribution: null },
      author: legal?.author ?? null,
      source_url: `${KHRONOS_PAGE}${encodeURIComponent(m.name)}`,
      dimensions_m: null,
      triangles: null,
      formats: [m.variant === 'glTF-Binary' ? 'glb' : 'gltf'],
      downloadable: true,
    };
  }

  async search(q: ProviderQuery, env: ProviderEnv): Promise<ProviderPage> {
    const { models, note } = await this.index(env);
    // ranked by what the index says (the same order for every page of a search)
    const ranked: { m: IndexModel; score: number }[] = [];
    for (const m of models) {
      const category = guessCategory(m.label);
      if (q.category && category !== q.category) continue;
      const score = relevance(q.words, {
        // the label, the name as one word ('boombox') and as its words ('boom box')
        name: `${m.label} ${m.name} ${words(m.name.replace(/([a-z])([A-Z])/g, '$1 $2')).join(' ')}`,
        tags: m.tags.filter((t) => !META_TAGS.has(t.toLowerCase())),
        category,
      });
      if (q.words.length && score <= 0) continue;
      ranked.push({ m, score });
    }
    // best first; the index's (alphabetical) order for equal scores and empty queries
    ranked.sort((a, b) => b.score - a.score);
    const page = ranked.slice(q.offset, q.offset + q.limit);
    // the licences of the page's models (cached for a day; a model whose metadata does not arrive
    // before the search's deadline shows NOASSERTION this time, the load goes on for the next)
    const metas = await mapLimited(page, METADATA_AT_ONCE, (r) => this.metadata(r.m, env).catch(() => null));
    const hits = page.map((r, i) => ({
      model: this.result(r.m, metas[i]),
      score: r.score,
      next: q.offset + i + 1,
    }));
    const end = q.offset + hits.length;
    return { hits, end: end < ranked.length ? end : null, note };
  }

  async details(id: string, env: ProviderEnv): Promise<ProviderDetails> {
    const m = await this.model(id, env);
    const meta = await this.metadata(m, env);
    return { model: this.result(m, meta), description: meta.summary, revision: `${m.variant}/${m.file}` };
  }

  async thumbnail(id: string, env: ProviderEnv): Promise<ThumbnailSource | null> {
    const m = await this.model(id, env);
    const url = this.result(m, null).thumbnail_url;
    return url ? { url } : null;
  }

  async plan(id: string, env: ProviderEnv): Promise<DownloadPlan> {
    const m = await this.model(id, env);
    const url = `${KHRONOS_BASE}${encodeURIComponent(m.name)}/${m.variant}/${encodeURIComponent(m.file)}`;
    return {
      format: m.variant === 'glTF-Binary' ? 'glb' : 'gltf',
      main: m.file,
      files: [{ path: m.file, url }],
      discover: m.variant === 'glTF',
    };
  }
}
