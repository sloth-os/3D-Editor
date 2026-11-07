import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  createOperatorRegistry,
  defaultMaterial,
  type OperatorContext,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { ViewportEngine } from '../src/viewport/engine';
import { buildMaterial, TextureCache } from '../src/viewport/materials';
import {
  HIDDEN_LAYER,
  TransmissionLayers,
  assignLevels,
  blurMargin,
  installTransmissionLayer,
  lookupRect,
  patchTransmission,
  transmissionOf,
  transmissionThickness,
  type LayerItem,
} from '../src/viewport/transmission';

/*
 * Glass and liquids in the WebGL renders (transmission.ts). Regressions: a transmissive object
 * inside another one (the perfume in a glass bottle) was missing from the outer one, which only
 * refracted the opaque objects; every transmissive material refracted what lay 0.5 m behind it, so
 * an 8 cm bottle showed a shifted copy of its own front label. WebGL is replaced by a stand-in that
 * records which objects each render of the scene draws.
 */

/** One render of a scene: its target and which transmissive meshes the camera drew. */
interface Draw {
  scene: unknown;
  target: unknown;
  drawn: string[];
  /** The target's scissor rectangle (x, y, width, height) when it had the scissor test on. */
  scissor: number[] | null;
}

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class RecordingWebGLRenderer {
    domElement: HTMLCanvasElement;
    outputColorSpace: string = three.SRGBColorSpace;
    toneMapping: number = three.NoToneMapping;
    toneMappingExposure = 1;
    shadowMap = { enabled: false, type: three.PCFShadowMap, autoUpdate: true, needsUpdate: false };
    autoClear = true;
    draws: Draw[] = [];
    private target: unknown = null;
    private clearColor = new three.Color();
    private clearAlpha = 1;
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
    clear() {}
    clearDepth() {}
    render(scene: InstanceType<typeof three.Object3D>, camera: InstanceType<typeof three.Camera>) {
      const drawn: string[] = [];
      scene.traverseVisible((o) => {
        const m = o as InstanceType<typeof three.Mesh>;
        if (!m.isMesh || !m.layers.test(camera.layers)) return;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        if (mats.some((x) => x?.userData?.pfxTransmission || (x as { transmission?: number }).transmission))
          drawn.push(String(m.userData.objectId ?? m.name));
      });
      const t = this.target as InstanceType<typeof three.WebGLRenderTarget> | null;
      const scissor = t?.scissorTest ? t.scissor.toArray() : null;
      this.draws.push({ scene, target: this.target, drawn, scissor });
    }
    readRenderTargetPixels(_t: unknown, _x: number, _y: number, _w: number, _h: number, b: Uint8Array) {
      b.fill(0);
    }
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
  return { ...three, WebGLRenderer: RecordingWebGLRenderer, PMREMGenerator: StubPMREMGenerator };
});

const registry = createOperatorRegistry();

