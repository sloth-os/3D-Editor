import { closeSync, openSync, readSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  BUILTIN_PROVIDER,
  IMPORT_BYTES_PER_IMAGE_BYTE,
  OPERATOR_FIXED_BYTES,
  SAVE_BYTES_PER_IMAGE_BYTE,
  STORE_CATEGORIES,
  createEditorState,
  importEstimate,
  operatorMemoryCheck,
  projectObjects,
  storedMeshBytes,
  withObjects,
  type ImportReader,
  type OperatorEstimate,
  type ReportLevel,
  type SceneDoc,
  type StoreCategory,
  type StoreResult,
} from '@3d-editor/core';
import { NotFoundError, ToolError } from '../mcp/agent';
import type { ServiceContext } from '../services';
import { STORE_PROVIDER_IDS, type ServerConfig, type StoreProviderId } from '../config';
import { errorMessage } from '../observability/tracing';
import { StorageUnavailableError } from '../sync/room-manager';
import { ProjectMemoryError } from '../sync/project-memory';
import { PACKAGE_VERSION } from '../version';
import { ModelCache, type CacheHandle, type CachedFile } from './cache';
import { MAX_MODEL_BYTES, contentTypeFor, downloadPlan } from './download';
import {
  StoreCancelledError,
  StoreUpstreamError,
  dnsResolver,
  guardedFetch,
  isLocalFetch,
  sniffImage,
  storeFetch,
  type HostResolver,
} from './http';
import { clip, licenseNote } from './licenses';
import { queryWords } from './relevance';
import { decodeCursor, encodeCursor, mergePages, searchKey, type CursorOffsets } from './search';
import { THUMBNAIL_SIZE, THUMBNAIL_VERSION, ThumbnailStage, renderBuiltinThumbnail } from './thumbnails';
import { safeArchivePath } from './zip';
import { BuiltinProvider, type BuiltinCatalog } from './providers/builtin';
import { CatalogProvider } from './providers/catalog';
import { KhronosProvider } from './providers/khronos';
import { PolyHavenProvider } from './providers/polyhaven';
import { PolyPizzaProvider } from './providers/polypizza';
import { SketchfabProvider } from './providers/sketchfab';
import {
  MAX_THUMBNAIL_BYTES,
  type ModelProvider,
  type ProviderDetails,
  type ProviderModel,
  type ProviderEnv,
  type ProviderPage,
} from './providers/types';

/*
 * The model store (SPEC §10): the built-in catalog of core and the external providers (Khronos
 * glTF samples, Poly Haven, Sketchfab, Poly Pizza, JSON catalogs; providers/*.ts), searched in
 * parallel (each within STORE_FETCH_TIMEOUT_MS, its state reported per provider) and merged into
 * pages with an opaque cursor (search.ts); provider indexes fetched lazily and cached for 24 hours
 * in memory and on disk; nothing downloaded before an insert (or a request for a model's files);
 * downloads checked and cached on disk under a least-recently-used budget (download.ts, cache.ts);
 * thumbnails proxied and cached, built-in ones rendered once (thumbnails.ts).
 *
 * Inserting runs a core operator (store.add for a built-in model, store.insert_files with the
 * downloaded files for an external one): an agent runs it in its own project (store_add: one step
 * of its undo history, synced live), the REST route in the project's room.
 */

export { STORE_CATEGORIES, type StoreCategory } from '@3d-editor/core';
/** The providers the server knows (STORE_PROVIDERS picks and orders them; defined with the config). */
export { STORE_PROVIDER_IDS, type StoreProviderId } from '../config';

export type StoreFormat = StoreResult['formats'][number];

/** Most results of one search page (store_search `limit`, REST `?limit=`). */
export const MAX_STORE_RESULTS = 50;

/**
 * A model as search lists it (core StoreResult; thumbnail_url is the store's thumbnail route; a
 * built-in model that takes parameters lists them as `params`, JSON schema properties).
 */
export type StoreModel = ProviderModel;

/** One model with what its provider says beyond the search result. */
export interface StoreModelDetails extends StoreModel {
  description: string | null;
  /** What the licence asks of a film the model appears in (null: nothing beyond the credit). */
  license_note: string | null;
  /** The model's own parameters (built-in models: store.add `params`). */
  params?: Record<string, unknown>;
  /**
   * The files an insert uses (paths relative to the main file; the main file first), known once
   * the model was downloaded (details with `download`, a files request or an insert); null before.
   */
  files: { path: string; bytes: number | null }[] | null;
  /** Format and path of the main file (null for built-in models and before the download). */
  format: 'glb' | 'gltf' | 'obj' | null;
  main: string | null;
}

/** How a provider answered (search results and GET /api/store/providers). */
export interface StoreProviderStatus {
  id: string;
  name: string;
  enabled: boolean;
  status: 'ok' | 'error' | 'timeout' | 'disabled' | 'needs_key';
  /** The setting it needs (e.g. POLYPIZZA_API_KEY). */
  needs_key: string | null;
  message: string | null;
}

export interface StoreSearchQuery {
  query?: string;
  category?: StoreCategory;
  /** Provider ids (default: every configured one). */
  providers?: string[];
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string;
}

export interface StoreSearchResult {
  results: StoreModel[];
  providers: StoreProviderStatus[];
  /** Opaque cursor of the next page, or null. */
  next_cursor: string | null;
}

