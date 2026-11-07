import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  createFCurve,
  createOperatorRegistry,
  createUVSphere,
  insertKeyframe,
  renderItems,
  renderSceneSoftware,
  resolveView,
  type CameraData,
  type OperatorContext,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { viewport } from '../src/editor/editor';
import { uiCommand } from '../src/editor/rpc';
import { session as sessionSignal } from '../src/app/store';
import type { ProjectSession } from '../src/project/session';
import { renderOutputSize, type PathTraceOptions } from '../src/render';
import { applyLensShift, sceneCameraView } from '../src/render/view';
import {
  MAX_FRAMES_IN_FLIGHT,
  SLOW_QUEUE_FRAME_MS,
  MSAA_HEAVY_TRIANGLES,
  MSAA_OFF_FRAME_MS,
  MSAA_ON_FRAME_MS,
  VIEWPORT_MSAA_SAMPLES,
  ViewportEngine,
} from '../src/viewport/engine';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { LOCAL_SHADOW_LAYER, lightIntensity, spotCone } from '../src/viewport/scene-objects';
import { SLOW_FRAME_MS, slowFrameCompiled, slowFrameMs } from '../src/telemetry/perf';
import { viewTransformParams, viewTransformPixel } from '../src/viewport/view-transform';

/*
 * The viewport engine's render entry points (F12, Render Animation, MCP renders) with a recording
 * stand-in for WebGL (the test environment has none): which camera renders the scene, how the
 * render target is cleared and which options reach the path tracer.
 */

/** What the stand-in renderer records. */
interface RecordingRenderer {
  /**
   * Every `render(scene, camera)` call: a copy of the camera, the clear alpha of its target and the
   * colour management in effect.
   */
  renders: {
    scene: THREE.Object3D;
    camera: THREE.Camera;
    clearAlpha: number | null;
    toneMapping: number;
    toneMappingExposure: number;
  }[];
  /** Fills the pixels read back from the render target. */
  readPixels: (buffer: Uint8Array) => void;
  /** Called on every `render(scene, camera)`, to look at the scene as it is drawn. */
  onRender: ((scene: THREE.Object3D) => void) | null;
  /** What `getContext()` returns (null: no WebGL2 fences). */
  context: unknown;
  info: { programs: unknown[] };
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
    onRender: RecordingRenderer['onRender'] = null;
    /** The WebGL context `getContext()` returns (a fence stand-in in frame pacing tests). */
    context: unknown = null;
    /** Compiled shader programs (tests add some to stand for a frame that compiles shaders). */
    info = { programs: [] as unknown[] };
    getContext() {
      return this.context;
    }
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
      this.renders.push({
        scene,
        camera: camera.clone(),
        clearAlpha: this.cleared.get(this.target) ?? null,
        toneMapping: this.toneMapping,
        toneMappingExposure: this.toneMappingExposure,
      });
      this.onRender?.(scene);
    }
    readRenderTargetPixels(_t: unknown, _x: number, _y: number, _w: number, _h: number, buffer: Uint8Array) {
      this.readPixels(buffer);
    }
    compile() {}
    dispose() {}
  }
  /** Prefiltered environment maps need WebGL: placeholder targets (the procedural sky's, studio's). */
  class StubPMREMGenerator {
    fromScene() {
      return new three.WebGLRenderTarget(1, 1);
    }
    fromEquirectangular() {
      return new three.WebGLRenderTarget(1, 1);
    }
    fromCubemap() {
      return new three.WebGLRenderTarget(1, 1);
    }
    compileEquirectangularShader() {}
    compileCubemapShader() {}
    dispose() {}
  }
  return { ...three, WebGLRenderer: RecordingWebGLRenderer, PMREMGenerator: StubPMREMGenerator };
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

/**
 * The renders that drew the scene's objects, in order: not the shadow-only render of the point and
 * spot light shadow maps (SceneObjects.renderLocalShadows), whose camera sees no object layer.
 */
function scenePasses(e: ViewportEngine, gl: RecordingRenderer): RecordingRenderer['renders'] {
  return gl.renders.filter((x) => x.scene === e.scene && x.camera.layers.isEnabled(0));
}

/** The camera that drew the scene in the last render. */
function sceneCamera(e: ViewportEngine, gl: RecordingRenderer): THREE.Camera {
  const r = scenePasses(e, gl).at(-1);
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
// Cheap: at most 8.6 ms under coverage in 300 runs, timed inside the hook. A reporter that times
// hooks from vitest's task events (onHookStart / onHookEnd) can show it taking seconds: the worker
// sends those events at most every 100 ms and leaves the rest to a timer, which cannot fire while
// synchronous tests run, so the end of a hook can reach the reporter only after the tests that
// follow it. Which hook that hits varies from run to run; under coverage it was the afterEach of one
// of the tests before 'lights a simple scene as brightly as the path tracer …', shown taking about
// that test's time.
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
    expect(scenePasses(e, gl)[0]?.clearAlpha).toBe(1);
    expect(img.data[3]).toBe(255);
    s.doc.updateRender({ film_transparent: true });
    gl.renders.length = 0;
    img = e.renderPixels({ width: 16, height: 16 });
    expect(scenePasses(e, gl)[0]?.clearAlpha).toBe(0);
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

const registry = createOperatorRegistry();
/** Runs an operator on the session's document (like the editor's own runs, without the UI). */
function ok(s: ProjectSession, id: string, params: Record<string, unknown> = {}): void {
  const ctx: OperatorContext = {
    doc: s.doc,
    state: s.state,
    origin: s.doc.origin,
    source: 'test',
    report: () => undefined,
  };
  const r = registry.run(ctx, id, params);
  if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
}

/** A mesh as a render drew it. */
interface DrawnMesh {
  triangles: number;
  /** Highest point of the drawn geometry (object space). */
  maxZ: number;
  /** Every material opaque and writing depth (X-ray makes them see-through). */
  opaque: boolean;
}

/** The meshes of objects a render of the scene draws (visible with all their parents), by name. */
function drawnMeshes(s: ProjectSession, scene: THREE.Object3D): Map<string, DrawnMesh> {
  const out = new Map<string, DrawnMesh>();
  scene.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || typeof m.userData.objectId !== 'string' || (m as THREE.InstancedMesh).isInstancedMesh)
      return;
    const g = m.geometry;
    g.computeBoundingBox();
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    out.set(s.doc.getObject(m.userData.objectId)?.name ?? m.userData.objectId, {
      triangles: (g.index ? g.index.count : g.getAttribute('position').count) / 3,
      maxZ: g.boundingBox!.max.z,
      opaque: mats.every((x) => !x.transparent && x.depthWrite),
    });
  });
  return out;
}

/** Records what the next renders of the engine's scene draw; returns the last one. */
function recordScene(s: ProjectSession, e: ViewportEngine, gl: RecordingRenderer) {
  let last: { meshes: Map<string, DrawnMesh>; background: unknown; environment: unknown } | null = null;
  gl.onRender = (scene) => {
    if (scene !== e.scene) return;
    last = {
      meshes: drawnMeshes(s, scene),
      background: e.scene.background,
      environment: e.scene.environment,
    };
  };
  return () => {
    if (!last) throw new Error('the scene was not rendered');
    return last;
  };
}

/** Names of the meshes the core renderers (path tracer, server) render: render visibility. */
function coreRenderedNames(doc: SceneDoc, frame = 1): string[] {
  const ev = new SceneEvaluator(doc).evaluate(frame, { forRender: true });
  return renderItems(ev, { forRender: true }).map((it) => it.object.name);
}

