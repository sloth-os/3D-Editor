import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import type { OperatorRegistry } from '@3d-editor/core';
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

/** Origin of the MCP request (used for editor and download links; links carry no token). */
export function baseUrl(extra: ToolExtra): string {
  const url = extra.requestInfo?.url;
  if (url) return url.origin;
  const host = extra.requestInfo?.headers?.host;
  return typeof host === 'string' ? `http://${host}` : '';
}
