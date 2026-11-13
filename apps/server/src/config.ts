import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PACKAGE_VERSION } from './version';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type PersistenceMode = 'memory' | 'disk' | 'webdav';

export interface WebDAVSettings {
  /** Base URL of the upstream WebDAV collection (no trailing slash). */
  url: string;
  username?: string;
  password?: string;
  /** Folder (inside `url`) holding the editor's `projects/` directory, e.g. `/3d-editor`. */
  basePath: string;
}

export interface OtelSettings {
  /** OTLP/HTTP base endpoint (no trailing slash), e.g. `http://collector:4318`. */
  endpoint: string;
  serviceName: string;
  /** Extra headers for OTLP requests (from OTEL_EXPORTER_OTLP_HEADERS). */
  headers: Record<string, string>;
}

export interface ServerConfig {
  port: number;
  host: string;
  /** Directory holding the built PWA, or null when there is nothing to serve. */
  publicDir: string | null;
  /** Directory of disk persistence (`DATA_DIR`, default ./data). */
  dataDir: string;
  /**
   * Where live projects are kept: `SYNC_PERSISTENCE`, else `webdav` when WEBDAV_URL is set, else
   * `disk` when DATA_DIR is set, else `memory` (lost when the server stops).
   */
  persistence: PersistenceMode;
  roomIdleTtlSeconds: number;
  persistDebounceMs: number;
  /**
   * How long a shutdown (SIGTERM, SIGINT) may take before the server exits anyway
   * (`SHUTDOWN_TIMEOUT_SECONDS`, default 9 s: Docker sends SIGKILL 10 s after SIGTERM).
   */
  shutdownTimeoutMs: number;
  /**
   * How long a shutdown waits for storage to save the loaded projects: {@link shutdownSaveWait} of
   * `shutdownTimeoutMs` (7 s by default).
   */
  shutdownSaveWaitMs: number;
  webdav: WebDAVSettings | null;
  /** Expose the upstream WebDAV server to browsers under `/dav`. */
  webdavProxy: boolean;
  /** Shared secret for /api, /sync, /mcp, /dav and /otlp (null = open). */
  authToken: string | null;
  mcpEnabled: boolean;
  /** Additional secret accepted on /mcp only. */
  mcpToken: string | null;
  /** Undo steps kept per MCP agent and project (`MCP_UNDO_STEPS`, default 100). */
  mcpUndoSteps: number;
  /**
   * Replaced or deleted data kept for the undo history of each MCP agent and project, in bytes
   * (`MCP_UNDO_MEMORY_MB`, default 64 MB); older steps are dropped beyond it.
   */
  mcpUndoMemoryBytes: number;
  /** Accept browser telemetry on /otlp. */
  telemetryEnabled: boolean;
  /** OpenTelemetry export (null = disabled, zero overhead). */
  otel: OtelSettings | null;
  logLevel: LogLevel;
  corsOrigins: string[];
  version: string;
  /**
   * The ffmpeg executable of video exports (`FFMPEG_PATH`, default `ffmpeg` from the PATH; a value
   * with a slash is a file path, resolved against the working directory).
   */
  ffmpegPath: string;
  /** Where video exports are written (`EXPORT_DIR`, default `<DATA_DIR>/exports`). */
  exportDir: string;
  /** Most bytes all video exports may take on disk (`EXPORT_MAX_MB`, default 20480 MB). */
  exportMaxBytes: number;
  /** How long finished video exports are kept (`EXPORT_TTL_HOURS`, default 168 h). */
  exportTtlMs: number;
  /** Most video exports waiting to start (`EXPORT_MAX_QUEUED`, default 8; more answer QUEUE_FULL). */
  exportMaxQueued: number;
  /**
   * The model store's providers, in search order (`STORE_PROVIDERS`, default builtin, khronos,
   * polyhaven, sketchfab, polypizza, and catalog when STORE_CATALOG_URLS is set).
   */
  storeProviders: StoreProviderId[];
  /** Sketchfab API token (`SKETCHFAB_TOKEN`): Sketchfab models download only with it. */
  sketchfabToken: string | null;
  /** Poly Pizza API key (`POLYPIZZA_API_KEY`): the provider answers only with it. */
  polypizzaApiKey: string | null;
  /** JSON model catalogs of the `catalog` provider (`STORE_CATALOG_URLS`, comma-separated). */
  storeCatalogUrls: string[];
  /** Where downloaded store models and thumbnails are cached (`MODEL_CACHE_DIR`, default `<DATA_DIR>/model-cache`). */
  modelCacheDir: string;
  /** Most bytes the model cache keeps, least recently used dropped first (`MODEL_CACHE_MAX_MB`, default 2048 MB). */
  modelCacheMaxBytes: number;
  /** Timeout of each request to a store provider (`STORE_FETCH_TIMEOUT_MS`, default 20000 ms). */
  storeFetchTimeoutMs: number;
  /** Base URL of the rideo server (`RIDEO_URL`, no trailing slash; null = the rideo bridge is off). */
  rideoUrl: string | null;
  /** Bearer token for the rideo server (`RIDEO_TOKEN`). */
  rideoToken: string | null;
}

