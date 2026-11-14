import type { StoreCategory, StoreResult } from '@3d-editor/core';
import { apiUrl, authHeaders } from '../app/server-config';

/*
 * Typed client of the editor server's model store and video export routes (SPEC §9, §10):
 *   GET    /api/store/providers                         the providers and how they answered last
 *   GET    /api/store/search?query=&category=&providers=&limit=&cursor=
 *   GET    /api/store/models/:model[?download=1]        one model (with download: its files)
 *   GET    /api/store/models/:model/thumbnail           its thumbnail (proxied, cached)
 *   GET    /api/store/models/:model/files/*             its files (a cached download proxy)
 *   POST   /api/projects/:id/video-exports              start an export (202)
 *   GET    /api/projects/:id/video-exports              the project's exports, newest first
 *   GET    /api/projects/:id/video-exports/:export      one export (?wait=<s>: until it changes)
 *   DELETE /api/projects/:id/video-exports/:export      cancel it and delete its files
 *   GET    /api/projects/:id/video-exports/:export/files/<name>
 * Requests carry the server token (Bearer header); URLs the browser loads itself (images, links,
 * videos) carry it as `?token=` (apiUrl). Failures throw an ApiError with the server's message and
 * code (`{error, code}` bodies: NEEDS_KEY, NOT_DOWNLOADABLE, UNAVAILABLE, UPSTREAM, QUEUE_FULL,
 * FFMPEG_UNAVAILABLE, NOT_FOUND, INVALID_PARAMS, OUT_OF_MEMORY …).
 */

/** A failed request: the server's message, HTTP status (0: no answer) and error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Whether `err` is the abort of a request (a newer search replaced it, the window closed). */
export function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/** The error of a non-2xx response: its `{error, code}` body when it has one. */
async function responseError(res: Response, what: string): Promise<ApiError> {
  let message = `${what} failed (HTTP ${res.status})`;
  let code: string | null = null;
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown };
    if (typeof body?.error === 'string' && body.error) message = body.error;
    if (typeof body?.code === 'string' && body.code) code = body.code;
  } catch {
    // not JSON: keep the status line
  }
  return new ApiError(message, res.status, code);
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** A JSON request to the editor server (aborts rethrown as they are). */
async function requestJson<T>(path: string, what: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders() };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(`${what} failed: the editor server did not answer`, 0, null);
  }
  if (!res.ok) throw await responseError(res, what);
  return (await res.json()) as T;
}

// ------------------------------------------------------------------ model store

/** How a provider answered (GET /api/store/providers and search pages). */
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
  category?: StoreCategory | null;
  /** Provider ids (default: every configured one). */
  providers?: string[];
  /** Results per page (1–50, default 20). */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  cursor?: string | null;
}

export interface StoreSearchPage {
  results: StoreResult[];
  providers: StoreProviderStatus[];
  /** Opaque cursor of the next page, or null at the end. */
  next_cursor: string | null;
}

/** One model with what its provider says beyond the search result. */
export interface StoreModelDetails extends StoreResult {
  description: string | null;
  /** What the licence asks of a film the model appears in (null: nothing beyond the credit). */
  license_note: string | null;
  params?: Record<string, unknown>;
  /** The files an insert uses (main file first), known once the model was downloaded. */
  files: { path: string; bytes: number | null }[] | null;
  format: 'glb' | 'gltf' | 'obj' | null;
  main: string | null;
}

/** Path of a model's store route ('<provider>:<id>', the colon kept as the server writes it). */
export function storeModelPath(model: string): string {
  return `/api/store/models/${encodeURIComponent(model).replace(/%3A/gi, ':')}`;
}

/** The providers the server knows, configured ones first. */
export async function fetchStoreProviders(signal?: AbortSignal): Promise<StoreProviderStatus[]> {
  const r = await requestJson<{ providers: StoreProviderStatus[] }>(
    '/api/store/providers',
    'Listing the providers',
    {
      signal,
    },
  );
  return Array.isArray(r.providers) ? r.providers : [];
}