/** Placement and size of an inserted model (core store.add / store.insert_files). */
export interface StoreInsertOptions {
  location?: [number, number, number];
  rotation_deg?: number;
  height_m?: number;
  width_m?: number;
  depth_m?: number;
  name?: string;
  /** Main colour as #rrggbb (built-in models). */
  color?: string;
  /**
   * The model's own parameters (built-in models: store.add `params`, as its search result lists
   * them), checked by the model's schema before anything is inserted.
   */
  params?: Record<string, unknown>;
}

/**
 * The core operator that inserts a model: `store.add` for a built-in model, `store.insert_files`
 * (with the downloaded files as base64) for an external one. An agent runs it in its own project
 * (store_add: one step of its undo history), the REST route in the project's room.
 */
export interface StoreInsertCall {
  operator: 'store.add' | 'store.insert_files';
  params: Record<string, unknown>;
  entry: StoreModel;
  /** Notes for the caller (what the licence asks, options that do not apply). */
  warnings: string[];
}

/** The model an insert's reply credits: the search result's id, name, licence and source. */
export interface StoreInsertEntry {
  id: string;
  provider: string;
  name: string;
  license: StoreModel['license'];
  author: string | null;
  source_url: string | null;
  /** The thumbnail route (absolute in store_add's reply, like store_search's). */
  thumbnail_url: string | null;
}

export interface StoreInsertResult {
  /**
   * What the operator returned: the root object (an EMPTY wrapping the model), its name, its
   * objects and their names, its dimensions_m (its entry and warnings are the reply's own fields).
   */
  result: Record<string, unknown> | null;
  entry: StoreInsertEntry;
  /** The store's notes (what the licence asks …) and the operator's warnings. */
  warnings: string[];
}

/**
 * The reply of an insert (store_add, REST): the operator's result without what the reply carries
 * once (core's store.add returns its catalog entry and its warnings too, which it also reports), the
 * entry as the model's credit, and the warnings. `origin` makes the thumbnail route absolute.
 */
export function insertReply(
  result: unknown,
  entry: StoreModel,
  warnings: readonly string[],
  origin = '',
): StoreInsertResult {
  let rest: Record<string, unknown> | null = null;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const { entry: _entry, warnings: _warnings, ...own } = result as Record<string, unknown>;
    rest = own;
  }
  const thumb = entry.thumbnail_url;
  return {
    result: rest,
    entry: {
      id: entry.id,
      provider: entry.provider,
      name: entry.name,
      license: entry.license,
      author: entry.author,
      source_url: entry.source_url,
      thumbnail_url: thumb && origin && thumb.startsWith('/') ? `${origin}${thumb}` : thumb,
    },
    warnings: [...warnings],
  };
}

/** A file the store serves (thumbnails, cached model files). */
export interface StoreFile {
  data: Uint8Array;
  contentType: string;
  etag: string | null;
}

/** Options of the store's network calls. */
export interface StoreCallOptions {
  /** Stops waiting (the request ended). */
  signal?: AbortSignal;
}

/** Options of {@link ModelStore.prepareInsert}. */
export interface StoreInsertCallOptions extends StoreCallOptions {
  /**
   * The document the model goes into: the server's memory check is asked with the insert's
   * estimate before the downloaded files are read (OUT_OF_MEMORY when it refuses).
   */
  doc?: SceneDoc;
}

/** A cached file of a model, held until `release()` (stream it from `path`). */
export interface StoreFileHandle {
  path: string;
  bytes: number;
  contentType: string;
  etag: string;
  release(): void;
}

/** Options of {@link ModelStore.details}. */
export interface StoreDetailsOptions extends StoreCallOptions {
  /** Download the model's files (cached) so `files` lists them. */
  download?: boolean;
}

/** What a test (or a special deployment) can replace. */
export interface ModelStoreOptions {
  /** Providers by id, replacing the ones built from the configuration. */
  providers?: Partial<Record<StoreProviderId, ModelProvider>>;
  /** The built-in catalog (default: core's). */
  catalog?: BuiltinCatalog;
  /** Most bytes of one model (default 200 MB). */
  maxModelBytes?: number;
  /** How long a search waits for a provider (default: SEARCH_DEADLINE_MS or STORE_FETCH_TIMEOUT_MS). */
  searchDeadlineMs?: number;
  /**
   * Resolves host names for the check that the store fetches only public servers (http.ts
   * guardedFetch). Default: DNS, or none for a fetch marked LOCAL_FETCH (a test's fake answers
   * without the network); null: names are not resolved (addresses are still checked).
   */
  resolveHost?: HostResolver | null;
}

/** Message of a store without configuration (as the phase-0 stub answered). */
const UNAVAILABLE = 'The model store is not available yet on this server.';

/**
 * How long a search waits for a provider (or STORE_FETCH_TIMEOUT_MS when that is shorter): far less
 * than a download may take. At the deadline the provider stops waiting for the network and answers
 * from what it holds (an index past its age), within DEADLINE_GRACE_MS; the loads it started go on
 * in the background (cache.ts), so a later search finds them.
 */
const SEARCH_DEADLINE_MS = 5000;
const DEADLINE_GRACE_MS = 300;
/**
 * A provider that did not answer a search in time is given COOLDOWN_DEADLINE_MS per search for the
 * next COOLDOWN_MS (enough to answer from its cache, e.g. once its index finished loading in the
 * background), so one provider that hangs does not hold up every search.
 */