/** The model store providers the server knows (STORE_PROVIDERS picks and orders them). */
export const STORE_PROVIDER_IDS = [
  'builtin',
  'khronos',
  'polyhaven',
  'sketchfab',
  'polypizza',
  'catalog',
] as const;
export type StoreProviderId = (typeof STORE_PROVIDER_IDS)[number];
/** STORE_PROVIDERS when unset (catalog is added when STORE_CATALOG_URLS is set). */
export const DEFAULT_STORE_PROVIDERS: readonly StoreProviderId[] = [
  'builtin',
  'khronos',
  'polyhaven',
  'sketchfab',
  'polypizza',
];

export interface ConfigEnvironment {
  /** Directory of the running module/bundle (used to locate the default PUBLIC_DIR). */
  moduleDir?: string;
  cwd?: string;
  exists?: (p: string) => boolean;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const boolish = z.string().transform((v, ctx) => {
  const s = v.trim().toLowerCase();
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  ctx.addIssue({ code: 'custom', message: `expected a boolean (true/false), got '${v}'` });
  return z.NEVER;
});

const httpUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}, 'expected an http(s) URL');

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_DIR: z.string().optional(),
  DATA_DIR: z.string().default('./data'),
  SYNC_PERSISTENCE: z.enum(['memory', 'disk', 'webdav']).optional(),
  ROOM_IDLE_TTL_SECONDS: z.coerce.number().positive().default(3600),
  PERSIST_DEBOUNCE_MS: z.coerce.number().int().min(0).default(1500),
  SHUTDOWN_TIMEOUT_SECONDS: z.coerce.number().positive().max(3600).default(9),
  WEBDAV_URL: httpUrl.optional(),
  WEBDAV_USERNAME: z.string().optional(),
  WEBDAV_PASSWORD: z.string().optional(),
  WEBDAV_BASE_PATH: z.string().default('/3d-editor'),
  WEBDAV_PROXY: boolish.optional(),
  AUTH_TOKEN: z.string().optional(),
  MCP_ENABLED: boolish.default(true),
  MCP_TOKEN: z.string().optional(),
  MCP_UNDO_STEPS: z.coerce.number().int().min(1).max(10000).default(100),
  MCP_UNDO_MEMORY_MB: z.coerce.number().min(0).max(65536).default(64),
  TELEMETRY_ENABLED: boolish.default(true),
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl.optional(),
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().default('3d-editor-server'),
  LOG_LEVEL: z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .pipe(z.enum(LOG_LEVELS))
    .default('info'),
  CORS_ORIGINS: z.string().optional(),
  APP_VERSION: z.string().optional(),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  EXPORT_DIR: z.string().optional(),
  EXPORT_MAX_MB: z.coerce.number().positive().max(1_048_576).default(20480),
  EXPORT_TTL_HOURS: z.coerce.number().positive().max(87_600).default(168),
  EXPORT_MAX_QUEUED: z.coerce.number().int().min(1).max(1000).default(8),
  STORE_PROVIDERS: z.string().optional(),
  SKETCHFAB_TOKEN: z.string().optional(),
  POLYPIZZA_API_KEY: z.string().optional(),
  STORE_CATALOG_URLS: z.string().optional(),
  MODEL_CACHE_DIR: z.string().optional(),
  MODEL_CACHE_MAX_MB: z.coerce.number().min(0).max(1_048_576).default(2048),
  STORE_FETCH_TIMEOUT_MS: z.coerce.number().int().min(100).max(600_000).default(20_000),
  RIDEO_URL: httpUrl.optional(),
  RIDEO_TOKEN: z.string().optional(),
});

