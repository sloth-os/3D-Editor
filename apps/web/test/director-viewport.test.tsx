import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  BUILT_KINDS,
  DESK_PROPS,
  HUMANOID_KINDS,
  SceneDoc,
  SceneEvaluator,
  cameraForFrame,
  deskProp,
  getShots,
  type ShotData,
} from '@3d-editor/core';
import { closeDialog, dialog, session as sessionSignal, workspace } from '../src/app/store';
import { hoveredArea, registry, run, runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { registerUiOperators } from '../src/editor/ui-operators';
import { installKeymap } from '../src/editor/keymap';
import { ADD_MENU, RENDER_MENU, VIEW_MENU, type MenuItem } from '../src/editor/menus';
import type { ProjectSession } from '../src/project/session';
import { ViewportEngine } from '../src/viewport/engine';
import { shotPin } from '../src/viewport/follow-shots';
import { ACTION_SAFE_INSET, CameraFrame, ViewportHeader } from '../src/ui/Viewport';

/*
 * The viewport side of the director's desk: Follow Shots (the camera view and the browser's renders
 * look through the camera of the shot at the frame, the shot the sequence strip pinned first), the
 * camera guides (thirds and action safe), their header buttons and View menu entries, Render >
 * Export Video… (Ctrl+Shift+F12) and Add > Actor. WebGL is replaced by a stand-in (happy-dom has
 * none).
 */

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class StubWebGLRenderer {
    domElement: HTMLCanvasElement;
    outputColorSpace: string = three.SRGBColorSpace;
    toneMapping: number = three.NoToneMapping;
    toneMappingExposure = 1;
    shadowMap = { enabled: false, type: three.PCFShadowMap };
    autoClear = true;
    private target: unknown = null;
    constructor(params: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement = params.canvas ?? document.createElement('canvas');
    }
    setPixelRatio() {}
    getPixelRatio() {
      return 1;
    }
    setSize() {}
    getSize(t: InstanceType<typeof three.Vector2>) {
      return t.set(1, 1);
    }
    getClearColor(t: InstanceType<typeof three.Color>) {
      return t;
    }
    getClearAlpha() {
      return 1;
    }
    setClearColor() {}
    setClearAlpha() {}
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    getRenderTarget() {
      return this.target;
    }
    clear() {}
    clearDepth() {}
    render() {}
    readRenderTargetPixels() {}
    compile() {}
    dispose() {}
  }
  class StubPMREMGenerator {
    fromScene() {
      return new three.WebGLRenderTarget(1, 1);
    }
    fromEquirectangular() {
      return new three.WebGLRenderTarget(1, 1);
    }
    compileEquirectangularShader() {}
    dispose() {}
  }
  return { ...three, WebGLRenderer: StubWebGLRenderer, PMREMGenerator: StubPMREMGenerator };
});

/** A session on the default scene (cube, light, scene camera), with undo like the editor's. */
function session(): ProjectSession {
  const doc = SceneDoc.create();
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'director-viewport-test',
    doc,
    undo: new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 }),
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
    schedulePresence: () => undefined,
    sceneStats: () => ({ objects: 3, vertices: 8, faces: 6, triangles: 12 }),
  } as unknown as ProjectSession;
}

function ok(id: string, params: Record<string, unknown>): Record<string, unknown> {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
  return (r.result ?? {}) as Record<string, unknown>;
}

/** A shot over frames start..end with its own camera at x (looking along +Y). */
function addShot(name: string, start: number, end: number, x: number): ShotData {
  ok('desk.shot_add', {
    name,
    frame_start: start,
    frame_end: end,
    from_view: { position: [x, -8, 1.6], target: [x, 0, 1], lens_mm: 35 },
    solve: false,
  });
  return getShots(s.doc).find((shot) => shot.name === name)!;
}

const engines: ViewportEngine[] = [];
function engine(): ViewportEngine {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const e = new ViewportEngine(canvas, s);
  e.width = 800;
  e.height = 600;
  engines.push(e);
  return e;
}

/** Private ViewportEngine.renderCameraId: the camera a render without an explicit view shows. */
type RenderCamera = (opts: {
  cameraId?: string;
  frame?: number | null;
  useViewport?: boolean;
}) => string | null;
const renderCamera = (e: ViewportEngine) =>
  (e as unknown as { renderCameraId: RenderCamera }).renderCameraId.bind(e);

let s: ProjectSession;
beforeAll(() => {
  if (!registry.has('wm.call_menu')) registerUiOperators(registry);
});
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  s = session();
  sessionSignal.value = s;
});
afterEach(() => {
  cleanup();
  for (const e of engines.splice(0)) e.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  sessionSignal.value = null;
  workspace.value = 'Layout';
  closeDialog();
});