const COOLDOWN_MS = 60_000;
const COOLDOWN_DEADLINE_MS = 250;

/**
 * Concurrent downloads of models, fetches of thumbnails and renders of built-in thumbnails (one:
 * they share one document, see thumbnails.ts ThumbnailStage).
 */
const MAX_DOWNLOADS = 3;
const MAX_THUMBNAIL_FETCHES = 6;
const MAX_THUMBNAIL_RENDERS = 1;

const PROVIDER_NAMES: Record<StoreProviderId, string> = {
  builtin: 'Built-in models',
  khronos: 'Khronos glTF sample models',
  polyhaven: 'Poly Haven',
  sketchfab: 'Sketchfab',
  polypizza: 'Poly Pizza',
  catalog: 'Model catalogs',
};

/** Origin of the REST route's inserts (no agent: not part of anyone's undo history). */
const REST_ORIGIN = { type: 'store-rest' };

/** A counting semaphore (FIFO; waits end with the caller's signal). */
class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, what = 'request'): Promise<T> {
    if (this.active >= this.max)
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', abort);
          resolve();
        };
        const abort = () => {
          const i = this.queue.indexOf(go);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new StoreCancelledError(what));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        this.queue.push(go);
      });
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

interface Internals {
  config: ServerConfig;
  cache: ModelCache;
  /** Configured providers, in STORE_PROVIDERS order. */
  providers: Map<StoreProviderId, ModelProvider>;
  /** Tie precedence of merged results: built-in first, then STORE_PROVIDERS order. */
  order: StoreProviderId[];
  /** How each provider answered last. */
  last: Map<StoreProviderId, { status: StoreProviderStatus['status']; message: string | null }>;
  /** Providers that did not answer a search in time: until when they get the short deadline. */
  cooldown: Map<StoreProviderId, number>;
  /** Host names to addresses, for the public-servers check (null: not resolved). */
  resolver: HostResolver | null;
  /** The server's fetch for public servers only (every request and redirect checked). */
  publicFetch: typeof fetch;
  downloads: Limiter;
  fetches: Limiter;
  renders: Limiter;
  /** The document built-in thumbnails are rendered in. */
  stage: ThumbnailStage;
}

/** The store's thumbnail route of a model. */
export function thumbnailPath(id: string): string {
  return `/api/store/models/${encodeURIComponent(id).replace(/%3A/gi, ':')}/thumbnail`;
}

/** `model` with the store's thumbnail route as its thumbnail (when it has one). */
function proxied<M extends StoreResult>(model: M): M {
  const has = model.provider === BUILTIN_PROVIDER || !!model.thumbnail_url;
  return { ...model, thumbnail_url: has ? thumbnailPath(model.id) : null };
}

const etagOf = (sha256: string) => `"${sha256.slice(0, 32)}"`;

/** The model store of the server. */
export class ModelStore {
  private internals: Internals | null = null;

  constructor(
    protected readonly ctx: ServiceContext,
    private readonly opts: ModelStoreOptions = {},
  ) {}

  /** Throws UNAVAILABLE for a store built without a configuration (it has nothing to serve). */
  private assertAvailable(): void {
    if (!this.ctx?.config) throw new ToolError(UNAVAILABLE, 'UNAVAILABLE');
  }

  /** The store's state, created on first use (the constructor reads nothing of its context). */
  private get s(): Internals {
    if (this.internals) return this.internals;
    this.assertAvailable();
    const config = this.ctx.config;
    const providers = new Map<StoreProviderId, ModelProvider>();
    for (const id of config.storeProviders) {
      const given = this.opts.providers?.[id];
      providers.set(id, given ?? this.createProvider(id, config));
    }
    const order = [...providers.keys()].sort((a, b) =>
      a === BUILTIN_PROVIDER ? -1 : b === BUILTIN_PROVIDER ? 1 : 0,
    );
    const resolver =
      this.opts.resolveHost !== undefined
        ? this.opts.resolveHost
        : isLocalFetch(this.ctx.fetch)
          ? null
          : dnsResolver();
    this.internals = {
      config,
      cache: new ModelCache({
        dir: config.modelCacheDir,
        maxBytes: config.modelCacheMaxBytes,
        log: this.ctx.log,
      }),
      providers,
      order,
      last: new Map(),
      cooldown: new Map(),
      resolver,
      publicFetch: guardedFetch(this.ctx.fetch, { resolve: resolver }),
      downloads: new Limiter(MAX_DOWNLOADS),
      fetches: new Limiter(MAX_THUMBNAIL_FETCHES),
      renders: new Limiter(MAX_THUMBNAIL_RENDERS),
      stage: new ThumbnailStage(),
    };
    return this.internals;
  }

  private createProvider(id: StoreProviderId, config: ServerConfig): ModelProvider {
    switch (id) {
      case 'builtin':
        return new BuiltinProvider(this.opts.catalog);
      case 'khronos':
        return new KhronosProvider();
      case 'polyhaven':
        return new PolyHavenProvider();
      case 'sketchfab':
        return new SketchfabProvider(config.sketchfabToken);
      case 'polypizza':
        return new PolyPizzaProvider(config.polypizzaApiKey);
      case 'catalog':
        return new CatalogProvider(config.storeCatalogUrls);
    }
  }