function session(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'transmission-test',
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

/** A material on objects, with fields. */
function material(s: ProjectSession, name: string, objects: string[], fields: Record<string, unknown>) {
  ok(s, 'material.new', { name, assign: false });
  const id = s.doc.listMaterials().find((m) => m.name === name)!.id;
  ok(s, 'object.material_assign', { material: id, objects });
  s.doc.updateBlockByKind('materials', id, fields);
}

/** An 8 cm glass bottle with amber perfume inside and a black label in front, seen by a camera. */
function bottleScene(): ProjectSession {
  const s = session();
  ok(s, 'mesh.primitive_cube_add', { name: 'Bottle', size: 0.08, location: [0, 0, 0.04] });
  ok(s, 'mesh.primitive_cube_add', { name: 'Perfume', size: 0.06, location: [0, 0, 0.035] });
  ok(s, 'mesh.primitive_cube_add', { name: 'Label', size: 0.03, location: [0, -0.042, 0.04] });
  s.doc.updateObject(s.doc.findObjectByName('Label')!.id, { scale: [1, 0.02, 1] });
  ok(s, 'mesh.primitive_plane_add', { name: 'Table', size: 2 });
  material(s, 'Glass', ['Bottle'], { transmission: 1, roughness: 0, ior: 1.5 });
  material(s, 'Amber', ['Perfume'], {
    transmission: 1,
    roughness: 0,
    ior: 1.36,
    base_color: [1, 0.84, 0.55, 1],
  });
  material(s, 'Ink', ['Label'], { base_color: [0.02, 0.02, 0.02, 1] });
  ok(s, 'object.camera_add', { name: 'Cam', location: [0, -0.5, 0.06], rotation: [Math.PI / 2, 0, 0] });
  s.doc.updateScene({ camera: s.doc.findObjectByName('Cam')!.id });
  s.doc.updateRender({ resolution_x: 64, resolution_y: 48, resolution_percentage: 100 });
  return s;
}

const engines: ViewportEngine[] = [];
function engine(s: ProjectSession) {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  const e = new ViewportEngine(canvas, s);
  engines.push(e);
  return { e, gl: e.renderer as unknown as { draws: Draw[] } };
}

/** The transmission uniforms of an object's first material in the engine's three.js scene. */
function uniformsOf(e: ViewportEngine, s: ProjectSession, name: string) {
  const v = e.objects.views.get(s.doc.findObjectByName(name)!.id)!;
  return transmissionOf((v.mesh!.material as THREE.Material[])[0])!;
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('transmission in the WebGL renders', () => {
  it('draws the perfume into the picture the bottle refracts', () => {
    const s = bottleScene();
    ok(s, 'object.light_add', { type: 'SUN', name: 'Sun', rotation: [0.4, 0.3, 0] });
    const { e, gl } = engine(s);
    e.renderPixels({ width: 64, height: 48 });
    // shadow maps are drawn once per image, with the first picture: the glass, on the layer that
    // hides it from the camera there, still casts its shadow into them
    expect(e.renderer.shadowMap.autoUpdate).toBe(false);
    const sun = e.objects.views.get(s.doc.findObjectByName('Sun')!.id)!.light as THREE.DirectionalLight;
    expect(sun.shadow.camera.layers.isEnabled(HIDDEN_LAYER)).toBe(true);
    expect(sun.shadow.camera.layers.isEnabled(0)).toBe(true);
    const ids = Object.fromEntries(['Bottle', 'Perfume'].map((n) => [s.doc.findObjectByName(n)!.id, n]));
    const names = (d: Draw) => d.drawn.map((id) => ids[id]).sort();
    const draws = gl.draws.filter((d) => d.scene === e.scene);
    // the opaque scene (the perfume refracts it), then the scene with the perfume (the bottle does),
    // then the image with both
    expect(draws.map(names)).toEqual([[], ['Perfume'], ['Bottle', 'Perfume']]);
    const bottle = uniformsOf(e, s, 'Bottle');
    const perfume = uniformsOf(e, s, 'Perfume');
    expect(bottle.map.value).not.toBe(perfume.map.value);
    expect(bottle.depth.value).toBeInstanceOf(THREE.DepthTexture);
    expect(perfume.map.value).toBeInstanceOf(THREE.Texture);
    for (const n of ['Bottle', 'Perfume']) {
      const mesh = e.objects.views.get(s.doc.findObjectByName(n)!.id)!.mesh!;
      // the meshes are back on the camera's layer
      expect(mesh.layers.test(new THREE.Layers())).toBe(true);
      expect(mesh.layers.isEnabled(HIDDEN_LAYER)).toBe(false);
      // three.js's own transmission pass is off: it would refract only the opaque objects
      const material = (mesh.material as THREE.Material[])[0] as THREE.MeshPhysicalMaterial;
      expect(material.transmission).toBe(0);
    }
  });

  it('refracts what lies a bottle’s width behind the glass, not half a metre', () => {
    const s = bottleScene();
    const { e } = engine(s);
    s.view.shading.value = 'MATERIAL';
    e.sync();
    expect(uniformsOf(e, s, 'Bottle').thickness.value).toBeCloseTo(0.08, 6);
    expect(uniformsOf(e, s, 'Perfume').thickness.value).toBeCloseTo(0.06, 6);
    expect(uniformsOf(e, s, 'Bottle').transmission.value).toBe(1);
  });

  it('draws one picture when no transmissive object shows another one', () => {
    const s = bottleScene();
    s.doc.removeObject(s.doc.findObjectByName('Perfume')!.id);
    const { e, gl } = engine(s);
    e.renderPixels({ width: 64, height: 48 });
    // the opaque scene, refracted by the bottle, then the image
    expect(gl.draws.filter((d) => d.scene === e.scene).map((d) => d.drawn.length)).toEqual([0, 1]);
  });
});

describe('the part of a picture that is drawn', () => {
  /*
   * Regression: every frame rendered the whole scene again for the picture glass refracts, however
   * little of the screen the glass covered: in lighthouse-cove (2.5 M grass triangles, two light
   * beams and a lantern pane) that was half of each viewport frame in software WebGL.
   */
  /** A glass cube of `size` at `location` on a large floor, seen from 10 m above by the camera. */
  function paneScene(
    location: [number, number, number],
    glass: Record<string, unknown> = {},
  ): ProjectSession {
    const s = session();
    ok(s, 'mesh.primitive_plane_add', { name: 'Floor', size: 40 });
    ok(s, 'mesh.primitive_cube_add', { name: 'Pane', size: 0.2, location });
    material(s, 'Glass', ['Pane'], { transmission: 1, roughness: 0, ior: 1.5, ...glass });
    ok(s, 'object.camera_add', { name: 'Cam', location: [0, 0, 10], rotation: [0, 0, 0] });
    s.doc.updateScene({ camera: s.doc.findObjectByName('Cam')!.id });
    s.doc.updateRender({ resolution_x: 400, resolution_y: 300, resolution_percentage: 100 });
    return s;
  }
  const layersOf = (e: ViewportEngine) => (e as unknown as { transmission: TransmissionLayers }).transmission;
  const area = (r: number[]) => r[2] * r[3];

  it('is where the glass on screen reads it, not the whole frame', () => {
    const s = paneScene([2.5, 1.5, 0.1]);
    const { e, gl } = engine(s);
    e.renderPixels({ width: 400, height: 300 });
    const draws = gl.draws.filter((d) => d.scene === e.scene);
    // the picture, drawn only around the pane, then the image itself, whole
    expect(draws).toHaveLength(2);
    const [x, y, w, h] = draws[0].scissor!;
    // (the 20 cm pane, its 20 cm reach around it, and the blur margin: about 6 % of the frame)
    expect(area([x, y, w, h])).toBeLessThan(0.08 * 400 * 300);
    expect(draws[1].scissor).toBeNull();
    // the pane is up and to the right of the centre; the rectangle holds all of it
    const [nx0, ny0, nx1, ny1] = layersOf(e).lastItems[0].rect;
    expect(x).toBeLessThanOrEqual(((nx0 + 1) / 2) * 400);
    expect(y).toBeLessThanOrEqual(((ny0 + 1) / 2) * 300);
    expect(x + w).toBeGreaterThanOrEqual(((nx1 + 1) / 2) * 400);
    expect(y + h).toBeGreaterThanOrEqual(((ny1 + 1) / 2) * 300);
    expect(x).toBeGreaterThan(200);
    expect(y).toBeGreaterThan(150);
    // the picture target is left without a scissor for the next frame
    expect((draws[0].target as THREE.WebGLRenderTarget).scissorTest).toBe(false);
  });

  it('is larger around rough glass, which blurs what it shows', () => {
    const clear = engine(paneScene([2.5, 1.5, 0.1]));
    clear.e.renderPixels({ width: 400, height: 300 });
    const frosted = engine(paneScene([2.5, 1.5, 0.1], { roughness: 0.4 }));
    frosted.e.renderPixels({ width: 400, height: 300 });
    const scissorOf = (x: { e: ViewportEngine; gl: { draws: Draw[] } }) =>
      x.gl.draws.filter((d) => d.scene === x.e.scene)[0].scissor!;
    expect(area(scissorOf(frosted))).toBeGreaterThan(4 * area(scissorOf(clear)));
  });

  it('is nothing when the glass is off screen', () => {
    const s = paneScene([30, 0, 0.1]);
    const { e, gl } = engine(s);
    e.renderPixels({ width: 400, height: 300 });
    // only the image: no picture is drawn for glass nobody sees
    expect(gl.draws.filter((d) => d.scene === e.scene)).toHaveLength(1);
    expect(layersOf(e).lastPictures).toBe(0);
  });

  it('is the object’s screen area widened by the light’s way through it and the blur of rough glass', () => {
    const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const glass = new THREE.MeshPhysicalMaterial({ transmission: 1, thickness: 0.5, roughness: 0, ior: 1.5 });
    installTransmissionLayer(glass);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), glass);
    mesh.updateMatrixWorld();
    const it = {
      mesh,
      box: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      rect: [-0.25, -1 / 3, 0.25, 1 / 3],
      distance: 10,
      level: 0,
    } as LayerItem;
    // the box ±1 m widened by the thickness (0.5 m) is ±1.5 m: x 250–550 px, y 150–450 px, plus the
    // margin clear glass blurs in
    const m = Math.ceil(blurMargin(800, 0.1));
    expect(m).toBeLessThan(25);
    expect(lookupRect(it, camera, 800, 600)).toEqual([250 - m, 150 - m, 550 + m, 450 + m]);
    // the thickness is scaled like the object: ±2 m
    mesh.scale.setScalar(2);
    mesh.updateMatrixWorld();
    expect(lookupRect(it, camera, 800, 600)).toEqual([200 - m, 100 - m, 600 + m, 500 + m]);
    // rough glass (roughness 0.6 at IOR 1.5) reads far around it
    const rough = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      thickness: 0.5,
      roughness: 0.6,
      ior: 1.5,
    });
    installTransmissionLayer(rough);
    expect(transmissionOf(rough)!.blur).toBeCloseTo(0.6, 9);
    mesh.material = rough;
    expect(lookupRect(it, camera, 800, 600)).toEqual([0, 0, 800, 600]);
    // a roughness texture can make any glass rough: its most roughness counts
    const textured = new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 0.1, ior: 1.5 });
    installTransmissionLayer(textured, 1);
    expect(transmissionOf(textured)!.blur).toBe(1);
    // IOR 1 bends nothing and blurs nothing (three.js: roughness × clamp(2 × ior − 2, 0, 1))
    const air = new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 1, ior: 1 });
    installTransmissionLayer(air);
    expect(transmissionOf(air)!.blur).toBe(0);
    // off screen: nothing
    mesh.material = glass;
    mesh.scale.setScalar(1);
    mesh.updateMatrixWorld();
    it.box.set(new THREE.Vector3(10, -1, -1), new THREE.Vector3(12, 1, 1));
    const off = lookupRect(it, camera, 800, 600)!;
    expect(off[2] > off[0] && off[3] > off[1]).toBe(false);
    // a box reaching behind a perspective camera may cover any part of the view
    const persp = new THREE.PerspectiveCamera(40, 4 / 3, 0.1, 100);
    persp.position.set(0, 0, 0.5);
    persp.updateMatrixWorld();
    it.box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    expect(lookupRect(it, persp, 800, 600)).toBeNull();
  });

  it('covers every instance of instanced glass', () => {
    const geometry = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const glass = new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 0, ior: 1.5 });
    installTransmissionLayer(glass);
    const beads = new THREE.InstancedMesh(geometry, glass, 2);
    beads.setMatrixAt(0, new THREE.Matrix4().makeTranslation(-3, 0, 0));
    beads.setMatrixAt(1, new THREE.Matrix4().makeTranslation(3, 0, 0));
    const scene = new THREE.Scene();
    scene.add(beads);
    scene.updateMatrixWorld();
    const camera = new THREE.OrthographicCamera(-4, 4, 3, -3, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld();
    const layers = new TransmissionLayers();
    layers.prepare(new THREE.WebGLRenderer(), scene, camera, 800, 600);
    // regression: the box was the source geometry's, at the origin, so the picture would only have
    // been drawn there
    const box = layers.lastItems[0].box;
    expect(box.min.x).toBeCloseTo(-3.05, 6);
    expect(box.max.x).toBeCloseTo(3.05, 6);
    layers.dispose();
  });
});