describe('final renders (F12, Render Animation, MCP renders)', () => {
  it('show what renders show, not the viewport display (visibility, render modifier levels, X-ray, Display As)', () => {
    // regression: rasterized final renders drew the viewport's scene: H-hidden objects were missing,
    // hide_render objects appeared, Subdivision used its viewport levels, X-ray made everything
    // see-through and Display As Wire objects vanished
    const s = session();
    ok(s, 'object.modifier_add', {
      object: 'Cube',
      type: 'SUBSURF',
      params: { levels: 0, render_levels: 2 },
    });
    ok(s, 'mesh.primitive_uv_sphere_add', { name: 'RenderOff', location: [0, 2.6, 0] });
    ok(s, 'mesh.primitive_cone_add', { name: 'ViewHidden', location: [0, -2.6, 0] });
    ok(s, 'mesh.primitive_cone_add', { name: 'WireCone', location: [2.6, 0, 0] });
    const id = (name: string) => s.doc.findObjectByName(name)!.id;
    s.doc.updateObject(id('RenderOff'), { hide_render: true });
    s.doc.updateObject(id('ViewHidden'), { hide_viewport: true });
    s.doc.updateObject(id('WireCone'), { display_type: 'WIRE' });
    s.view.xray.value = true;
    const { e, gl } = engine(s);
    const drawn = recordScene(s, e, gl);
    // the viewport itself: viewport visibility and levels, see-through
    e.sync();
    e.renderPixels({ useViewport: true });
    const viewport = drawn().meshes;
    expect([...viewport.keys()].sort()).toEqual(['Cube', 'RenderOff']);
    expect(viewport.get('Cube')!.triangles).toBe(12);
    expect(viewport.get('Cube')!.opaque).toBe(false);
    // F12: the objects the path tracer renders, subdivided with the render levels, opaque
    e.renderPixels();
    const final = drawn().meshes;
    expect([...final.keys()].sort()).toEqual(coreRenderedNames(s.doc).sort());
    expect([...final.keys()].sort()).toEqual(['Cube', 'ViewHidden', 'WireCone']);
    expect(final.get('Cube')!.triangles).toBe(6 * 16 * 2);
    for (const m of final.values()) expect(m.opaque).toBe(true);
    // the viewport shows its own state again on its next sync
    e.sync();
    gl.renders.length = 0;
    e.renderPixels({ useViewport: true });
    expect([...drawn().meshes.keys()].sort()).toEqual(['Cube', 'RenderOff']);
  });

  it('show shape keys while the viewport is in Edit Mode', () => {
    // regression: F12 in Edit Mode used the viewport's Edit Mode evaluation (shape keys off)
    const s = session();
    const cube = s.doc.findObjectByName('Cube')!;
    const n = s.doc.getMesh(cube.data!)!.positions.length / 3;
    const positions = s.doc.getMesh(cube.data!)!.positions;
    ok(s, 'object.shape_key_add', { object: 'Cube', name: 'Tall', value: 1 });
    ok(s, 'object.shape_key_set_positions', {
      object: 'Cube',
      key: 'Tall',
      offsets: Array.from({ length: n }, (_, i) => [0, 0, positions[i * 3 + 2] > 0 ? 1.5 : 0]),
    });
    s.state.selectedIds = [cube.id];
    s.state.activeId = cube.id;
    s.state.mode = 'EDIT';
    const { e, gl } = engine(s);
    const drawn = recordScene(s, e, gl);
    e.renderPixels();
    expect(drawn().meshes.get('Cube')!.maxZ).toBeCloseTo(2.5, 5);
    // the viewport keeps editing the basis
    e.renderPixels({ useViewport: true });
    expect(drawn().meshes.get('Cube')!.maxZ).toBeCloseTo(1, 5);
    expect(s.state.mode).toBe('EDIT');
  });

  it('show the world behind the materials and behind clay (SOLID) shading', () => {
    // regression: MCP render_image {shading: 'MATERIAL'} rendered the viewport's Material Preview
    // (studio HDRI background and lighting), and SOLID the viewport's grey background
    const s = session();
    s.doc.updateWorld({ environment: 'NONE', color: [0.8, 0.05, 0.05], strength: 1 });
    const { e, gl } = engine(s);
    const drawn = recordScene(s, e, gl);
    for (const shading of [undefined, 'RENDERED', 'SOLID'] as const) {
      e.renderPixels({ shading });
      const bg = drawn().background as THREE.Color;
      expect(bg).toBeInstanceOf(THREE.Color);
      expect(bg.r).toBeCloseTo(0.8, 6);
      expect(bg.g).toBeCloseTo(0.05, 6);
      expect(bg.b).toBeCloseTo(0.05, 6);
      expect(drawn().environment).toBeNull();
    }
  });

  it('apply the exposure and the view transform in the output pass, also with Standard', () => {
    // regression: Standard mapped to NoToneMapping, which ignores toneMappingExposure; the other
    // transforms used three.js's tone mapping curves instead of the core renderers'
    const s = session();
    const { e, gl } = engine(s);
    /** The colour management of the output pass of the last render. */
    const output = () => {
      const u = gl.renders
        .map((r) => ((r.scene as THREE.Mesh).material as THREE.ShaderMaterial | undefined)?.uniforms)
        .filter((x) => x?.curve && x.inset)
        .at(-1)!;
      return { mode: u.mode.value, exposure: u.exposure.value, inset: u.inset.value, outset: u.outset.value };
    };
    s.doc.updateRender({ view_transform: 'STANDARD', exposure: 2 });
    e.renderPixels();
    expect(output()).toEqual({ mode: 0, exposure: 4, inset: 0, outset: 0 });
    // three.js's own tone mapping stays off (the pass does it)
    expect(gl.renders.find((x) => x.scene === e.scene)!.toneMapping).toBe(THREE.NoToneMapping);
    s.doc.updateRender({ view_transform: 'AGX', exposure: -1 });
    e.renderPixels();
    expect(output()).toEqual({ ...viewTransformParams('AGX'), exposure: 0.5 });
    // clay shading is always Standard without exposure, like the server's renderer
    e.renderPixels({ shading: 'SOLID' });
    expect(output()).toEqual({ mode: 0, exposure: 1, inset: 0, outset: 0 });
  });

  it('keep the aspect ratio of outputs larger than 4096 px or smaller than 16 px', () => {
    // regression: each side was clamped to 16..4096 on its own: 8000×2000 rendered 4096×2000
    const s = session();
    const { e } = engine(s);
    s.doc.updateRender({ resolution_x: 8000, resolution_y: 2000, resolution_percentage: 100 });
    let img = e.renderPixels();
    expect([img.width, img.height]).toEqual([4096, 1024]);
    e.startPathTrace({ samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ width: 4096, height: 1024 });
    s.doc.updateRender({ resolution_x: 1920, resolution_y: 1080, resolution_percentage: 1 });
    img = e.renderPixels();
    expect([img.width, img.height]).toEqual([19, 11]);
    // explicit sizes (MCP renders) are kept, a missing side follows the output's aspect ratio
    s.doc.updateRender({ resolution_x: 40, resolution_y: 20, resolution_percentage: 100 });
    img = e.renderPixels({ width: 64, height: 16 });
    expect([img.width, img.height]).toEqual([64, 16]);
    img = e.renderPixels({ width: 64 });
    expect([img.width, img.height]).toEqual([64, 32]);
  });
});

