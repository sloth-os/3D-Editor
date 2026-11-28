import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { OperatorRegistry } from '@3d-editor/core';
import { forwardedPrefix } from '../base-path';
import type { ServerConfig } from '../config';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import type { RoomManager } from '../sync/room-manager';
import type { Renderer } from '../render';
import type { RenderStore } from '../render/store';
import type { VideoExports } from '../video';
import type { ModelStore } from '../store';
import type { AgentSession } from './agent';
import type { HistoryLimits } from './history';

/*
 * What the MCP tools of every module share: the context they run in, the type of the registrar
 * that adds a tool (tools.ts `tool()`), the argument schemas used by many tools and the
 * annotations. tools.ts registers the editor's tools and hands its registrar to the feature
 * modules (video-tools.ts, store-tools.ts, brief-tools.ts), which register theirs with it.
 *
 * Registration must not read the context's members: a test registers every tool with a context
 * that holds only `historyLimits` (docs-history.test.ts). Handlers read `ctx` when they run.
 */

export { strictArgObject } from './strict-args';

export interface ToolContext {
  agent: AgentSession;
  rooms: RoomManager;
  registry: OperatorRegistry;
  config: ServerConfig;
  metrics: ServerMetrics;
  log: Log;
  /** Server-side renderer (render processes). */
  renderer: Renderer;
  /** Stored render results (render_animation `store`). */
  renderStore: RenderStore;
  /** Video export jobs (export_video, export_status, cancel_export, list_exports). */
  exports: VideoExports;
  /** The model store (store_search, store_add). */
  store: ModelStore;
  /** Limits of the agents' undo histories (for descriptions and notes). */
  historyLimits: HistoryLimits;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
/** What a tool's handler returns: a result, or an object or array that becomes its JSON text. */
export type ToolOutput = CallToolResult | Record<string, unknown> | unknown[];

/** Title, description and hints of a tool. */
export interface ToolMeta {
  title: string;
  description: string;
  annotations?: ToolAnnotations;
  /**
   * Added to the error of an unknown argument that is not a typo of a valid one (e.g. that
   * operator parameters belong in `params`).
   */
  argsHint?: string;
}

export type ToolHandler<S extends z.ZodRawShape> = (
  args: z.output<z.ZodObject<S>>,
  extra: ToolExtra,
) => Promise<ToolOutput> | ToolOutput;

/**
 * Registers a tool (tools.ts `tool()`): strict arguments (unknown or misspelled names fail with
 * suggestions, the input schema in tools/list is closed), metrics, a tracing span, project notes,
 * and errors as results: a ToolError's message on one line, followed by `{"code": …}` as JSON for
 * OUT_OF_MEMORY and the service codes (agent.ts codedErrorDetails).
 */
export type ToolRegistrar = <S extends z.ZodRawShape>(
  name: string,
  meta: ToolMeta,
  shape: S,
  handler: ToolHandler<S>,
) => void;

// ------------------------------------------------------------------ shared schemas

export const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const color = z.union([vec3, vec4]).describe('Linear RGB or RGBA, components 0..1');
export const projectArg = z
  .string()
  .min(1)
  .describe(
    'Project id or name (see list_projects): the exact name, or, when no project has it, the name in another letter case',
  );
export const objectArg = z.string().min(1).describe('Object id or exact object name');
export const objectList = z.array(z.string().min(1)).min(1).describe('Object ids or exact names');

// ------------------------------------------------------------------ annotations

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
export const EDIT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

// ------------------------------------------------------------------ helpers

/** The last value of a header a proxy may append to (`a, b`: `b`), as Fastify reads them. */
function lastHeaderValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  return raw?.split(',').pop()?.trim() || undefined;
}

const COLON = 58;
const OPEN_BRACKET = 91;

/**
 * Whether a char code is an ASCII letter or digit, `.`, `-` or `_`: what a host name or IPv4 address
 * is made of (`_` in Docker's service names, `docker_svc`, which the URL parser keeps as they are).
 */
