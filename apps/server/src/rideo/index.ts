import { ToolError } from '../mcp/agent';
import type { ServiceContext } from '../services';

/*
 * The bridge to a rideo server (SPEC §11, phase 2): imports a rideo clip's blocking into a project
 * and pushes an export's clips back as motion references. This is the FOUNDATION stub: the public
 * names are fixed, every operation answers UNAVAILABLE until the bridge lands.
 */

/** Where the bridge talks to (RIDEO_URL, RIDEO_TOKEN; tools may name another server). */
export interface RideoTarget {
  url?: string;
  token?: string;
  /** rideo project id. */
  project: string;
  /** rideo clip id. */
  clip: string;
}

/** Options of {@link RideoBridge.importClip} (rideo_import). */
export interface RideoImportOptions {
  rideo: RideoTarget;
  /** Character ids → actor kinds, overriding what the import infers. */
  cast_overrides?: Record<string, string>;
}

/** Options of {@link RideoBridge.push} (rideo_push). */
export interface RideoPushOptions {
  /** The video export whose clips are pushed. */
  export: string;
  rideo: RideoTarget;
  /** Editor shot ids (default: the shots with physics, tethers, held or thrown props or a camera move). */
  shots?: string[];
  mode?: 'motion' | 'pose' | 'camera';
  pass?: string;
  write_blocking?: boolean;
}

function unavailable(): ToolError {
  return new ToolError('The rideo bridge is not available yet on this server.', 'UNAVAILABLE');
}

/** The rideo bridge of the server. */
export class RideoBridge {
  constructor(protected readonly ctx: ServiceContext) {}

  /** Whether a rideo server is configured (RIDEO_URL). */
  get configured(): boolean {
    return this.ctx.config.rideoUrl !== null;
  }

  /** Imports a rideo clip's blocking into a project (id or name). */
  async importClip(_project: string, _opts: RideoImportOptions): Promise<unknown> {
    throw unavailable();
  }

  /** Writes the blocking back to rideo and pushes an export's clips as motion references. */
  async push(_project: string, _opts: RideoPushOptions): Promise<unknown> {
    throw unavailable();
  }

  /** Stops requests in flight (server shutdown). */
  async close(): Promise<void> {}
}