  /** The cache (tests and diagnostics). */
  get cache(): ModelCache {
    return this.s.cache;
  }

  /**
   * The store's fetch: public servers only (loopback, private and link-local addresses refused on
   * every request and redirect), and `trusted` (a configured catalog's origin) whatever its address.
   */
  private fetchTrusting(trusted?: string | null): typeof fetch {
    const s = this.s;
    if (!trusted) return s.publicFetch;
    return guardedFetch(this.ctx.fetch, { resolve: s.resolver, trusted: new Set([trusted]) });
  }

  private env(signal?: AbortSignal): ProviderEnv {
    return {
      fetch: this.s.publicFetch,
      fetchTrusting: (origin) => this.fetchTrusting(origin),
      timeoutMs: this.s.config.storeFetchTimeoutMs,
      cache: this.s.cache,
      log: this.ctx.log,
      signal,
    };
  }

  /** The provider and provider-local id of a store id ('<provider>:<id>'; bare ids are built-in). */
  private resolve(model: string): {
    provider: ModelProvider;
    id: StoreProviderId;
    local: string;
    full: string;
  } {
    const m = /^([a-z]+):(.+)$/.exec(model.trim());
    const pid = (m ? m[1] : BUILTIN_PROVIDER) as StoreProviderId;
    const local = m ? m[2] : model.trim();
    if (!local) throw new ToolError('a model id is required', 'INVALID_PARAMS');
    if (!(STORE_PROVIDER_IDS as readonly string[]).includes(pid))
      throw new NotFoundError(
        `Unknown store provider '${pid}' in model id '${model}' (providers: ${STORE_PROVIDER_IDS.join(', ')})`,
      );
    const provider = this.s.providers.get(pid);
    if (!provider)
      throw new ToolError(
        `The store provider '${pid}' is not enabled on this server (STORE_PROVIDERS: ${[...this.s.providers.keys()].join(', ') || 'none'})`,
        'UNAVAILABLE',
      );
    return { provider, id: pid, local, full: `${pid}:${local}` };
  }

  private status(id: StoreProviderId): StoreProviderStatus {
    const p = this.s.providers.get(id);
    if (!p) {
      const message =
        id === 'catalog' && !this.s.config.storeCatalogUrls.length
          ? 'STORE_CATALOG_URLS is not set'
          : 'not in STORE_PROVIDERS';
      return { id, name: PROVIDER_NAMES[id], enabled: false, status: 'disabled', needs_key: null, message };
    }
    const missing = p.missingKey();
    const last = this.s.last.get(id);
    const blocked = !!missing && !p.searchesWithoutKey();
    return {
      id,
      name: p.name,
      enabled: true,
      status: blocked ? 'needs_key' : (last?.status ?? 'ok'),
      needs_key: missing,
      message: blocked
        ? `set ${missing} to use ${p.name}`
        : (last?.message ?? (missing ? `searching works; downloads need ${missing}` : null)),
    };
  }

  /** The providers the server knows: the configured ones first (with how they answered last). */
  async providers(): Promise<StoreProviderStatus[]> {
    const configured = [...this.s.providers.keys()];
    const others = STORE_PROVIDER_IDS.filter((id) => !this.s.providers.has(id));
    return [...configured, ...others].map((id) => this.status(id));
  }

  /** Searches the providers in parallel (each within the search deadline) and merges the results. */
  async search(query: StoreSearchQuery, opts: StoreCallOptions = {}): Promise<StoreSearchResult> {
    const s = this.s;
    const text = (query.query ?? '').trim().slice(0, 200);
    const words = queryWords(text);
    const category = query.category ?? null;
    if (category !== null && !(STORE_CATEGORIES as readonly string[]).includes(category))
      throw new ToolError(
        `unknown category '${category}' (categories: ${STORE_CATEGORIES.join(', ')})`,
        'INVALID_PARAMS',
      );
    const limit = Math.min(MAX_STORE_RESULTS, Math.max(1, Math.floor(query.limit ?? 20)));
    let requested: StoreProviderId[];
    if (query.providers?.length) {
      requested = [];
      for (const raw of query.providers) {
        const id = raw.trim().toLowerCase();
        if (!(STORE_PROVIDER_IDS as readonly string[]).includes(id))
          throw new ToolError(
            `unknown store provider '${raw}' (providers: ${STORE_PROVIDER_IDS.join(', ')})`,
            'INVALID_PARAMS',
          );
        if (!requested.includes(id as StoreProviderId)) requested.push(id as StoreProviderId);
      }
    } else requested = [...s.providers.keys()];
    const key = searchKey(text, category, requested);
    const offsets: CursorOffsets = {};
    const fromCursor = query.cursor ? decodeCursor(query.cursor, key) : null;
    for (const id of requested) offsets[id] = fromCursor ? (fromCursor[id] ?? null) : 0;

    const pages = new Map<string, ProviderPage>();
    const statuses = new Map<StoreProviderId, StoreProviderStatus>();
    await Promise.all(
      requested.map(async (id) => {
        const st = this.status(id);
        const provider = s.providers.get(id);
        if (!provider || st.status === 'needs_key' || offsets[id] === null) {
          statuses.set(
            id,
            offsets[id] === null && provider && st.status !== 'needs_key'
              ? { ...st, status: 'ok', message: 'no more results' }
              : st,
          );
          return;
        }
        const outcome = await this.searchOne(
          provider,
          { text, words, category, offset: offsets[id]!, limit },
          opts.signal,
        );
        // a cancelled search says nothing about the provider
        if (opts.signal?.aborted) return;
        if (outcome.page) pages.set(id, outcome.page);
        s.last.set(id, { status: outcome.status, message: outcome.message });
        this.ctx.metrics?.storeSearches.inc({ provider: id, status: outcome.status });
        statuses.set(id, this.status(id));
      }),
    );
    if (opts.signal?.aborted) throw new StoreCancelledError('store search');
    const merged = mergePages(
      s.order.filter((id) => requested.includes(id)),
      pages,
      offsets,
      limit,
    );
    // providers that failed keep their offset: the next page tries them again, unless this page
    // found nothing at all (a cursor must not lead to endless empty pages)
    const more = Object.entries(merged.offsets).some(
      ([id, o]) => o !== null && (pages.has(id) || merged.results.length > 0),
    );
    return {
      results: merged.results.map(proxied),
      providers: requested.map((id) => statuses.get(id) ?? this.status(id)),
      next_cursor: more ? encodeCursor(key, merged.offsets) : null,
    };
  }

