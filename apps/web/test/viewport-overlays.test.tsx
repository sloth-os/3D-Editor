import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator, type ObjectData } from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { ViewportEngine } from '../src/viewport/engine';
import { CameraFrame, InfoOverlay, PeerCursors } from '../src/ui/Viewport';
import { slowFrameCompiled, slowFrameMs } from '../src/telemetry/perf';

/*
 * The viewport's Overlays toggle hides every overlay, like Blender: the object helpers (cameras,
 * lights, empties, bones, curves without a surface), wireframe overlays, the edit-mode cage, the
 * camera frame, the text info and the statistics. WebGL is replaced by a stand-in (happy-dom has
 * none); only what the engine puts on screen is checked.
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

/** A session on the default scene (cube, light, camera) plus an empty and a wire curve. */
function session(): ProjectSession {
  const doc = SceneDoc.create();
  doc.addObject({ name: 'Marker', type: 'EMPTY', location: [2, 0, 0] });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'viewport-overlays-test',
    doc,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    schedulePresence: () => undefined,
    sceneStats: () => ({ objects: 4, vertices: 8, faces: 6, triangles: 12 }),
  } as unknown as ProjectSession;
}

const engines: ViewportEngine[] = [];
function engine(s: ProjectSession): ViewportEngine {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const e = new ViewportEngine(canvas, s);
  engines.push(e);
  return e;
}

const byType = (s: ProjectSession, type: ObjectData['type']) =>
  s.doc.listObjects().find((o) => o.type === type)!;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  cleanup();
  for (const e of engines.splice(0)) e.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('viewport overlays toggle', () => {
  it('hides the camera, light and empty helpers and their pick proxies', () => {
    // regression: helpers were drawn (and clickable) whatever the Overlays toggle said
    const s = session();
    const e = engine(s);
    const ids = (['CAMERA', 'LIGHT', 'EMPTY'] as const).map((t) => byType(s, t).id);
    e.sync();
    for (const id of ids) {
      const v = e.objects.views.get(id)!;
      expect(v.helper?.visible).toBe(true);
      expect(e.objects.pickables()).toContain(v.pickProxy);
    }
    s.view.overlays.value = false;
    e.sync();
    for (const id of ids) {
      const v = e.objects.views.get(id)!;
      expect(v.helper?.visible).toBe(false);
      expect(e.objects.pickables()).not.toContain(v.pickProxy);
    }
    // the meshes stay on screen and pickable
    const cube = e.objects.views.get(byType(s, 'MESH').id)!;
    expect(cube.mesh?.visible).toBe(true);
    expect(e.objects.pickables()).toContain(cube.mesh);
    s.view.overlays.value = true;
    e.sync();
    for (const id of ids) expect(e.objects.views.get(id)!.helper?.visible).toBe(true);
  });

  it('hides wireframe overlays but keeps the wires of Wireframe shading', () => {
    const s = session();
    const e = engine(s);
    const cube = byType(s, 'MESH');
    s.view.showWireframe.value = true;
    e.sync();
    const wire = () => e.objects.views.get(cube.id)!.wire;
    expect(wire()?.visible).toBe(true);
    s.view.overlays.value = false;
    e.sync();
    expect(wire()?.visible ?? false).toBe(false);
    // an object displayed as wire is drawn by the overlays too
    s.view.showWireframe.value = false;
    s.doc.updateObject(cube.id, { display_type: 'WIRE' });
    e.sync();
    expect(wire()?.visible ?? false).toBe(false);
    s.view.overlays.value = true;
    e.sync();
    expect(wire()?.visible).toBe(true);
    // Wireframe shading draws wires with or without overlays
    s.doc.updateObject(cube.id, { display_type: 'TEXTURED' });
    s.view.shading.value = 'WIREFRAME';
    s.view.overlays.value = false;
    e.sync();
    expect(wire()?.visible).toBe(true);
  });

  it('hides the edit-mode cage display, and picking still finds its faces', () => {
    const s = session();
    const e = engine(s);
    const cube = byType(s, 'MESH');
    s.state.selectedIds = [cube.id];
    s.state.activeId = cube.id;
    s.state.mode = 'EDIT';
    e.sync();
    expect(e.edit.group.visible).toBe(true);
    s.view.overlays.value = false;
    e.sync();
    expect(e.edit.group.visible).toBe(false);
    // the cage used for picking keeps the edited mesh
    expect(e.edit.cage.geometry.getAttribute('position').count).toBe(8);
  });

  it('hides the text info, the statistics, the camera frame and peers’ cursors', () => {
    // regression: 'Camera Perspective', '(1) Scene Collection | Cube', the statistics and the
    // camera frame stayed on screen with the overlays off
    const s = session();
    const e = engine(s);
    s.view.cameraView.value = true;
    e.width = 800;
    e.height = 600;
    e.sync();
    (s.peers as unknown as { value: unknown[] }).value = [
      { clientId: 7, state: { user: { name: 'Ada', color: '#f00' }, cursor3d: [0, 0, 0] } },
    ];
    const { container } = render(
      <div>
        <InfoOverlay s={s} />
        <CameraFrame engine={e} />
        <PeerCursors s={s} engine={e} />
      </div>,
    );
    const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
    expect(q('viewport-info')?.textContent).toContain('Scene Collection');
    expect(q('viewport-stats')?.textContent).toContain('Triangles 12');
    expect(q('camera-frame')).not.toBeNull();
    expect(container.textContent).toContain('Ada');
    act(() => {
      s.view.overlays.value = false;
    });
    expect(q('viewport-info')).toBeNull();
    expect(q('viewport-stats')).toBeNull();
    expect(q('camera-frame')).toBeNull();
    expect(container.textContent).not.toContain('Ada');
    act(() => {
      s.view.overlays.value = true;
    });
    expect(q('viewport-info')).not.toBeNull();
    expect(q('camera-frame')).not.toBeNull();
  });
});

