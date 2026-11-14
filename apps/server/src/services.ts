import { createOperatorRegistry, type OperatorRegistry } from '@3d-editor/core';
import type { ServerConfig } from './config';
import type { Log } from './observability/log';
import type { ServerMetrics } from './observability/metrics';
import type { RoomManager } from './sync/room-manager';
import { sharedRenderer, type Renderer } from './render';
import { sharedRenderStore, type RenderStore } from './render/store';
import { VideoExports } from './video';
import { ModelStore } from './store';
import { RideoBridge } from './rideo';

/*
 * The services of the server, built once in app.ts and shared by the MCP tools (ToolContext) and
 * the REST routes (registerVideoExportRoutes, registerStoreRoutes, registerRideoRoutes).
 */

export interface ServerServices {
  /** The server-side renderer (the process-wide one, created on first use: render processes start lazily). */
  readonly renderer: Renderer;
  /** Stored render results (render_animation `store`). */
  readonly renderStore: RenderStore;
  /** The operator registry of the server (created on first use when MCP is off). */
  readonly registry: OperatorRegistry;
  /** Video export jobs. */
  readonly exports: VideoExports;
  /** The model store. */
  readonly store: ModelStore;
  /** The bridge to a rideo server. */
  readonly rideo: RideoBridge;
}

/**
 * What each service is built with. A service's constructor must not use `services` (the others
 * may not exist yet): it reads them when it works.
 */
export interface ServiceContext {
  config: ServerConfig;
  log: Log;
  metrics: ServerMetrics;
  /** The loaded projects (open a project with `rooms.open(id)`). */
  rooms: RoomManager;
  /** The other services (the renderer, the registry, the exports for the rideo bridge …). */
  services: ServerServices;
  /** fetch for outbound requests (model providers, rideo); tests inject one. */
  fetch: typeof fetch;
}

export interface ServerServicesOptions {
  config: ServerConfig;
  log: Log;
  metrics: ServerMetrics;
  rooms: RoomManager;
  /** Default: one created on first use. */
  registry?: OperatorRegistry;
  /** Default: the process-wide renderer (see `RENDER_WORKERS`). */
  renderer?: Renderer;
  /** Default: the process-wide render store. */
  renderStore?: RenderStore;
  /** fetch of the model providers and the rideo bridge (default: the global fetch). */
  fetch?: typeof fetch;
}

class Services implements ServerServices {
  readonly renderStore: RenderStore;
  readonly exports: VideoExports;
  readonly store: ModelStore;
  readonly rideo: RideoBridge;
  private registryInstance: OperatorRegistry | null;

  constructor(private readonly opts: ServerServicesOptions) {
    this.renderStore = opts.renderStore ?? sharedRenderStore();
    this.registryInstance = opts.registry ?? null;
    const ctx: ServiceContext = {
      config: opts.config,
      log: opts.log,
      metrics: opts.metrics,
      rooms: opts.rooms,
      services: this,
      fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    };
    this.exports = new VideoExports(ctx);
    this.store = new ModelStore(ctx);
    this.rideo = new RideoBridge(ctx);
  }

  get renderer(): Renderer {
    return this.opts.renderer ?? sharedRenderer({ log: this.opts.log });
  }

  get registry(): OperatorRegistry {
    return (this.registryInstance ??= createOperatorRegistry());
  }
}

/** Builds the services of a server (app.ts). */
export function createServerServices(opts: ServerServicesOptions): ServerServices {
  return new Services(opts);
}

/**
 * Stops the services (the app's preClose: before the projects are saved and closed): cancels
 * export jobs and their ffmpeg processes, model downloads and rideo requests. The renderer is the
 * process's (main.ts closes it).
 */
export async function closeServerServices(services: ServerServices): Promise<void> {
  await Promise.allSettled([services.exports.close(), services.store.close(), services.rideo.close()]);
}
