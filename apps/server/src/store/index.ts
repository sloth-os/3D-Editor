import { ToolError } from '../mcp/agent';
import type { ServiceContext } from '../services';

/*
 * The model store (SPEC §10): the built-in catalog of core and external providers (Khronos glTF
 * samples, Poly Haven, Sketchfab, Poly Pizza, JSON catalogs), searched lazily, downloaded only on
 * insert and cached on disk. This is the FOUNDATION stub: the public names are fixed, every
 * operation answers UNAVAILABLE until the store server lands. The types mirror core
 * store/types.ts (StoreResult …), kept here so the server does not wait for those exports.
 */

/** The model categories (core store/types.ts StoreCategory). */
export const STORE_CATEGORIES = [
  'people',
  'animals',
  'furniture',
  'props',
  'food',
  'vehicles',
  'nature',
  'architecture',
  'street',
  'sports',
] as const;
export type StoreCategory = (typeof STORE_CATEGORIES)[number];

/** The providers the server knows (STORE_PROVIDERS picks and orders them; defined with the config). */
export { STORE_PROVIDER_IDS, type StoreProviderId } from '../config';

export type StoreFormat = 'builtin' | 'glb' | 'gltf' | 'obj';

/** Most results of one search page (store_search `limit`, REST `?limit=`). */
export const MAX_STORE_RESULTS = 100;

/** A model as search lists it (core StoreResult). */
export interface StoreModel {
  /** `<provider>:<id>` */
  id: string;
  provider: string;
  name: string;
  category: StoreCategory | null;
  tags: string[];
  thumbnail_url: string | null;
  license: { spdx: string; url: string | null; attribution: string | null };
  author: string | null;
  source_url: string | null;
  dimensions_m: [number, number, number] | null;
  triangles: number | null;
  formats: StoreFormat[];
  downloadable: boolean;
  /** The setting that would make it downloadable (e.g. SKETCHFAB_TOKEN). */
  needs_key?: string;
}

/** One model with what its provider says beyond the search result. */
export interface StoreModelDetails extends StoreModel {
  description: string | null;
  /** The files an insert downloads (paths relative to the main file), when known. */
  files: { path: string; bytes: number | null }[] | null;
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
}

export interface StoreInsertResult {
  /** What the operator returned: the root object (an EMPTY wrapping the model), its objects … */
  result: unknown;
  entry: StoreModel;
  warnings: string[];
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

function unavailable(): ToolError {
  return new ToolError('The model store is not available yet on this server.', 'UNAVAILABLE');
}

/** The model store of the server. */
export class ModelStore {
  constructor(protected readonly ctx: ServiceContext) {}

  /** The configured providers and how they answered last. */
  async providers(): Promise<StoreProviderStatus[]> {
    throw unavailable();
  }

  /** Searches the providers in parallel (each with STORE_FETCH_TIMEOUT_MS) and merges the results. */
  async search(_query: StoreSearchQuery, _opts: StoreCallOptions = {}): Promise<StoreSearchResult> {
    throw unavailable();
  }

  /** One model (`<provider>:<id>`; NOT_FOUND when unknown). */
  async details(_model: string, _opts: StoreCallOptions = {}): Promise<StoreModelDetails> {
    throw unavailable();
  }

  /** A model's thumbnail (proxied and cached; built-in ones rendered once). */
  async thumbnail(_model: string, _opts: StoreCallOptions = {}): Promise<StoreFile> {
    throw unavailable();
  }

  /**
   * A file of a model (`path` relative to its main file; '' for the main file), downloaded once
   * and cached: the browser inserts external models itself with core store.insert_files.
   * NOT_DOWNLOADABLE / NEEDS_KEY when the model cannot be downloaded.
   */
  async files(_model: string, _path: string, _opts: StoreCallOptions = {}): Promise<StoreFile> {
    throw unavailable();
  }

  /**
   * The operator call that inserts `model` with `opts` (downloads an external model's files
   * first; NOT_DOWNLOADABLE / NEEDS_KEY when it cannot be downloaded).
   */
  async prepareInsert(
    _model: string,
    _opts: StoreInsertOptions,
    _call: StoreCallOptions = {},
  ): Promise<StoreInsertCall> {
    throw unavailable();
  }

  /** Inserts a model into a project (id; POST /api/projects/:id/store) in the project's room. */
  async insert(
    _project: string,
    _model: string,
    _opts: StoreInsertOptions,
    _call: StoreCallOptions = {},
  ): Promise<StoreInsertResult> {
    throw unavailable();
  }

  /** Stops downloads and flushes the cache index (server shutdown). */
  async close(): Promise<void> {}
}
