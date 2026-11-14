import type { StoreCategory, StoreResult } from '@3d-editor/core';
import type { StoreProviderId } from '../../config';
import type { Log } from '../../observability/log';
import type { ModelCache } from '../cache';

/*
 * What every model store provider implements (builtin, khronos, polyhaven, sketchfab, polypizza,
 * catalog). Providers know nothing of each other: the store asks them in parallel (search.ts merges
 * their pages), downloads what their plans list (download.ts) and caches everything (cache.ts).
 */

/**
 * A model as a search lists it: the store result, and for a built-in model that takes parameters
 * its own (store.add `params`) as JSON schema properties.
 */
export interface ProviderModel extends StoreResult {
  params?: Record<string, unknown>;
}

/** Details of a model beyond its search result. */
export interface ProviderDetails {
  model: StoreResult;
  description: string | null;
  /** The model's own parameters (built-in models: their JSON schema properties). */
  params?: Record<string, unknown>;
  /**
   * A revision of the model's files (part of the download cache key: a model whose files changed
   * upstream downloads again).
   */
  revision?: string;
}

/** What a provider works with. */
export interface ProviderEnv {
  /** fetch of public servers (loopback, private and link-local hosts refused: http.ts guardedFetch). */
  fetch: typeof fetch;
  /**
   * fetch that may also reach `origin` whatever its address: an origin the administrator configured
   * (a catalog's, STORE_CATALOG_URLS). Absent: `fetch` serves.
   */
  fetchTrusting?(origin: string): typeof fetch;
  /** STORE_FETCH_TIMEOUT_MS: each request's time to its headers and between two body chunks. */
  timeoutMs: number;
  cache: ModelCache;
  log: Log;
  /** The search or request this work is for went away (or timed out). */
  signal?: AbortSignal;
}

/** A page request (offsets count the provider's own results in its own order). */
export interface ProviderQuery {
  /** The query as typed (trimmed). */
  text: string;
  /** Its words (see relevance.ts queryWords). */
  words: string[];
  category: StoreCategory | null;
  offset: number;
  limit: number;
}

export interface ProviderHit {
  model: ProviderModel;
  /** relevance.ts score (merging across providers). */
  score: number;
  /** The offset that continues after this hit. */
  next: number;
}

export interface ProviderPage {
  hits: ProviderHit[];
  /** The offset after the whole page; null when the provider has nothing more. */
  end: number | null;
  /** Something the user should know (an index used past its age because the provider failed …). */
  note?: string | null;
}

/** A file of a download plan. */
export interface PlannedFile {
  /** Path of the file in the model (relative, forward slashes; the main file's name for it). */
  path: string;
  url: string;
  /** Size the provider announced (checked before and while downloading), when it did. */
  bytes?: number | null;
  /** MD5 the provider announced (checked after downloading). */
  md5?: string | null;
}

/** How to download a model: its files, or a ZIP archive holding them. */
export interface DownloadPlan {
  format: 'glb' | 'gltf' | 'obj';
  /** Path of the main file. */
  main: string;
  /** The files (main first). Empty with `archive`. */
  files: PlannedFile[];
  /**
   * Read the main glTF (or OBJ) after downloading it and fetch the buffers, images (or material
   * libraries and textures) it names, relative to its URL: for sources that do not list them.
   */
  discover?: boolean;
  /** A ZIP archive with the model (the main file is found in it: .gltf, else .glb, else .obj). */
  archive?: { url: string; bytes?: number | null };
  /** Headers of the downloads (only sent to `headersHost`). */
  headers?: Record<string, string>;
  headersHost?: string;
  /**
   * An origin the administrator configured (a catalog's own) that this download may reach whatever
   * its address (see ProviderEnv.fetchTrusting); every other host must be public.
   */
  trustedOrigin?: string;
}

/** Where a thumbnail is fetched from. */
export interface ThumbnailSource {
  url: string;
  headers?: Record<string, string>;
  /** As DownloadPlan.trustedOrigin. */
  trustedOrigin?: string;
}

export interface ModelProvider {
  readonly id: StoreProviderId;
  /** Display name. */
  readonly name: string;
  /** The setting a download needs and the server lacks (e.g. SKETCHFAB_TOKEN), else null. */
  missingKey(): string | null;
  /** Whether searching works without that setting (Sketchfab: yes; Poly Pizza: no). */
  searchesWithoutKey(): boolean;
  search(q: ProviderQuery, env: ProviderEnv): Promise<ProviderPage>;
  /** A model by its provider-local id (NOT_FOUND when unknown). */
  details(id: string, env: ProviderEnv): Promise<ProviderDetails>;
  /** Where its thumbnail is (null: none; built-in thumbnails are rendered, not fetched). */
  thumbnail(id: string, env: ProviderEnv): Promise<ThumbnailSource | null>;
  /** How to download it (NOT_DOWNLOADABLE / NEEDS_KEY when it cannot be). */
  plan(id: string, env: ProviderEnv): Promise<DownloadPlan>;
  /**
   * Checks a model's own parameters (store.add `params`) by the model's schema: INVALID_PARAMS
   * saying what is wrong and which parameters the model takes. Providers without it have models
   * that take none (built by code: the built-in models only).
   */
  checkParams?(id: string, params: Record<string, unknown>): void;
}

/** 24 hours: how long provider indexes and API answers are reused. */
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest index or API answer (JSON) read. */
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;
/** Largest thumbnail fetched. */
export const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/**
 * Thumbnail URLs of a provider's models as its search results gave them (the latest `max`, each
 * for `ttlMs`), so the thumbnails of a page of results cost no request to the provider's API (nor
 * a cached answer on disk) per model: only a model nobody listed lately is looked up.
 */
export class SeenThumbnails {
  private readonly urls = new Map<string, { url: string; until: number }>();

  constructor(
    private readonly max = 5000,
    private readonly ttlMs = INDEX_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  remember(id: string, url: string | null): void {
    if (!url) return;
    this.urls.delete(id);
    this.urls.set(id, { url, until: this.now() + this.ttlMs });
    for (const oldest of this.urls.keys()) {
      if (this.urls.size <= this.max) break;
      this.urls.delete(oldest);
    }
  }

  get(id: string): string | null {
    const seen = this.urls.get(id);
    if (!seen) return null;
    if (seen.until <= this.now()) {
      this.urls.delete(id);
      return null;
    }
    return seen.url;
  }
}

/** The page of `ranked` (the provider's results in its order) from `q.offset`. */
export function pageOf(
  ranked: readonly { model: StoreResult; score: number }[],
  q: ProviderQuery,
): ProviderPage {
  const hits = ranked.slice(q.offset, q.offset + q.limit).map((r, i) => ({
    model: r.model,
    score: r.score,
    next: q.offset + i + 1,
  }));
  const end = q.offset + hits.length;
  return { hits, end: end < ranked.length ? end : null };
}