describe('transmission levels', () => {
  /** An object with world box `min`–`max` covering `rect` on screen, `distance` from the camera. */
  const item = (
    min: [number, number, number],
    max: [number, number, number],
    rect: [number, number, number, number],
    distance: number,
  ) =>
    ({
      mesh: new THREE.Mesh(),
      box: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)),
      rect,
      distance,
      level: 0,
    }) as LayerItem;

  it('puts what is inside another object, or behind it on screen, a level below', () => {
    const bottle = item([-1, -1, -1], [1, 1, 1], [-0.5, -0.5, 0.5, 0.5], 5);
    const perfume = item([-0.8, -0.8, -0.8], [0.8, 0.8, 0.5], [-0.4, -0.4, 0.4, 0.3], 5.1);
    const ice = item([-0.2, -0.2, -0.2], [0.2, 0.2, 0.2], [-0.1, -0.1, 0.1, 0.1], 5);
    const behind = item([3, -1, -1], [5, 1, 1], [0.4, -0.5, 0.9, 0.5], 9);
    const apart = item([10, 10, 10], [11, 11, 11], [0.95, 0.95, 0.99, 0.99], 8);
    const items = [bottle, perfume, ice, behind, apart];
    assignLevels(items);
    expect(items.map((i) => i.level)).toEqual([2, 1, 0, 0, 0]);
    // at most three levels
    const nest = [0, 1, 2, 3, 4].map((k) =>
      item([-5 + k, -5 + k, -5 + k], [5 - k, 5 - k, 5 - k], [-1, -1, 1, 1], 10),
    );
    assignLevels(nest);
    expect(nest.map((i) => i.level)).toEqual([2, 2, 2, 1, 0]);
  });

  it('gives an object and its instances (shared materials) one level', () => {
    const mats = [new THREE.MeshPhysicalMaterial()];
    const a = item([-1, -1, -1], [1, 1, 1], [-0.5, -0.5, 0.5, 0.5], 5);
    const inner = item([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], [-0.2, -0.2, 0.2, 0.2], 5);
    const copy = item([10, 10, 10], [11, 11, 11], [0.9, 0.9, 1, 1], 9);
    a.mesh.material = mats;
    copy.mesh.material = mats;
    assignLevels([a, inner, copy]);
    expect([a.level, inner.level, copy.level]).toEqual([1, 0, 1]);
  });
});