describe('follow shots', () => {
  it('looks through the camera of the shot at the frame, the pinned one first, the scene camera between shots', () => {
    const wide = addShot('Wide', 1, 48, 0);
    const close = addShot('Close', 1, 48, 3);
    const later = addShot('Later', 60, 70, 6);
    const e = engine();
    const sceneCamera = s.doc.getScene().camera!;
    const at = (frame: number) => {
      s.state.frame = frame;
      e.sync();
      return e.viewCamera()?.id ?? null;
    };
    s.view.cameraView.value = true;
    // without Follow Shots: the scene camera
    expect(at(10)).toBe(sceneCamera);
    s.view.followShots.value = true;
    expect(at(10)).toBe(wide.camera);
    expect(at(65)).toBe(later.camera);
    expect(at(55)).toBe(sceneCamera);
    shotPin(s.view).value = close.id;
    expect(at(10)).toBe(close.camera);
    // the pin holds only inside its shot
    expect(at(65)).toBe(later.camera);
    // the camera view is drawn from that camera
    at(10);
    const loc = s.doc.getObject(close.camera!)!.location;
    const cam = e.camera;
    expect(cam.position.x).toBeCloseTo(loc[0], 4);
    expect(cam.position.y).toBeCloseTo(loc[1], 4);
    expect(cam.position.z).toBeCloseTo(loc[2], 4);
  });

  it('renders through the followed camera: F12 the shown one, each animation frame its own shot', () => {
    const wide = addShot('Wide', 1, 48, 0);
    const close = addShot('Close', 1, 48, 3);
    const e = engine();
    const cam = renderCamera(e);
    const sceneCamera = s.doc.getScene().camera!;
    s.state.frame = 10;
    shotPin(s.view).value = close.id;
    expect(cam({})).toBe(sceneCamera);
    s.view.followShots.value = true;
    // F12 of the current frame: what the camera view shows (the pinned shot)
    expect(cam({})).toBe(close.camera);
    // a frame of Render Animation: the cut as cameraForFrame has it
    expect(cam({ frame: 10 })).toBe(wide.camera);
    expect(cam({ frame: 10 })).toBe(cameraForFrame(s.doc, 10));
    expect(cam({ frame: 55 })).toBe(sceneCamera);
    // an explicit camera wins; a capture of the viewport outside the camera view shows the viewport
    expect(cam({ cameraId: sceneCamera })).toBe(sceneCamera);
    expect(cam({ useViewport: true })).toBeNull();
    s.view.cameraView.value = true;
    expect(cam({ useViewport: true })).toBe(close.camera);
  });

  it('names the shot shown in the camera frame', () => {
    addShot('Wide', 1, 48, 0);
    const e = engine();
    s.view.cameraView.value = true;
    s.state.frame = 5;
    e.sync();
    const { container } = render(<CameraFrame engine={e} />);
    const label = () => container.querySelector('[data-testid="camera-frame-shot"]');
    expect(label()).toBeNull();
    act(() => {
      s.view.followShots.value = true;
    });
    expect(label()?.textContent).toBe('Wide');
    act(() => {
      s.state.frame = 50;
    });
    expect(label()?.textContent).toBe('No shot at this frame');
  });
});

