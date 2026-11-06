import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  createFCurve,
  insertKeyframe,
  resolveView,
  type CameraData,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import type { PathTraceOptions } from '../src/render';
import { applyLensShift, sceneCameraView } from '../src/render/view';
import { ViewportEngine } from '../src/viewport/engine';

/*
 * The viewport engine's render entry points (F12, Render Animation, MCP renders) with a recording
 * stand-in for WebGL (the test environment has none): which camera renders the scene, how the
 * render target is cleared and which options reach the path tracer.
 */

/** What the stand-in renderer records. */
interface RecordingRenderer {
  /** Every `render(scene, camera)` call: a copy of the camera and the clear alpha of its target. */
  renders: { scene: THREE.Object3D; camera: THREE.Camera; clearAlpha: number | null }[];
  /** Fills the pixels read back from the render target. */
  readPixels: (buffer: Uint8Array) => void;
}

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  /** Records what a WebGLRenderer would draw (no GPU in happy-dom). */
  class RecordingWebGLRenderer {
    domElement: HTMLCanvasElement;
    outputColorSpace: string = three.SRGBColorSpace;
    toneMapping: number = three.NoToneMapping;
    toneMappingExposure = 1;
    shadowMap = { enabled: false, type: three.PCFShadowMap };
    autoClear = true;
    autoClearColor = true;
    autoClearDepth = true;
    autoClearStencil = true;
    renders: RecordingRenderer['renders'] = [];
    readPixels: RecordingRenderer['readPixels'] = (b) => b.fill(0);
    private clearColor = new three.Color(0, 0, 0);
    private clearAlpha = 1;
    private target: unknown = null;
    private cleared = new Map<unknown, number>();
    private pixelRatio = 1;
    constructor(params: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement = params.canvas ?? document.createElement('canvas');
    }
    setPixelRatio(r: number) {
      this.pixelRatio = r;
    }
    getPixelRatio() {
      return this.pixelRatio;
    }
    setSize() {}
    getSize(t: InstanceType<typeof three.Vector2>) {
      return t.set(1, 1);
    }
    getClearColor(t: InstanceType<typeof three.Color>) {
      return t.copy(this.clearColor);
    }
    getClearAlpha() {
      return this.clearAlpha;
    }
    setClearColor(c: InstanceType<typeof three.Color> | number, a = 1) {
      this.clearColor.set(c);
      this.clearAlpha = a;
    }
    setClearAlpha(a: number) {
      this.clearAlpha = a;
    }
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    getRenderTarget() {
      return this.target;
    }
    clear() {
      this.cleared.set(this.target, this.clearAlpha);
    }
    clearDepth() {}
    render(scene: InstanceType<typeof three.Object3D>, camera: InstanceType<typeof three.Camera>) {
      this.renders.push({ scene, camera: camera.clone(), clearAlpha: this.cleared.get(this.target) ?? null });
    }
    readRenderTargetPixels(_t: unknown, _x: number, _y: number, _w: number, _h: number, buffer: Uint8Array) {
      this.readPixels(buffer);
    }
    compile() {}
    dispose() {}
  }
  return { ...three, WebGLRenderer: RecordingWebGLRenderer };
});

const pathTraced = vi.hoisted(() => [] as PathTraceOptions[]);
vi.mock('../src/render', async (importOriginal) => {
  const render = await importOriginal<typeof import('../src/render')>();
  return {
    ...render,
    pathTraceDocument: (_doc: unknown, o: PathTraceOptions) => {
      pathTraced.push(o);
      return { options: o };
    },
  };
});

/** A project session on the default scene (cube, light, camera) without world lighting. */
function session(): ProjectSession {
  const doc = SceneDoc.create();
  doc.updateWorld({ environment: 'NONE' });
  doc.updateRender({ resolution_x: 40, resolution_y: 20, resolution_percentage: 100 });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'viewport-render-test',
    doc,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    schedulePresence: () => undefined,
  } as unknown as ProjectSession;
}

const engines: ViewportEngine[] = [];
/** A viewport engine whose frame loop never runs (like a hidden browser tab). */
function engine(s: ProjectSession): { e: ViewportEngine; gl: RecordingRenderer } {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const e = new ViewportEngine(canvas, s);
  engines.push(e);
  return { e, gl: e.renderer as unknown as RecordingRenderer };
}

/** The camera that drew the scene in the last render. */
function sceneCamera(e: ViewportEngine, gl: RecordingRenderer): THREE.Camera {
  const r = gl.renders.filter((x) => x.scene === e.scene).at(-1);
  if (!r) throw new Error('the scene was not rendered');
  return r.camera;
}