describe('slow viewport notice', () => {
  afterEach(() => {
    slowFrameMs.value = 0;
    slowFrameCompiled.value = false;
  });

  it('says how long a slow frame took, under the text info and above the statistics', () => {
    // regression: Rendered shading of a heavy scene in software WebGL drew for minutes with nothing
    // on screen saying so
    const s = session();
    const { container } = render(<InfoOverlay s={s} />);
    const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    expect(q('viewport-slow-frame')).toBeNull();
    act(() => {
      slowFrameMs.value = 12_500;
    });
    const notice = q('viewport-slow-frame')!;
    expect(notice.textContent).toBe('Slow viewport: 13 s per frame');
    expect(notice.title).toContain('Solid shading is much faster');
    // one column: the notice ends the text info, the statistics follow it (they overlapped)
    expect(q('viewport-info')!.contains(notice)).toBe(true);
    expect(q('viewport-info')!.parentElement).toBe(q('viewport-stats')!.parentElement);
    expect(q('viewport-info')!.nextElementSibling).toBe(q('viewport-stats'));
    act(() => {
      slowFrameMs.value = 3_240;
    });
    expect(q('viewport-slow-frame')!.textContent).toBe('Slow viewport: 3.2 s per frame');
    // the first frame in Rendered shading compiles the shaders: later ones are faster
    act(() => {
      slowFrameMs.value = 51_000;
      slowFrameCompiled.value = true;
    });
    expect(q('viewport-slow-frame')!.textContent).toBe(
      'Slow viewport: 51 s for the last frame (compiling shaders)',
    );
    // hidden with the overlays, gone once frames are fast again
    act(() => {
      s.view.overlays.value = false;
    });
    expect(q('viewport-slow-frame')).toBeNull();
    act(() => {
      s.view.overlays.value = true;
      slowFrameMs.value = 0;
    });
    expect(q('viewport-info')).not.toBeNull();
    expect(q('viewport-slow-frame')).toBeNull();
  });
});