/**
 * How long a shutdown that may take `timeoutMs` in all waits for storage to save the loaded
 * projects: 2 s less, so that the server closes them, logs which stayed unsaved and stops the rest
 * before it exits anyway (half of `timeoutMs` below 4 s). 7 s of the default 9 s.
 */
export function shutdownSaveWait(timeoutMs: number): number {
  return Math.max(timeoutMs - 2000, timeoutMs / 2);
}

/** Normalizes a WebDAV folder path: leading slash, no trailing slash ('' for the root). */
export function normalizeBasePath(p: string): string {
  const parts = p.split('/').filter((s) => s && s !== '.');
  if (parts.includes('..')) throw new Error(`WEBDAV_BASE_PATH must not contain '..': ${p}`);
  return parts.length ? `/${parts.join('/')}` : '';
}

/** Parses `key1=value1,key2=value2` (W3C baggage style, values may be percent-encoded). */
export function parseHeaderList(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of s.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep raw */
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Splits a comma-separated setting into its trimmed, non-empty items. */
function commaList(s: string | undefined): string[] {
  return (s ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * The model store providers of STORE_PROVIDERS (known ids, in the given order, each once); unset:
 * the defaults, plus catalog when catalog URLs are configured.
 */
export function parseStoreProviders(value: string | undefined, hasCatalogUrls: boolean): StoreProviderId[] {
  if (value === undefined)
    return hasCatalogUrls ? [...DEFAULT_STORE_PROVIDERS, 'catalog'] : [...DEFAULT_STORE_PROVIDERS];
  const out: StoreProviderId[] = [];
  for (const raw of commaList(value)) {
    const id = raw.toLowerCase();
    if (!(STORE_PROVIDER_IDS as readonly string[]).includes(id))
      throw new Error(
        `Invalid configuration: STORE_PROVIDERS: unknown provider '${raw}' (known: ${STORE_PROVIDER_IDS.join(', ')})`,
      );
    if (!out.includes(id as StoreProviderId)) out.push(id as StoreProviderId);
  }
  if (out.includes('catalog') && !hasCatalogUrls)
    throw new Error(
      'Invalid configuration: STORE_PROVIDERS lists catalog, which requires STORE_CATALOG_URLS',
    );
  return out;
}

/** The ffmpeg command: a name looked up on the PATH, or a file path (with a slash) made absolute. */
export function resolveExecutable(value: string, cwd: string): string {
  return /[\\/]/.test(value) ? path.resolve(cwd, value) : value;
}

function defaultModuleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Candidate locations of the built PWA, in priority order:
 *  1. `<dir of the bundle>/../public` (Docker image layout: /app/dist/main.js + /app/public)
 *  2. `apps/web/dist` relative to the working directory (running from the repository root)
 *  3. `<dir of the bundle>/../../web/dist` (running from inside apps/server)
 */
export function publicDirCandidates(moduleDir: string, cwd: string): string[] {
  return [
    path.resolve(moduleDir, '..', 'public'),
    path.resolve(cwd, 'apps', 'web', 'dist'),
    path.resolve(moduleDir, '..', '..', 'web', 'dist'),
  ];
}

/**
 * Builds the server configuration from environment variables. Pure with respect to its
 * inputs: pass `process.env` (and optionally a fake file system probe for tests).
 */
export function loadConfig(
  env: Record<string, string | undefined>,
  opts: ConfigEnvironment = {},
): ServerConfig {
  // Treat empty values as unset so `FOO=` in an env file does not override defaults.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string' && v.trim() !== '') cleaned[k] = v.trim();
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;
  const cwd = opts.cwd ?? process.cwd();
  const exists = opts.exists ?? existsSync;
  const moduleDir = opts.moduleDir ?? defaultModuleDir();

  const webdav: WebDAVSettings | null = e.WEBDAV_URL
    ? {
        url: e.WEBDAV_URL.replace(/\/+$/, ''),
        username: e.WEBDAV_USERNAME,
        password: e.WEBDAV_PASSWORD,
        basePath: normalizeBasePath(e.WEBDAV_BASE_PATH),
      }
    : null;
  // without SYNC_PERSISTENCE: WebDAV when WEBDAV_URL is set, else disk when DATA_DIR is set
  // (giving a data directory means "keep my projects there"), else memory
  const persistence: PersistenceMode =
    e.SYNC_PERSISTENCE ?? (webdav ? 'webdav' : cleaned.DATA_DIR ? 'disk' : 'memory');
  if (persistence === 'webdav' && !webdav)
    throw new Error('Invalid configuration: SYNC_PERSISTENCE=webdav requires WEBDAV_URL');

  let publicDir: string | null;
  if (e.PUBLIC_DIR) publicDir = path.resolve(cwd, e.PUBLIC_DIR);
  else
    publicDir = publicDirCandidates(moduleDir, cwd).find((d) => exists(path.join(d, 'index.html'))) ?? null;

  const corsOrigins = (e.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const dataDir = path.resolve(cwd, e.DATA_DIR);
  const storeCatalogUrls = commaList(e.STORE_CATALOG_URLS);
  for (const url of storeCatalogUrls) {
    if (!httpUrl.safeParse(url).success)
      throw new Error(`Invalid configuration: STORE_CATALOG_URLS: expected http(s) URLs, got '${url}'`);
  }
  const storeProviders = parseStoreProviders(e.STORE_PROVIDERS, storeCatalogUrls.length > 0);

  return {
    port: e.PORT,
    host: e.HOST,
    publicDir,
    dataDir,
    persistence,
    roomIdleTtlSeconds: e.ROOM_IDLE_TTL_SECONDS,
    persistDebounceMs: e.PERSIST_DEBOUNCE_MS,
    shutdownTimeoutMs: e.SHUTDOWN_TIMEOUT_SECONDS * 1000,
    shutdownSaveWaitMs: shutdownSaveWait(e.SHUTDOWN_TIMEOUT_SECONDS * 1000),
    webdav,
    webdavProxy: !!webdav && (e.WEBDAV_PROXY ?? true),
    authToken: e.AUTH_TOKEN ?? null,
    mcpEnabled: e.MCP_ENABLED,
    mcpToken: e.MCP_TOKEN ?? null,
    mcpUndoSteps: e.MCP_UNDO_STEPS,
    mcpUndoMemoryBytes: Math.round(e.MCP_UNDO_MEMORY_MB * 1024 * 1024),
    telemetryEnabled: e.TELEMETRY_ENABLED,
    otel: e.OTEL_EXPORTER_OTLP_ENDPOINT
      ? {
          endpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/+$/, ''),
          serviceName: e.OTEL_SERVICE_NAME,
          headers: parseHeaderList(e.OTEL_EXPORTER_OTLP_HEADERS),
        }
      : null,
    logLevel: e.LOG_LEVEL,
    corsOrigins,
    version: e.APP_VERSION ?? PACKAGE_VERSION,
    ffmpegPath: resolveExecutable(e.FFMPEG_PATH, cwd),
    exportDir: e.EXPORT_DIR ? path.resolve(cwd, e.EXPORT_DIR) : path.join(dataDir, 'exports'),
    exportMaxBytes: Math.round(e.EXPORT_MAX_MB * 1024 * 1024),
    exportTtlMs: Math.round(e.EXPORT_TTL_HOURS * 3_600_000),
    exportMaxQueued: e.EXPORT_MAX_QUEUED,
    storeProviders,
    sketchfabToken: e.SKETCHFAB_TOKEN ?? null,
    polypizzaApiKey: e.POLYPIZZA_API_KEY ?? null,
    storeCatalogUrls,
    modelCacheDir: e.MODEL_CACHE_DIR
      ? path.resolve(cwd, e.MODEL_CACHE_DIR)
      : path.join(dataDir, 'model-cache'),
    modelCacheMaxBytes: Math.round(e.MODEL_CACHE_MAX_MB * 1024 * 1024),
    storeFetchTimeoutMs: e.STORE_FETCH_TIMEOUT_MS,
    rideoUrl: e.RIDEO_URL ? e.RIDEO_URL.replace(/\/+$/, '') : null,
    rideoToken: e.RIDEO_TOKEN ?? null,
  };
}