/** The view the core renderers (path tracer, server) give the scene camera in a w × h image. */
function coreView(doc: SceneDoc, width: number, height: number) {
  const scene = new SceneEvaluator(doc).evaluate(1);
  return resolveView(doc, scene, { width, height }, width / height, null);
}

function cameraObject(s: ProjectSession) {
  return s.doc.listObjects().find((o) => o.type === 'CAMERA')!;
}

/** Keys `location[index]` of an object at frames. */
function keyLocation(s: ProjectSession, id: string, index: number, keys: [number, number][]): void {
  let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index });
  for (const [frame, value] of keys) fc = insertKeyframe(fc, frame, value, 'LINEAR');
  s.doc.setFCurve(fc);
}

beforeEach(() => {
  // no animation frames: the viewport never evaluates on its own (hidden tabs get none)
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  pathTraced.length = 0;
});
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('viewport render entry points', () => {
  it('renders the camera at the requested frame (Render Animation, MCP render_image {frame})', () => {
    // regression: the render camera came from the viewport's last evaluation, so every frame of a
    // rasterized animation showed an animated camera where it was at the first one
    const s = session();
    const cam = cameraObject(s);
    keyLocation(s, cam.id, 0, [
      [1, 7.36],
      [3, 10.36],
    ]);
    const { e, gl } = engine(s);
    for (const [frame, x] of [
      [1, 7.36],
      [3, 10.36],
      [2, 8.86],
    ]) {
      e.renderPixels({ frame });
      expect(sceneCamera(e, gl).position.x).toBeCloseTo(x, 5);
    }
    // the viewport keeps its own frame
    expect(s.state.frame).toBe(1);
  });

  it('renders the document as it is now when the viewport has not redrawn (hidden tab)', () => {
    // regression: a camera moved (or created and requested) since the viewport's last animation
    // frame rendered from where it was before
    const s = session();
    const cam = cameraObject(s);
    const { e, gl } = engine(s);
    e.renderPixels();
    const x0 = sceneCamera(e, gl).position.x;
    s.doc.updateObject(cam.id, { location: [cam.location[0] + 3, cam.location[1], cam.location[2]] });
    e.renderPixels();
    expect(sceneCamera(e, gl).position.x).toBeCloseTo(x0 + 3, 5);
    // a camera added since then, requested by id (MCP render_image {camera})
    const id = s.doc.addObject({ name: 'Top', type: 'CAMERA', data: cam.data, location: [0, 0, 20] });
    e.renderPixels({ cameraId: id });
    expect(sceneCamera(e, gl).position.toArray()).toEqual([0, 0, 20]);
    // and the path tracer is told to use it, not the viewport's view
    e.startPathTrace({ cameraId: id, samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ cameraId: id });
    expect(pathTraced.at(-1)?.view).toBeUndefined();
    // a scene camera set since then
    s.doc.updateScene({ camera: id });
    e.startPathTrace({ samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ cameraId: id });
    e.renderPixels();
    expect(sceneCamera(e, gl).position.toArray()).toEqual([0, 0, 20]);
    // a requested object that is not a camera is an error, not the viewport's view
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    expect(() => e.renderPixels({ cameraId: cube.id })).toThrow("'Cube' is a MESH object, not a camera");
    expect(() => e.startPathTrace({ cameraId: cube.id })).toThrow("'Cube' is a MESH object, not a camera");
    expect(() => e.renderPixels({ cameraId: 'Nope' })).toThrow("Camera 'Nope' not found");
  });

  it('applies the camera lens shift like the path tracer and the server renderers', () => {
    // regression: rasterized renders ignored shift_x / shift_y
    const s = session();
    const cam = cameraObject(s);
    s.doc.updateBlockByKind('cameras', cam.data!, { shift_x: 0.3, shift_y: -0.1 });
    const { e, gl } = engine(s);
    e.renderPixels();
    const used = sceneCamera(e, gl) as THREE.PerspectiveCamera;
    const reference = coreView(s.doc, 40, 20);
    used.projectionMatrix.elements.forEach((v, i) => expect(v).toBeCloseTo(reference.proj[i], 9));
  });

  it('shows the lens shift in the viewport camera view, inside the centred camera frame', () => {
    const s = session();
    const cam = cameraObject(s);
    const { e } = engine(s);
    s.view.cameraView.value = true;
    e.width = 900;
    e.height = 600;
    for (const settings of [
      { shift_x: 0.3, shift_y: -0.1 },
      { type: 'ORTHO', ortho_scale: 8, shift_x: -0.2, shift_y: 0.25 },
    ] as Partial<CameraData>[]) {
      s.doc.updateBlockByKind('cameras', cam.data!, settings);
      e.sync();
      const view = e.camera;
      const frame = e.cameraFrameRect()!;
      const ev = s.evaluator.evaluate(1).byId.get(cam.id)!;
      const rendered = sceneCameraView(ev.camera!, ev.worldMatrix, 2);
      for (const p of [new THREE.Vector3(1, 1, 1), new THREE.Vector3(-1, 0.5, -1)]) {
        const a = p.clone().project(view);
        const b = p.clone().project(rendered);
        // where the render puts the point, mapped through the camera frame into the viewport
        expect(a.x).toBeCloseTo(((frame.x + (b.x * 0.5 + 0.5) * frame.w) / e.width) * 2 - 1, 9);
        expect(a.y).toBeCloseTo(1 - ((frame.y + (0.5 - b.y * 0.5) * frame.h) / e.height) * 2, 9);
      }
    }
  });

  it('clears to a transparent background with Film > Transparent', () => {
    // regression: the scene pass cleared with the renderer's opaque clear alpha, so transparent
    // film renders had an opaque black background
    const s = session();
    const { e, gl } = engine(s);
    gl.readPixels = (b) => {
      b.set([10, 20, 30, 0]);
      b.set([200, 100, 50, 128], 4);
    };
    let img = e.renderPixels({ width: 16, height: 16 });
    expect(gl.renders.find((r) => r.scene === e.scene)?.clearAlpha).toBe(1);
    expect(img.data[3]).toBe(255);
    s.doc.updateRender({ film_transparent: true });
    gl.renders.length = 0;
    img = e.renderPixels({ width: 16, height: 16 });
    expect(gl.renders.find((r) => r.scene === e.scene)?.clearAlpha).toBe(0);
    // straight alpha is kept; fully transparent pixels are black
    const last = img.data.length - 16 * 4; // bottom row first in WebGL: the top row of the image
    expect([...img.data.subarray(last, last + 8)]).toEqual([0, 0, 0, 0, 200, 100, 50, 128]);
  });
});