describe('camera guides', () => {
  it('draws thirds and the action-safe frame inside the camera frame, toggled by the operator', () => {
    const e = engine();
    s.view.cameraView.value = true;
    e.sync();
    const { container } = render(<CameraFrame engine={e} />);
    const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    expect(q('camera-guides')).toBeNull();
    act(() => void run('view3d.toggle_camera_guides', {}, 'ui'));
    expect(s.view.cameraGuides.value).toBe(true);
    const guides = q('camera-guides')!;
    // inside the frame (the guides scale with it)
    expect(q('camera-frame')!.firstElementChild!.contains(guides)).toBe(true);
    const lines = [...q('camera-guide-thirds')!.querySelectorAll('line')].map((l) =>
      ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a)).toFixed(3)),
    );
    expect(lines).toEqual([
      ['33.333', '0.000', '33.333', '100.000'],
      ['0.000', '33.333', '100.000', '33.333'],
      ['66.667', '0.000', '66.667', '100.000'],
      ['0.000', '66.667', '100.000', '66.667'],
    ]);
    // one pixel wide whatever the frame's size: vector-effect is not inherited, so each shape has it
    // (on the group only, the lines of the stretched view box were a percent of the frame wide)
    const shapes = [...q('camera-guides')!.querySelectorAll('line, rect')];
    expect(shapes).toHaveLength(5);
    for (const shape of shapes) {
      expect(shape.getAttribute('vector-effect')).toBe('non-scaling-stroke');
      expect(shape.getAttribute('stroke-width')).toBe('1');
    }
    const safe = q('camera-guide-action-safe')!;
    expect(ACTION_SAFE_INSET).toBe(0.035);
    expect(Number(safe.getAttribute('x'))).toBeCloseTo(3.5, 6);
    expect(Number(safe.getAttribute('width'))).toBeCloseTo(93, 6);
    // hidden with the overlays
    act(() => {
      s.view.overlays.value = false;
    });
    expect(q('camera-guides')).toBeNull();
    act(() => {
      s.view.overlays.value = true;
    });
    act(() => void run('view3d.toggle_camera_guides', {}, 'ui'));
    expect(q('camera-guides')).toBeNull();
  });

  it('offers both toggles in the header in camera view and in the Director workspace', () => {
    const { container } = render(<ViewportHeader s={s} />);
    const q = (id: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    expect(q('toggle-follow-shots')).toBeNull();
    act(() => {
      s.view.cameraView.value = true;
    });
    act(() => void fireEvent.click(q('toggle-follow-shots')!));
    expect(s.view.followShots.value).toBe(true);
    expect(q('toggle-follow-shots')!.getAttribute('aria-pressed')).toBe('true');
    act(() => void fireEvent.click(q('toggle-camera-guides')!));
    expect(s.view.cameraGuides.value).toBe(true);
    expect(q('toggle-camera-guides')!.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      s.view.cameraView.value = false;
    });
    expect(q('toggle-follow-shots')).toBeNull();
    act(() => {
      workspace.value = 'Director';
    });
    expect(q('toggle-follow-shots')).not.toBeNull();
  });
});

const resolve = (items: MenuItem['submenu']): MenuItem[] =>
  !items ? [] : typeof items === 'function' ? items() : items;

describe('menus and keys', () => {
  it('View has Follow Shots and Camera Guides with their state', () => {
    const items = VIEW_MENU();
    const follow = items.find((i) => i.label === 'Follow Shots')!;
    const guides = items.find((i) => i.label === 'Camera Guides')!;
    expect(follow.op).toBe('view3d.toggle_follow_shots');
    expect(guides.op).toBe('view3d.toggle_camera_guides');
    expect(follow.checked!()).toBe(false);
    s.view.followShots.value = true;
    expect(follow.checked!()).toBe(true);
    s.view.cameraGuides.value = true;
    expect(guides.checked!()).toBe(true);
  });

  it('Render > Export Video… and Ctrl+Shift+F12 open the Export Video window', () => {
    const item = RENDER_MENU().find((i) => i.label === 'Export Video…')!;
    expect(item.op).toBe('wm.export_video');
    expect(item.shortcut).toBe('Ctrl Shift F12');
    act(() => void run(item.op!, item.params, 'menu'));
    expect(dialog.value).toBe('export-video');
    closeDialog();
    const uninstall = installKeymap();
    try {
      hoveredArea.value = 'viewport';
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'F12', code: 'F12', ctrlKey: true, shiftKey: true }),
      );
      expect(dialog.value).toBe('export-video');
    } finally {
      uninstall();
    }
  });

  it('Add > Actor offers every built kind, people first, and adds one at the 3D cursor', () => {
    const actor = ADD_MENU.find((i) => i.label === 'Actor')!;
    const items = resolve(actor.submenu);
    const titles = items.filter((i) => i.title).map((i) => i.title);
    expect(titles).toEqual(['People', 'Animals']);
    const kinds = items.filter((i) => i.op).map((i) => (i.params as { kind: string }).kind);
    expect([...kinds].sort()).toEqual([...BUILT_KINDS].sort());
    const firstAnimal = kinds.findIndex((k) => !(HUMANOID_KINDS as readonly string[]).includes(k));
    expect(kinds.slice(0, firstAnimal).every((k) => (HUMANOID_KINDS as readonly string[]).includes(k))).toBe(
      true,
    );
    for (const i of items.filter((x) => x.op)) {
      expect(i.op).toBe('desk.actor_add');
      expect(() => registry.parseParams(i.op!, i.params ?? {})).not.toThrow();
    }
    expect(items.find((i) => i.label === 'Small Dog')).toBeDefined();
    s.state.cursorLocation = [1, 2, 0];
    const adult = items.find((i) => (i.params as { kind?: string } | undefined)?.kind === 'adult')!;
    expect(run(adult.op!, adult.params, 'menu')).toBe(true);
    const added = s.doc.listObjects().find((o) => deskProp(o, DESK_PROPS.role) === 'actor')!;
    expect(deskProp(added, DESK_PROPS.kind)).toBe('adult');
    expect(added.location.slice(0, 2)).toEqual([1, 2]);
  });
});