  /**
   * One provider's page within the search deadline (see SEARCH_DEADLINE_MS; the short one while the
   * provider cools down after a timeout).
   */
  private async searchOne(
    provider: ModelProvider,
    q: { text: string; words: string[]; category: StoreCategory | null; offset: number; limit: number },
    signal: AbortSignal | undefined,
  ): Promise<{ page: ProviderPage | null; status: StoreProviderStatus['status']; message: string | null }> {
    const s = this.s;
    const fetchMs = s.config.storeFetchTimeoutMs;
    const fullMs = this.opts.searchDeadlineMs ?? Math.min(SEARCH_DEADLINE_MS, fetchMs);
    const coolingUntil = s.cooldown.get(provider.id) ?? 0;
    const cooling = coolingUntil > Date.now();
    const deadlineMs = cooling ? Math.min(fullMs, COOLDOWN_DEADLINE_MS) : fullMs;
    const controller = new AbortController();
    let timedOut = false;
    let soft: ReturnType<typeof setTimeout> | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    // the caller went away, or the deadline and its grace passed: stop waiting even for a provider
    // that does not stop
    const stop = new Promise<never>((_, reject) => {
      const halt = () => reject(new Error('stopped'));
      soft = setTimeout(() => {
        timedOut = true;
        // the provider stops waiting for the network and answers from what it holds, or is left
        controller.abort(new Error('the search deadline passed'));
        hard = setTimeout(halt, DEADLINE_GRACE_MS);
      }, deadlineMs);
      if (signal?.aborted) {
        controller.abort(signal.reason);
        halt();
      } else {
        onAbort = () => {
          controller.abort(signal?.reason);
          halt();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
    const seconds = (ms: number) => Math.round(ms / 10) / 100;
    try {
      const page = await Promise.race([provider.search(q, this.env(controller.signal)), stop]);
      s.cooldown.delete(provider.id);
      return { page, status: 'ok', message: page.note ?? null };
    } catch (err) {
      if (signal?.aborted) return { page: null, status: 'error', message: 'cancelled' };
      if (timedOut || (err instanceof StoreUpstreamError && err.timeout)) {
        s.cooldown.set(provider.id, Date.now() + COOLDOWN_MS);
        const which = fullMs === fetchMs ? 'STORE_FETCH_TIMEOUT_MS' : 'the search deadline';
        return {
          page: null,
          status: 'timeout',
          message: cooling
            ? `no answer within ${seconds(fullMs)} s (${which}) before: searches wait at most ${seconds(deadlineMs)} s for it until it answers, for ${Math.round(COOLDOWN_MS / 1000)} s`
            : `no answer within ${seconds(deadlineMs)} s (${which})`,
        };
      }
      if (err instanceof ToolError && err.code === 'NEEDS_KEY')
        return { page: null, status: 'needs_key', message: err.message };
      this.ctx.log.warn({ provider: provider.id, err: errorMessage(err) }, 'model store: search failed');
      return { page: null, status: 'error', message: clip(errorMessage(err), 500) };
    } finally {
      clearTimeout(soft);
      clearTimeout(hard);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private async providerDetails(model: string, signal?: AbortSignal) {
    const r = this.resolve(model);
    const details = await r.provider.details(r.local, this.env(signal));
    return { ...r, details };
  }

  /** One model (`<provider>:<id>`; NOT_FOUND when unknown). */
  async details(model: string, opts: StoreDetailsOptions = {}): Promise<StoreModelDetails> {
    const { id, local, details, provider } = await this.providerDetails(model, opts.signal);
    let files: StoreModelDetails['files'] = null;
    let format: StoreModelDetails['format'] = null;
    let main: string | null = null;
    if (id !== BUILTIN_PROVIDER) {
      const key = bundleKey(details);
      let content = await this.s.cache.peek('models', key);
      if (!content && opts.download) {
        const handle = await this.bundle(provider, local, details, opts.signal);
        content = { files: [...handle.files], meta: handle.meta };
        handle.release();
      }
      if (content) {
        const mainPath = String(content.meta?.main ?? '');
        // the main file first
        const sorted = [...content.files].sort((a, b) =>
          a.path === mainPath ? -1 : b.path === mainPath ? 1 : 0,
        );
        files = sorted.map((f) => ({ path: f.path, bytes: f.bytes }));
        format = (content.meta?.format as StoreModelDetails['format']) ?? null;
        main = mainPath || null;
      }
    }
    return {
      ...proxied(details.model),
      description: details.description,
      license_note: licenseNote(details.model.license.spdx),
      ...(details.params ? { params: details.params } : {}),
      files,
      format,
      main,
    };
  }

  /**
   * The downloaded files of an external model (cached; downloaded when not held), pinned: release
   * the handle after reading. NOT_DOWNLOADABLE / NEEDS_KEY when the model cannot be downloaded.
   */
  private async bundle(
    provider: ModelProvider,
    local: string,
    details: ProviderDetails,
    signal?: AbortSignal,
  ): Promise<CacheHandle> {
    const model = details.model;
    if (!model.downloadable)
      throw new ToolError(
        `${model.id} is listed only: its provider does not allow downloading it`,
        'NOT_DOWNLOADABLE',
      );
    if (model.needs_key)
      throw new ToolError(
        `Downloading ${provider.name} models needs ${model.needs_key}: set it in the server's environment`,
        'NEEDS_KEY',
      );
    const s = this.s;
    return s.cache.entry(
      'models',
      provider.id,
      bundleKey(details),
      (dir, buildSignal) =>
        s.downloads.run(
          async () => {
            const t0 = Date.now();
            try {
              const plan = await provider.plan(local, this.env(buildSignal));
              const content = await downloadPlan(plan, dir, {
                fetch: this.fetchTrusting(plan.trustedOrigin),
                timeoutMs: s.config.storeFetchTimeoutMs,
                signal: buildSignal,
                what: model.id,
                maxBytes: this.opts.maxModelBytes ?? MAX_MODEL_BYTES,
                onBytes: (n) => this.ctx.metrics?.storeDownloadBytes.inc(undefined, n),
              });
              this.ctx.metrics?.storeDownloads.inc({ provider: provider.id, status: 'ok' });
              this.ctx.log.info(
                {
                  model: model.id,
                  files: content.files.length,
                  bytes: content.files.reduce((n, f) => n + f.bytes, 0),
                  ms: Date.now() - t0,
                },
                'model store: model downloaded',
              );
              return content;
            } catch (err) {
              this.ctx.metrics?.storeDownloads.inc({ provider: provider.id, status: 'error' });
              this.ctx.log.warn({ model: model.id, err: errorMessage(err) }, 'model store: download failed');
              throw err;
            }
          },
          buildSignal,
          model.id,
        ),
      signal,
    );
  }

  /** A model's thumbnail (proxied and cached; built-in ones rendered once). */
  async thumbnail(model: string, opts: StoreCallOptions = {}): Promise<StoreFile> {
    const r = this.resolve(model);
    const s = this.s;
    let handle: CacheHandle;
    if (r.id === BUILTIN_PROVIDER) {
      const entry = await r.provider.details(r.local, this.env(opts.signal));
      const id = entry.model.id.slice(BUILTIN_PROVIDER.length + 1);
      // a new server version (models may have changed) renders thumbnails again
      handle = await s.cache.entry(
        'thumbs',
        BUILTIN_PROVIDER,
        `builtin:${id}:v${THUMBNAIL_VERSION}:${PACKAGE_VERSION}:${THUMBNAIL_SIZE}`,
        (dir, signal) =>
          s.renders.run(
            async () => {
              const png = await renderBuiltinThumbnail({
                id,
                registry: this.ctx.services.registry,
                renderer: this.ctx.services.renderer,
                signal,
                stage: s.stage,
              });
              await writeFile(path.join(dir, 'thumbnail.png'), png);
              return { files: [fileInfo('thumbnail.png', png, 'image/png')] };
            },
            signal,
            entry.model.id,
          ),
        opts.signal,
      );
    } else {
      const source = await r.provider.thumbnail(r.local, this.env(opts.signal));
      if (!source) throw new NotFoundError(`${r.full} has no thumbnail`);
      handle = await s.cache.entry(
        'thumbs',
        r.id,
        `${r.full}:${source.url}`,
        (dir, signal) =>
          s.fetches.run(
            async () => {
              const got = await storeFetch(source.url, {
                what: `the thumbnail of ${r.full}`,
                timeoutMs: s.config.storeFetchTimeoutMs,
                maxBytes: MAX_THUMBNAIL_BYTES,
                expect: 'image',
                signal,
                fetchImpl: this.fetchTrusting(source.trustedOrigin),
                headers: source.headers,
              });
              const type = sniffImage(got.data) ?? 'application/octet-stream';
              const name = `thumbnail.${type.split('/')[1] ?? 'bin'}`;
              await writeFile(path.join(dir, name), got.data);
              return { files: [fileInfo(name, got.data, type)] };
            },
            signal,
            r.full,
          ),
        opts.signal,
      );
    }
    try {
      const f = handle.files[0];
      return {
        data: await handle.read(f.path),
        contentType: f.type ?? 'application/octet-stream',
        etag: etagOf(f.sha256),
      };
    } finally {
      handle.release();
    }
  }

  /**
   * A file of a model (`path` relative to its main file; '' for the main file), downloaded once
   * and cached, held for the caller: stream it from `path`, then release it (the browser inserts
   * external models itself with core store.insert_files). NOT_DOWNLOADABLE / NEEDS_KEY when the
   * model cannot be downloaded.
   */
  async openFile(model: string, filePath: string, opts: StoreCallOptions = {}): Promise<StoreFileHandle> {
    const { id, local, details, provider, full } = await this.providerDetails(model, opts.signal);
    if (id === BUILTIN_PROVIDER)
      throw new ToolError(
        `${full} is built by code and has no files: insert it with store_add or store.add`,
        'INVALID_PARAMS',
      );
    const handle = await this.bundle(provider, local, details, opts.signal);
    const want = filePath === '' ? String(handle.meta.main ?? '') : safeArchivePath(filePath);
    const f = want ? handle.files.find((x) => x.path === want) : undefined;
    if (!f) {
      handle.release();
      throw new NotFoundError(`${full} has no file '${filePath}' (the model's details list its files)`);
    }
    return {
      path: handle.path(f.path),
      bytes: f.bytes,
      contentType: f.type ?? contentTypeFor(f.path),
      etag: etagOf(f.sha256),
      release: () => handle.release(),
    };
  }

  /** A file of a model in memory (see {@link openFile}). */
  async files(model: string, filePath: string, opts: StoreCallOptions = {}): Promise<StoreFile> {
    const f = await this.openFile(model, filePath, opts);
    try {
      const data = await readFile(f.path);
      return {
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        contentType: f.contentType,
        etag: f.etag,
      };
    } finally {
      f.release();
    }
  }

  /**
   * The operator call that inserts `model` with `opts` (downloads an external model's files
   * first; NOT_DOWNLOADABLE / NEEDS_KEY when it cannot be downloaded).
   */
  async prepareInsert(
    model: string,
    opts: StoreInsertOptions,
    call: StoreInsertCallOptions = {},
  ): Promise<StoreInsertCall> {
    const { id, local, details, provider } = await this.providerDetails(model, call.signal);
    const entry = proxied(details.model);
    const warnings: string[] = [];
    const placement: Record<string, unknown> = {};
    for (const k of ['location', 'rotation_deg', 'height_m', 'width_m', 'depth_m', 'name'] as const)
      if (opts[k] !== undefined) placement[k] = opts[k];
    // a model's own parameters are checked by its schema first (an external model takes none:
    // refused before anything is downloaded)
    const params = opts.params && Object.keys(opts.params).length ? opts.params : undefined;
    if (params) {
      if (!provider.checkParams)
        throw new ToolError(
          `${details.model.id} takes no params: only built-in models take parameters of their own ` +
            `(got ${Object.keys(params).join(', ')})`,
          'INVALID_PARAMS',
        );
      provider.checkParams(local, params);
    }
    const note = licenseNote(details.model.license.spdx);
    if (note)
      warnings.push(`${details.model.id}: ${note} (recorded on the root object and in video export credits)`);
    if (id === BUILTIN_PROVIDER)
      return {
        operator: 'store.add',
        params: {
          model: details.model.id,
          ...placement,
          ...(opts.color !== undefined ? { color: opts.color } : {}),
          ...(params ? { params } : {}),
        },
        entry,
        warnings,
      };
    if (opts.color !== undefined)
      warnings.push('color applies to built-in models only: the model keeps its materials');
    const handle = await this.bundle(provider, local, details, call.signal);
    try {
      // refused before anything is read: the files and their base64 are several times the model
      if (call.doc) this.checkInsertMemory(call.doc, handle);
      const files: Record<string, string> = {};
      for (const f of handle.files) {
        const data = await handle.read(f.path);
        files[f.path] = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
      }
      const m = details.model;
      const dims =
        m.dimensions_m && m.dimensions_m.every((d) => Number.isFinite(d) && d > 0) ? m.dimensions_m : null;
      return {
        operator: 'store.insert_files',
        params: {
          entry: {
            id: clip(m.id, 400),
            name: clip(m.name, 200),
            provider: m.provider,
            license: {
              spdx: clip(m.license.spdx, 64),
              url: m.license.url ? clip(m.license.url, 2000) : null,
              attribution: m.license.attribution ? clip(m.license.attribution, 2000) : null,
            },
            author: m.author ? clip(m.author, 400) : null,
            source_url: m.source_url ? clip(m.source_url, 2000) : null,
            ...(dims ? { dimensions_m: [...dims] } : {}),
            ...(m.category ? { category: m.category } : {}),
          },
          format: handle.meta.format,
          files,
          main: handle.meta.main,
          ...placement,
        },
        entry,
        warnings,
      };
    } finally {
      handle.release();
    }
  }

  /**
   * Asks the server's memory check (core operatorMemoryCheck, as the registry asks it before
   * store.insert_files runs) with the insert's estimate from the cached files' sizes and the main
   * file's header; OUT_OF_MEMORY when it refuses. Nothing to do without a check.
   */
  private checkInsertMemory(doc: SceneDoc, handle: CacheHandle): void {
    const check = operatorMemoryCheck();
    if (!check) return;
    const mainPath = String(handle.meta.main ?? '');
    const main = handle.files.find((f) => f.path === mainPath);
    if (!main) return;
    const companions = handle.files.reduce((n, f) => (f.path === mainPath ? n : n + f.bytes), 0);
    const file = diskReader(handle.path(main.path), main.bytes);
    let estimate: OperatorEstimate | null;
    try {
      estimate = insertFilesEstimate(file.reader, String(handle.meta.format ?? 'glb'), companions);
    } finally {
      file.close();
    }
    if (!estimate || estimate.bytes <= 0) return;
    const operator = 'store.insert_files';
    let refused: string | null;
    if (estimate.addedStoredBytes > 0) {
      const project = projectObjects(doc);
      refused = check({
        operator,
        estimate,
        storedBytes: storedMeshBytes(doc) + project.bytes,
        saveBytes: project.save,
        objects: project.objects,
        doc,
      });
    } else refused = check({ operator, estimate, storedBytes: 0, doc });
    if (refused) throw new ToolError(refused, 'OUT_OF_MEMORY');
  }

  /** Inserts a model into a project (id; POST /api/projects/:id/store) in the project's room. */
  async insert(
    project: string,
    model: string,
    opts: StoreInsertOptions,
    call: StoreCallOptions = {},
  ): Promise<StoreInsertResult> {
    const room = await this.openRoom(project);
    const prepared = await this.prepareInsert(model, opts, { ...call, doc: room.scene });
    // the project may have been deleted or unloaded while the model downloaded
    const live = room.destroyed ? await this.openRoom(project) : room;
    const reports: { level: ReportLevel; message: string }[] = [];
    live.touch();
    const res = this.ctx.services.registry.run(
      {
        doc: live.scene,
        state: createEditorState(),
        origin: REST_ORIGIN,
        source: 'api',
        report: (level, message) => void reports.push({ level, message }),
      },
      prepared.operator,
      prepared.params,
    );
    if (!res.ok)
      throw new ToolError(`${prepared.operator} failed: ${res.error ?? 'unknown error'}`, res.code);
    // the thumbnail route stays relative, as the REST search gives it
    return insertReply(res.result, prepared.entry, [
      ...prepared.warnings,
      ...reports.filter((r) => r.level !== 'INFO').map((r) => r.message),
    ]);
  }

  private async openRoom(project: string) {
    // a store without a configuration answers UNAVAILABLE before it looks for the project
    this.assertAvailable();
    let room;
    try {
      room = await this.ctx.rooms.open(project);
    } catch (err) {
      if (err instanceof StorageUnavailableError) throw new ToolError(err.message, 'UNAVAILABLE');
      if (err instanceof ProjectMemoryError) throw new ToolError(err.message, 'OUT_OF_MEMORY');
      throw err;
    }
    if (!room) throw new NotFoundError(`project '${project}' not found`);
    return room;
  }

  /** Stops downloads and lets running cache writes settle (server shutdown). */
  async close(): Promise<void> {
    await this.internals?.cache.close();
    this.internals?.stage.close();
  }
}

/** What core's store.insert_files estimator says when the files' bytes did not decide (memory.ts IMPORT_LOWER). */
const IMAGES_LOWER = 'the images embedded in the file (fewer or smaller textures)';

/**
 * The estimate core's store.insert_files estimator (operators/memory.ts) makes for a model's files,
 * from what it reads of them: the main file through `main` (its header and JSON; a glTF's buffers,
 * images and an OBJ's material files only by their size, `companionBytes`). Asked before the files
 * are read: base64 of a 200 MB model is 270 MB of string outside the JavaScript heap's limit.
 */
export function insertFilesEstimate(
  main: ImportReader,
  format: string,
  companionBytes: number,
): OperatorEstimate | null {
  const head = main.read(0, Math.min(4, main.byteLength));
  const glb =
    head.length === 4 && head[0] === 0x67 && head[1] === 0x6c && head[2] === 0x54 && head[3] === 0x46;
  const e = importEstimate(format === 'gltf' && glb ? 'glb' : format, main);
  const images = IMPORT_BYTES_PER_IMAGE_BYTE * companionBytes;
  return withObjects(
    {
      ...e,
      bytes: e.bytes + images,
      addedStoredBytes: e.addedStoredBytes + companionBytes,
      addedSaveBytes: (e.addedSaveBytes ?? 0) + SAVE_BYTES_PER_IMAGE_BYTE * companionBytes,
      lower: images > e.bytes - OPERATOR_FIXED_BYTES ? IMAGES_LOWER : e.lower,
    },
    { objects: 1 },
  );
}

/** A file on disk as an ImportReader (ranges read when asked; `close` when done). */
function diskReader(file: string, byteLength: number): { reader: ImportReader; close(): void } {
  const fd = openSync(file, 'r');
  return {
    reader: {
      byteLength,
      read(start, end) {
        const to = Math.min(end, byteLength);
        if (to <= start) return new Uint8Array(0);
        const buf = Buffer.allocUnsafe(to - start);
        const n = readSync(fd, buf, 0, to - start, start);
        return new Uint8Array(buf.buffer, buf.byteOffset, n);
      },
    },
    close: () => closeSync(fd),
  };
}

/** The cache key of a model's files (its id and the provider's revision of them). */
function bundleKey(details: ProviderDetails): string {
  return `${details.model.id}#${details.revision ?? ''}`;
}

function fileInfo(name: string, data: Uint8Array, type: string): CachedFile {
  return {
    path: name,
    bytes: data.byteLength,
    sha256: createHash('sha256').update(data).digest('hex'),
    type,
  };
}