describe('viewport captures (MCP editor_command screenshot)', () => {
  type Shading = 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED';
  /** What a picture of the scene looked like and what the viewport showed while it was drawn. */
  interface Look {
    /** The shading it was drawn in, told apart by what it looks like (see {@link recordLooks}). */
    shading: Shading;
    /** Whether the viewport's overlays were on while it was drawn. */
    overlays: boolean;
    /** Whether any of the editor's own parts of the overlay scene was drawn (grid, 3D cursor, gizmo …). */
    editorParts: boolean;
  }
  /**
   * Records the pictures of the scene (the scene and the overlay scene drawn over it). The world is
   * dark red without an environment, so Material Preview has the studio HDRI as environment,
   * Rendered shading the world colour behind it and shadow maps (the render settings' default),
   * Wireframe no meshes but the objects' wires (drawn with the overlays), Solid opaque meshes in
   * front of the viewport's grey.
   */
  function recordLooks(s: ProjectSession, e: ViewportEngine, gl: RecordingRenderer): Look[] {
    s.doc.updateWorld({ environment: 'NONE', color: [0.8, 0.05, 0.05], strength: 1 });
    const looks: Look[] = [];
    let meshes = 0;
    gl.onRender = (scene) => {
      if (scene === e.overlay && looks.length) {
        const last = looks[looks.length - 1];
        let wires = 0;
        scene.traverseVisible((o) => {
          if ((o as THREE.LineSegments).isLineSegments && typeof o.userData.objectId === 'string') wires++;
        });
        if (last.shading === 'SOLID' && !meshes && wires) last.shading = 'WIREFRAME';
        last.editorParts = e.overlay.children.some(
          (c) => c.visible && typeof c.userData.objectId !== 'string',
        );
        return;
      }
      if (scene !== e.scene) return;
      const bg = e.scene.background;
      const red = bg instanceof THREE.Color && bg.r > 0.7 && bg.g < 0.1;
      const shadows = (e.renderer as unknown as { shadowMap: { enabled: boolean } }).shadowMap.enabled;
      meshes = drawnMeshes(s, scene).size;
      const shading: Shading = e.scene.environment ? 'MATERIAL' : red && shadows ? 'RENDERED' : 'SOLID';
      looks.push({ shading, overlays: s.view.overlays.value, editorParts: false });
    };
    return looks;
  }
  /** Runs one turn of the viewport's frame loop (what requestAnimationFrame would run). */
  const viewportFrame = (e: ViewportEngine) =>
    (e as unknown as { loop(now: number): void }).loop(performance.now());

  it('draw in the shading the viewport shows unless another one is asked for', () => {
    // regression: captures were always drawn in Rendered shading, so a screenshot of a viewport in
    // Solid shading compiled every material and drew the shadow maps (20–25 s for a 71-material
    // scene in software WebGL) and showed what the person did not see
    const s = session();
    const { e, gl } = engine(s);
    const looks = recordLooks(s, e, gl);
    for (const shading of ['SOLID', 'RENDERED', 'MATERIAL', 'WIREFRAME'] as const) {
      s.view.shading.value = shading;
      viewportFrame(e);
      expect(looks.at(-1)).toEqual({ shading, overlays: true, editorParts: true });
      e.renderPixels({ useViewport: true });
      // without overlays (Wireframe shading's wires are the shading itself)
      expect(looks.at(-1)).toEqual({ shading, overlays: false, editorParts: false });
      expect(s.view.shading.value).toBe(shading);
    }
    s.view.shading.value = 'SOLID';
    viewportFrame(e);
    for (const shading of ['RENDERED', 'MATERIAL', 'WIREFRAME', 'SOLID'] as const) {
      e.renderPixels({ useViewport: true, shading });
      expect(looks.at(-1)).toEqual({ shading, overlays: false, editorParts: false });
      expect(s.view.shading.value).toBe('SOLID');
      expect(s.view.overlays.value).toBe(true);
    }
    // final renders are drawn with materials and lights unless asked otherwise
    e.renderPixels();
    expect(looks.at(-1)?.shading).toBe('RENDERED');
    e.renderPixels({ shading: 'SOLID' });
    expect(looks.at(-1)?.shading).not.toBe('RENDERED');
  });

  it('leave the viewport’s shading, overlays and frame as they were, also when the capture fails', () => {
    const s = session();
    const { e, gl } = engine(s);
    const looks = recordLooks(s, e, gl);
    // the transform gizmo is in the overlay scene, shown whatever the overlays (ViewportInteraction)
    const gizmo = new THREE.Group();
    e.overlay.add(gizmo);
    s.state.frame = 3;
    viewportFrame(e);
    e.renderPixels({ useViewport: true, shading: 'RENDERED', frame: 7 });
    expect(looks.at(-1)).toEqual({ shading: 'RENDERED', overlays: false, editorParts: false });
    expect([s.view.shading.value, s.view.overlays.value, s.state.frame]).toEqual(['SOLID', true, 3]);
    expect(gizmo.visible).toBe(true);
    // the viewport's next frame shows its own shading and overlays again
    viewportFrame(e);
    expect(looks.at(-1)).toEqual({ shading: 'SOLID', overlays: true, editorParts: true });
    // a capture that fails half-way (the camera view of a camera that is not there)
    s.view.cameraView.value = true;
    s.view.shading.value = 'MATERIAL';
    expect(() => e.renderPixels({ useViewport: true, shading: 'RENDERED', cameraId: 'Nope' })).toThrow(
      "Camera 'Nope' not found",
    );
    expect([s.view.shading.value, s.view.overlays.value, s.state.frame]).toEqual(['MATERIAL', true, 3]);
    expect(gizmo.visible).toBe(true);
    viewportFrame(e);
    expect(looks.at(-1)).toEqual({ shading: 'MATERIAL', overlays: true, editorParts: true });
    // one that fails after it hid the editor's parts of the overlay scene: while drawing the
    // overlay scene, or reading the pixels back (a lost WebGL context)
    const editorParts = () =>
      e.overlay.children.filter((c) => c.visible && typeof c.userData.objectId !== 'string').length;
    const fail = new Error('WebGL context lost');
    for (const when of ['drawing', 'reading'] as const) {
      const record = gl.onRender;
      gl.onRender = (scene) => {
        record?.(scene);
        if (when === 'drawing' && scene === e.overlay) {
          expect([editorParts(), gizmo.visible]).toEqual([0, false]);
          throw fail;
        }
      };
      gl.readPixels = () => {
        expect([editorParts(), gizmo.visible]).toEqual([0, false]);
        throw fail;
      };
      expect(() => e.renderPixels({ useViewport: true, shading: 'WIREFRAME', frame: 5 })).toThrow(fail);
      gl.onRender = record;
      gl.readPixels = (b) => b.fill(0);
      expect([s.view.shading.value, s.view.overlays.value, s.state.frame]).toEqual(['MATERIAL', true, 3]);
      // what the capture hid itself is shown again at once (the gizmo is not the scene sync's)
      expect(gizmo.visible).toBe(true);
      viewportFrame(e);
      expect(looks.at(-1)).toEqual({ shading: 'MATERIAL', overlays: true, editorParts: true });
    }
  });

  it('editor_command screenshot: the viewport’s shading by default, {shading} on request, an unknown one is an error', async () => {
    const s = session();
    const { e, gl } = engine(s);
    const looks = recordLooks(s, e, gl);
    sessionSignal.value = s;
    viewport.engine = e;
    try {
      e.sync();
      const shot = (await uiCommand('screenshot', { width: 32, height: 16 })) as Record<string, unknown>;
      expect(shot).toMatchObject({ mime: 'image/png', width: 32, height: 16 });
      expect(String(shot.data_base64).length).toBeGreaterThan(0);
      expect(looks.at(-1)?.shading).toBe('SOLID');
      await uiCommand('screenshot', { width: 32, height: 16, shading: 'rendered' });
      expect(looks.at(-1)?.shading).toBe('RENDERED');
      expect(s.view.shading.value).toBe('SOLID');
      s.view.shading.value = 'MATERIAL';
      await uiCommand('screenshot', { width: 32, height: 16 });
      expect(looks.at(-1)?.shading).toBe('MATERIAL');
      await uiCommand('screenshot', { width: 32, height: 16, shading: 'WIREFRAME' });
      expect(looks.at(-1)?.shading).toBe('WIREFRAME');
      // an unknown shading draws nothing and changes nothing
      gl.renders.length = 0;
      await expect(uiCommand('screenshot', { shading: 'TOON' })).rejects.toThrow(
        "Unknown shading 'TOON': use one of WIREFRAME, SOLID, MATERIAL, RENDERED",
      );
      expect(gl.renders).toHaveLength(0);
      expect([s.view.shading.value, s.view.overlays.value]).toEqual(['MATERIAL', true]);
    } finally {
      viewport.engine = null;
      sessionSignal.value = null;
    }
  });

  it('keep the materials of every shading drawn, so that neither the viewport nor the next picture builds them again', () => {
    // regression: a capture in Solid or Wireframe shading disposed the materials of a viewport in
    // Material Preview or Rendered shading, so its next frame built them and compiled their
    // shaders again (three.js drops a material's shader programs with it): 17–22 s for a scene
    // with 71 materials in software WebGL, which the next command waited for; and every capture in
    // Rendered shading of a viewport in Solid shading built and compiled them for that picture
    const s = session();
    const { e, gl } = engine(s);
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    const cubeMaterials = () => e.objects.views.get(cube.id)!.mesh!.material as THREE.Material[];
    const disposed = new Set<THREE.Material>();
    const watch = (materials: THREE.Material[]) => {
      for (const m of materials) m.addEventListener('dispose', () => disposed.add(m));
      return materials;
    };
    /** The cube's materials in each picture of the scene drawn from now on. */
    const pictures: THREE.Material[][] = [];
    gl.onRender = (scene) => {
      if (scene === e.scene && e.objects.views.has(cube.id)) pictures.push(cubeMaterials());
    };
    s.view.shading.value = 'RENDERED';
    viewportFrame(e);
    const pbr = watch(cubeMaterials());
    expect(pbr[0]).toBeInstanceOf(THREE.MeshPhysicalMaterial);
    for (const shading of ['SOLID', 'WIREFRAME', 'MATERIAL', 'SOLID'] as const) {
      e.renderPixels({ useViewport: true, shading });
      watch(pictures.at(-1)!);
      // the viewport's next frame draws with its own materials again
      viewportFrame(e);
      expect(pictures.at(-1)).toBe(pbr);
    }
    expect(pictures.filter((p) => p !== pbr).map((p) => p[0].type)).toEqual([
      'MeshMatcapMaterial',
      'MeshMatcapMaterial',
      'MeshMatcapMaterial',
    ]);
    // the Solid shading picture drawn twice used the same materials
    const clay = pictures.filter((p) => p !== pbr);
    expect(clay[2]).toBe(clay[0]);
    expect(disposed.size).toBe(0);
    // a viewport in Solid shading keeps them too: only the first picture in Rendered shading builds
    s.view.shading.value = 'SOLID';
    viewportFrame(e);
    expect(pictures.at(-1)).toBe(clay[0]);
    for (let i = 0; i < 2; i++) {
      e.renderPixels({ useViewport: true, shading: 'RENDERED' });
      expect(pictures.at(-1)).toBe(pbr);
      viewportFrame(e);
      expect(pictures.at(-1)).toBe(clay[0]);
    }
    expect(disposed.size).toBe(0);
    // what a change of the material makes stale is built again, and the stale materials disposed,
    // when its shading is drawn next
    s.doc.updateMaterial(s.doc.getObject(cube.id)!.material_slots[0]!, { roughness: 0.25 });
    viewportFrame(e);
    expect(pictures.at(-1)).not.toBe(clay[0]);
    expect([...disposed]).toEqual(clay[0]);
    e.renderPixels({ useViewport: true, shading: 'RENDERED' });
    expect(pictures.at(-1)).not.toBe(pbr);
    expect((pictures.at(-1)![0] as THREE.MeshPhysicalMaterial).roughness).toBe(0.25);
    expect(pbr.every((m) => disposed.has(m))).toBe(true);
    // and the ones kept for other shadings go with the object
    const kept = [...new Set(pictures.slice(-2).flat())];
    watch(kept);
    s.doc.removeObject(cube.id);
    viewportFrame(e);
    expect(kept.every((m) => disposed.has(m))).toBe(true);
  });

  it('draw the object being edited in Wireframe shading (its wires, without the edit-mode cage)', () => {
    // regression: the object in Edit Mode drew no wires, its edges being the cage's, which a
    // screenshot leaves out with the other overlays: Wireframe screenshots in Edit Mode showed
    // nothing of it (and neither did the viewport with its overlays off)
    const s = session();
    const { e, gl } = engine(s);
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    s.state.selectedIds = [cube.id];
    s.state.activeId = cube.id;
    s.state.mode = 'EDIT';
    s.view.shading.value = 'WIREFRAME';
    /** The cube's wires and whether the cage was on screen, in each picture of the overlay scene. */
    const pictures: { wires: number; color: number[]; cage: boolean }[] = [];
    gl.onRender = (scene) => {
      if (scene !== e.overlay) return;
      const wires: THREE.LineSegments[] = [];
      scene.traverseVisible((o) => {
        if ((o as THREE.LineSegments).isLineSegments && o.userData.objectId === cube.id)
          wires.push(o as THREE.LineSegments);
      });
      const color = wires[0] ? (wires[0].material as THREE.LineBasicMaterial).color.toArray() : [];
      pictures.push({ wires: wires.length, color, cage: e.edit.group.visible });
    };
    viewportFrame(e);
    // the person sees the cage (an overlay), which shows the edges
    expect(pictures.at(-1)).toEqual({ wires: 0, color: [], cage: true });
    e.renderPixels({ useViewport: true });
    // the plain wire colour: the edited object is not highlighted as selected in Edit Mode
    const grey = new THREE.Color(0xbbbbbb).toArray();
    expect(pictures.at(-1)).toEqual({ wires: 1, color: grey, cage: false });
    viewportFrame(e);
    expect(pictures.at(-1)).toEqual({ wires: 0, color: [], cage: true });
    // the viewport with its overlays off shows the wires too
    s.view.overlays.value = false;
    viewportFrame(e);
    expect(pictures.at(-1)).toEqual({ wires: 1, color: grey, cage: false });
    // other shadings draw its surface, no wires
    s.view.overlays.value = true;
    s.view.shading.value = 'SOLID';
    e.renderPixels({ useViewport: true });
    expect(pictures.at(-1)).toEqual({ wires: 0, color: [], cage: false });
    expect(drawnMeshes(s, e.scene).has('Cube')).toBe(true);
  });
});