function isHostNameChar(c: number): boolean {
  const lower = c | 0x20;
  return (lower >= 97 && lower <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 45 || c === 95;
}

/** Whether a char code may be in a bracketed IPv6 address: hex digits, `:` and `.` (an IPv4 tail). */
function isIPv6Char(c: number): boolean {
  const lower = c | 0x20;
  return (lower >= 97 && lower <= 102) || (c >= 48 && c <= 57) || c === COLON || c === 46;
}

/**
 * Whether a Host or X-Forwarded-Host value is a host and an optional port, and nothing else: a name
 * or IPv4 address of ASCII letters, digits, `.`, `-` and `_` (`example.com`, `127.0.0.1`,
 * `docker_svc`), or an IPv6 address in brackets (`[::1]`), then `:port` with a port from 1 to 65535.
 * A quote, a brace, `@`, `/` or a space never reaches a link. Time linear in the value's length.
 */
export function isHostAndPort(value: string): boolean {
  let i = 0;
  if (value.charCodeAt(0) === OPEN_BRACKET) {
    const close = value.indexOf(']');
    if (close < 3) return false;
    for (i = 1; i < close; i++) if (!isIPv6Char(value.charCodeAt(i))) return false;
    i = close + 1;
  } else {
    while (i < value.length && isHostNameChar(value.charCodeAt(i))) i++;
    if (i === 0) return false;
  }
  if (i === value.length) return true;
  if (value.charCodeAt(i) !== COLON) return false;
  const port = value.slice(i + 1);
  if (port.length === 0 || port.length > 5) return false;
  for (let j = 0; j < port.length; j++) {
    const c = port.charCodeAt(j);
    if (c < 48 || c > 57) return false;
  }
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** `scheme://host[:port]` as a URL origin (lowercased, default port dropped), or null when invalid. */
function originOf(scheme: string, host: string | undefined): string | null {
  // a host and port only (isHostAndPort), then what the URL parser accepts of it
  if (!host || !isHostAndPort(host)) return null;
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * The address of this server as the MCP client reached it, for the links of results (editor and
 * download links; links carry no token): the scheme and host of the last values of
 * X-Forwarded-Proto and X-Forwarded-Host when a proxy sends usable ones (as Fastify reads them
 * with trustProxy; a host as isHostAndPort accepts it), else the scheme of the connection and the
 * Host header (the request URL the MCP transport builds from them: the scheme and authority of an
 * absolute-form request target are not read), then the base path (X-Forwarded-Prefix when usable,
 * else BASE_PATH), without a trailing slash: `https://example.com/3d` (docs/subpath.md). With an
 * HTTP request whose hosts are none of them usable (a Host isHostAndPort refuses, `a"b`, and no
 * usable X-Forwarded-Host), the base alone: the links are then paths under the editor's base
 * (`/3d/?project=…`), never paths from the root of a site the editor may share. A request without a
 * Host gets no links: the MCP transport answers it 400 before any tool runs (Node itself refuses
 * HTTP/1.1 without one). '' without an HTTP request (an in-memory client): the links are then paths
 * from the server's root, as REST gives them.
 */
export function baseUrl(extra: ToolExtra, config: Pick<ServerConfig, 'basePath'>): string {
  const info = extra.requestInfo;
  if (!info) return '';
  const headers = info.headers;
  const forwardedScheme = lastHeaderValue(headers['x-forwarded-proto'])?.toLowerCase();
  const scheme =
    forwardedScheme === 'http' || forwardedScheme === 'https'
      ? forwardedScheme
      : (info.url?.protocol.slice(0, -1) ?? 'http');
  const host = info.url?.host ?? (typeof headers.host === 'string' ? headers.host : undefined);
  const origin = originOf(scheme, lastHeaderValue(headers['x-forwarded-host'])) ?? originOf(scheme, host);
  return `${origin ?? ''}${forwardedPrefix(headers['x-forwarded-prefix']) ?? config.basePath}`;
}