describe('render cameras', () => {
  it('match the core renderers (perspective, orthographic, shifted, portrait, sensor fit)', () => {
    const doc = SceneDoc.create();
    const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!;
    for (const settings of [
      {},
      { shift_x: 0.25, shift_y: 0.1 },
      { type: 'ORTHO', ortho_scale: 9, shift_x: -0.2, shift_y: 0.3 },
      { sensor_fit: 'VERTICAL', lens: 35, shift_y: 0.5 },
      { clip_start: 0.5, clip_end: 40, shift_x: 1 },
    ] as Partial<CameraData>[])
      for (const [w, h] of [
        [64, 36],
        [30, 50],
      ]) {
        doc.updateBlockByKind('cameras', cam.data!, {
          type: 'PERSP',
          sensor_fit: 'AUTO',
          lens: 50,
          shift_x: 0,
          shift_y: 0,
          ...settings,
        });
        const ev = new SceneEvaluator(doc).evaluate(1).byId.get(cam.id)!;
        const three = sceneCameraView(ev.camera!, ev.worldMatrix, w / h);
        const core = coreView(doc, w, h);
        expect(three instanceof THREE.OrthographicCamera).toBe(core.ortho);
        three.projectionMatrix.elements.forEach((v, i) => expect(v).toBeCloseTo(core.proj[i], 9));
        three.matrixWorldInverse.elements.forEach((v, i) => expect(v).toBeCloseTo(core.view[i], 9));
      }
  });

  it('shift the projection only when there is a shift', () => {
    const pc = new THREE.PerspectiveCamera(40, 1.5, 0.1, 10);
    const before = [...pc.projectionMatrix.elements];
    applyLensShift(pc, 0, 0, 1.5);
    expect([...pc.projectionMatrix.elements]).toEqual(before);
    applyLensShift(pc, 0.5, 0, 1.5);
    // the image moves by half its width: the view centre projects to the left edge
    const p = new THREE.Vector3(0, 0, -5).applyMatrix4(pc.projectionMatrix);
    expect(p.x).toBeCloseTo(-1, 9);
    // the inverse follows (rays through pixels)
    const product = pc.projectionMatrixInverse.clone().multiply(pc.projectionMatrix).elements;
    new THREE.Matrix4().elements.forEach((v, i) => expect(product[i]).toBeCloseTo(v, 9));
  });
});