/** Rec. 709 luminance of a display (sRGB-encoded, 0..1) colour, in linear light. */
function displayLuminance(c: readonly number[]): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

/** Mean luminance of RGBA8 pixels. */
function meanLuminance(data: Uint8ClampedArray | Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4)
    sum += displayLuminance([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
  return sum / (data.length / 4);
}

/**
 * A 40 m plane (Lambertian grey, no specular: IOR 1) seen straight from above by a camera 10 m
 * up, lit by one lamp and a dark world colour: nothing shadows or reflects onto anything, so every
 * renderer computes the same image.
 */
function litPlane(lamp: 'SUN' | 'POINT' | 'SPOT', view: string, exposure = 0): ProjectSession {
  const s = session();
  const doc = s.doc;
  for (const o of doc.listObjects()) doc.removeObject(o.id);
  doc.updateWorld({ environment: 'NONE', color: [0.04, 0.04, 0.04], strength: 1 });
  doc.updateRender({ resolution_x: 48, resolution_y: 32, view_transform: view, exposure } as never);
  ok(s, 'mesh.primitive_plane_add', { name: 'Floor', size: 40 });
  ok(s, 'material.new', { name: 'Grey', assign: false });
  const mat = doc.listMaterials().find((m) => m.name === 'Grey')!.id;
  ok(s, 'object.material_assign', { material: mat, objects: ['Floor'] });
  doc.updateBlockByKind('materials', mat, { base_color: [0.7, 0.6, 0.5, 1], roughness: 1, ior: 1 });
  ok(s, 'object.camera_add', { name: 'Cam', location: [0, 0, 10], rotation: [0, 0, 0] });
  doc.updateScene({ camera: doc.findObjectByName('Cam')!.id });
  if (lamp === 'SUN')
    ok(s, 'object.light_add', { type: 'SUN', name: 'Lamp', energy: 2.5, rotation: [0.35, 0.2, 0] });
  else if (lamp === 'POINT')
    ok(s, 'object.light_add', { type: 'POINT', name: 'Lamp', energy: 1500, location: [1.5, -1, 4] });
  else
    ok(s, 'object.light_add', {
      type: 'SPOT',
      name: 'Lamp',
      energy: 4000,
      location: [0.5, 0.5, 6],
      rotation: [0.05, 0, 0],
      spot_size: 0.8,
      spot_blend: 0.35,
    });
  return s;
}

/**
 * The image the WebGL renderer draws of {@link litPlane} with the three.js scene the engine built
 * (lights, ambient, the floor material, the camera that drew it): per pixel the radiance three.js
 * computes for a Lambertian surface (`BRDF_Lambert` = albedo / π times the irradiance of every
 * light: candela / d² for point and spot lights with the spot cone's smoothstep, lux for
 * directional lights, colour × intensity for the ambient light), then the output pass
 * (`viewTransformPixel`, the shader's twin) with its exposure. Returns the mean luminance.
 */
function webglLuminance(e: ViewportEngine, gl: RecordingRenderer, width: number, height: number): number {
  const scene = e.scene;
  scene.updateMatrixWorld(true);
  const camera = sceneCamera(e, gl);
  camera.updateMatrixWorld(true);
  let albedo: THREE.Color | null = null;
  const lights: THREE.Light[] = [];
  scene.traverseVisible((o) => {
    if ((o as THREE.Light).isLight) lights.push(o as THREE.Light);
    const m = o as THREE.Mesh;
    if (m.isMesh && m.userData.objectId && !albedo)
      albedo = ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshPhysicalMaterial).color;
  });
  if (!albedo) throw new Error('the floor was not drawn');
  const a = albedo as THREE.Color;
  // the output pass of the render (the fullscreen quad with the view transform shader)
  const pass = gl.renders
    .map((r) => (r.scene as THREE.Mesh).material as THREE.ShaderMaterial | undefined)
    .find((m) => m?.uniforms?.curve && m.uniforms.inset)!;
  expect(pass).toBeTruthy();
  const view = (['STANDARD', 'AGX', 'FILMIC', 'ACES', 'NEUTRAL'] as const).find((v) => {
    const p = viewTransformParams(v);
    return (
      p.mode === pass.uniforms.mode.value &&
      p.inset === pass.uniforms.inset.value &&
      p.outset === pass.uniforms.outset.value
    );
  })!;
  const exposure = pass.uniforms.exposure.value as number;
  const n = new THREE.Vector3(0, 0, 1);
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane(n, 0);
  const p = new THREE.Vector3();
  let sum = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      ray.setFromCamera(new THREE.Vector2(((x + 0.5) / width) * 2 - 1, 1 - ((y + 0.5) / height) * 2), camera);
      if (!ray.ray.intersectPlane(plane, p)) throw new Error('the floor does not fill the image');
      const e3 = [0, 0, 0];
      for (const l of lights) {
        const c = l.color;
        let irradiance: number;
        if ((l as THREE.AmbientLight).isAmbientLight) irradiance = l.intensity;
        else if ((l as THREE.DirectionalLight).isDirectionalLight) {
          const d = l as THREE.DirectionalLight;
          const toLight = new THREE.Vector3()
            .setFromMatrixPosition(d.matrixWorld)
            .sub(new THREE.Vector3().setFromMatrixPosition(d.target.matrixWorld))
            .normalize();
          irradiance = d.intensity * Math.max(0, n.dot(toLight));
        } else {
          const pos = new THREE.Vector3().setFromMatrixPosition(l.matrixWorld);
          const toLight = pos.clone().sub(p);
          const d2 = toLight.lengthSq();
          toLight.normalize();
          irradiance = (l.intensity * Math.max(0, n.dot(toLight))) / Math.max(d2, 0.01);
          if ((l as THREE.SpotLight).isSpotLight) {
            const sp = l as THREE.SpotLight;
            const axis = pos.clone().sub(new THREE.Vector3().setFromMatrixPosition(sp.target.matrixWorld));
            const cos = toLight.dot(axis.normalize());
            const e0 = Math.cos(sp.angle);
            const e1 = Math.cos(sp.angle * (1 - sp.penumbra));
            const t = Math.min(1, Math.max(0, (cos - e0) / (e1 - e0)));
            irradiance *= t * t * (3 - 2 * t);
          }
        }
        e3[0] += c.r * irradiance;
        e3[1] += c.g * irradiance;
        e3[2] += c.b * irradiance;
      }
      const radiance = [a.r, a.g, a.b].map((k, i) => (k / Math.PI) * e3[i] * exposure);
      sum += displayLuminance(viewTransformPixel(view, radiance[0], radiance[1], radiance[2]));
    }
  return sum / (width * height);
}

