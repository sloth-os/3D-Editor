import { effect } from '@preact/signals';
import { session, toast } from '../app/store';
import { run, runResult, viewport } from './editor';
import { telemetry } from '../telemetry/telemetry';
import type { RenderImageOptions } from '../viewport/engine';

/**
 * Handles RPC requests routed by the server from MCP tools to this live editor:
 *  - `render` { width?, height?, camera?, use_viewport?, view?, shading?, frame?, engine?, samples?,
 *    max_bounces?, denoise?, time_limit?, seed? } → { mime, data_base64, width, height }; rasterized
 *    unless `engine` is PATHTRACER (see {@link rpcRenderEngineOptions})
 *  - `ui` { command, params } → result of a UI command (view changes, selection, modes,
 *    operators that need the browser, screenshots)
 */
export function installRpcHandler(): () => void {
  return effect(() => {
    const s = session.value;
    const provider = s?.provider;
    if (!s || !provider) return;
    provider.setRpcHandler(async (method, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      telemetry.count('editor.rpc.received', 1, { method });
      if (method === 'render') {
        const e = viewport.engine;
        if (!e) throw new Error('editor has no active viewport');
        const r = await e.renderImage({
          width: typeof p.width === 'number' ? p.width : undefined,
          height: typeof p.height === 'number' ? p.height : undefined,
          cameraId:
            typeof p.camera === 'string' ? (s.doc.resolveObject(p.camera)?.id ?? undefined) : undefined,
          useViewport: !!p.use_viewport,
          view:
            (p.view as {
              position: number[];
              target: number[];
              up?: number[];
              fov_degrees?: number;
            } | null) ?? null,
          shading:
            typeof p.shading === 'string'
              ? (p.shading.toUpperCase() as 'SOLID' | 'MATERIAL' | 'RENDERED' | 'WIREFRAME')
              : null,
          frame: typeof p.frame === 'number' ? p.frame : null,
          ...rpcRenderEngineOptions(p),
        });
        return { mime: 'image/png', data_base64: r.dataUrl.split(',')[1], width: r.width, height: r.height };
      }
      if (method === 'ui')
        return uiCommand(String(p.command ?? ''), (p.params ?? {}) as Record<string, unknown>);
      throw new Error(`unknown RPC method ${method}`);
    });
    return () => provider.setRpcHandler(null);
  });
}

/**
 * Engine options of an RPC `render` request. The server delegates rasterized renders to editors
 * (it path traces on its own worker pool), so the engine is RASTER unless the request names
 * `engine: 'PATHTRACER'`; then `samples`, `max_bounces`, `denoise`, `time_limit` (seconds) and
 * `seed` are honoured and the image is path traced on this editor's render workers.
 */
export function rpcRenderEngineOptions(p: Record<string, unknown>): RenderImageOptions {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  if (p.engine !== 'PATHTRACER') return { engine: 'RASTER' };
  const o: RenderImageOptions = { engine: 'PATHTRACER' };
  if (num(p.samples) !== undefined) o.samples = Math.max(1, Math.round(num(p.samples)!));
  if (num(p.max_bounces) !== undefined) o.max_bounces = Math.max(0, Math.round(num(p.max_bounces)!));
  if (typeof p.denoise === 'boolean') o.denoise = p.denoise;
  if (num(p.time_limit) !== undefined) o.time_limit = Math.max(0, num(p.time_limit)!);
  if (num(p.seed) !== undefined) o.seed = Math.round(num(p.seed)!);
  return o;
}

const VIEW_TYPES = ['FRONT', 'BACK', 'RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'CAMERA'] as const;
const SHADING_TYPES = ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'] as const;

/**
 * An enum parameter of a UI command, read from the first of `keys` that is given (MCP documents
 * `view.set_view {view}`; `type` is accepted too), case-insensitive; `fallback` when none is given.
 * Unknown values are an error that lists the valid ones.
 */
export function uiEnumParam<T extends string>(
  params: Record<string, unknown>,
  keys: readonly string[],
  values: readonly T[],
  fallback: T,
): T {
  const key = keys.find((k) => params[k] !== undefined && params[k] !== null);
  if (!key) return fallback;
  const v = String(params[key]).toUpperCase();
  if (!(values as readonly string[]).includes(v))
    throw new Error(`Unknown ${key} '${String(params[key])}': use one of ${values.join(', ')}`);
  return v as T;
}

async function uiCommand(command: string, params: Record<string, unknown>): Promise<unknown> {
  const s = session.value!;
  const e = viewport.engine;
  switch (command) {
    case 'view.frame_all':
      run('view3d.view_all', {}, 'mcp');
      return { ok: true };
    case 'view.frame_selected':
      run('view3d.view_selected', {}, 'mcp');
      return { ok: true };
    case 'view.set_view': {
      const type = uiEnumParam(params, ['view', 'type'], VIEW_TYPES, 'FRONT');
      const ok =
        type === 'CAMERA' ? run('view3d.view_camera', {}, 'mcp') : run('view3d.view_axis', { type }, 'mcp');
      return { ok, view: type };
    }
    case 'view.shading': {
      const type = uiEnumParam(params, ['shading', 'type'], SHADING_TYPES, 'SOLID');
      return { ok: run('view3d.toggle_shading', { type }, 'mcp'), shading: type };
    }
    case 'select': {
      const ids = (Array.isArray(params.objects) ? params.objects : [])
        .map((r) => s.doc.resolveObject(String(r))?.id)
        .filter(Boolean) as string[];
      s.state.selectedIds = ids;
      s.state.activeId = ids[ids.length - 1] ?? null;
      return { selected: ids };
    }
    case 'set_mode':
      return { ok: run('object.mode_set', { mode: String(params.mode ?? 'OBJECT').toUpperCase() }, 'mcp') };
    case 'set_frame':
      s.state.frame = Number(params.frame ?? 1);
      return { frame: s.state.frame };
    case 'play':
      s.view.playing.value = params.playing !== false;
      return { playing: s.view.playing.value };
    case 'notify':
      toast(String(params.message ?? ''), 'info', 6000);
      return { ok: true };
    case 'run_operator': {
      const r = runResult(String(params.operator), params.params, 'mcp');
      return r ? { ok: r.ok, error: r.error, result: r.result } : { ok: false };
    }
    case 'screenshot': {
      if (!e) throw new Error('no viewport');
      const r = await e.renderImage({
        useViewport: true,
        width: Number(params.width) || e.width,
        height: Number(params.height) || e.height,
      });
      return { mime: 'image/png', data_base64: r.dataUrl.split(',')[1], width: r.width, height: r.height };
    }
    case 'get_view': {
      if (!e) throw new Error('no viewport');
      const p = e.pose;
      return {
        target: p.target.toArray(),
        distance: p.distance,
        yaw: p.yaw,
        pitch: p.pitch,
        ortho: p.ortho,
        camera_view: s.view.cameraView.value,
      };
    }
    default:
      throw new Error(
        `unknown UI command '${command}'. Available: view.frame_all, view.frame_selected, view.set_view {view: ${VIEW_TYPES.join('|')}}, view.shading {shading: ${SHADING_TYPES.join('|')}}, select, set_mode, set_frame, play, notify, run_operator, screenshot, get_view`,
      );
  }
}