/** The query string of a search (empty fields left out). */
export function storeSearchParams(q: StoreSearchQuery): URLSearchParams {
  const p = new URLSearchParams();
  const text = q.query?.trim();
  if (text) p.set('query', text.slice(0, 200));
  if (q.category) p.set('category', q.category);
  if (q.providers?.length) p.set('providers', q.providers.join(','));
  if (q.limit !== undefined) p.set('limit', String(Math.min(50, Math.max(1, Math.floor(q.limit)))));
  if (q.cursor) p.set('cursor', q.cursor);
  return p;
}

/** One page of a store search (the next page with the previous page's `next_cursor`). */
export async function searchStore(q: StoreSearchQuery, signal?: AbortSignal): Promise<StoreSearchPage> {
  const qs = storeSearchParams(q).toString();
  const r = await requestJson<Partial<StoreSearchPage>>(
    `/api/store/search${qs ? `?${qs}` : ''}`,
    'Searching the model store',
    { signal },
  );
  return {
    results: Array.isArray(r.results) ? r.results : [],
    providers: Array.isArray(r.providers) ? r.providers : [],
    next_cursor: typeof r.next_cursor === 'string' && r.next_cursor ? r.next_cursor : null,
  };
}

/** One model; with `download` the server downloads (and caches) its files and lists them. */
export async function fetchStoreModel(
  model: string,
  opts: { download?: boolean; signal?: AbortSignal } = {},
): Promise<StoreModelDetails> {
  return requestJson<StoreModelDetails>(
    `${storeModelPath(model)}${opts.download ? '?download=1' : ''}`,
    `Getting ${model}`,
    { signal: opts.signal },
  );
}

/**
 * URL of a model's thumbnail for an <img> (the server's thumbnail route with the token), or null
 * when the model has none. Absolute URLs (an MCP result) are used as they are.
 */
export function storeThumbnailUrl(result: Pick<StoreResult, 'id' | 'thumbnail_url'>): string | null {
  const t = result.thumbnail_url;
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  return apiUrl(t.startsWith('/') ? t : `${storeModelPath(result.id)}/thumbnail`);
}

/** Route of one of a model's files ('' = its main file), each path segment encoded. */
export function storeFilePath(model: string, path: string): string {
  const rel = path
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  return `${storeModelPath(model)}/files/${rel}`;
}

/** URL of one of a model's files with the token (for links). */
export function storeFileUrl(model: string, path: string): string {
  return apiUrl(storeFilePath(model, path));
}

/**
 * Downloads one of a model's files through the server's cached proxy; `onBytes` is told how many
 * bytes arrived so far (when the body can be streamed).
 */