describe('final render brightness', () => {
  it('lights a simple scene as brightly as the path tracer and the CPU rasterizer', () => {
    // regression: WebGL renders (F12, Render Animation, browser MCP renders) were 15–20 % brighter
    // (8-bit mean) than the path tracer and the server's renderer: lamps were 12× (point, spot,
    // area) or 2.5× (sun) the core's Blender units and three.js's AgX / ACES / Neutral tone mapping
    // are other curves than the core's view transforms
    const cases = [
      ['SUN', 'STANDARD', 0],
      ['SUN', 'AGX', 0],
      ['POINT', 'AGX', 0.5],
      ['POINT', 'FILMIC', 0],
      ['SPOT', 'NEUTRAL', 0],
      ['SPOT', 'ACES', -0.5],
    ] as const;
    for (const [lamp, view, exposure] of cases) {
      const s = litPlane(lamp, view, exposure);
      const { e, gl } = engine(s);
      const img = e.renderPixels();
      expect([img.width, img.height]).toEqual([48, 32]);
      const webgl = webglLuminance(e, gl, img.width, img.height);
      const cpu = meanLuminance(
        renderSceneSoftware(s.doc, { width: img.width, height: img.height, engine: 'RASTER' }).data,
      );
      const pt = meanLuminance(
        renderSceneSoftware(s.doc, {
          width: img.width,
          height: img.height,
          engine: 'PATHTRACER',
          samples: 32,
          max_bounces: 1,
        }).data,
      );
      const label = `${lamp} ${view} ${exposure}`;
      expect(cpu / pt, `${label}: CPU rasterizer / path tracer`).toBeGreaterThan(0.97);
      expect(cpu / pt, `${label}: CPU rasterizer / path tracer`).toBeLessThan(1.03);
      expect(webgl / cpu, `${label}: WebGL / CPU rasterizer`).toBeGreaterThan(0.98);
      expect(webgl / cpu, `${label}: WebGL / CPU rasterizer`).toBeLessThan(1.02);
      expect(webgl / pt, `${label}: WebGL / path tracer`).toBeGreaterThan(0.97);
      expect(webgl / pt, `${label}: WebGL / path tracer`).toBeLessThan(1.03);
    }
    // path tracing six small images is CPU heavy on a loaded machine
  }, 60_000);

  it('gives lamps the intensities of the core renderers (Blender units)', () => {
    // point and spot: radiant intensity P / 4π (candela); sun: irradiance; area: radiance P / (π·A)
    expect(lightIntensity({ type: 'POINT', energy: 1000 })).toBeCloseTo(1000 / (4 * Math.PI), 9);
    expect(lightIntensity({ type: 'SPOT', energy: 1000 })).toBeCloseTo(1000 / (4 * Math.PI), 9);
    expect(lightIntensity({ type: 'SUN', energy: 3 })).toBe(3);
    expect(lightIntensity({ type: 'AREA', energy: 800 }, 2 * 3)).toBeCloseTo(800 / (Math.PI * 6), 9);
    expect(lightIntensity({ type: 'POINT', energy: -5 })).toBe(0);
    // the spot cone fades in over the blend like the core's smoothstep
    for (const [size, blend] of [
      [Math.PI / 4, 0.15],
      [1.2, 0],
      [2.5, 1],
      [Math.PI, 0.5],
    ]) {
      const { angle, penumbra } = spotCone(size, blend);
      const cosHalf = Math.cos(Math.min(Math.PI / 2, size / 2));
      expect(angle).toBeCloseTo(Math.min(Math.PI / 2, size / 2), 9);
      expect(Math.cos(angle * (1 - penumbra))).toBeCloseTo(cosHalf + (1 - cosHalf) * blend, 9);
    }
    // the engine's lights: an area light's radiance uses its world area (object scale included)
    const s = session();
    ok(s, 'object.light_add', {
      type: 'AREA',
      name: 'Panel',
      energy: 600,
      size: 2,
      size_y: 0.5,
      shape: 'RECTANGLE',
    });
    s.doc.updateObject(s.doc.findObjectByName('Panel')!.id, { scale: [2, 3, 1] });
    s.doc.updateRender({ engine: 'RASTER' });
    const { e } = engine(s);
    e.renderPixels();
    const found: Record<string, number> = {};
    e.scene.traverse((o) => {
      if ((o as THREE.Light).isLight && o.visible) found[o.type] = (o as THREE.Light).intensity;
    });
    expect(found.PointLight).toBeCloseTo(1000 / (4 * Math.PI), 6);
    expect(found.RectAreaLight).toBeCloseTo(600 / (Math.PI * 2 * 0.5 * 2 * 3), 6);
    // a spot lamp shines from its object's origin (three.js puts new spot lights 1 m up)
    ok(s, 'object.light_add', { type: 'SPOT', name: 'Spot', location: [1, 2, 3], rotation: [0.4, 0.3, 0] });
    e.renderPixels();
    let spot: THREE.SpotLight | null = null;
    e.scene.traverse((o) => {
      if ((o as THREE.SpotLight).isSpotLight) spot = o as THREE.SpotLight;
    });
    const sp = spot as unknown as THREE.SpotLight;
    sp.updateWorldMatrix(true, true);
    expect(
      new THREE.Vector3()
        .setFromMatrixPosition(sp.matrixWorld)
        .toArray()
        .map((v) => +v.toFixed(6)),
    ).toEqual([1, 2, 3]);
  });
});

