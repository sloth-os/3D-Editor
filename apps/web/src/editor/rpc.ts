import { effect } from '@preact/signals';
import { session, toast } from '../app/store';
import { run, runResult, viewport } from './editor';
import { telemetry } from '../telemetry/telemetry';

/**
 * Handles RPC requests routed by the server from MCP tools to this live editor:
 *  - `render` { width?, height?, camera?, use_viewport? } → { mime, data_base64, width, height }
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
          cameraId: typeof p.camera === 'string' ? (s.doc.resolveObject(p.camera)?.id ?? undefined) : undefined,
          useViewport: !!p.use_viewport,
        });
        return { mime: 'image/png', data_base64: r.dataUrl.split(',')[1], width: r.width, height: r.height };
      }
      if (method === 'ui') return uiCommand(String(p.command ?? ''), (p.params ?? {}) as Record<string, unknown>);
      throw new Error(`unknown RPC method ${method}`);
    });
    return () => provider.setRpcHandler(null);
  });
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
      const type = String(params.type ?? 'FRONT').toUpperCase();
      if (type === 'CAMERA') run('view3d.view_camera', {}, 'mcp');
      else run('view3d.view_axis', { type }, 'mcp');
      return { ok: true };
    }
    case 'view.shading':
      run('view3d.toggle_shading', { type: String(params.type ?? 'SOLID').toUpperCase() }, 'mcp');
      return { ok: true };
    case 'select': {
      const ids = (Array.isArray(params.objects) ? params.objects : []).map((r) => s.doc.resolveObject(String(r))?.id).filter(Boolean) as string[];
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
      const r = await e.renderImage({ useViewport: true, width: Number(params.width) || e.width, height: Number(params.height) || e.height });
      return { mime: 'image/png', data_base64: r.dataUrl.split(',')[1], width: r.width, height: r.height };
    }
    case 'get_view': {
      if (!e) throw new Error('no viewport');
      const p = e.pose;
      return { target: p.target.toArray(), distance: p.distance, yaw: p.yaw, pitch: p.pitch, ortho: p.ortho, camera_view: s.view.cameraView.value };
    }
    default:
      throw new Error(
        `unknown UI command '${command}'. Available: view.frame_all, view.frame_selected, view.set_view, view.shading, select, set_mode, set_frame, play, notify, run_operator, screenshot, get_view`,
      );
  }
}
