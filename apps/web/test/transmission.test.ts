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
  assignLevels,
  installTransmissionLayer,
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
      this.draws.push({ scene, target: this.target, drawn });
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
  material(s, 'Amber', ['Perfume'], { transmission: 1, roughness: 0, ior: 1.36, base_color: [1, 0.84, 0.55, 1] });
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
    // the meshes are back on the camera's layer
    for (const n of ['Bottle', 'Perfume']) {
      const v = e.objects.views.get(s.doc.findObjectByName(n)!.id)!;
      expect(v.mesh!.layers.test(new THREE.Layers())).toBe(true);
      expect(v.mesh!.layers.isEnabled(HIDDEN_LAYER)).toBe(false);
    }
    // three.js's own transmission pass is off: it would refract only the opaque objects
    for (const n of ['Bottle', 'Perfume'])
      expect(((e.objects.views.get(s.doc.findObjectByName(n)!.id)!.mesh!.material as THREE.Material[])[0] as THREE.MeshPhysicalMaterial).transmission).toBe(0);
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

describe('transmission levels', () => {
  const item = (box: [number[], number[]], rect: [number, number, number, number], distance: number) =>
    ({
      mesh: new THREE.Mesh(),
      box: new THREE.Box3(new THREE.Vector3(...box[0]), new THREE.Vector3(...box[1])),
      rect,
      distance,
      level: 0,
    }) as LayerItem;

  it('puts what is inside another object, or behind it on screen, a level below', () => {
    const bottle = item([[-1, -1, -1], [1, 1, 1]], [-0.5, -0.5, 0.5, 0.5], 5);
    const perfume = item([[-0.8, -0.8, -0.8], [0.8, 0.8, 0.5]], [-0.4, -0.4, 0.4, 0.3], 5.1);
    const ice = item([[-0.2, -0.2, -0.2], [0.2, 0.2, 0.2]], [-0.1, -0.1, 0.1, 0.1], 5);
    const behind = item([[3, -1, -1], [5, 1, 1]], [0.4, -0.5, 0.9, 0.5], 9);
    const apart = item([[10, 10, 10], [11, 11, 11]], [0.95, 0.95, 0.99, 0.99], 8);
    const items = [bottle, perfume, ice, behind, apart];
    assignLevels(items);
    expect(items.map((i) => i.level)).toEqual([2, 1, 0, 0, 0]);
    // at most three levels
    const nest = [0, 1, 2, 3, 4].map((k) => item([[-5 + k, -5 + k, -5 + k], [5 - k, 5 - k, 5 - k]], [-1, -1, 1, 1], 10));
    assignLevels(nest);
    expect(nest.map((i) => i.level)).toEqual([2, 2, 2, 1, 0]);
  });

  it('gives an object and its instances (shared materials) one level', () => {
    const mats = [new THREE.MeshPhysicalMaterial()];
    const a = item([[-1, -1, -1], [1, 1, 1]], [-0.5, -0.5, 0.5, 0.5], 5);
    const inner = item([[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]], [-0.2, -0.2, 0.2, 0.2], 5);
    const copy = item([[10, 10, 10], [11, 11, 11]], [0.9, 0.9, 1, 1], 9);
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
    const mat = buildMaterial(glass, 'PBR', doc, new TextureCache(() => undefined)) as THREE.MeshPhysicalMaterial;
    expect(mat.transmission).toBe(0);
    expect(transmissionOf(mat)?.transmission.value).toBe(1);
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: THREE.ShaderLib.physical.vertexShader,
      fragmentShader: THREE.ShaderLib.physical.fragmentShader,
    };
    mat.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, {} as THREE.WebGLRenderer);
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
