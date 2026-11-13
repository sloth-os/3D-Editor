import { effect } from '@preact/signals';
import type { EditorMode } from '@3d-editor/core';
import { session, toast, toasts } from '../app/store';
import { runResult, viewport } from './editor';
import { telemetry } from '../telemetry/telemetry';
import type { RenderImageOptions } from '../viewport/engine';

/**
 * Handles RPC requests routed by the server from MCP tools to this live editor:
 *  - `render` { width?, height?, camera?, use_viewport?, view?, shading?, frame?, engine?, samples?,
 *    max_bounces?, denoise?, time_limit?, seed? } → { mime, data_base64, width, height }; rasterized
 *    unless `engine` is PATHTRACER (see {@link rpcRenderEngineOptions}), a final render of the scene
 *    (see {@link rpcRenderShading})
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
          // an unknown camera is reported by the render, not replaced by the scene camera
          cameraId:
            typeof p.camera === 'string' ? (s.doc.resolveObject(p.camera)?.id ?? p.camera) : undefined,
          useViewport: !!p.use_viewport,
          view:
            (p.view as {
              position: number[];
              target: number[];
              up?: number[];
              fov_degrees?: number;
            } | null) ?? null,
          shading: rpcRenderShading(p.shading),
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

/**
 * The viewport shading of an RPC `render` (MCP `render_image {shading}`). MCP names the look of the
 * image, not a viewport shading: MATERIAL (its default) is materials, lights and the world, the look
 * of a final render (the viewport's Material Preview would light the scene with a studio HDRI and
 * show it instead of the world); SOLID is grey clay shading in front of the world colour. Null when
 * not given: a final render is then drawn like MATERIAL, a capture (`use_viewport`) in the shading
 * the viewport shows (see ViewportEngine.renderPixels). Unknown values are an error.
 */
export function rpcRenderShading(shading: unknown): 'RENDERED' | 'SOLID' | null {
  if (shading === undefined || shading === null) return null;
  const v = String(shading).toUpperCase();
  if (v === 'MATERIAL' || v === 'RENDERED') return 'RENDERED';
  if (v === 'SOLID') return 'SOLID';
  throw new Error(
    `Unknown shading '${String(shading)}': use MATERIAL (materials, lights and the world) or SOLID (grey clay)`,
  );
}

const VIEW_TYPES = ['FRONT', 'BACK', 'RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'CAMERA'] as const;
const SHADING_TYPES = ['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED'] as const;
/** Modes of `set_mode` (object.mode_set). */
const MODES = ['OBJECT', 'EDIT', 'SCULPT', 'VERTEX_PAINT'] as const satisfies readonly EditorMode[];

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

/**
 * A numeric UI command parameter: a finite number (a numeric string is accepted too). A missing
 * parameter or anything else is an error that names the parameter and what was given.
 */
export function uiNumberParam(params: Record<string, unknown>, key: string): number {
  const raw = params[key];
  const v = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(
      raw === undefined || raw === null
        ? `'${key}' is required: a number`
        : `'${key}' must be a number, got ${JSON.stringify(raw)}`,
    );
  return v;
}

/**
 * A boolean UI command parameter: true or false (also the strings "true" / "false" in any case, and
 * 1 / 0); `fallback` when it is not given. Anything else is an error that names the parameter.
 */
export function uiBooleanParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const raw = params[key];
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'boolean') return raw;
  if (raw === 1 || raw === 0) return raw === 1;
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'true' || v === 'false') return v === 'true';
  throw new Error(`'${key}' must be true or false, got ${JSON.stringify(raw)}`);
}

/**
 * Runs an operator for an MCP agent's UI command: `{ok: true, result?}`, or `{ok: false, error}` with
 * the operator's reason. The agent gets the reason; the person at this editor, who did not cause the
 * failure, gets no error toast for it (it stays in the Info log).
 */
function runForAgent(id: string, params?: unknown): { ok: boolean; error?: string; result?: unknown } {
  const shown = toasts.value;
  const r = runResult(id, params, 'mcp');
  if (r?.ok) return r.result === undefined ? { ok: true } : { ok: true, result: r.result };
  if (toasts.value !== shown)
    toasts.value = toasts.value.filter((t) => shown.includes(t) || t.level !== 'error');
  return { ok: false, error: r?.error ?? 'No project is open in this editor' };
}

/**
 * Runs a UI command of an RPC `ui` request (MCP `editor_command`) in this editor; invalid parameters
 * are errors that say what is wrong, and leave the editor as it was. A command that cannot be done
 * (no active mesh for Edit Mode, no scene camera, …) returns `ok: false` and the reason in `error`.
 */