describe('transmissive materials', () => {
  it('take their transmission out of three.js’s hands and refract the pictures, checked by depth', () => {
    const doc = SceneDoc.create({ empty: true });
    const glass = { ...defaultMaterial('g', 'Glass'), transmission: 1, ior: 1.5 };
    const mat = buildMaterial(
      glass,
      'PBR',
      doc,
      new TextureCache(() => undefined),
    ) as THREE.MeshPhysicalMaterial;
    expect(mat.transmission).toBe(0);
    expect(transmissionOf(mat)?.transmission.value).toBe(1);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    mat.onBeforeCompile(
      shader as unknown as THREE.WebGLProgramParametersWithUniforms,
      {} as THREE.WebGLRenderer,
    );
    expect(shader.vertexShader.startsWith('#define USE_TRANSMISSION')).toBe(true);
    expect(shader.fragmentShader.startsWith('#define USE_TRANSMISSION')).toBe(true);
    expect(shader.fragmentShader).toContain('pfxTransmissionDepth');
    expect(shader.fragmentShader).not.toContain('#include <transmission_pars_fragment>');
    expect(shader.uniforms.transmission).toBe(transmissionOf(mat)!.transmission);
    expect(shader.uniforms.transmissionSamplerMap).toBe(transmissionOf(mat)!.map);
    expect(mat.customProgramCacheKey()).toContain('|transmission');
    // an opaque material is left alone
    const plain = buildMaterial(defaultMaterial('p', 'Plain'), 'PBR', doc, new TextureCache(() => undefined));
    expect(transmissionOf(plain)).toBeNull();
    // three.js's shaders still have what the patch rewrites
    expect(
      patchTransmission({
        vertexShader: THREE.ShaderLib.physical.vertexShader,
        fragmentShader: THREE.ShaderLib.physical.fragmentShader,
      }),
    ).toBe(true);
    // idempotent
    installTransmissionLayer(mat);
    expect(transmissionOf(mat)?.transmission.value).toBe(1);
  });

  it('are as thick as the smallest side of their object', () => {
    const g = new THREE.BoxGeometry(0.084, 0.07, 0.096);
    expect(transmissionThickness(g)).toBeCloseTo(0.07, 9);
    expect(transmissionThickness(new THREE.BufferGeometry())).toBe(0);
  });
});