/**
 * The scene of the report: Blender's default scene (camera, 2 m cube) on a `floor` m plane at
 * z = −1, with a 15 cm pole and a 50 cm box, lit by a shadow-casting sun lamp.
 */
function sunScene(floor: number): ProjectSession {
  const s = session();
  ok(s, 'mesh.primitive_plane_add', { name: 'Floor', size: floor, location: [0, 0, -1] });
  ok(s, 'mesh.primitive_cube_add', {
    name: 'Pole',
    size: 1,
    location: [2.5, 1, 0.5],
    scale: [0.15, 0.15, 3],
  });
  ok(s, 'mesh.primitive_cube_add', { name: 'Box', size: 0.5, location: [-2, -2, -0.75] });
  ok(s, 'light.properties_set', { object: 'Light', type: 'SUN', energy: 3 });
  s.doc.updateObject(s.doc.findObjectByName('Light')!.id, {
    location: [2, -2, 5],
    rotation_euler: [0.6, 0.35, 0],
  });
  s.doc.updateRender({ use_shadows: true, resolution_x: 64, resolution_y: 36 });
  return s;
}

/** The shadow-casting suns (directional lights) of the engine's scene, by name. */
function shadowSuns(e: ViewportEngine): Map<string, THREE.DirectionalLight> {
  const out = new Map<string, THREE.DirectionalLight>();
  e.scene.traverse((o) => {
    const l = o as THREE.DirectionalLight;
    if (l.isDirectionalLight && l.castShadow && l.visible && l.parent)
      out.set(l.name || String(l.parent.userData.objectId ?? ''), l);
  });
  return out;
}

/** World size of a texel of a sun's shadow map and its biases in world units. */
function shadowMetrics(light: THREE.DirectionalLight) {
  const c = light.shadow.camera;
  const texel = Math.max(c.right - c.left, c.top - c.bottom) / light.shadow.mapSize.x;
  return { texel, normalBias: light.shadow.normalBias, depthBias: -light.shadow.bias * (c.far - c.near) };
}

/** Whether a world point lies in the volume a sun's shadow map covers. */
function inShadowMap(light: THREE.DirectionalLight, p: THREE.Vector3): boolean {
  const c = light.shadow.camera;
  // where three.js puts the shadow camera before drawing the map
  light.shadow.updateMatrices(light);
  const v = p.clone().applyMatrix4(c.matrixWorldInverse);
  const e = 1e-6;
  return (
    v.x >= c.left - e &&
    v.x <= c.right + e &&
    v.y >= c.bottom - e &&
    v.y <= c.top + e &&
    -v.z >= c.near - e &&
    -v.z <= c.far + e
  );
}

/** Points on the surface of an object's mesh as the render drew it (its world box, 4 × 4 × 4). */
function objectPoints(e: ViewportEngine, s: ProjectSession, name: string): THREE.Vector3[] {
  const id = s.doc.findObjectByName(name)!.id;
  let mesh: THREE.Mesh | null = null;
  e.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.objectId === id) mesh = o as THREE.Mesh;
  });
  const m = mesh as unknown as THREE.Mesh;
  m.updateWorldMatrix(true, false);
  m.geometry.computeBoundingBox();
  const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= 3; i++)
    for (let j = 0; j <= 3; j++)
      for (let k = 0; k <= 3; k++)
        out.push(
          new THREE.Vector3(
            THREE.MathUtils.lerp(b.min.x, b.max.x, i / 3),
            THREE.MathUtils.lerp(b.min.y, b.max.y, j / 3),
            THREE.MathUtils.lerp(b.min.z, b.max.z, k / 3),
          ),
        );
  return out;
}

describe('sun shadows', () => {
  it('stay sharp however large the ground plane: the map is fitted to what the render camera sees', () => {
    // regression: a sun's map was fitted to the whole scene's bounding sphere; with a 600 m floor a
    // texel was 0.42 m (wider than the 15 cm pole), the normal offset 0.63 m and the depth bias
    // 0.43 m: the shadows of the cube, the pole and the box faded out and vanished, and the cube's
    // faces got moiré acne
    const texels: number[] = [];
    for (const size of [12, 600]) {
      const s = sunScene(size);
      const { e, gl } = engine(s);
      e.renderPixels();
      const sun = [...shadowSuns(e).values()];
      expect(sun).toHaveLength(1);
      const light = sun[0];
      const m = shadowMetrics(light);
      texels.push(m.texel);
      expect(m.texel, `${size} m floor: texel`).toBeLessThan(0.02);
      expect(m.normalBias).toBeLessThan(0.04);
      expect(m.depthBias).toBeLessThan(0.03);
      // the casters the camera sees, and their shadows on the floor it sees, are in the map
      const cam = sceneCamera(e, gl);
      const view = new THREE.Frustum().setFromProjectionMatrix(
        new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
      );
      light.updateWorldMatrix(true, true);
      const dir = new THREE.Vector3()
        .setFromMatrixPosition(light.target.matrixWorld)
        .sub(new THREE.Vector3().setFromMatrixPosition(light.matrixWorld))
        .normalize();
      let checked = 0;
      for (const name of ['Cube', 'Pole', 'Box'])
        for (const p of objectPoints(e, s, name)) {
          const shadow = p.clone().addScaledVector(dir, (-1 - p.z) / dir.z);
          for (const q of [p, shadow])
            if (view.containsPoint(q) && Math.max(Math.abs(q.x), Math.abs(q.y)) <= size / 2) {
              expect(inShadowMap(light, q), `${size} m floor: ${name} ${q.toArray()}`).toBe(true);
              checked++;
            }
        }
      expect(checked).toBeGreaterThan(100);
    }
    // the 600 m floor's map is about as fine as the 12 m floor's, not 50 times coarser
    expect(texels[1] / texels[0]).toBeLessThan(3);
  });

  it('fit the sky’s sun the same way', () => {
    const s = sunScene(600);
    s.doc.removeObject(s.doc.findObjectByName('Light')!.id);
    s.doc.updateWorld({
      environment: 'SKY',
      sun_elevation: 0.8,
      sun_rotation: 3.9,
      sun_intensity: 3,
    } as never);
    const { e } = engine(s);
    e.renderPixels();
    const sky = shadowSuns(e).get('Sky Sun');
    expect(sky).toBeTruthy();
    const m = shadowMetrics(sky!);
    // the whole-scene fit gave 0.42 m texels here
    expect(m.texel).toBeLessThan(0.03);
    expect(m.normalBias).toBeLessThan(0.05);
    expect(m.depthBias).toBeLessThan(0.03);
    for (const p of objectPoints(e, s, 'Cube')) expect(inShadowMap(sky!, p)).toBe(true);
  });

  it('refit the map for every render: the viewport fits its own view, a final render the camera', () => {
    const s = sunScene(600);
    const { e } = engine(s);
    s.view.shading.value = 'RENDERED';
    // the viewport looks closely at the box, 2 m away
    e.setPose({
      target: new THREE.Vector3(-2, -2, -0.75),
      distance: 2,
      yaw: 0.6,
      pitch: 0.5,
      ortho: false,
      fovY: THREE.MathUtils.degToRad(39.6),
    });
    e.sync();
    e.thumbnail();
    const light = [...shadowSuns(e).values()][0];
    const close = shadowMetrics(light).texel;
    for (const p of objectPoints(e, s, 'Box')) expect(inShadowMap(light, p)).toBe(true);
    // the final render's camera sees the whole group from 11 m: a larger, coarser map
    e.renderPixels();
    const final = shadowMetrics([...shadowSuns(e).values()][0]).texel;
    expect(final).toBeGreaterThan(2 * close);
    for (const p of objectPoints(e, s, 'Pole')) expect(inShadowMap(light, p)).toBe(true);
  });
});