export async function uiCommand(command: string, params: Record<string, unknown>): Promise<unknown> {
  const s = session.value!;
  const e = viewport.engine;
  switch (command) {
    case 'view.frame_all':
      return runForAgent('view3d.view_all', {});
    case 'view.frame_selected':
      return runForAgent('view3d.view_selected', {});
    case 'view.set_view': {
      const type = uiEnumParam(params, ['view', 'type'], VIEW_TYPES, 'FRONT');
      // view3d.view_camera toggles the camera view: asked for the camera, the agent gets it whatever
      // the view is now
      if (type === 'CAMERA' && s.view.cameraView.value && s.doc.getScene().camera)
        return { ok: true, view: type };
      const r =
        type === 'CAMERA' ? runForAgent('view3d.view_camera', {}) : runForAgent('view3d.view_axis', { type });
      return r.ok ? { ok: true, view: type } : { ok: false, view: type, error: r.error };
    }
    case 'view.shading': {
      const type = uiEnumParam(params, ['shading', 'type'], SHADING_TYPES, 'SOLID');
      // view3d.toggle_shading switches WIREFRAME back to SOLID: the agent gets the shading it asks for
      const r = s.view.shading.value === type ? { ok: true } : runForAgent('view3d.toggle_shading', { type });
      return r.ok
        ? { ok: true, shading: s.view.shading.value }
        : { ok: false, shading: s.view.shading.value, error: r.error };
    }
    case 'select': {
      // objects (names or ids; the last one becomes active); none or [] deselects everything
      const refs = params.objects ?? [];
      const list = typeof refs === 'string' ? [refs] : refs;
      if (!Array.isArray(list) || list.some((r) => typeof r !== 'string'))
        throw new Error(`'objects' must be a list of object names or ids, got ${JSON.stringify(refs)}`);
      const found = list.map((r) => s.doc.resolveObject(r));
      const missing = list.filter((_, i) => !found[i]);
      if (missing.length)
        throw new Error(
          `Object${missing.length === 1 ? '' : 's'} not found: ${missing.join(', ')} (selection unchanged). Objects: ${s.doc
            .listObjects()
            .map((o) => o.name)
            .slice(0, 50)
            .join(', ')}`,
        );
      const ids = [...new Set(found.map((o) => o!.id))];
      s.state.selectedIds = ids;
      s.state.activeId = ids[ids.length - 1] ?? null;
      return { selected: ids, names: ids.map((id) => s.doc.getObject(id)?.name ?? id) };
    }
    case 'set_mode': {
      // `mode` is the editor's mode afterwards (unchanged when the switch failed)
      const r = runForAgent('object.mode_set', { mode: uiEnumParam(params, ['mode'], MODES, 'OBJECT') });
      return r.ok ? { ok: true, mode: s.state.mode } : { ok: false, mode: s.state.mode, error: r.error };
    }
    case 'set_frame':
      s.state.frame = uiNumberParam(params, 'frame');
      return { frame: s.state.frame };
    case 'play':
      s.view.playing.value = uiBooleanParam(params, 'playing', true);
      return { playing: s.view.playing.value };
    case 'notify':
      toast(String(params.message ?? ''), 'info', 6000);
      return { ok: true };
    case 'run_operator': {
      const r = runForAgent(String(params.operator), params.params);
      return { ok: r.ok, error: r.error, result: r.result };
    }
    case 'screenshot': {
      // The viewport's view without overlays, in the shading it shows now unless `shading` names
      // one of the viewport's shadings (MATERIAL: Material Preview), with the viewport's
      // multisampling, or with the other sample count when that shading was drawn with that one
      // only (ViewportEngine.captureSamples). The first picture in a shading this editor has not
      // drawn yet builds that shading's materials and compiles their shaders. The materials of
      // every shading drawn are kept (scene-objects.ts ObjectView.materialSets), and a changed one
      // is built again and gets the shader program of the one it replaces when only values
      // changed, so a picture in a shading this editor has drawn compiles nothing unless a material
      // changed so that it needs another shader. It costs a frame of its own shading, not of the
      // viewport's, and work of its own: it waits for the frames the GPU still draws for the
      // viewport, syncs the scene to its shading (in Rendered shading with shadows, the point and
      // spot light shadow maps are drawn again), draws into render targets of its size, reads the
      // pixels back and encodes a PNG; the viewport syncs back for its next frame. Measured costs:
      // docs/mcp.md (editor_command, `screenshot`). RENDERED is rasterized (WebGL), also when the
      // render engine is PATHTRACER (see ViewportEngine.pathTraces).
      const shading = uiEnumParam(params, ['shading'], SHADING_TYPES, s.view.shading.value);
      if (!e) throw new Error('no viewport');
      const r = await e.renderImage({
        useViewport: true,
        shading,
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
        `unknown UI command '${command}'. Available: view.frame_all, view.frame_selected, view.set_view {view: ${VIEW_TYPES.join('|')}}, view.shading {shading: ${SHADING_TYPES.join('|')}}, select {objects: [names]}, set_mode {mode: ${MODES.join('|')}}, set_frame {frame: number}, play {playing: true|false}, notify {message}, run_operator {operator, params}, screenshot {width?, height?, shading?: ${SHADING_TYPES.join('|')}}, get_view`,
      );
  }
}
