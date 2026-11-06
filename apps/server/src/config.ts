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
}

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
});

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

  return {
    port: e.PORT,
    host: e.HOST,
    publicDir,
    dataDir: path.resolve(cwd, e.DATA_DIR),
    persistence,
    roomIdleTtlSeconds: e.ROOM_IDLE_TTL_SECONDS,
    persistDebounceMs: e.PERSIST_DEBOUNCE_MS,
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
  };
}