export async function downloadStoreFile(
  model: string,
  path: string,
  opts: { signal?: AbortSignal; onBytes?: (received: number) => void } = {},
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(apiUrl(storeFilePath(model, path)), { headers: authHeaders(), signal: opts.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(`Downloading ${path || model} failed: the editor server did not answer`, 0, null);
  }
  if (!res.ok) throw await responseError(res, `Downloading ${path || model}`);
  const body = res.body;
  if (!body || !opts.onBytes) {
    const data = new Uint8Array(await res.arrayBuffer());
    opts.onBytes?.(data.byteLength);
    return data;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    opts.onBytes(received);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// ------------------------------------------------------------------ video exports

export const PASS_NAMES = ['beauty', 'depth', 'normal', 'mask', 'edges', 'pose'] as const;
export type PassName = (typeof PASS_NAMES)[number];

export type ExportQuality = 'draft' | 'standard' | 'high';
export type ExportLook = 'material' | 'clay' | 'solid';
export type ExportCodec = 'h264' | 'vp9';

/** The body of POST …/video-exports (SPEC §9; the server fills in the defaults). */
export interface VideoExportParams {
  shots?: string[] | 'all';
  frame_start?: number;
  frame_end?: number;
  camera?: string;
  outputs?: { sequence: boolean; clips: boolean; posters: boolean; contact_sheet: boolean };
  width?: number;
  height?: number;
  fps?: number;
  quality?: ExportQuality;
  look?: ExportLook;
  passes?: PassName[];
  codec?: ExportCodec;
  match_model_duration?: boolean;
  label?: string;
}

export type ExportStatus = 'queued' | 'running' | 'encoding' | 'done' | 'failed' | 'cancelled';
export type ExportFileKind = 'sequence' | 'clip' | 'poster' | 'manifest' | 'contact_sheet' | 'pass';

/** A file an export wrote. */
export interface ExportFile {
  name: string;
  kind: ExportFileKind;
  pass?: PassName;
  /** The shot's id ('range' for a frame range export). */
  shot?: string;
  external_shot?: string;
  bytes: number;
  frames?: number;
  duration_s?: number;
  /** Server path of the file (no token: see {@link videoExportFileUrl}). */
  url: string;
  sha256: string;
}

export interface ExportProgress {
  frames_done: number;
  frames_total: number;
  /** 0–1. */
  fraction: number;
  /** Frames rendered per second (0 before the first frame). */
  fps: number;
  /** Seconds left (null while unknown). */
  eta_s: number | null;
  /** The shot being rendered (id), or null. */
  shot: string | null;
}

/** An export job of the server. */
export interface ExportJob {
  id: string;
  project: string;
  label: string | null;
  status: ExportStatus;
  params: VideoExportParams;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: ExportProgress;
  error: string | null;
  warnings: string[];
  files: ExportFile[];
}

/** Whether a job has ended (it changes no more). */
export function exportFinished(status: ExportStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled';
}

/** Route of a project's exports (or of one of them). */
export function videoExportsPath(project: string, exportId?: string): string {
  const base = `/api/projects/${encodeURIComponent(project)}/video-exports`;
  return exportId ? `${base}/${encodeURIComponent(exportId)}` : base;
}

/** Starts an export of the project as the server holds it (202: the job, queued or running). */
export async function startVideoExport(
  project: string,
  params: VideoExportParams,
  signal?: AbortSignal,
): Promise<ExportJob> {
  return requestJson<ExportJob>(videoExportsPath(project), 'Starting the export', {
    method: 'POST',
    body: params,
    signal,
  });
}

/** The project's exports, newest first. */
export async function listVideoExports(project: string, signal?: AbortSignal): Promise<ExportJob[]> {
  const r = await requestJson<{ exports?: ExportJob[] }>(videoExportsPath(project), 'Listing the exports', {
    signal,
  });
  return Array.isArray(r.exports) ? r.exports : [];
}

/**
 * One export; with `waitS` (0–50) the server answers when the job's status changes or after that
 * many seconds (a long poll: progress alone does not end it).
 */
export async function getVideoExport(
  project: string,
  exportId: string,
  opts: { waitS?: number; signal?: AbortSignal } = {},
): Promise<ExportJob> {
  const wait = opts.waitS !== undefined ? Math.min(50, Math.max(0, opts.waitS)) : undefined;
  return requestJson<ExportJob>(
    `${videoExportsPath(project, exportId)}${wait !== undefined ? `?wait=${wait}` : ''}`,
    'Getting the export',
    { signal: opts.signal },
  );
}

/** Cancels an export (when it has not ended) and deletes its files; returns the job as it was. */
export async function deleteVideoExport(
  project: string,
  exportId: string,
  signal?: AbortSignal,
): Promise<ExportJob> {
  return requestJson<ExportJob>(videoExportsPath(project, exportId), 'Deleting the export', {
    method: 'DELETE',
    signal,
  });
}

/** URL of an export's file for links, <video> and <img> (the server path with the token). */
export function videoExportFileUrl(file: Pick<ExportFile, 'url'>): string {
  return apiUrl(file.url);
}
