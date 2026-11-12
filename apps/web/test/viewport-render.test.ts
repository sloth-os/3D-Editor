import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  createFCurve,
  createMesh,
  createOperatorRegistry,
  createUVSphere,
  getModifierDef,
  insertKeyframe,
  registerBuiltinModifiers,
  registerModifier,
  renderItems,
  renderSceneSoftware,
  resolveView,
  type CameraData,
  type OperatorContext,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import { viewport } from '../src/editor/editor';
import { registerUiOperators } from '../src/editor/ui-operators';
import { ViewportInteraction } from '../src/viewport/interaction';
import { ModalTransform } from '../src/viewport/modal-transform';
import { clonePose, posePosition, type ViewPose } from '../src/viewport/navigation';
import { uiCommand } from '../src/editor/rpc';
import { session as sessionSignal } from '../src/app/store';
import type { ProjectSession } from '../src/project/session';
import {
  INSTANCE_BYTES,
  InProcessWorker,
  RASTER_BYTES_PER_TRIANGLE,
  RasterEvaluationGuard,
  RenderPool,
  estimateRender,
  guardedEvaluation,
  rasterNeeds,
  renderOutputSize,
  tabMemoryWithRenders,
  type PathTraceOptions,
} from '../src/render';
import { startPathTrace } from '../src/render/path-trace';
import { YOUNG_GENERATION_BYTES, pageHeapEstimate } from '../src/render/memory';
import { applyLensShift, sceneCameraView } from '../src/render/view';
import {
  VIEW_ANIMATION_MS,
  FRESH_POLL_MS,
  MAX_FRAMES_IN_FLIGHT,
  SLOW_QUEUE_FRAME_MS,
  MSAA_HEAVY_TRIANGLES,
  MSAA_OFF_FRAME_MS,
  MSAA_ON_FRAME_MS,
  VIEWPORT_MSAA_SAMPLES,
  FINAL_RENDER_SAMPLES,
  FINAL_SUPERSAMPLE_MS,
  FINAL_SUPERSAMPLE_OFFSETS,
  ViewportEngine,
  thumbnailJpeg,
} from '../src/viewport/engine';
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAABlendShader } from 'three/examples/jsm/shaders/SMAAShader.js';
import { glslFunction, glslProgram } from './glsl';
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
      // like three.js, which runs a material's onBeforeRender right before it draws with it (and
      // gives it its shader program): scene-objects.ts disposes what a material replaced after that
      const override = (scene as InstanceType<typeof three.Scene>).overrideMaterial ?? null;
      if (!override)
        scene.traverseVisible((o) => {
          const mesh = o as InstanceType<typeof three.Mesh>;
          if (!mesh.isMesh || !o.layers.test(camera.layers)) return;
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
            m?.onBeforeRender(this as never, scene as never, camera, mesh.geometry, mesh, null as never);
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

beforeEach(async () => {
  // no animation frames: the viewport never evaluates on its own (hidden tabs get none)
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  pathTraced.length = 0;
  // lets a timer of vitest's that is due fire before the test (see below)
  await new Promise((done) => setTimeout(done, 0));
});
// Cheap: at most 2.5 ms in 132 runs under coverage (this file three times), timed inside the hook.
// A reporter that times hooks from vitest's task events (onHookStart / onHookEnd) can show it
// taking as long as a synchronous test that runs after it. The worker sends those events at most
// every 100 ms; an event that comes sooner waits for a timer (vitest 5.0.5, `throttle` in
// run.BPv-BBRv.js), and a timer that fires exactly 100 ms after the last send sends nothing and
// leaves no timer behind (`now - last > ms`, `pendingCall ??=`): the event then waits for the next
// task event, at the end of the next test when that test is synchronous, and a wait inside the test
// does not help. So no test here runs long synchronously: 'lights a simple scene as brightly as the
// path tracer …', which lit six scenes in one test (2.7–3.4 s under coverage; the reporter showed
// the afterEach two or three tests before it taking 3.1–5.0 s, inside the hook 0.1–0.2 ms), is one
// test per scene.
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
    // what a change of the material makes stale is built again when its shading is drawn next, and
    // the stale materials are disposed once the new ones have been drawn wherever they were
    // (scene-objects.ts replaceSlot): the Solid ones in Solid shading, the others in Rendered and
    // Material Preview shading
    s.doc.updateMaterial(s.doc.getObject(cube.id)!.material_slots[0]!, { roughness: 0.25 });
    viewportFrame(e);
    const clayNow = pictures.at(-1)!;
    expect(clayNow).not.toBe(clay[0]);
    expect([...disposed]).toEqual(clay[0]);
    e.renderPixels({ useViewport: true, shading: 'RENDERED' });
    const pbrNow = pictures.at(-1)!;
    expect(pbrNow).not.toBe(pbr);
    expect((pbrNow[0] as THREE.MeshPhysicalMaterial).roughness).toBe(0.25);
    expect(pbr.some((m) => disposed.has(m))).toBe(false);
    e.renderPixels({ useViewport: true, shading: 'MATERIAL' });
    expect(pictures.at(-1)).toBe(pbrNow);
    expect(pbr.every((m) => disposed.has(m))).toBe(true);
    // and the ones kept for other shadings go with the object
    const kept = [...clayNow, ...pbrNow];
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
  // regression: WebGL renders (F12, Render Animation, browser MCP renders) were 15–20 % brighter
  // (8-bit mean) than the path tracer and the server's renderer: lamps were 12× (point, spot,
  // area) or 2.5× (sun) the core's Blender units and three.js's AgX / ACES / Neutral tone mapping
  // are other curves than the core's view transforms. One test per lamp and view transform: each
  // runs synchronously (path tracing a small image is most of it), see the afterEach above
  it.each([
    ['SUN', 'STANDARD', 0],
    ['SUN', 'AGX', 0],
    ['POINT', 'AGX', 0.5],
    ['POINT', 'FILMIC', 0],
    ['SPOT', 'NEUTRAL', 0],
    ['SPOT', 'ACES', -0.5],
  ] as const)(
    'lights a simple scene as brightly as the path tracer and the CPU rasterizer: %s lamp, %s, exposure %s',
    (lamp, view, exposure) => {
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
    },
    // path tracing a small image is CPU heavy on a loaded machine
    20_000,
  );

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
    // a frame of the viewport
    (e as unknown as { loop(now: number): void }).loop(performance.now());
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
    type Fence = { done: boolean };
    const all: Fence[] = [];
    // the frames' fences (the engine flushes right after one), and those that end a frame's
    // multisampled renders (`scenes`, put while the frame renders)
    const fences: Fence[] = [];
    const scenes: Fence[] = [];
    gl.context = {
      SYNC_STATUS: 0x9114,
      SIGNALED,
      SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
      fenceSync: () => {
        const f = { done: false };
        all.push(f);
        scenes.push(f);
        return f;
      },
      // like a GPU's, fences signal in order: done once it or a later one is
      getSyncParameter: (f: Fence) => (all.slice(all.indexOf(f)).some((g) => g.done) ? SIGNALED : 0x9118),
      deleteSync: () => undefined,
      flush: () => {
        if (all.length && scenes.at(-1) === all.at(-1)) fences.push(scenes.pop()!);
      },
      isContextLost: () => false,
    };
    return Object.assign(fences, { scenes });
  }

  /**
   * Records the copies of the canvas made into 2D canvases (happy-dom has no 2D canvas): a 2D context
   * that records what is drawn into it with drawImage and does nothing else.
   */
  function recordCopies(): { copied: unknown[]; restore(): void } {
    const copied: unknown[] = [];
    const context = new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, key) =>
        key === 'drawImage'
          ? (src: unknown) => copied.push(src)
          : key === 'createImageData'
            ? (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
            : () => undefined,
    });
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
    return { copied, restore: () => spy.mockRestore() };
  }

  /**
   * {@link fenceContext} that also reads pixels back into buffers (WebGL2 pixel pack buffers): the
   * reads it was asked for (the framebuffer and buffer bound then), and what is bound now. Its
   * buffers hold pixels of 200.
   */
  function readbackContext(gl: RecordingRenderer) {
    const fences = fenceContext(gl);
    const READ_FRAMEBUFFER = 0x8ca8;
    const PIXEL_PACK_BUFFER = 0x88eb;
    const bound = { read: 'three.js framebuffer' as unknown, pack: null as unknown };
    const reads: { framebuffer: unknown; buffer: unknown; offset: unknown }[] = [];
    Object.assign(gl.context as object, {
      READ_FRAMEBUFFER,
      READ_FRAMEBUFFER_BINDING: 0x8caa,
      PIXEL_PACK_BUFFER,
      PIXEL_PACK_BUFFER_BINDING: 0x88ed,
      STREAM_READ: 0x88e1,
      RGBA: 0x1908,
      UNSIGNED_BYTE: 0x1401,
      drawingBufferWidth: 8,
      drawingBufferHeight: 4,
      getParameter: (p: number) => (p === 0x8caa ? bound.read : p === 0x88ed ? bound.pack : null),
      bindFramebuffer: (target: number, fb: unknown) => {
        if (target === READ_FRAMEBUFFER) bound.read = fb;
      },
      bindBuffer: (target: number, buffer: unknown) => {
        if (target === PIXEL_PACK_BUFFER) bound.pack = buffer;
      },
      createBuffer: () => ({ buffer: reads.length }),
      bufferData: () => undefined,
      readPixels: (...args: unknown[]) =>
        reads.push({ framebuffer: bound.read, buffer: bound.pack, offset: args[6] }),
      getBufferSubData: (_target: number, _offset: number, dst: Uint8Array) => dst.fill(200),
      deleteBuffer: () => undefined,
    });
    return { fences, reads, bound };
  }

  it("draws no frame for the project's thumbnail: copies the frame the viewport drew, reads back one the GPU still draws", () => {
    // regression: the thumbnail drew a frame of its own (with 4 million triangles in software WebGL
    // its copy waited 0.55 to 0.95 s for the GPU, 3 s after every change); a copy of the canvas
    // waits for the frames the GPU still draws (1.16 to 1.28 s while the animation played)
    const s = session();
    const { e, gl } = engine(s);
    const { fences, reads, bound } = readbackContext(gl);
    // the copies of the canvas made (drawImage), and the JPEGs made, of copies or read backs
    const { copied, restore } = recordCopies();
    let encoded = 0;
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      () => `data:image/jpeg;base64,${++encoded}`,
    );
    const done = () => {
      for (const f of [...fences, ...fences.scenes]) f.done = true;
    };
    try {
      // before the viewport drew anything: none, and no frame drawn for it (a hidden page draws none)
      let renders = scenePasses(e, gl).length;
      expect(e.thumbnail()).toBeNull();
      expect(scenePasses(e, gl).length).toBe(renders);
      // a frame the GPU still draws: none, nothing copied; the loop reads the canvas back after it,
      // into a buffer, without waiting, and binds back what three.js had bound
      frame(e);
      renders = scenePasses(e, gl).length;
      expect(e.thumbnail()).toBeNull();
      frame(e);
      expect(reads).toEqual([{ framebuffer: null, buffer: { buffer: 0 }, offset: 0 }]);
      expect(bound).toEqual({ read: 'three.js framebuffer', pack: null });
      expect(e.thumbnail()).toBeNull();
      frame(e);
      expect(reads).toHaveLength(1);
      // drawn: the next turn of the loop makes the thumbnail of the pixels read back
      done();
      frame(e);
      expect(encoded).toBe(1);
      expect(copied).toEqual([]);
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,1');
      expect(scenePasses(e, gl).length).toBe(renders);
      // nothing in flight and the canvas shows the document: a copy of a frame drawn since, at once
      e.requestRender();
      frame(e);
      done();
      frame(e);
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,2');
      expect(copied).toEqual([e.renderer.domElement]);
      // a frame that shows no change of the document (the view moved) in flight: the copy of the
      // frame before, which shows the same document, without waiting for it
      e.requestRender();
      frame(e);
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,2');
      expect(copied).toHaveLength(1);
      // a change of the document drawn in a frame the GPU still draws: none until it is read back
      done();
      frame(e);
      s.doc.addObject({ type: 'EMPTY', name: 'Marker' });
      frame(e);
      expect(e.thumbnail()).toBeNull();
      expect(copied).toHaveLength(1);
      frame(e);
      expect(reads).toHaveLength(2);
      done();
      frame(e);
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,3');
      expect(copied).toHaveLength(1);
      // a resize clears the canvas: a frame of another change drawn before it is not copied after it
      s.doc.addObject({ type: 'EMPTY', name: 'Marker 2' });
      frame(e);
      done();
      frame(e);
      e.resize();
      expect(e.thumbnail()).toBeNull();
      expect(copied).toHaveLength(1);
      frame(e);
      done();
      frame(e);
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,4');
      expect(copied).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('scales the pixels read back down into the thumbnail, the top row of the image first', () => {
    // WebGL reads rows from the bottom: 4 × 2 pixels, the bottom row red, the top row green, each
    // column brighter than the one on its left
    const pixels = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++) {
        const k = (y * 4 + x) * 4;
        const v = [40, 80, 160, 200][x];
        pixels.set(y === 0 ? [v, 0, 0, 255] : [0, v, 0, 255], k);
      }
    let put: ImageData | null = null;
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
      putImageData: (img: ImageData) => (put = img),
    } as never);
    const encode = vi
      .spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue('data:image/jpeg;base64,AA==');
    try {
      expect(thumbnailJpeg(pixels, 4, 2, 2)).toBe('data:image/jpeg;base64,AA==');
      // 2 × 1: each pixel the mean of the 2 × 2 it covers
      expect(put!.width).toBe(2);
      expect(put!.height).toBe(1);
      expect([...put!.data]).toEqual([30, 30, 0, 255, 90, 90, 0, 255]);
      // at full size: the top row of the image (green) first
      expect(thumbnailJpeg(pixels, 4, 2, 4)).toBe('data:image/jpeg;base64,AA==');
      expect([...put!.data.slice(0, 4)]).toEqual([0, 40, 0, 255]);
      expect([...put!.data.slice(16, 20)]).toEqual([40, 0, 0, 255]);
      expect(encode).toHaveBeenCalledWith('image/jpeg', 0.7);
    } finally {
      context.mockRestore();
      encode.mockRestore();
    }
  });

  it('reads back the thumbnail of a change while the viewport draws without a pause, holding no frame back', () => {
    // regression: while the animation played the viewport always had frames in flight, and the
    // thumbnail of a change waited until it stopped (30 s at most): a light project's list entry
    // kept its old picture
    const s = session();
    const { e, gl } = engine(s);
    const { fences, reads } = readbackContext(gl);
    const { copied, restore } = recordCopies();
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AA==');
    /**
     * A turn of the loop while the animation plays: the frame changes, the GPU is done with the oldest
     * fence (and so with everything before it: fences signal in order).
     */
    const play = () => {
      fences.find((f) => !f.done)!.done = true;
      s.state.frame += 1;
      frame(e);
    };
    try {
      // the GPU draws three frames of the animation at a time
      for (let i = 0; i < 3; i++) {
        s.state.frame += 1;
        frame(e);
      }
      const renders = () => scenePasses(e, gl).length;
      play();
      // a change of the document; its thumbnail is asked for while frames are in flight
      s.doc.addObject({ type: 'EMPTY', name: 'Marker' });
      play();
      expect(e.thumbnail()).toBeNull();
      // read back after the frame that shows it, and the animation goes on: a frame every turn
      let before = renders();
      play();
      expect(reads).toHaveLength(1);
      expect(renders()).toBeGreaterThan(before);
      before = renders();
      play();
      expect(renders()).toBeGreaterThan(before);
      expect(e.thumbnail()).toBeNull();
      // once the GPU has filled its buffer: the thumbnail, no copy of the canvas made, no more reads
      for (let i = 0; i < 4; i++) play();
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,AA==');
      expect(copied).toEqual([]);
      expect(reads).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it('copies the frame of a change once for a thumbnail asked for before it was drawn, without WebGL2 fences', () => {
    // without fences no frame is in flight: the loop copies the canvas once it shows the change
    const s = session();
    const { e } = engine(s);
    const { copied, restore } = recordCopies();
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AA==');
    try {
      frame(e);
      s.doc.addObject({ type: 'EMPTY', name: 'Marker' });
      expect(e.thumbnail()).toBeNull();
      frame(e);
      expect(copied).toEqual([]);
      frame(e);
      expect(copied).toEqual([e.renderer.domElement]);
      expect(e.thumbnail()).toBe('data:image/jpeg;base64,AA==');
      // and nothing more while the viewport draws nothing new
      for (let i = 0; i < 3; i++) frame(e);
      expect(copied).toHaveLength(1);
    } finally {
      restore();
    }
  });

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
    // a GPU draws its frames fast: multisampling comes back (the first frame's time is not what
    // frames cost: it builds the pipelines)
    now += MSAA_ON_FRAME_MS / 2;
    fences[0].done = true;
    heavy.e.requestRender();
    frame(heavy.e);
    expect(heavy.e.multisampling).toBe(false);
    now += MSAA_ON_FRAME_MS / 2;
    fences[1].done = true;
    frame(heavy.e);
    expect(heavy.e.multisampling).toBe(true);
    // a light scene starts with it
    const light = engine(scatterScene(20));
    frame(light.e);
    expect(light.e.multisampling).toBe(true);
  });

  it('says drawn once a heavy scene’s first frame is done (multisampling turned off in its sync)', () => {
    // regression: the sync of a heavy scene's first frame turned multisampling off, which asks for a
    // frame (requestRender); the frame drawn right after the sync showed that change, but counted as
    // showing only those asked for before the sync, so data-view stayed pending until some other
    // change: an end-to-end test waiting for a drawn frame of a scene over 1 M triangles timed out
    const heavy = engine(scatterScene(400));
    const fences = fenceContext(heavy.gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    frame(heavy.e);
    expect(heavy.e.multisampling).toBe(false);
    expect(heavy.e.canvas.dataset.view).toBe('pending');
    const passes = scenePasses(heavy.e, heavy.gl).length;
    // the GPU takes 2 s for it (multisampling stays off), then nothing changes
    now += 2000;
    for (const f of [...fences, ...fences.scenes]) f.done = true;
    for (let i = 0; i < 3; i++) {
      now += 16;
      frame(heavy.e);
    }
    expect(heavy.e.canvas.dataset.view).toBe('drawn');
    // and no other frame was drawn: the first one showed every change
    expect(scenePasses(heavy.e, heavy.gl)).toHaveLength(passes);
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

  it('says on the canvas whether the GPU has drawn every change (data-view, for end-to-end tests)', () => {
    // regression: an end-to-end test took a picture of the viewport right after the panel showed a
    // change (a bake's cache text), while the browser still showed the frame before it (software
    // WebGL took seconds to draw the selection outline's first frame): it compared later pictures
    // with that one and failed
    const s = session();
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const view = () => e.canvas.dataset.view;
    expect(view()).toBe('pending');
    frame(e);
    // drawn, but not by the GPU yet
    expect(view()).toBe('pending');
    fences[0].done = true;
    frame(e);
    expect(view()).toBe('drawn');
    // a change: pending at once, until a frame showing it is done
    s.state.selectedIds = [s.doc.listObjects().find((o) => o.type === 'MESH')!.id];
    expect(view()).toBe('pending');
    frame(e);
    // another change while that frame is drawn
    e.requestRender();
    fences[1].done = true;
    frame(e);
    expect(view()).toBe('pending');
    fences[2].done = true;
    frame(e);
    expect(view()).toBe('drawn');
    // an animated view change: pending until its last frame is done
    const p = clonePose(e.pose);
    p.yaw += 1;
    now = 2000;
    e.setPose(p, true);
    for (const ms of [0, 50, 100, 150, 200]) {
      now = 2000 + ms;
      frame(e);
      for (const f of fences) f.done = true;
      expect(view(), `${ms} ms into it`).toBe('pending');
    }
    now = 2000 + VIEW_ANIMATION_MS;
    frame(e);
    expect(view()).toBe('pending');
    for (const f of fences) f.done = true;
    frame(e);
    expect(view()).toBe('drawn');
  });

  it('says on the canvas how many samples per pixel the frame it shows was drawn with (data-samples)', () => {
    // regression: end-to-end tests compared pictures of the viewport taken a few seconds apart on a
    // busy machine, where it had turned multisampling off between them: 0.8–1.4 % of the pixels,
    // the edges, differed. A test compares pictures drawn with the same samples
    const s = session();
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const shown = () => [e.canvas.dataset.view, e.canvas.dataset.samples];
    /** Runs the loop on every animation frame (16 ms) for `ms` while the GPU draws. */
    const wait = (ms: number) => {
      for (let t = 0; t < ms; t += 16) {
        now += 16;
        frame(e);
      }
    };
    // the first frame builds the pipelines; drawn with multisampling
    frame(e);
    fences[0].done = true;
    frame(e);
    expect(shown()).toEqual(['drawn', String(VIEWPORT_MSAA_SAMPLES)]);
    // a slow frame turns it off: the frame drawn again without it says so once it is done
    e.requestRender();
    frame(e);
    wait(MSAA_OFF_FRAME_MS + 50);
    fences[1].done = true;
    frame(e);
    expect(e.multisampling).toBe(false);
    expect(shown()).toEqual(['pending', String(VIEWPORT_MSAA_SAMPLES)]);
    wait(MSAA_ON_FRAME_MS * 2);
    fences[2].done = true;
    frame(e);
    expect(shown()).toEqual(['drawn', '0']);
  });

  it('says how many samples per pixel the frame was drawn with where WebGL has no fences', () => {
    // without fences (WebGL 1) a frame counts as drawn once it is sent: its samples with it
    const s = session();
    const { e, gl } = engine(s);
    expect(gl.context).toBeNull();
    frame(e);
    expect([e.canvas.dataset.view, e.canvas.dataset.samples]).toEqual([
      'drawn',
      String(VIEWPORT_MSAA_SAMPLES),
    ]);
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
    /** Runs the loop on every animation frame (16 ms) for `ms` while the GPU draws. */
    const wait = (ms: number) => {
      for (let t = 0; t < ms; t += 16) {
        now += Math.min(16, ms - t);
        frame(e);
      }
    };
    /** Finishes the frame in flight after `ms` and runs the loop once (with a view change if asked). */
    const finish = (ms: number, change = false) => {
      wait(ms);
      fences.at(-1)!.done = true;
      if (change) e.requestRender();
      frame(e);
    };
    /** The GPU draws the frame in flight's multisampled renders for `ms`, then it is done. */
    const slow = (ms: number) => {
      wait(ms);
      finish(1);
    };
    // the first frame builds the pipelines: its time is not what frames cost
    frame(e);
    finish(MSAA_ON_FRAME_MS / 2, true);
    expect(samples()).toEqual([VIEWPORT_MSAA_SAMPLES, VIEWPORT_MSAA_SAMPLES]);
    // a slow frame: multisampling goes off and the view is drawn again without it, unasked
    slow(MSAA_OFF_FRAME_MS + 50);
    expect(e.multisampling).toBe(false);
    expect(samples()).toEqual([0, 0]);
    expect(scenePasses(e, gl)).toHaveLength(3);
    // frames without it that are not fast enough keep it off (the first one, which builds the
    // pipelines for the new sample count, does not count)
    finish(MSAA_ON_FRAME_MS / 2, true);
    finish(MSAA_ON_FRAME_MS * 3, true);
    expect(e.multisampling).toBe(false);
    expect(scenePasses(e, gl)).toHaveLength(5);
    // a fast one brings it back, and the view is drawn again with it
    finish(MSAA_ON_FRAME_MS / 2);
    expect(e.multisampling).toBe(true);
    expect(samples()).toEqual([VIEWPORT_MSAA_SAMPLES, VIEWPORT_MSAA_SAMPLES]);
    expect(scenePasses(e, gl)).toHaveLength(6);
    // a slow frame that compiled shaders (the first one in Rendered shading) changes nothing: its
    // time is the compiler's (regression: a light scene's first frames, slow while compiling, turned
    // multisampling off and the next fast ones on again, so its edges changed between screenshots)
    gl.onRender = () => gl.info.programs.push({});
    finish(MSAA_ON_FRAME_MS / 2, true);
    gl.onRender = null;
    expect(scenePasses(e, gl)).toHaveLength(7);
    finish(SLOW_FRAME_MS + 1000);
    expect(e.multisampling).toBe(true);
    expect(slowFrameMs.value).toBe(SLOW_FRAME_MS + 1000);
    expect(slowFrameCompiled.value).toBe(true);
    expect(scenePasses(e, gl)).toHaveLength(7);
    // the frames after it show what the scene costs
    e.requestRender();
    frame(e);
    slow(SLOW_FRAME_MS + 1000);
    expect(e.multisampling).toBe(false);
    expect(slowFrameCompiled.value).toBe(false);
    expect(scenePasses(e, gl)).toHaveLength(9);
    finish(MSAA_ON_FRAME_MS / 2, true);
    finish(MSAA_ON_FRAME_MS / 2);
    expect(e.multisampling).toBe(true);
    expect(slowFrameMs.value).toBe(0);
    // a light scene's frame slowed down for a moment (a busy machine) keeps it
    expect(MSAA_OFF_FRAME_MS).toBeGreaterThanOrEqual(1000);
    // fast frames that compile shaders do not bring multisampling back
    finish(MSAA_ON_FRAME_MS / 2, true);
    slow(MSAA_OFF_FRAME_MS * 2);
    expect(e.multisampling).toBe(false);
    gl.onRender = () => gl.info.programs.push({});
    for (let i = 0; i < 3; i++) finish(MSAA_ON_FRAME_MS / 2, true);
    expect(e.multisampling).toBe(false);
    gl.onRender = null;
  });

  it('keeps multisampling for a frame seen done late because the main thread was busy (a rigid body bake)', () => {
    // regression: in software WebGL a light scene lost its smooth edges for good after a rigid body
    // bake, which kept the main thread busy for seconds: the frame drawn right before it was only
    // seen done after it, and counted as that slow
    const s = session();
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    frame(e);
    // no frame of the loop runs for 1.5 s; the GPU is done by then
    now += 1500;
    fences.at(-1)!.done = true;
    frame(e);
    expect(e.multisampling).toBe(true);
    expect(scenePasses(e, gl)).toHaveLength(1);
  });

  it('keeps multisampling for a frame slow after its multisampled renders (outlines, view transform)', () => {
    // regression: on a busy machine the default cube's frames took more than a second in software
    // WebGL, most of it for the full-screen passes after the scene (selection outlines, view
    // transform), which cost as much without multisampling: it went off between two pictures of the
    // same view in an end-to-end test, whose edges then differed (1.4 % of the pixels)
    const s = session();
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    frame(e);
    // the scene and its overlays are seen drawing after 30 ms and done after 40 ms
    now += 30;
    frame(e);
    for (const f of fences.scenes) f.done = true;
    now += 10;
    frame(e);
    // the rest of the frame takes 1.5 s more
    now += 1500;
    frame(e);
    fences.at(-1)!.done = true;
    now += 10;
    frame(e);
    expect(e.multisampling).toBe(true);
    expect(scenePasses(e, gl)).toHaveLength(1);
  });

  /**
   * A viewport whose loop runs on every animation frame (16 ms) while the test waits; its first
   * frame (which builds the pipelines) is drawn in `firstFrameMs`.
   */
  function pacedEngine(s: ProjectSession, firstFrameMs = 50) {
    const { e, gl } = engine(s);
    const fences = fenceContext(gl);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const clock = {
      e,
      gl,
      fences,
      /** Runs the loop every 16 ms for `ms`. */
      wait(ms: number) {
        for (let t = 0; t < ms; t += 16) {
          now += Math.min(16, ms - t);
          frame(e);
        }
      },
      /** Moves the clock on without running the loop (the main thread is busy). */
      hold(ms: number) {
        now += ms;
      },
      /** The GPU finishes every frame in flight after `ms`; the loop sees it (and draws what is asked). */
      finish(ms: number, change = false) {
        clock.wait(ms);
        for (const f of [...fences, ...fences.scenes]) f.done = true;
        if (change) e.requestRender();
        frame(e);
      },
      /** A frame of a change, which the GPU draws for `ms`. */
      change(ms: number) {
        e.requestRender();
        frame(e);
        clock.finish(ms);
      },
    };
    // the first frame builds the pipelines; the next ones show what frames cost
    frame(e);
    clock.finish(firstFrameMs);
    return clock;
  }

  it('keeps multisampling when the first fence read after the main thread was held up says a frame is still drawing', () => {
    // regression: WebGL changes a fence's state only between tasks, and Chrome reads it again from
    // the GPU process a task later. In software WebGL a frame of domino-cascade (0.3–0.7 s) drawn
    // before a 1.5 s screenshot was read as drawing 1.7 s after it began (done 2 ms later):
    // multisampling went off, the viewport drew Material Preview without it, and the first
    // screenshot there (4 samples) built every material's pipelines again (13.2 s, no shader compiled)
    const changes: Record<string, boolean[]> = {};
    for (const heldUpBy of ['a long task', 'a picture'] as const) {
      const s = session();
      const c = pacedEngine(s);
      const switched = (changes[heldUpBy] = [] as boolean[]);
      const engine = c.e as unknown as { setMultisampling(on: boolean): void };
      const set = engine.setMultisampling.bind(engine);
      engine.setMultisampling = (on) => {
        switched.push(on);
        set(on);
      };
      c.e.requestRender();
      frame(c.e);
      c.wait(32);
      if (heldUpBy === 'a picture') {
        // the picture waits for the GPU to draw the frame and itself
        c.gl.readPixels = (b) => {
          c.hold(1600);
          b.fill(0);
        };
        c.e.renderPixels({ useViewport: true, shading: 'SOLID', width: 32, height: 16 });
      } else c.hold(1600);
      // the first read says the frame is still drawing, the next one (2 ms later) that it is done
      frame(c.e);
      c.hold(2);
      for (const f of [...c.fences, ...c.fences.scenes]) f.done = true;
      frame(c.e);
      expect(c.e.multisampling, heldUpBy).toBe(true);
    }
    // never turned off (and on again)
    expect(changes).toEqual({ 'a long task': [], 'a picture': [] });
  });

  it('keeps multisampling when the read after a short picture says the frame drawn before it is still drawing', () => {
    // a picture waits for the frames the GPU still draws, and the first fence read after it can still
    // say "drawing" for one done before it (WebGL changes a fence's state only between tasks). After
    // a picture shorter than FRESH_POLL_MS that read counts as fresh: a frame whose multisampled
    // renders took 0.9 s, read as drawing 1.1 s after they began, turned multisampling off. Frames in
    // flight while a picture is taken do not count.
    const s = session();
    const c = pacedEngine(s);
    const switched: boolean[] = [];
    const engine = c.e as unknown as { setMultisampling(on: boolean): void };
    const set = engine.setMultisampling.bind(engine);
    engine.setMultisampling = (on) => {
      switched.push(on);
      set(on);
    };
    c.e.requestRender();
    frame(c.e);
    // the GPU draws the frame for 0.9 s, read every 16 ms; then a picture of 0.2 s
    c.wait(MSAA_OFF_FRAME_MS - 100);
    c.gl.readPixels = (b) => {
      c.hold(FRESH_POLL_MS - 50);
      b.fill(0);
    };
    c.e.renderPixels({ useViewport: true, width: 32, height: 16 });
    // the first read says the frame is still drawing, the next one (2 ms later) that it is done
    frame(c.e);
    c.hold(2);
    for (const f of [...c.fences, ...c.fences.scenes]) f.done = true;
    frame(c.e);
    expect(switched).toEqual([]);
    expect(c.e.multisampling).toBe(true);
  });

  it('keeps multisampling off when frames queued behind each other are seen done together', () => {
    // regression: after the main thread was held up (a screenshot), the frames the GPU had drawn
    // meanwhile were seen done in one turn of the loop; the second one counted from when the first
    // was seen done, 0 ms, so multisampling came back, and the next frame built every pipeline
    // again for 4 samples (seconds in software WebGL) and turned it off again
    const s = scatterScene(400);
    const c = pacedEngine(s, MSAA_ON_FRAME_MS * 4);
    expect(c.e.multisampling).toBe(false);
    // two frames, the second queued behind the first
    c.e.requestRender();
    frame(c.e);
    c.e.requestRender();
    frame(c.e);
    expect(c.fences.length).toBe(3);
    c.hold(1600);
    for (const f of [...c.fences, ...c.fences.scenes]) f.done = true;
    frame(c.e);
    expect(c.e.multisampling).toBe(false);
    // a frame seen fast from its start brings it back (a GPU)
    c.change(MSAA_ON_FRAME_MS / 2);
    expect(c.e.multisampling).toBe(true);
  });

  it('does not count the first frame after a change that has the GPU build pipelines without compiling a shader', () => {
    // a shading or X-ray switch, a picture or new multisampling give frames other pipelines
    // (SwiftShader builds one per shader, render state and sample count: seconds for a scene's
    // materials in software WebGL), also where no program is linked for them: such a slow frame says
    // nothing of what frames cost
    const s = session();
    s.view.shading.value = 'SOLID';
    const c = pacedEngine(s);
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    const events: [string, () => void][] = [
      ['a shading switch', () => (s.view.shading.value = 'MATERIAL')],
      ['a shading switch back', () => (s.view.shading.value = 'SOLID')],
      ['X-ray', () => (s.view.xray.value = true)],
      ['a picture', () => c.e.renderPixels({ useViewport: true, width: 32, height: 16 })],
    ];
    for (const [what, event] of events) {
      event();
      frame(c.e);
      c.finish(MSAA_OFF_FRAME_MS * 3);
      expect(c.e.multisampling, what).toBe(true);
      // the frames after it count
      c.change(50);
    }
    // a material built again for new values reuses its shader program and pipelines (an animated
    // colour during playback): its frame counts
    s.doc.updateMaterial(cube.material_slots[0]!, { roughness: 0.31 });
    frame(c.e);
    c.finish(MSAA_OFF_FRAME_MS * 3);
    expect(c.e.multisampling).toBe(false);
    // the first frame without multisampling builds the pipelines again: fast or slow, it does not
    // count; a fast frame after it brings multisampling back, and the first one with it does not
    // count either
    c.finish(MSAA_ON_FRAME_MS / 2);
    expect(c.e.multisampling).toBe(false);
    c.change(MSAA_ON_FRAME_MS / 2);
    expect(c.e.multisampling).toBe(true);
    c.finish(MSAA_OFF_FRAME_MS * 3);
    expect(c.e.multisampling).toBe(true);
  });

  /**
   * Takes a shader program out of the renderer's list as three.js does when it releases one
   * (WebGLPrograms.releaseProgram): the last one moves into its place.
   */
  function releaseProgram(gl: RecordingRenderer, program: unknown) {
    const programs = gl.info.programs;
    const i = programs.indexOf(program);
    programs[i] = programs[programs.length - 1];
    programs.pop();
  }

  it('counts a frame that compiled a program as compiling, also when another program was released in it', () => {
    // regression: three.js appends a program it compiles to its list and takes a released one out
    // by moving the last one into its place. A frame that compiled a program and released another
    // one (an edit that gives a material another shader: the old material goes once the new one is
    // drawn) kept the number of programs and the last one, so its compile time counted as what
    // frames cost; a frame that only released one (an object with a material of its own deleted)
    // changed the last one and counted as compiling
    const s = session();
    const c = pacedEngine(s);
    const programs = c.gl.info.programs;
    const replaced = {};
    programs.push(replaced, {});
    c.gl.onRender = () => {
      // the new material's program, compiled when it is drawn, then the old one's released
      programs.push({});
      releaseProgram(c.gl, replaced);
      c.gl.onRender = null;
    };
    c.e.requestRender();
    frame(c.e);
    expect(programs).toHaveLength(2);
    c.finish(MSAA_OFF_FRAME_MS * 3);
    expect(c.e.multisampling).toBe(true);
    expect(slowFrameCompiled.value).toBe(true);
    // a frame that only released a program compiled none: its time is what frames cost
    // (multisampling goes off, and the fast frames after it bring it back)
    programs.push({});
    const deleted = programs[0];
    c.gl.onRender = () => {
      releaseProgram(c.gl, deleted);
      c.gl.onRender = null;
    };
    c.e.invalidate();
    frame(c.e);
    expect(programs).toHaveLength(2);
    c.finish(MSAA_OFF_FRAME_MS * 3);
    expect(c.e.multisampling).toBe(false);
    expect(slowFrameCompiled.value).toBe(false);
    c.finish(MSAA_ON_FRAME_MS / 2);
    c.change(MSAA_ON_FRAME_MS / 2);
    c.finish(MSAA_ON_FRAME_MS / 2);
    expect(c.e.multisampling).toBe(true);
    // a program compiled in the frame's scene sync (an environment map made for the shading) counts
    // too: its GPU work comes before the frame's renders
    const sync = c.e.sync.bind(c.e);
    vi.spyOn(c.e, 'sync').mockImplementation(() => {
      sync();
      c.gl.info.programs.push({});
    });
    c.e.invalidate();
    frame(c.e);
    vi.mocked(c.e.sync).mockRestore();
    c.finish(MSAA_OFF_FRAME_MS * 3);
    expect(c.e.multisampling).toBe(true);
    expect(slowFrameCompiled.value).toBe(true);
    // and a frame that compiled nothing is what frames cost
    c.e.invalidate();
    frame(c.e);
    c.finish(MSAA_OFF_FRAME_MS * 3);
    expect(c.e.multisampling).toBe(false);
  });

  it('draws pictures with the viewport’s multisampling: 4 samples while it has them, none while it does not', () => {
    // regression: pictures always had 4 samples (8 asked for); software WebGL builds pipelines per
    // sample count, so the first picture in a shading the viewport had drawn single-sampled built
    // every material's pipelines again: 9.8–13.5 s for domino-cascade, no shader compiled. A
    // shading drawn with the other count only (before the viewport's changed) keeps that one.
    const samplesOf = (
      e: ViewportEngine,
      gl: RecordingRenderer,
      opts: Parameters<ViewportEngine['renderPixels']>[0],
    ) => {
      const seen: number[] = [];
      gl.onRender = (scene) => {
        const target = (
          gl as unknown as { getRenderTarget(): THREE.WebGLRenderTarget | null }
        ).getRenderTarget();
        if (scene === e.scene && gl.renders.at(-1)!.camera.layers.isEnabled(0))
          seen.push(target?.samples ?? -1);
      };
      e.renderPixels(opts);
      gl.onRender = null;
      return seen.at(-1);
    };
    const light = pacedEngine(session());
    expect(light.e.multisampling).toBe(true);
    for (const shading of ['SOLID', 'RENDERED', null] as const)
      expect(
        samplesOf(light.e, light.gl, { useViewport: true, shading, width: 32, height: 16 }),
        String(shading),
      ).toBe(VIEWPORT_MSAA_SAMPLES);
    const heavy = pacedEngine(scatterScene(400));
    expect(heavy.e.multisampling).toBe(false);
    for (const shading of ['SOLID', 'MATERIAL', null] as const)
      expect(
        samplesOf(heavy.e, heavy.gl, { useViewport: true, shading, width: 32, height: 16 }),
        String(shading),
      ).toBe(0);
    // a final render (F12, render_image in the browser) of Rendered shading, drawn by the viewport
    // without samples only, has none either: supersampled or smoothed with SMAA (see the next test)
    expect(samplesOf(heavy.e, heavy.gl, { width: 32, height: 16 })).toBe(0);
    // the light scene's viewport (Solid) drops its samples: Rendered, drawn by a picture with 4
    // only, keeps them; Solid, drawn by the viewport with both, and Material Preview, not drawn
    // yet, have the viewport's
    const setMultisampling = (on: boolean) =>
      (light.e as unknown as { setMultisampling(on: boolean): void }).setMultisampling(on);
    const capture = (shading: 'SOLID' | 'MATERIAL' | 'RENDERED' | null) =>
      samplesOf(light.e, light.gl, { useViewport: true, shading, width: 32, height: 16 });
    setMultisampling(false);
    light.wait(32);
    expect(capture('RENDERED')).toBe(VIEWPORT_MSAA_SAMPLES);
    expect(capture(null)).toBe(0);
    expect(capture('MATERIAL')).toBe(0);
    // and back: Material Preview, drawn without samples only, keeps none
    setMultisampling(true);
    light.wait(32);
    expect(light.e.multisampling).toBe(true);
    expect(capture('MATERIAL')).toBe(0);
    expect(capture('RENDERED')).toBe(VIEWPORT_MSAA_SAMPLES);
    expect(capture(null)).toBe(VIEWPORT_MSAA_SAMPLES);
  });

  /**
   * What a render drew: the sample counts of the targets the scene was drawn into (in order) and
   * the size of the last one, and how often SMAA ran.
   */
  type Drawn = { samples: number[]; size: [number, number]; smaa: number };
  function drawnBy(
    c: { e: ViewportEngine; gl: RecordingRenderer },
    opts: Parameters<ViewportEngine['renderPixels']>[0],
  ): Drawn {
    const smaa = vi.spyOn(SMAAPass.prototype, 'render');
    smaa.mockClear();
    const samples: number[] = [];
    let size: [number, number] = [0, 0];
    c.gl.onRender = (scene) => {
      const target = (
        c.gl as unknown as { getRenderTarget(): THREE.WebGLRenderTarget | null }
      ).getRenderTarget();
      if (scene === c.e.scene && c.gl.renders.at(-1)!.camera.layers.isEnabled(0)) {
        samples.push(target?.samples ?? -1);
        size = [target?.width ?? 0, target?.height ?? 0];
      }
    };
    try {
      c.e.renderPixels(opts);
    } finally {
      c.gl.onRender = null;
    }
    return { samples, size, smaa: smaa.mock.calls.length };
  }

  /**
   * The GPU times the next one-pixel read-backs wait for, in order (ms): a final render without
   * samples reads one after the frames the GPU still draws for the viewport, and one after its first
   * picture (see ViewportEngine.drawFinalScene).
   */
  function gpuTimes(c: { gl: RecordingRenderer; hold(ms: number): void }, ...ms: number[]): void {
    c.gl.readPixels = (b) => {
      if (b.length === 4 && ms.length) c.hold(ms.shift()!);
      b.fill(0);
    };
  }

  const setMultisampling = (e: ViewportEngine, on: boolean) =>
    (e as unknown as { setMultisampling(on: boolean): void }).setMultisampling(on);
  const passes = (e: ViewportEngine) =>
    (
      e as unknown as {
        captureParts(): Record<
          'unpremultiply' | 'premultiply' | 'unpremultiplyShown' | 'average',
          ShaderPass
        >;
      }
    ).captureParts();

  it('draws final renders of a shading the viewport drew only without samples without them: supersampled when the first picture fits the time budget, else smoothed with SMAA; multisampled where it drew it with samples and in Render Animation', () => {
    // regressions: final renders (F12, render_image in the browser) always asked for 8 samples (4
    // in software WebGL): the first one after the viewport drew Rendered shading without samples (a
    // heavy scene, slow frames) built every material's pipelines again: 19.4 s for the first F12 at
    // 1280×720 and 11.4 s for the next one, in examples/domino-cascade with a 1 M triangle grid in
    // software WebGL. Then SMAA alone smoothed them: rods 0.8 px wide came out dashed.
    const heavy = pacedEngine(scatterScene(400));
    expect(heavy.e.multisampling).toBe(false);
    // the SMAA pass is made when the viewport goes without samples, before any final render, so
    // the lookup textures it decodes from data URLs are there for the first one
    expect((heavy.e as unknown as { smaa: SMAAPass | null }).smaa).toBeInstanceOf(SMAAPass);
    const supersampled = (size: [number, number]): Drawn => ({
      samples: FINAL_SUPERSAMPLE_OFFSETS.map(() => 0),
      size,
      smaa: 0,
    });
    const smoothed = (size: [number, number]): Drawn => ({ samples: [0], size, smaa: 1 });
    // Rendered, drawn by the viewport without samples: the GPU drew the first picture in the budget
    // (after 3 s of the viewport's frames, which do not count), so it draws four more, no SMAA
    gpuTimes(heavy, 3000, FINAL_SUPERSAMPLE_MS);
    expect(drawnBy(heavy, { width: 32, height: 16 })).toEqual(supersampled([32, 16]));
    // a first picture that took longer is the only one, smoothed with SMAA
    gpuTimes(heavy, 0, FINAL_SUPERSAMPLE_MS + 1);
    expect(drawnBy(heavy, { width: 32, height: 16 })).toEqual(smoothed([32, 16]));
    // so is clay shading (SOLID), not drawn yet, while the viewport has no samples
    gpuTimes(heavy, 0, FINAL_SUPERSAMPLE_MS + 1);
    expect(drawnBy(heavy, { width: 30, height: 20, shading: 'SOLID' })).toEqual(smoothed([30, 20]));
    // a capture (editor_command screenshot) shows what the viewport shows: no SMAA
    expect(drawnBy(heavy, { useViewport: true, width: 32, height: 16 })).toEqual({
      samples: [0],
      size: [32, 16],
      smaa: 0,
    });
    // every frame of Render Animation is multisampled (they all get the same anti-aliasing: the
    // first one builds the pipelines); Rendered is multisampled from then on
    const multisampled = (size: [number, number]): Drawn => ({
      samples: [FINAL_RENDER_SAMPLES],
      size,
      smaa: 0,
    });
    expect(drawnBy(heavy, { width: 32, height: 16, frame: 2, animation: true })).toEqual(
      multisampled([32, 16]),
    );
    expect(drawnBy(heavy, { width: 32, height: 16 })).toEqual(multisampled([32, 16]));
    // the Solid final render built Solid's pipelines without samples (noted for its own draw
    // context, not the viewport's): once the viewport has samples again, a Solid picture and the
    // next Solid final render still draw without them, a Material Preview picture with them
    setMultisampling(heavy.e, true);
    heavy.wait(32);
    expect(heavy.e.multisampling).toBe(true);
    expect(drawnBy(heavy, { useViewport: true, shading: 'SOLID', width: 32, height: 16 }).samples).toEqual([
      0,
    ]);
    gpuTimes(heavy, 0, 10);
    expect(drawnBy(heavy, { width: 30, height: 20, shading: 'SOLID' })).toEqual(supersampled([30, 20]));
    expect(drawnBy(heavy, { useViewport: true, shading: 'MATERIAL', width: 32, height: 16 }).samples).toEqual(
      [VIEWPORT_MSAA_SAMPLES],
    );
    // a light scene's viewport has samples: its final renders are multisampled (Rendered not drawn
    // yet), also once the viewport drew Rendered with samples
    const light = pacedEngine(session());
    expect(light.e.multisampling).toBe(true);
    expect(drawnBy(light, { width: 32, height: 16 })).toEqual(multisampled([32, 16]));
    light.e.session.view.shading.value = 'RENDERED';
    light.change(32);
    expect(drawnBy(light, { width: 32, height: 16 })).toEqual(multisampled([32, 16]));
    // and when the viewport then drops its samples, Rendered, drawn with them, keeps them
    setMultisampling(light.e, false);
    light.wait(32);
    expect(drawnBy(light, { width: 32, height: 16 })).toEqual(multisampled([32, 16]));
  });

  it('moves the pictures of a supersampled final render by fractions of a pixel and averages them evenly, drawing transmission pictures for each', () => {
    // a camera with a lens shift, which every picture keeps (setViewOffset would compute the
    // projection anew without it)
    const s = scatterScene(400);
    s.doc.updateBlockByKind('cameras', cameraObject(s).data!, { shift_x: 0.3, shift_y: -0.1 });
    const heavy = pacedEngine(s);
    expect(heavy.e.multisampling).toBe(false);
    // the camera each picture's transmission pictures are drawn with (glass refracts what that
    // picture sees), as it is when they are drawn
    const transmission = (heavy.e as unknown as { transmission: { prepare(...a: unknown[]): void } })
      .transmission;
    const prepare = transmission.prepare.bind(transmission);
    const refracted: THREE.Camera[] = [];
    vi.spyOn(transmission, 'prepare').mockImplementation((...a: unknown[]) => {
      refracted.push((a[2] as THREE.Camera).clone());
      prepare(...a);
    });
    const average = passes(heavy.e).average;
    const weights: number[] = [];
    /** The targets each mix into the average read and wrote (the average before, and after it). */
    const mixes: { read: THREE.WebGLRenderTarget; write: THREE.WebGLRenderTarget }[] = [];
    vi.spyOn(average, 'render').mockImplementation((_r, write, read) => {
      weights.push(average.uniforms.weight.value as number);
      mixes.push({ read, write });
    });
    const into: unknown[] = [];
    heavy.gl.onRender = (scene) => {
      if (scene === heavy.e.scene && heavy.gl.renders.at(-1)!.camera.layers.isEnabled(0))
        into.push((heavy.gl as unknown as { getRenderTarget(): unknown }).getRenderTarget());
    };
    const [width, height] = [64, 36];
    heavy.gl.renders.length = 0;
    gpuTimes(heavy, 0, 1);
    heavy.e.renderPixels({ width, height });
    heavy.gl.onRender = null;
    const pictures = scenePasses(heavy.e, heavy.gl).map((r) => r.camera);
    expect(pictures).toHaveLength(FINAL_SUPERSAMPLE_OFFSETS.length);
    // the first picture is the average so far; each mix reads the average the last one wrote, and
    // the view transform the last one (no picture is mixed into a target it is read from)
    expect(mixes).toHaveLength(FINAL_SUPERSAMPLE_OFFSETS.length - 1);
    mixes.forEach((m, i) => {
      expect(m.read, `mix ${i} reads`).toBe(i ? mixes[i - 1].write : into[0]);
      expect([m.write === m.read, m.write === into[i + 1]], `mix ${i} writes`).toEqual([false, false]);
    });
    const output = (heavy.e as unknown as { captureParts(): { output: ShaderPass } }).captureParts().output;
    expect(output.uniforms.tDiffuse.value).toBe(mixes.at(-1)!.write.texture);
    // where a picture puts a point in front of the camera, in pixels from where the first one does
    const at = (cam: THREE.Camera) => {
      const p = new THREE.Vector3(0, 0, 1)
        .applyMatrix4(cam.matrixWorldInverse)
        .applyMatrix4(cam.projectionMatrix);
      return [(p.x * width) / 2, (p.y * height) / 2];
    };
    const moved = (cams: THREE.Camera[]) =>
      cams.map((cam) => at(cam).map((v, k) => +(v - at(pictures[0])[k]).toFixed(9)));
    const offsets = FINAL_SUPERSAMPLE_OFFSETS.map((o) => o.map((v) => +v.toFixed(9)));
    expect(moved(pictures)).toEqual(offsets);
    expect(moved(refracted)).toEqual(offsets);
    // 5 points per pixel, no two in the same row or column, centred on the pixel
    expect(new Set(FINAL_SUPERSAMPLE_OFFSETS.map(([x]) => x)).size).toBe(5);
    expect(new Set(FINAL_SUPERSAMPLE_OFFSETS.map(([, y]) => y)).size).toBe(5);
    for (const k of [0, 1])
      expect(FINAL_SUPERSAMPLE_OFFSETS.reduce((t, o) => t + o[k], 0)).toBeCloseTo(0, 12);
    // the n-th picture is mixed into the average of those before it with weight 1 / n, so every
    // picture counts the same: the shader, run on the CPU on pictures of colours 0, 1, … 4
    expect(weights).toEqual([1 / 2, 1 / 3, 1 / 4, 1 / 5]);
    let mean = [0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
      const averaged = glslProgram(glslFunction(average.material.fragmentShader, 'averaged'), {
        globals: { weight: i ? weights[i - 1] : 1 },
      });
      mean = averaged('averaged', mean, [i, 2 * i, 0.5, 1]) as number[];
    }
    expect(mean.map((v) => +v.toFixed(12))).toEqual([2, 4, 0.5, 1]);
  });

  it('draws the shadow maps once for the five pictures of a supersampled final render, into a half-float picture freed afterwards', () => {
    // the shadow maps do not depend on the camera: redrawing them for every picture moved by a
    // fraction of a pixel cost four more shadow passes per render; the pictures are averaged in
    // linear light, which an 8-bit target would clamp at 1 and quantize; and the picture target,
    // as large as the image with a depth buffer, was GPU memory kept after each render
    const heavy = pacedEngine(scatterScene(400));
    expect(heavy.e.multisampling).toBe(false);
    const gl = heavy.gl as unknown as {
      shadowMap: { enabled: boolean; needsUpdate?: boolean };
      getRenderTarget(): THREE.WebGLRenderTarget | null;
    };
    // the shadow maps as three.js draws them: in the next render after a request (needsUpdate)
    let requested = false;
    const shadowPasses: number[] = [];
    Object.defineProperty(gl.shadowMap, 'needsUpdate', {
      configurable: true,
      get: () => requested,
      set: (v: boolean) => void (requested = v),
    });
    const local = vi.spyOn(heavy.e.objects, 'renderLocalShadows');
    const pictures: THREE.WebGLRenderTarget[] = [];
    const freed = new Set<THREE.WebGLRenderTarget>();
    heavy.gl.onRender = (scene) => {
      if (requested) {
        shadowPasses.push(heavy.gl.renders.length);
        requested = false;
      }
      const target = gl.getRenderTarget();
      if (scene !== heavy.e.scene || !heavy.gl.renders.at(-1)!.camera.layers.isEnabled(0) || !target) return;
      if (!pictures.includes(target)) target.addEventListener('dispose', () => freed.add(target));
      pictures.push(target);
    };
    gpuTimes(heavy, 0, 1);
    try {
      heavy.e.renderPixels({ width: 64, height: 36 });
    } finally {
      heavy.gl.onRender = null;
      delete (gl.shadowMap as { needsUpdate?: boolean }).needsUpdate;
    }
    expect(pictures).toHaveLength(FINAL_SUPERSAMPLE_OFFSETS.length);
    expect(gl.shadowMap.enabled).toBe(true);
    // the maps of point and spot lights in a pass of their own, the suns' with the first picture
    expect(local).toHaveBeenCalledTimes(1);
    expect(local.mock.results[0].value).toBe(true);
    expect(shadowPasses).toHaveLength(2);
    // the first picture goes into the composer's buffer, the four moved ones into a picture target
    // of their own: half floats like the composer's, as large as the image, freed after the render
    const [first, ...moved] = pictures;
    expect(new Set(moved).size).toBe(1);
    expect(moved[0]).not.toBe(first);
    expect([moved[0].texture.type, first.texture.type]).toEqual([THREE.HalfFloatType, THREE.HalfFloatType]);
    expect([moved[0].width, moved[0].height]).toEqual([64, 36]);
    expect(freed.has(moved[0])).toBe(true);
  });

  it("chooses the samples of a final render by what was drawn in its own shading, not by the viewport's shading", () => {
    // a light scene, its viewport multisampled in Solid shading, showed Rendered for a while
    // without samples: Rendered has been drawn without them only, Solid with them
    const light = pacedEngine(session());
    expect(light.e.multisampling).toBe(true);
    setMultisampling(light.e, false);
    light.e.session.view.shading.value = 'RENDERED';
    light.change(32);
    light.e.session.view.shading.value = 'SOLID';
    setMultisampling(light.e, true);
    light.change(32);
    expect(light.e.multisampling).toBe(true);
    // a final render in Rendered goes without samples (supersampled: the first picture was quick),
    // so it builds no pipelines with them; one in Solid has the samples Solid was drawn with
    gpuTimes(light, 0, 1);
    expect(drawnBy(light, { width: 32, height: 16 })).toEqual({
      samples: FINAL_SUPERSAMPLE_OFFSETS.map(() => 0),
      size: [32, 16],
      smaa: 0,
    });
    expect(drawnBy(light, { width: 32, height: 16, shading: 'SOLID' }).samples).toEqual([
      FINAL_RENDER_SAMPLES,
    ]);
  });

  it('averages the pictures of a transparent film premultiplied, and smooths one with SMAA on colours premultiplied in its blend space', () => {
    const heavy = pacedEngine(scatterScene(400));
    heavy.e.session.doc.updateRender({ film_transparent: true });
    const parts = passes(heavy.e);
    const names = new Map<unknown, string>([
      [parts.unpremultiply.material, 'unpremultiply'],
      [parts.premultiply.material, 'premultiply'],
      [parts.unpremultiplyShown.material, 'unpremultiply shown'],
      [parts.average.material, 'average'],
    ]);
    const drawn = () => {
      const seen: string[] = [];
      heavy.gl.onRender = (scene) => {
        const r = heavy.gl.renders.at(-1)!;
        if (scene === heavy.e.scene && r.camera.layers.isEnabled(0)) seen.push(`scene ${r.clearAlpha}`);
        const m = (scene as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
        const name = names.get(m);
        if (name) seen.push(name);
        else if (m?.uniforms?.tArea) seen.push('smaa weights');
      };
      heavy.e.renderPixels({ width: 32, height: 16 });
      heavy.gl.onRender = null;
      return seen;
    };
    // supersampled: the pictures cleared to a transparent background, averaged premultiplied (like
    // the samples of a multisampled picture), then divided by alpha
    gpuTimes(heavy, 0, 1);
    expect(drawn()).toEqual([
      'scene 0',
      'scene 0',
      'average',
      'scene 0',
      'average',
      'scene 0',
      'average',
      'scene 0',
      'average',
      'unpremultiply',
    ]);
    // smoothed with SMAA: after the view transform, premultiplied and divided again around it
    gpuTimes(heavy, 0, FINAL_SUPERSAMPLE_MS + 1);
    expect(drawn()).toEqual([
      'scene 0',
      'unpremultiply',
      'premultiply',
      'smaa weights',
      'unpremultiply shown',
    ]);
  });

  it('keeps the colour of edges against a transparent background through SMAA, which blends colours raised to the power 2.2', () => {
    // regression: the colours were premultiplied by alpha itself; three.js's SMAA blend
    // (SMAABlendShader) mixes them raised to the power 2.2 and alpha as it is, so an edge pixel
    // between an object and the transparent background came out (1 - s)^(1/2.2 - 1) times too
    // bright at blend weight s: 1.65 times at 40 % coverage (rgb 220 where the object was 134)
    const { e } = engine(session());
    const parts = passes(e);
    const premultiplied = glslProgram(
      glslFunction(parts.premultiply.material.fragmentShader, 'premultiplied'),
    );
    const straight = glslProgram(glslFunction(parts.unpremultiplyShown.material.fragmentShader, 'straight'));
    // three.js's own SMAA blend, run on the CPU on a row of 3 pixels (array parameters spelled out)
    const blendSource = glslFunction(SMAABlendShader.fragmentShader, 'SMAANeighborhoodBlendingPS')
      .replace('vec4 offset[ 2 ]', 'vec4 offset0, vec4 offset1')
      .replace(/offset\[ (\d) \]/g, 'offset$1');
    let colours: number[][] = [];
    let weights: number[][] = [];
    const W = 3;
    const blend = glslProgram(blendSource, {
      globals: { resolution: [1 / W, 1] },
      natives: {
        texture2D: (tex: 'colour' | 'weights', uv: number[]) => {
          const x = Math.floor(uv[0] * W);
          const inside = Math.floor(uv[1]) === 0 && x >= 0 && x < W;
          return inside ? (tex === 'colour' ? colours : weights)[x] : [0, 0, 0, 0];
        },
      },
    });
    /**
     * The middle pixel `own` after SMAA blends it with its left neighbour `left` by `s` (straight
     * colours in, straight colours out), with or without the film's premultiplication around it.
     */
    const smaa = (own: number[], left: number[], s: number, film = true) => {
      colours = [left, own, [0, 0, 0, 0]].map((c) =>
        film ? (premultiplied('premultiplied', c) as number[]) : c,
      );
      // the middle pixel's blue weight blends it with the pixel on its left
      weights = [
        [0, 0, 0, 0],
        [0, 0, s, 0],
        [0, 0, 0, 0],
      ];
      const uv = [1.5 / W, 0.5];
      const out = blend(
        'SMAANeighborhoodBlendingPS',
        uv,
        [uv[0] - 1 / W, uv[1], uv[0], uv[1] + 1],
        [uv[0] + 1 / W, uv[1], uv[0], uv[1] - 1],
        'colour',
        'weights',
      ) as number[];
      return (film ? (straight('straight', out) as number[]) : out).map((v) => +v.toFixed(6));
    };
    const object = [0.525, 0.35, 0.2, 1];
    const clear = [0, 0, 0, 0];
    for (const s of [0.1, 0.4, 0.75]) {
      // the object's edge, blended with the background: its colour at the blended alpha
      expect(smaa(object, clear, s), `object, ${s}`).toEqual([0.525, 0.35, 0.2, +(1 - s).toFixed(6)]);
      // the background blended with the object's edge: the same
      expect(smaa(clear, object, s), `background, ${s}`).toEqual([0.525, 0.35, 0.2, s]);
      // a half transparent surface: its colour, at its alpha times the coverage
      expect(smaa([0.2, 0.6, 0.9, 0.5], clear, s), `glass, ${s}`).toEqual([
        0.2,
        0.6,
        0.9,
        +(0.5 * (1 - s)).toFixed(6),
      ]);
      // two opaque objects blend as SMAA blends them without a transparent film
      const other = [0.9, 0.1, 0.3, 1];
      expect(smaa(object, other, s), `objects, ${s}`).toEqual(smaa(object, other, s, false));
    }
  });

  it('notes the samples a final render was drawn with as the GPU drew it: a capture reuses them', () => {
    // a GPU with 4 samples at most (software WebGL) draws the 8 of a final render with 4: a capture
    // in that shading after the viewport dropped its samples has 4, the pipelines built
    const capped = pacedEngine(session());
    (capped.gl as unknown as { capabilities: { maxSamples: number } }).capabilities = { maxSamples: 4 };
    expect(drawnBy(capped, { width: 32, height: 16 }).samples).toEqual([FINAL_RENDER_SAMPLES]);
    setMultisampling(capped.e, false);
    capped.wait(32);
    expect(
      drawnBy(capped, { useViewport: true, shading: 'RENDERED', width: 32, height: 16 }).samples,
    ).toEqual([4]);
    // a GPU with more draws them with 8: a capture in that shading has the viewport's own count (the
    // pipelines of neither count are built, and the viewport's next frame needs its own)
    const roomy = pacedEngine(session());
    (roomy.gl as unknown as { capabilities: { maxSamples: number } }).capabilities = { maxSamples: 16 };
    expect(drawnBy(roomy, { width: 32, height: 16 }).samples).toEqual([FINAL_RENDER_SAMPLES]);
    expect(drawnBy(roomy, { useViewport: true, shading: 'RENDERED', width: 32, height: 16 }).samples).toEqual(
      [VIEWPORT_MSAA_SAMPLES],
    );
  });

  it('shrinks the SMAA targets after a final render and keeps the pass', () => {
    const heavy = pacedEngine(scatterScene(400));
    const smaa = (heavy.e as unknown as { smaa: SMAAPass }).smaa;
    const sizes = vi.spyOn(smaa, 'setSize');
    gpuTimes(heavy, 0, FINAL_SUPERSAMPLE_MS + 1);
    expect(drawnBy(heavy, { width: 64, height: 36 }).smaa).toBe(1);
    // sized for the picture while it ran, then to one pixel (its targets hold nothing between renders)
    expect(sizes.mock.calls).toEqual([
      [64, 36],
      [1, 1],
    ]);
    expect((heavy.e as unknown as { smaa: SMAAPass }).smaa).toBe(smaa);
  });
});

describe('animated view changes (Blender smooth view)', () => {
  /*
   * Regression: a zoom, pan, orbit or projection toggle made within 220 ms of an animated view change
   * (an orbit step, an axis view, framing) was lost, because every frame of the animation set the view
   * again. Like Blender, whose navigation finishes a running smooth view before it changes the view,
   * a change made meanwhile is made on the view the animation goes to, and the frames show it at once;
   * get_view and pictures of the viewport's view show where the view goes from the start.
   */
  const uiRegistry = createOperatorRegistry();
  registerUiOperators(uiRegistry);
  /** Runs a browser UI operator as editor_command run_operator does (an agent's call). */
  function op(s: ProjectSession, id: string, params: Record<string, unknown> = {}): void {
    const ctx: OperatorContext = {
      doc: s.doc,
      state: s.state,
      origin: s.doc.origin,
      source: 'mcp',
      report: () => undefined,
      ui: {},
    };
    const r = uiRegistry.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
  }
  let clock = 0;
  /** A viewport with its pointer handling, as the editor sets them up, on a clock the test moves. */
  function setup() {
    clock = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    // the view a viewport saved (persistPose) is the next one's start (restorePose)
    localStorage.clear();
    const s = session();
    const { e, gl } = engine(s);
    const el = e.canvas.parentElement!;
    const i = new ViewportInteraction(e, s, el, { run: () => true, openContextMenu: () => undefined });
    sessionSignal.value = s;
    viewport.engine = e;
    viewport.interaction = i;
    const t0 = clock;
    /** Runs the frame loop as the animation frame `ms` after the start would. */
    const frameAt = (ms: number) => {
      clock = t0 + ms;
      (e as unknown as { loop(now: number): void }).loop(clock);
    };
    frameAt(0);
    return { s, e, gl, i, el, frameAt };
  }
  afterEach(() => {
    viewport.interaction?.dispose();
    viewport.interaction = null;
    viewport.engine = null;
    sessionSignal.value = null;
    vi.restoreAllMocks();
    localStorage.clear();
  });
  /** The view of a pose as numbers (to compare views). */
  const numbers = (p: ViewPose) => [
    ...p.target.toArray(),
    p.distance,
    p.yaw,
    p.pitch,
    p.fovY,
    p.ortho ? 1 : 0,
  ];
  const expectView = (p: ViewPose, q: ViewPose, label = '') =>
    numbers(p).forEach((v, k) => expect(v, `${label}: component ${k}`).toBeCloseTo(numbers(q)[k], 9));

  it('make a zoom right after an orbit step on the orbited view (editor_command run_operator)', async () => {
    const { s, e, gl, frameAt } = setup();
    const before = clonePose(e.pose);
    op(s, 'view3d.view_orbit', { type: 'ORBITLEFT' });
    op(s, 'view3d.zoom', {});
    // an agent gets the view it goes to at once, also in a picture of the viewport's view
    const view = (await uiCommand('get_view', {})) as { yaw: number; distance: number };
    expect(view.yaw).toBeCloseTo(before.yaw + Math.PI / 12, 12);
    expect(view.distance).toBeCloseTo(before.distance * 0.8, 12);
    e.renderPixels({ useViewport: true, width: 32, height: 16 });
    expect(sceneCamera(e, gl).position.distanceTo(posePosition(e.pose))).toBeLessThan(1e-9);
    // the frames show it at once (the animation ended with the zoom), and keep showing it
    for (const ms of [16, 33, 110, 400]) {
      frameAt(ms);
      expect(e.shownPose.yaw).toBeCloseTo(before.yaw + Math.PI / 12, 12);
      expect(e.shownPose.distance).toBeCloseTo(before.distance * 0.8, 12);
      expect(sceneCamera(e, gl).position.distanceTo(posePosition(e.pose))).toBeLessThan(1e-9);
    }
  });

  it('give a change made while they run the view it gives after them, and show it at once', () => {
    type Setup = ReturnType<typeof setup>;
    const changes: [string, (x: Setup) => void][] = [
      ['view3d.zoom', ({ s }) => op(s, 'view3d.zoom', { delta: -2 })],
      ['the mouse wheel', ({ el }) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))],
      ['a pinch (zoomBy)', ({ i }) => i.zoomBy(0.7)],
      ['panning', ({ i }) => i.pan(30, -20)],
      ['orbiting with the mouse', ({ i }) => i.orbit(25, 10)],
      ['the projection', ({ s }) => op(s, 'view3d.view_persportho')],
      ['the Focal Length field', ({ e }) => (e.pose.fovY = 0.5)],
    ];
    const animated: [string, (x: Setup) => void][] = [
      ['an orbit step', ({ s }) => op(s, 'view3d.view_orbit', { type: 'ORBITUP', angle: 0.4 })],
      ['an axis view', ({ s }) => op(s, 'view3d.view_axis', { type: 'TOP' })],
      ['Frame All', ({ s }) => op(s, 'view3d.view_all')],
      ['Frame Selected', ({ s }) => op(s, 'view3d.view_selected')],
    ];
    // every change, each during one of the animated changes (every one of them in turn)
    for (const [k, [change, make]] of changes.entries()) {
      const [what, animate] = animated[k % animated.length];
      const label = `${change} during ${what}`;
      // the view it gives after the animation
      const after = setup();
      animate(after);
      after.frameAt(300);
      make(after);
      after.frameAt(320);
      const expected = clonePose(after.e.shownPose);
      after.e.dispose();
      // made halfway through it
      const x = setup();
      const from = clonePose(x.e.pose);
      animate(x);
      const to = clonePose(x.e.pose);
      x.frameAt(110);
      // (the frames show poses on the way)
      const halfway = numbers(x.e.shownPose);
      expect(
        numbers(from).some((v, k) => Math.abs(v - halfway[k]) > 1e-6),
        label,
      ).toBe(true);
      expect(
        numbers(to).some((v, k) => Math.abs(v - halfway[k]) > 1e-6),
        label,
      ).toBe(true);
      make(x);
      expect(
        numbers(x.e.pose).some((v, k) => Math.abs(v - numbers(to)[k]) > 1e-6),
        label,
      ).toBe(true);
      x.frameAt(130);
      expectView(x.e.shownPose, expected, label);
      expectView(x.e.pose, expected, label);
      x.frameAt(400);
      expectView(x.e.shownPose, expected, label);
      x.e.dispose();
    }
  });

  it('start an animated change made while another one runs from the view that one goes to', () => {
    // two orbit steps in a row turn the view by two steps; Frame All right after an orbit step
    // frames the orbited view
    const { s, e, frameAt } = setup();
    const before = clonePose(e.pose);
    op(s, 'view3d.view_orbit', { type: 'ORBITLEFT' });
    op(s, 'view3d.view_orbit', { type: 'ORBITLEFT' });
    frameAt(50);
    op(s, 'view3d.view_all');
    const framed = clonePose(e.pose);
    expect(framed.yaw).toBeCloseTo(before.yaw + Math.PI / 6, 12);
    expect(framed.target.distanceTo(before.target)).toBeGreaterThan(1e-3);
    // that animation starts from what the frames showed
    frameAt(60);
    expect(Math.abs(e.shownPose.yaw - framed.yaw)).toBeGreaterThan(1e-3);
    frameAt(400);
    expectView(e.shownPose, framed);
  });

  it('align the camera to the view an animated change goes to (Align Active Camera to View)', () => {
    const { s, e } = setup();
    op(s, 'view3d.view_axis', { type: 'TOP' });
    // no frame drawn since: the camera goes to the top view, not to the view the frames showed
    op(s, 'view3d.camera_to_view');
    const cam = s.doc.getObject(s.doc.getScene().camera!)!;
    const m = new THREE.Matrix4().fromArray(s.doc.worldMatrix(cam.id));
    const position = new THREE.Vector3().setFromMatrixPosition(m);
    expect(position.distanceTo(posePosition(e.pose))).toBeLessThan(1e-6);
    // looking straight down
    const look = new THREE.Vector3(0, 0, -1).transformDirection(m);
    expect(look.z).toBeCloseTo(-1, 9);
  });

  it('snap moves to the grid step of the view the frames show (transform gizmo, G with Ctrl)', () => {
    // regression: the snap increment (1 m when the view is farther than 4 m, else 0.1 m) came from
    // the view an animated change goes to, while the frames still showed the grid of another one
    const { s, e, i, frameAt } = setup();
    e.width = 800;
    e.height = 600;
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    s.state.selectedIds = [cube.id];
    s.state.activeId = cube.id;
    s.view.tool.value = 'move';
    s.view.snapping.value = true;
    const near = clonePose(e.pose);
    near.distance = 3;
    e.setPose(near);
    frameAt(16);
    const gizmo = (i as unknown as { gizmo: { translationSnap: number | null } }).gizmo;
    expect(gizmo.translationSnap).toBe(0.1);
    // Frame All to a far view: its first frames still show the near one
    const far = clonePose(near);
    far.distance = 30;
    e.setPose(far, true);
    frameAt(32);
    expect(e.shownPose.distance).toBeLessThan(4);
    expect(gizmo.translationSnap).toBe(0.1);
    // a G move with Ctrl snaps to that step too
    const at = e.project(new THREE.Vector3(0, 0, 0));
    const g = new ModalTransform(e, s, 'translate', { x: at.x, y: at.y });
    g.update({ x: at.x + 37, y: at.y + 11 }, { ctrl: true, shift: false });
    const moved = g.current.slice(12, 15);
    expect(moved.some((v) => Math.abs(v) > 1e-9)).toBe(true);
    for (const v of moved) expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9);
    expect(moved.some((v) => Math.abs(v - Math.round(v)) > 1e-9)).toBe(true);
    g.finish(false);
    // once there, the far view's step
    frameAt(400);
    expect(e.shownPose.distance).toBe(30);
    expect(gizmo.translationSnap).toBe(1);
  });
});