describe('render output size', () => {
  it('scales both sides by the same factor to fit 4096 px', () => {
    expect(renderOutputSize(8000, 2000, 100)).toEqual({
      width: 4096,
      height: 1024,
      requested: { width: 8000, height: 2000 },
      scaled: true,
    });
    expect(renderOutputSize(2000, 9000, 50)).toEqual({
      width: 910,
      height: 4096,
      requested: { width: 1000, height: 4500 },
      scaled: true,
    });
    expect(renderOutputSize(4000, 1000, 100)).toMatchObject({ width: 4000, height: 1000, scaled: false });
    expect(renderOutputSize(1920, 1080, 15)).toMatchObject({ width: 288, height: 162, scaled: false });
    expect(renderOutputSize(1920, 1080, 1)).toMatchObject({ width: 19, height: 11, scaled: false });
    expect(renderOutputSize(4, 4, 1)).toMatchObject({ width: 1, height: 1, scaled: false });
  });
});

describe('heavy scenes in Rendered shading', () => {
  /** Runs one turn of the viewport's frame loop (what requestAnimationFrame would run). */
  const frame = (e: ViewportEngine) => (e as unknown as { loop(now: number): void }).loop(performance.now());
  /** The shadow-only renders that draw the point and spot light shadow maps. */
  const shadowPasses = (e: ViewportEngine, gl: RecordingRenderer) =>
    gl.renders.filter((r) => r.scene === e.scene && r.camera.layers.mask === 1 << LOCAL_SHADOW_LAYER);
  const instancedMeshes = (e: ViewportEngine) => {
    const out: THREE.InstancedMesh[] = [];
    e.scene.traverse((o) => {
      if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o as THREE.InstancedMesh);
    });
    return out;
  };
  /** A session whose ground scatters `count` rocks of about 4,000 triangles (the default point light casts shadows). */
  function scatterScene(count: number): ProjectSession {
    const s = session();
    const rock = s.doc.addObject({
      name: 'Rock',
      type: 'MESH',
      data: s.doc.addMesh('Rock', createUVSphere({ segments: 64, ring_count: 32, radius: 0.05 })),
      location: [0, 0, -30],
    });
    ok(s, 'mesh.primitive_plane_add', { size: 20 });
    const ground = s.doc.listObjects().find((o) => o.name === 'Plane')!;
    ok(s, 'object.particle_system_add', {
      object: ground.id,
      settings: { count, instance_type: 'OBJECT', instance_object: rock },
    });
    s.view.shading.value = 'RENDERED';
    return s;
  }

  afterEach(() => {
    slowFrameMs.value = 0;
    slowFrameCompiled.value = false;
    vi.restoreAllMocks();
  });

  /** A stand-in WebGL2 context whose frame fences the test completes (`fences[i].done = true`). */
  function fenceContext(gl: RecordingRenderer) {
    const SIGNALED = 0x9119;
    const fences: { done: boolean }[] = [];
    gl.context = {
      SYNC_STATUS: 0x9114,
      SIGNALED,
      SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
      fenceSync: () => {
        const f = { done: false };
        fences.push(f);
        return f;
      },
      getSyncParameter: (f: { done: boolean }) => (f.done ? SIGNALED : 0x9118),
      deleteSync: () => undefined,
      flush: () => undefined,
      isContextLost: () => false,
    };
    return fences;
  }

  it('draws point and spot light shadow maps after scene changes, not for every frame', () => {
    // regression: every frame drew the point light's six cube faces again, also while only the view moved
    const s = session();
    s.view.shading.value = 'RENDERED';
    const { e, gl } = engine(s);
    frame(e);
    expect(shadowPasses(e, gl)).toHaveLength(1);
    // the view moves: the maps, which do not depend on it, are kept
    for (let i = 0; i < 3; i++) {
      e.requestRender();
      frame(e);
    }
    expect(scenePasses(e, gl)).toHaveLength(4);
    expect(shadowPasses(e, gl)).toHaveLength(1);
    // the scene changes: they are drawn again before the next frame's renders
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    s.doc.updateObject(cube.id, { location: [0, 0, 1] });
    frame(e);
    expect(shadowPasses(e, gl)).toHaveLength(2);
    const last = gl.renders.findIndex((r) => r === shadowPasses(e, gl)[1]);
    expect(gl.renders.slice(last + 1).some((r) => r.scene === e.scene && r.camera.layers.isEnabled(0))).toBe(
      true,
    );
  });

  it('redraws other people’s selection boxes without syncing the scene', () => {
    // regression: any presence change (this client's own frame or view, someone else's cursor) synced
    // the whole scene, which also redrew the point and spot light shadow maps
    const s = session();
    s.view.shading.value = 'RENDERED';
    const { e, gl } = engine(s);
    frame(e);
    const syncs = vi.spyOn(e, 'sync');
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    (s.peers as unknown as { value: unknown[] }).value = [
      { clientId: 7, state: { user: { name: 'Ada', color: '#f00' }, selection: [cube.id] } },
    ];
    frame(e);
    expect(syncs).not.toHaveBeenCalled();
    expect(scenePasses(e, gl)).toHaveLength(2);
    expect(shadowPasses(e, gl)).toHaveLength(1);
    // Ada's selection box is drawn
    const boxes = (e as unknown as { peerBoxes: THREE.Group }).peerBoxes;
    expect(boxes.children).toHaveLength(1);
    (s.peers as unknown as { value: unknown[] }).value = [];
    frame(e);
    expect(boxes.children).toHaveLength(0);
    expect(syncs).not.toHaveBeenCalled();
  });

  it('leaves big instance scatters out of point and spot light shadows; they keep the sun’s', () => {
    // regression: lighthouse-cove's 2.5 M instance triangles were drawn 14 times more per frame for the
    // shadow maps of two point lights (six cube faces each) and two spot lights
    const castingInShadowPass = (count: number) => {
      const s = scatterScene(count);
      const { e, gl } = engine(s);
      const casting: boolean[][] = [];
      gl.onRender = () => {
        if (gl.renders.at(-1)!.camera.layers.mask === 1 << LOCAL_SHADOW_LAYER)
          casting.push(instancedMeshes(e).map((im) => im.castShadow));
      };
      frame(e);
      expect(instancedMeshes(e).length).toBeGreaterThan(0);
      // in the frame's renders (the sun's shadow map is drawn in them) the instances cast shadows
      expect(instancedMeshes(e).every((im) => im.castShadow)).toBe(true);
      return { casting, skip: e.objects.localShadowsSkipInstances };
    };
    // 400 rocks × ~4,000 triangles × six cube faces is over the budget
    const heavy = castingInShadowPass(400);
    expect(heavy.casting).toEqual([heavy.casting[0].map(() => false)]);
    expect(heavy.skip).toBe(true);
    // a small scatter keeps casting point light shadows
    const light = castingInShadowPass(20);
    expect(light.casting).toEqual([light.casting[0].map(() => true)]);
    expect(light.skip).toBe(false);
  });

  it('draws a heavy scene’s first frame without multisampling; fast frames bring it back', () => {
    // regression: a heavy scene's first frames (shaders compiling, which says nothing about what a
    // frame costs) were drawn with 4× MSAA: minutes in software WebGL
    const heavy = engine(scatterScene(400));
    const fences = fenceContext(heavy.gl);
    const composer = (heavy.e as unknown as { composer: EffectComposer }).composer;
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    frame(heavy.e);
    expect(heavy.e.objects.drawnTriangles()).toBeGreaterThan(MSAA_HEAVY_TRIANGLES);
    expect(heavy.e.multisampling).toBe(false);
    expect([composer.renderTarget1.samples, composer.renderTarget2.samples]).toEqual([0, 0]);
    // a GPU draws it fast: multisampling comes back
    now += MSAA_ON_FRAME_MS / 2;
    fences[0].done = true;
    frame(heavy.e);
    expect(heavy.e.multisampling).toBe(true);
    // a light scene starts with it
    const light = engine(scatterScene(20));
    frame(light.e);
    expect(light.e.multisampling).toBe(true);
  });

  it('draws one transmission picture in heavy scenes, levels for nested glass otherwise', () => {
    const glassScene = (count: number) => {
      const s = count ? scatterScene(count) : session();
      s.view.shading.value = 'RENDERED';
      ok(s, 'mesh.primitive_uv_sphere_add', { radius: 1, location: [0, 0, 3] });
      ok(s, 'mesh.primitive_uv_sphere_add', { radius: 0.5, location: [0, 0, 3] });
      for (const o of s.doc.listObjects().filter((x) => x.name.startsWith('Sphere'))) {
        s.state.selectedIds = [o.id];
        s.state.activeId = o.id;
        ok(s, 'material.new', { name: `Glass ${o.name}`, transmission: 1, roughness: 0 });
      }
      s.state.selectedIds = [];
      s.state.activeId = null;
      return s;
    };
    const pictures = (s: ProjectSession) => {
      const { e } = engine(s);
      frame(e);
      return (e as unknown as { transmission: { lastPictures: number } }).transmission.lastPictures;
    };
    // the inner sphere is seen through the outer one: two levels
    expect(pictures(glassScene(0))).toBe(2);
    // with 1.6 M instance triangles each level would render them once more
    expect(pictures(glassScene(400))).toBe(1);
  });

  it('starts a change’s frame while the GPU draws the last one, queues no more behind slow frames, and says how long a slow frame took', () => {
    // regressions: in software WebGL a heavy frame drew for minutes with frames queueing behind it
    // and nothing on screen saying so; then a change made while the GPU still drew the frame before
    // it waited for that frame, so a screenshot taken right after the change (an e2e test, an
    // agent) showed the view without it
    const s = session();
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const change = (ms: number) => {
      now += ms;
      e.requestRender();
      frame(e);
    };
    frame(e);
    expect(scenePasses(e, gl)).toHaveLength(1);
    expect(fences).toHaveLength(1);
    // fast frames: every change starts its frame at once
    change(20);
    change(20);
    expect(scenePasses(e, gl)).toHaveLength(3);
    now += 20;
    for (const f of fences) f.done = true;
    frame(e);
    expect(slowFrameMs.value).toBe(0);
    // a slow frame (drawn for more than SLOW_QUEUE_FRAME_MS): a change still starts its frame behind
    // it, and nothing more queues up behind those two
    change(100);
    expect(scenePasses(e, gl)).toHaveLength(4);
    change(SLOW_QUEUE_FRAME_MS + 100);
    expect(scenePasses(e, gl)).toHaveLength(5);
    expect(MAX_FRAMES_IN_FLIGHT).toBe(2);
    change(3500);
    frame(e);
    expect(scenePasses(e, gl)).toHaveLength(5);
    expect(slowFrameMs.value).toBe(0);
    // the slow frame is done 12.1 s after it started: the notice says so, and the view as it is now
    // is drawn next
    now += 7500;
    fences[3].done = true;
    frame(e);
    expect(slowFrameMs.value).toBe(12_100);
    expect(scenePasses(e, gl)).toHaveLength(6);
    // the one behind it is done 3 s later: it took 3 s, not the 14 s since it was started
    now += 3000;
    fences[4].done = true;
    frame(e);
    expect(slowFrameMs.value).toBe(3000);
    expect(scenePasses(e, gl)).toHaveLength(6);
    // a fast frame clears it
    now += SLOW_FRAME_MS / 4;
    fences[5].done = true;
    frame(e);
    expect(slowFrameMs.value).toBe(0);
  });

  it('draws without multisampling while frames are slow, with it again once they are fast', () => {
    // regression: software WebGL rasterizes every MSAA sample: lighthouse-cove's Rendered frames took
    // 3.2 s with 4× MSAA and 0.8 s without
    const s = session();
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    const composer = (e as unknown as { composer: EffectComposer }).composer;
    const samples = () => [composer.renderTarget1.samples, composer.renderTarget2.samples];
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    /** Finishes the frame in flight after `ms` and runs the loop once (with a view change if asked). */
    const finish = (ms: number, change = false) => {
      now += ms;
      fences.at(-1)!.done = true;
      if (change) e.requestRender();
      frame(e);
    };
    frame(e);
    expect(samples()).toEqual([VIEWPORT_MSAA_SAMPLES, VIEWPORT_MSAA_SAMPLES]);
    // a slow frame: multisampling goes off and the view is drawn again without it, unasked
    finish(MSAA_OFF_FRAME_MS + 50);
    expect(e.multisampling).toBe(false);
    expect(samples()).toEqual([0, 0]);
    expect(scenePasses(e, gl)).toHaveLength(2);
    // frames without it that are not fast enough keep it off
    finish(MSAA_ON_FRAME_MS * 3, true);
    expect(e.multisampling).toBe(false);
    expect(scenePasses(e, gl)).toHaveLength(3);
    // a fast one brings it back, and the view is drawn again with it
    finish(MSAA_ON_FRAME_MS / 2);
    expect(e.multisampling).toBe(true);
    expect(samples()).toEqual([VIEWPORT_MSAA_SAMPLES, VIEWPORT_MSAA_SAMPLES]);
    expect(scenePasses(e, gl)).toHaveLength(4);
    // a slow frame that compiled shaders (the first one in Rendered shading) changes nothing: its
    // time is the compiler's (regression: a light scene's first frames, slow while compiling, turned
    // multisampling off and the next fast ones on again, so its edges changed between screenshots)
    gl.onRender = () => gl.info.programs.push({});
    finish(MSAA_ON_FRAME_MS / 2, true);
    gl.onRender = null;
    expect(scenePasses(e, gl)).toHaveLength(5);
    finish(SLOW_FRAME_MS + 1000);
    expect(e.multisampling).toBe(true);
    expect(slowFrameMs.value).toBe(SLOW_FRAME_MS + 1000);
    expect(slowFrameCompiled.value).toBe(true);
    expect(scenePasses(e, gl)).toHaveLength(5);
    // the frames after it show what the scene costs
    e.requestRender();
    frame(e);
    finish(SLOW_FRAME_MS + 1000);
    expect(e.multisampling).toBe(false);
    expect(slowFrameCompiled.value).toBe(false);
    expect(scenePasses(e, gl)).toHaveLength(7);
    finish(MSAA_ON_FRAME_MS / 2);
    expect(e.multisampling).toBe(true);
    expect(slowFrameMs.value).toBe(0);
    // a light scene's frame slowed down for a moment (a busy machine) keeps it
    expect(MSAA_OFF_FRAME_MS).toBeGreaterThanOrEqual(1000);
    // fast frames that compile shaders do not bring multisampling back
    gl.onRender = () => gl.info.programs.push({});
    finish(MSAA_OFF_FRAME_MS * 2);
    expect(e.multisampling).toBe(false);
    finish(MSAA_ON_FRAME_MS / 2, true);
    expect(e.multisampling).toBe(false);
    finish(MSAA_ON_FRAME_MS / 2, true);
    expect(e.multisampling).toBe(false);
    gl.onRender = null;
  });
});