describe('RASTER final renders and the heap of the tab', () => {
  /**
   * Runs `fn` with Chromium's performance.memory of a `limit`-byte heap limit (and a usedJSHeapSize
   * of 10 MB, which the editor does not read: the page's heap is estimated from its scene).
   */
  function withHeap<T>(limit: number, fn: () => T): T {
    const before = Object.getOwnPropertyDescriptor(performance, 'memory');
    Object.defineProperty(performance, 'memory', {
      value: { jsHeapSizeLimit: limit, usedJSHeapSize: 10 * MB },
      configurable: true,
    });
    const restore = () => {
      if (before) Object.defineProperty(performance, 'memory', before);
      else delete (performance as { memory?: unknown }).memory;
    };
    try {
      const r = fn();
      if (r instanceof Promise) return r.finally(restore) as T;
      restore();
      return r;
    } catch (err) {
      restore();
      throw err;
    }
  }
  const MB = 1024 * 1024;
  /** The evaluator of final renders the engine keeps (null when it has none). */
  const finalEvaluator = (e: ViewportEngine) =>
    (e as unknown as { finalEval: SceneEvaluator | null }).finalEval;

  /**
   * A cable of 32 points dense only in renders (128 samples per span, a ring of 68 points: 539,648
   * triangles), whose bevel depth is keyed: stored 0, 0.05 at frame 1, 0 from frame 10.
   */
  function denseCable(s: ProjectSession): void {
    const data = s.doc.addCurve({
      splines: [
        {
          type: 'BEZIER',
          points: Array.from({ length: 32 }, (_, i) => ({
            co: [i * 0.4 - 6.4, Math.sin(i) * 0.6, 0.3] as [number, number, number],
            handle_left: null,
            handle_right: null,
            handle_left_type: 'AUTO' as const,
            handle_right_type: 'AUTO' as const,
            radius: 1,
            tilt: 0,
            weight: 1,
          })),
          use_cyclic_u: false,
          resolution_u: 0,
          order_u: 4,
          use_endpoint_u: true,
          use_smooth: true,
          material_index: 0,
        },
      ],
      resolution_u: 1,
      render_resolution_u: 128,
      bevel_depth: 0,
      bevel_resolution: 32,
    });
    s.doc.addObject({ name: 'Cable', type: 'CURVE', data });
    let fc = createFCurve({ target_type: 'curve', target_id: data, path: 'bevel_depth', index: 0 });
    fc = insertKeyframe(fc, 1, 0.05, 'CONSTANT');
    s.doc.setFCurve(insertKeyframe(fc, 10, 0, 'CONSTANT'));
  }

  /**
   * The default cube as `count` copies (Array) with a Bevel by angle of `segments` that only renders:
   * 6 copies of 30 segments unless given.
   */
  function renderOnlyBevel(s: ProjectSession, count = 6, segments = 30): void {
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    const mod = (id: string, type: string, params: Record<string, unknown>, show_viewport: boolean) => ({
      id,
      name: id,
      type,
      show_viewport,
      show_render: true,
      show_in_editmode: true,
      show_expanded: true,
      params,
    });
    s.doc.updateObject(cube.id, {
      name: 'BevCube',
      modifiers: [
        mod('Arr', 'ARRAY', { count, relative_offset_displace: [1.5, 0, 0] }, true),
        mod('Bev', 'BEVEL', { width: 0.05, segments }, false),
      ] as never,
    });
  }

  it("refuses a final render whose geometry at the render settings does not fit the tab's heap, before evaluating it", async () => {
    // regression: the RASTER engine evaluated the scene on the page with no check: a curve whose
    // surface only its keyed bevel makes (4.3 million triangles) ended the tab with
    // --max-old-space-size=400, also when an agent rendered it as the path tracer's refusal advised
    const s = session();
    denseCable(s);
    s.view.shading.value = 'SOLID';
    const { e, gl } = engine(s);
    // a small heap: 50 MB a render may fill, the page's own heap (its scene, 0.02 GB) included
    expect(pageHeapEstimate(s.doc, 1)).toBeGreaterThan(15 * MB);
    expect(pageHeapEstimate(s.doc, 1)).toBeLessThan(20 * MB);
    const heap = YOUNG_GENERATION_BYTES + 50 * MB;
    const refusal =
      'The RASTER render was not started: the geometry it evaluates at the render settings needs about 0.06 GB ' +
      "of JavaScript heap, more than the 0.03 GB the tab has left for it: a render may fill 0.05 GB of its 0.18 GB heap limit, the rest being kept free for V8's young generation and for the page to keep working, and the page uses 0.02 GB of that " +
      '(about 0.5 million triangles: curve and text surfaces, modifier and shape key results), and running out of ' +
      'memory would end the tab. Lower the triangles (subdivision render levels, curve and text render resolution, ' +
      'objects in the scene).';
    withHeap(heap, () => {
      expect(() => e.renderPixels()).toThrow(refusal);
      // nothing evaluated nor drawn, and the viewport as it was
      expect(finalEvaluator(e)).toBeNull();
      expect(scenePasses(e, gl)).toEqual([]);
      expect(s.view.shading.value).toBe('SOLID');
      // a frame of Render Animation, and an agent's render_image (renderer browser, engine RASTER)
      expect(() => e.renderPixels({ frame: 1, width: 64, height: 36, animation: true })).toThrow(refusal);
    });
    await withHeap(heap, () => expect(e.renderImage({ engine: 'RASTER' })).rejects.toThrow(refusal));
    // at frame 10 the cable has no bevel: no surface, nothing to refuse
    withHeap(heap, () => expect(e.renderPixels({ frame: 10 }).width).toBe(40));
    // a capture of the viewport draws what the viewport evaluated: not refused
    withHeap(heap, () => expect(e.renderPixels({ useViewport: true }).width).toBe(40));
  });

  it("renders a scene that builds nothing beyond what the page holds, whatever the page's own heap is estimated at", async () => {
    // regression: four 720 × 720 grids, a page estimated past the share a render may fill (it lives
    // with its heap), were refused for every RASTER render, which builds nothing: "needs about 0.001
    // GB of JavaScript heap, and the tab has none left for it … (about 0 triangles …)"
    const s = session();
    const { e } = engine(s);
    // a heap of 8 MB a render may fill, less than the page's own (its scene, 0.02 GB)
    const heap = YOUNG_GENERATION_BYTES + 8 * MB;
    expect(pageHeapEstimate(s.doc, 1)).toBeGreaterThan(8 * MB);
    withHeap(heap, () => {
      expect(e.renderPixels().width).toBe(40);
      expect(e.renderPixels({ frame: 1, width: 64, height: 36, animation: true }).width).toBe(64);
    });
    await withHeap(heap, async () => expect((await e.renderImage({ engine: 'RASTER' })).width).toBe(40));
    // the cube subdivided in renders builds geometry: refused there
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    s.doc.updateObject(cube.id, {
      modifiers: [
        {
          id: 'Sub',
          name: 'Sub',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { levels: 0, render_levels: 1 },
        },
      ] as never,
    });
    withHeap(heap, () =>
      expect(() => e.renderPixels()).toThrow(
        /^The RASTER render was not started: .*and the tab has none left for it: .*\(about 48 triangles: /,
      ),
    );
  });

  it('refuses a modifier the estimate cannot see before it runs on the page, naming it, and keeps no result without it', () => {
    // the estimate counts no edge of a Bevel limited by angle: the evaluation counts them from its
    // real input right before it runs (render/guard.ts RasterEvaluationGuard)
    const s = session();
    // 2 cubes beveled with 16 segments (bevelling the 6 cubes of 30 segments is slow under coverage)
    renderOnlyBevel(s, 2, 16);
    const { e } = engine(s);
    registerBuiltinModifiers();
    const bevel = getModifierDef('BEVEL')!;
    let bevels = 0;
    registerModifier({ ...bevel, apply: (mesh, params, ctx) => (bevels++, bevel.apply(mesh, params, ctx)) });
    try {
      // 1 MB of room beside the page's own heap: room for the cubes, not for their bevels
      withHeap(YOUNG_GENERATION_BYTES + pageHeapEstimate(s.doc, 1) + MB, () => {
        expect(() => e.renderPixels()).toThrow(
          /^The RASTER render was not started: the geometry it evaluates at the render settings needs about 0\.002 GB of JavaScript heap, more than the 0\.001 GB the tab has left for it: .*\(about 6,936 triangles: curve and text surfaces, modifier and shape key results\), and running out of memory would end the tab\. The Bevel modifier 'Bev' of 'BevCube' would make 6,936 of these triangles \(lower its segments\)\. Lower the triangles/,
        );
      });
      expect(bevels).toBe(0);
      // the evaluator that skipped it is dropped: with room, the next render bevels the cubes, and
      // the engine counts what that evaluator keeps from what the Bevel made
      expect(finalEvaluator(e)).toBeNull();
      e.renderPixels();
      expect(bevels).toBe(1);
      expect((e as unknown as { finalHeld: number }).finalHeld).toBe(
        6_936 * RASTER_BYTES_PER_TRIANGLE + INSTANCE_BYTES.heap,
      );
    } finally {
      registerModifier(bevel);
    }
  });

  it('lets the geometry an earlier final render kept go first when the new one would not fit next to it', () => {
    const s = session();
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    s.doc.updateObject(cube.id, {
      modifiers: [
        {
          id: 'Sub',
          name: 'Sub',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { levels: 0, render_levels: 2 },
        },
      ] as never,
    });
    const { e } = engine(s);
    e.renderPixels();
    const first = finalEvaluator(e);
    expect(first).not.toBeNull();
    // what the render adds to the page's heap, and what the evaluator keeps of it: its 192 triangles
    // and its instance
    const needs = rasterNeeds(estimateRender(s.doc, true, 1)).heap;
    const kept = 192 * RASTER_BYTES_PER_TRIANGLE + 1 * INSTANCE_BYTES.heap;
    // room for both beside the page's own heap: the evaluator and its caches are kept
    const page = pageHeapEstimate(s.doc, 1);
    withHeap(YOUNG_GENERATION_BYTES + page + needs + kept, () => e.renderPixels());
    expect(finalEvaluator(e)).toBe(first);
    // room for the new one only: the kept one goes first, and the render evaluates afresh
    withHeap(YOUNG_GENERATION_BYTES + page + needs + kept - 1, () => e.renderPixels());
    expect(finalEvaluator(e)).not.toBe(first);
    expect(finalEvaluator(e)).not.toBeNull();
  });

  it('counts the geometry an earlier render kept while a modifier runs, and evaluates without it where the modifier does not fit next to it', () => {
    const s = session();
    renderOnlyBevel(s);
    // 2 cubes beveled with 12 segments (renderOnlyBevel's 6 cubes of 30 segments are slow to bevel twice)
    const bevCube = s.doc.findObjectByName('BevCube')!;
    const smaller = (width: number) =>
      bevCube.modifiers.map((m) => ({
        ...m,
        params: m.type === 'BEVEL' ? { ...m.params, segments: 12, width } : { ...m.params, count: 2 },
      }));
    s.doc.updateObject(bevCube.id, { modifiers: smaller(0.05) });
    const { e } = engine(s);
    registerBuiltinModifiers();
    const bevel = getModifierDef('BEVEL')!;
    let bevels = 0;
    registerModifier({ ...bevel, apply: (mesh, params, ctx) => (bevels++, bevel.apply(mesh, params, ctx)) });
    try {
      e.renderPixels();
      const first = finalEvaluator(e);
      // what the evaluator keeps: the 2 beveled cubes, 2,028 triangles each
      const kept = (e as unknown as { finalHeld: number }).finalHeld;
      expect(kept).toBe(4_056 * RASTER_BYTES_PER_TRIANGLE + INSTANCE_BYTES.heap);
      // a wider bevel: the cubes are beveled again while what the earlier render made is still held
      s.doc.updateObject(bevCube.id, { modifiers: smaller(0.06) });
      // the heap the Bevel needs as it runs, from a check with room for the Array before it only
      const estimate = estimateRender(s.doc, true, 1);
      const probe = new RasterEvaluationGuard(estimate, {
        ...tabMemoryWithRenders(0),
        heapLimit: YOUNG_GENERATION_BYTES + 64 * 1024,
        heapUsed: 0,
      });
      guardedEvaluation(probe, () => new SceneEvaluator(s.doc).evaluate(1, { forRender: true }));
      expect(probe.refusal!.label).toBe('Bevel');
      const need = probe.refusal!.needs.heap;
      // room for it, but not next to what the earlier render kept; the estimate of the scene, which
      // sees no edge the Bevel bevels, fits next to it: the evaluator is kept for the render
      const heap = YOUNG_GENERATION_BYTES + pageHeapEstimate(s.doc, 1) + need + kept / 2;
      expect(rasterNeeds(estimate).heap + kept).toBeLessThan(need + kept / 2);
      withHeap(heap, () => e.renderPixels());
      // the Bevel was refused next to it and ran once evaluated without it
      expect(bevels).toBe(2);
      expect(finalEvaluator(e)).not.toBe(first);
      expect(finalEvaluator(e)).not.toBeNull();
    } finally {
      registerModifier(bevel);
    }
  });

  it('tells a path traced render what the evaluator of final renders keeps on the page, while it keeps it', () => {
    // a cube subdivided twice in renders: the evaluator keeps its 192 triangles and its instance
    const s = session();
    const cube = s.doc.listObjects().find((o) => o.type === 'MESH')!;
    s.doc.updateObject(cube.id, {
      modifiers: [
        {
          id: 'Sub',
          name: 'Sub',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { levels: 0, render_levels: 2 },
        },
      ] as never,
    });
    const { e } = engine(s);
    e.startPathTrace({ samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ pageHeld: 0 });
    e.renderPixels();
    const kept = 192 * RASTER_BYTES_PER_TRIANGLE + INSTANCE_BYTES.heap;
    expect((e as unknown as { finalHeld: number }).finalHeld).toBe(kept);
    e.startPathTrace({ samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ pageHeld: kept });
    // once the evaluator is dropped (after a minute without final renders), nothing
    (e as unknown as { dropFinalEvaluator(): void }).dropFinalEvaluator();
    e.startPathTrace({ samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ pageHeld: 0 });
  });

  it("takes the page's own heap at the viewport's frame, not at the frame it renders", () => {
    // the viewport shows frame 10, where a grid of 64 × 64 quads is subdivided four times for it
    // (keyed; none at frame 1): 2 million triangles the page holds; renders subdivide it once
    const s = session();
    const plane = s.doc.addMesh(
      'Grid',
      createMesh({
        positions: Array.from({ length: 65 * 65 }, (_, i) => [
          (i % 65) / 32 - 1,
          Math.floor(i / 65) / 32 - 1,
          0,
        ]).flat(),
        faces: Array.from({ length: 64 * 64 }, (_, i) => {
          const a = Math.floor(i / 64) * 65 + (i % 64);
          return [a, a + 1, a + 66, a + 65];
        }),
      }),
    );
    const id = s.doc.addObject({
      name: 'Grid',
      type: 'MESH',
      data: plane,
      modifiers: [
        {
          id: 'Sub',
          name: 'Sub',
          type: 'SUBSURF',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { levels: 0, render_levels: 1 },
        },
      ] as never,
    });
    let fc = createFCurve({
      target_type: 'object',
      target_id: id,
      path: 'modifiers["Sub"].levels',
      index: 0,
    });
    fc = insertKeyframe(fc, 1, 0, 'CONSTANT');
    s.doc.setFCurve(insertKeyframe(fc, 10, 4, 'CONSTANT'));
    s.state.frame = 10;
    const { e } = engine(s);
    // a heap of 300 MB: the page's own scene at frame 10 is over the share
    expect(pageHeapEstimate(s.doc, 10)).toBeGreaterThan(300 * MB - YOUNG_GENERATION_BYTES);
    withHeap(300 * MB, () =>
      expect(() => e.renderPixels({ frame: 1 })).toThrow(
        /and the tab has none left for it: .*, and the page uses 0\.\d+ GB \(about 32,768 triangles/,
      ),
    );
    // a path traced render takes it at the viewport's frame too
    e.startPathTrace({ frame: 1, samples: 1 });
    expect(pathTraced.at(-1)).toMatchObject({ frame: 1, pageFrame: 10 });
    s.state.frame = 1;
    withHeap(300 * MB, () => expect(e.renderPixels({ frame: 1 }).width).toBe(40));
  });

  it('counts the heap the path traced renders running in the tab hold', async () => {
    const s = session();
    denseCable(s);
    const { e } = engine(s);
    const needs = rasterNeeds(estimateRender(s.doc, true, 1)).heap;
    const pool = new RenderPool({ size: 1, idleMs: 0, factory: () => new InProcessWorker() });
    try {
      // a path traced render of the default scene runs in the tab meanwhile
      const job = startPathTrace(pool, session().doc, { width: 8, height: 8, frame: 1, samples: 1 << 16 });
      await new Promise<void>((resolve) => {
        const off = job.subscribe(() => {
          if (job.status.phase !== 'rendering') return;
          off();
          resolve();
        });
      });
      const held = tabMemoryWithRenders(0).held.heap;
      expect(held).toBeGreaterThan(0);
      // the room of the page alone, less one byte of what the running render holds
      const page = pageHeapEstimate(s.doc, 1);
      withHeap(YOUNG_GENERATION_BYTES + page + needs + held - 1, () =>
        expect(() => e.renderPixels()).toThrow(/and the page and the path traced renders running in it use/),
      );
      job.cancel();
      await job.result;
    } finally {
      pool.dispose();
    }
  });
});
