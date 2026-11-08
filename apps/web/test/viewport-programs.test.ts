import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { signal } from '@preact/signals';
import {
  MATERIAL_PRESETS,
  SceneDoc,
  SceneEvaluator,
  createCube,
  presetMaterialValues,
} from '@3d-editor/core';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { ViewportEngine } from '../src/viewport/engine';
import { slowFrameCompiled, slowFrameMs } from '../src/telemetry/perf';
import { createWebGL2Stub, type WebGL2Stub } from './webgl2-stub';

/*
 * The viewport on three.js's own WebGLRenderer, on a stand-in WebGL2 context (webgl2-stub.ts): which
 * shader programs three.js links when materials change or X-ray is turned on and off, and what it
 * keeps. Linking a program and compiling its shaders took seconds per program in software WebGL
 * (SwiftShader): 9–15 s until the next Material Preview or Rendered frame after a material edit, and
 * 34.7 s for the first frame with X-ray in Rendered shading (examples/domino-cascade, 1280×720).
 */

function session(): ProjectSession {
  const doc = SceneDoc.create();
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    id: 'viewport-programs-test',
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

let stub: WebGL2Stub;
const engines: ViewportEngine[] = [];
function engine(s: ProjectSession): ViewportEngine {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.appendChild(canvas);
  document.body.appendChild(host);
  stub = createWebGL2Stub(canvas);
  canvas.getContext = ((kind: string) => (kind === 'webgl2' ? stub.gl : null)) as typeof canvas.getContext;
  const e = new ViewportEngine(canvas, s);
  engines.push(e);
  return e;
}
/** Runs one turn of the viewport's frame loop (what requestAnimationFrame would run). */
const frame = (e: ViewportEngine) => (e as unknown as { loop(now: number): void }).loop(performance.now());

const preset = (id: string) => presetMaterialValues(MATERIAL_PRESETS.find((p) => p.id === id)!);

/**
 * Objects like examples/domino-cascade's: a table with a procedural material (base colour,
 * roughness and bump textures) and a plain one, dowels sharing a procedural wood material, and
 * dominoes with plain materials of their own.
 */
function dominoes(s: ProjectSession) {
  const doc = s.doc;
  const tiles = doc.addMaterial({ ...preset('ceramic_tiles'), name: 'Wood' });
  const dark = doc.addMaterial({ name: 'Wood Dark', base_color: [0.09, 0.045, 0.02, 1], roughness: 0.5 });
  const top = createCube({ size: 2 });
  top.faceMaterials = top.faces.map((_, i) => i % 2);
  doc.addObject({
    type: 'MESH',
    name: 'Table',
    data: doc.addMesh('Table', top),
    material_slots: [tiles, dark],
  });
  const beech = doc.addMaterial({ ...preset('wood'), name: 'Beech' });
  for (let i = 0; i < 3; i++)
    doc.addObject({
      type: 'MESH',
      name: `Dowel.${i}`,
      data: doc.addMesh(`Dowel.${i}`, createCube({ size: 0.3 })),
      material_slots: [beech],
      location: [i - 1, 2, 0],
    });
  const plastics: string[] = [];
  for (let i = 0; i < 3; i++) {
    const m = doc.addMaterial({ name: `Plastic ${i}`, base_color: [0.9, 0.1 * i, 0.05, 1], roughness: 0.12 });
    plastics.push(m);
    doc.addObject({
      type: 'MESH',
      name: `Domino.${i}`,
      data: doc.addMesh(`Domino.${i}`, createCube({ size: 0.4 })),
      material_slots: [m],
      location: [i - 1, -2, 0],
    });
  }
  return { tiles, dark, beech, plastics, table: doc.findObjectByName('Table')!.id };
}

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  // let vitest send its task events (it does so from a timer, which these synchronous tests block)
  await new Promise((done) => setTimeout(done, 0));
});
afterEach(() => {
  for (const e of engines.splice(0)) e.dispose();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('shader programs of the viewport (three.js on a stand-in WebGL2 context)', () => {
  // One test per shading, each with its own timeout: under coverage both shadings in one test took
  // 0.9 s of the default 5 s at a load of 2–3; apart, Material Preview 0.21–0.27 s and Rendered
  // 0.64–0.82 s at a load of 2.4–4.0 (five runs, two of them beside an end-to-end test run), and
  // 0.27 s and 0.86 s with the core and server suites running beside them (as in CI's coverage job).
  for (const [shading, name] of [
    ['MATERIAL', 'Material Preview'],
    ['RENDERED', 'Rendered'],
  ] as const)
    it(`are not linked again when a material changes or X-ray is turned on and off in ${name} shading`, () => {
      // regression: a material edit built the object's whole material set again (its key covered
      // every slot) and disposed the old materials before the new ones were drawn, so three.js
      // deleted their shader programs and linked them again (the procedural material of the table
      // when the plain one next to it changed, the dowels' shared one); X-ray built a set of
      // transparent materials, each needing programs of its own
      const s = session();
      const e = engine(s);
      const m = dominoes(s);
      s.view.shading.value = shading;
      frame(e);
      frame(e);
      const info = e.renderer.info;
      const links = stub.links;
      expect(links, shading).toBeGreaterThan(3);
      /** What three.js holds after the first round (the composer's second target is made then). */
      let held = { programs: 0, geometries: 0, textures: 0 };
      const tableMaterials = () => e.objects.views.get(m.table)!.mesh!.material as THREE.Material[];
      /** Changes something, draws a frame and checks that no shader program was linked for it. */
      const step = (what: string, change: () => void) => {
        change();
        frame(e);
        expect(stub.links - links, `${shading}: programs linked again after ${what}`).toBe(0);
      };
      // 50 changes in Rendered shading, 20 in Material Preview
      for (let i = 0; i < (shading === 'RENDERED' ? 10 : 4); i++) {
        const roughness = 0.2 + i / 100;
        const tiles = tableMaterials()[0];
        step('an edit of the plain material next to a procedural one', () =>
          s.doc.updateMaterial(m.dark, { roughness }),
        );
        // the table's procedural material is kept, the plain one next to it built again
        expect(tableMaterials()[0], shading).toBe(tiles);
        expect((tableMaterials()[1] as THREE.MeshPhysicalMaterial).roughness, shading).toBe(roughness);
        step('an edit of the procedural material', () => s.doc.updateMaterial(m.tiles, { roughness }));
        step('an edit of the procedural material of three objects', () =>
          s.doc.updateMaterial(m.beech, { base_color: [0.6, 0.4, 0.2 + i / 200, 1] }),
        );
        step('an edit of a plain material', () => s.doc.updateMaterial(m.plastics[i % 3], { roughness }));
        step('X-ray turned on or off', () => (s.view.xray.value = !s.view.xray.value));
        if (i === 0) held = { programs: info.programs!.length, ...info.memory };
      }
      expect({ programs: info.programs!.length, ...info.memory }, shading).toEqual(held);
      // the replaced materials went once the new ones were drawn
      expect(e.objects.waitingMaterials(), shading).toBe(0);
    }, 10_000);

  it('are kept for the other shadings a changed material was drawn in: drawing there again links none', () => {
    // regression: the material a change replaced was disposed once the new one had been drawn in one
    // shading, and three.js dropped the shader programs only it held for the others: a procedural
    // material's (or a backface-culled one's) for Material Preview after an edit in Rendered shading
    // or the other way round, a Solid material's opaque one after an edit with X-ray on. The next
    // frame or picture there linked them again: 9.8–11.9 s in software WebGL (domino-cascade's
    // Beech and Wood, Material Preview after an edit in Rendered shading)
    const s = session();
    const e = engine(s);
    const m = dominoes(s);
    // a plain material with shader programs of its own, also in Solid shading (front faces only)
    const glazed = s.doc.addMaterial({
      name: 'Glazed',
      base_color: [0.2, 0.5, 0.8, 1],
      roughness: 0.3,
      use_backface_culling: true,
    });
    s.doc.addObject({
      type: 'MESH',
      name: 'Vase',
      data: s.doc.addMesh('Vase', createCube({ size: 0.4 })),
      material_slots: [glazed],
      location: [2, -2, 0],
    });
    type Shading = readonly ['SOLID' | 'MATERIAL' | 'RENDERED', boolean];
    const show = ([shading, xray]: Shading) => {
      s.view.shading.value = shading;
      s.view.xray.value = xray;
      frame(e);
    };
    const material: Shading = ['MATERIAL', false];
    const rendered: Shading = ['RENDERED', false];
    const solid: Shading = ['SOLID', false];
    const solidXray: Shading = ['SOLID', true];
    for (const where of [material, rendered, solid, solidXray]) show(where);
    const info = e.renderer.info;
    const links = stub.links;
    let held = { programs: 0, geometries: 0, textures: 0 };
    // edits in each shading, then a frame in another one the materials were drawn in: 96 edits
    let edit = 0;
    for (let i = 0; i < 8; i++) {
      for (const [here, there] of [
        [rendered, material],
        [material, rendered],
        [solidXray, solid],
        [solid, solidXray],
      ]) {
        show(here);
        edit++;
        s.doc.updateMaterial(m.beech, { base_color: [0.6, 0.4, 0.2 + edit / 200, 1] });
        s.doc.updateMaterial(m.tiles, { roughness: 0.3 + edit / 100 });
        s.doc.updateMaterial(glazed, { base_color: [0.2, 0.5, 0.8 - edit / 100, 1] });
        frame(e);
        // the replaced materials wait for the other shading
        expect(e.objects.waitingMaterials(), `${here} → ${there}`).toBeGreaterThan(0);
        show(there);
        expect(stub.links - links, `programs linked again in ${there} after edits in ${here}`).toBe(0);
      }
      if (i === 0) held = { programs: info.programs!.length, ...info.memory };
    }
    expect({ programs: info.programs!.length, ...info.memory }).toEqual(held);
    // drawn in every shading again: none waits
    for (const where of [material, rendered, solid, solidXray]) show(where);
    expect(stub.links - links).toBe(0);
    expect(e.objects.waitingMaterials()).toBe(0);
  });

  it('are kept for an object drawn again after its material changed while only its instances were drawn', () => {
    // an instanced object (a collection instance, a particle scatter) is drawn with other shader
    // programs than the object itself: a change made while only the instances were drawn (the
    // object hidden or out of view, as scatter sources often are) keeps the material it replaced
    // for the object's own programs
    const s = session();
    const e = engine(s);
    const doc = s.doc;
    const gems = doc.addCollection({ name: 'Gems' });
    // front faces only: shader programs no other material here shares
    const ruby = doc.addMaterial({
      name: 'Ruby',
      base_color: [0.6, 0.02, 0.05, 1],
      use_backface_culling: true,
    });
    const gem = doc.addObject({
      type: 'MESH',
      name: 'Gem',
      data: doc.addMesh('Gem', createCube({ size: 0.4 })),
      material_slots: [ruby],
      collection: gems,
    });
    doc.addObject({
      type: 'EMPTY',
      name: 'Gems',
      instance_type: 'COLLECTION',
      instance_collection: gems,
      location: [2, 0, 0],
    });
    s.view.shading.value = 'RENDERED';
    frame(e);
    // (three.js links the point light's shadow programs again at the second scene sync: it keys them
    // with the lights of the render before)
    e.invalidate();
    frame(e);
    const instanced = () => {
      let n = 0;
      e.scene.traverse((o) => {
        if ((o as THREE.InstancedMesh).isInstancedMesh && o.visible) n++;
      });
      return n;
    };
    expect(instanced()).toBe(1);
    const links = stub.links;
    for (let i = 0; i < 5; i++) {
      // the gem hidden: only its instance is drawn when its material changes
      doc.updateObject(gem, { hide_viewport: true });
      frame(e);
      doc.updateMaterial(ruby, { roughness: 0.2 + i / 100 });
      frame(e);
      expect(instanced()).toBe(1);
      expect(e.objects.waitingMaterials()).toBe(1);
      doc.updateObject(gem, { hide_viewport: false });
      frame(e);
      expect(stub.links - links).toBe(0);
      expect(e.objects.waitingMaterials()).toBe(0);
    }
  });

  it('are kept for a material changed while its object is not drawn, until the new material is', () => {
    // a material replaced by one that was never drawn (its object hidden, or out of view) is kept:
    // disposing it would drop its shader program, which the new one gets when it is drawn
    const s = session();
    const e = engine(s);
    const m = dominoes(s);
    s.view.shading.value = 'RENDERED';
    frame(e);
    const links = stub.links;
    const programs = e.renderer.info.programs!.length;
    s.doc.updateObject(m.table, { hide_viewport: true });
    frame(e);
    const tiles = (e.objects.views.get(m.table)!.mesh!.material as THREE.Material[])[0];
    let disposed = 0;
    tiles.addEventListener('dispose', () => disposed++);
    s.doc.updateMaterial(m.tiles, { roughness: 0.3 });
    frame(e);
    s.doc.updateMaterial(m.tiles, { roughness: 0.31 });
    frame(e);
    // the material drawn last waits (the first replacement, never drawn, went at once)
    expect(disposed).toBe(0);
    expect(e.renderer.info.programs!.length).toBe(programs);
    expect(e.objects.waitingMaterials()).toBe(1);
    s.doc.updateObject(m.table, { hide_viewport: false });
    frame(e);
    expect(stub.links - links).toBe(0);
    expect(disposed).toBe(1);
    expect(e.objects.waitingMaterials()).toBe(0);
    expect(e.renderer.info.programs!.length).toBe(programs);
  });

  it('are kept for pictures of the viewport: pictures after the first in a shading link none', () => {
    // regression: every picture (editor_command screenshot) made its output pass and copy quad
    // anew and disposed them, so three.js linked their two shader programs for every picture
    const s = session();
    const e = engine(s);
    dominoes(s);
    s.view.shading.value = 'RENDERED';
    frame(e);
    const picture = (shading: 'SOLID' | 'RENDERED' | null) => {
      e.renderPixels({ useViewport: true, width: 32, height: 16, shading });
      frame(e);
    };
    picture(null);
    picture('SOLID');
    const links = stub.links;
    const programs = e.renderer.info.programs!.length;
    for (let i = 0; i < 5; i++) {
      picture(null);
      picture('SOLID');
      // and a final render (F12, render_image in the browser) with the scene camera
      e.renderPixels({ width: 32, height: 16 });
      frame(e);
    }
    expect(stub.links - links).toBe(0);
    expect(e.renderer.info.programs!.length).toBe(programs);
  });

  it('are not built again for pictures: a picture has the viewport’s samples, also when the viewport drops them', () => {
    // regression: pictures (editor_command screenshot) always had 4 samples. Software WebGL
    // (SwiftShader) builds a pipeline per shader and sample count: the first picture in a shading
    // the viewport had drawn without multisampling (a heavy scene, slow frames) built every
    // material's pipelines again, 9.8–13.5 s for examples/domino-cascade with no shader compiled
    const ids = (keys: Iterable<string>) => new Set([...keys].map((k) => k.split('|')[0]));
    const built: Record<string, string[]> = {};
    for (const multisampled of [true, false])
      for (const shading of ['MATERIAL', 'RENDERED', 'SOLID'] as const) {
        const s = session();
        const e = engine(s);
        dominoes(s);
        if (!multisampled) (e as unknown as { setMultisampling(on: boolean): void }).setMultisampling(false);
        s.view.shading.value = shading;
        frame(e);
        // the programs the frame drew the scene with (into the scene target, not the canvas)
        const scene = ids([...stub.pipelines].filter((k) => !k.endsWith('|canvas')));
        const before = new Set(stub.pipelines);
        e.renderPixels({ useViewport: true, width: 32, height: 16 });
        frame(e);
        built[`${shading}${multisampled ? '' : ' without multisampling'}`] = [...stub.pipelines].filter(
          (k) => !before.has(k) && scene.has(k.split('|')[0]),
        );
        expect(e.multisampling).toBe(multisampled);
      }
    expect(built).toEqual({
      MATERIAL: [],
      RENDERED: [],
      SOLID: [],
      'MATERIAL without multisampling': [],
      'RENDERED without multisampling': [],
      'SOLID without multisampling': [],
    });
  });

  it('are not built again for a picture in a shading drawn before the viewport’s multisampling changed', () => {
    // the picture has the samples that shading was drawn with; with the viewport's new ones it
    // would build every material's pipelines again
    const ids = (keys: Iterable<string>) => new Set([...keys].map((k) => k.split('|')[0]));
    const built: Record<string, string[]> = {};
    for (const multisampled of [true, false])
      for (const shading of ['MATERIAL', 'RENDERED'] as const) {
        const s = session();
        const e = engine(s);
        dominoes(s);
        const setMultisampling = (on: boolean) =>
          (e as unknown as { setMultisampling(on: boolean): void }).setMultisampling(on);
        setMultisampling(multisampled);
        s.view.shading.value = shading;
        frame(e);
        const scene = ids([...stub.pipelines].filter((k) => !k.endsWith('|canvas')));
        // the viewport goes on in Solid shading with the other sample count
        s.view.shading.value = 'SOLID';
        setMultisampling(!multisampled);
        frame(e);
        const before = new Set(stub.pipelines);
        e.renderPixels({ useViewport: true, shading, width: 32, height: 16 });
        built[`${shading} drawn ${multisampled ? 'with' : 'without'} multisampling`] = [
          ...stub.pipelines,
        ].filter((k) => !before.has(k) && scene.has(k.split('|')[0]));
      }
    expect(built).toEqual({
      'MATERIAL drawn with multisampling': [],
      'RENDERED drawn with multisampling': [],
      'MATERIAL drawn without multisampling': [],
      'RENDERED drawn without multisampling': [],
    });
  });

  it('make a frame that links one count as compiling, also when it releases another, and not one that only releases one', () => {
    // regression: the viewport took a frame for compiling when three.js's last program changed.
    // three.js appends a program it links to its list and takes one it releases out by moving the
    // last one into its place: an edit that gave a procedural material another shader (sheen)
    // linked one and released the replaced material's in the same frame, which kept the last one,
    // so its compile time counted for multisampling; deleting an object whose material had a
    // program of its own released one, changed the last one and counted as compiling
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    /**
     * Draws the frame of a change, which the GPU draws for 3 s (its fences read every 16 ms), and
     * says how the viewport counted it: as slow from compiling shaders, and whether its time turned
     * multisampling off.
     */
    const slowFrame = (e: ViewportEngine, change: () => void) => {
      const links = stub.links;
      const deletes = stub.deletes;
      const programs = e.renderer.info.programs!.length;
      change();
      frame(e);
      stub.busy = true;
      for (let t = 0; t < 3000; t += 16) {
        now += 16;
        frame(e);
      }
      stub.busy = false;
      now += 16;
      frame(e);
      return {
        links: stub.links - links,
        deletes: stub.deletes - deletes,
        programs: e.renderer.info.programs!.length - programs,
        compiling: slowFrameCompiled.value,
        multisampling: e.multisampling,
      };
    };
    try {
      for (const shading of ['MATERIAL', 'RENDERED'] as const) {
        const s = session();
        const e = engine(s);
        const m = dominoes(s);
        s.view.shading.value = shading;
        frame(e);
        frame(e);
        expect(
          slowFrame(e, () => s.doc.updateMaterial(m.tiles, { sheen_weight: 0.5 })),
          shading,
        ).toEqual({ links: 1, deletes: 1, programs: 0, compiling: true, multisampling: true });
        expect(
          slowFrame(e, () => s.doc.removeObject(m.table)),
          `${shading}: the table deleted`,
        ).toEqual({ links: 0, deletes: 1, programs: -1, compiling: false, multisampling: false });
      }
    } finally {
      slowFrameMs.value = 0;
      slowFrameCompiled.value = false;
      vi.restoreAllMocks();
    }
  });

  it('link the see-through variants once in Solid shading: X-ray on and off again reuses them', () => {
    const s = session();
    const e = engine(s);
    const m = dominoes(s);
    frame(e);
    const tableMaterials = () => e.objects.views.get(m.table)!.mesh!.material as THREE.Material[];
    const clay = [...tableMaterials()];
    expect(clay.every((x) => !x.transparent)).toBe(true);
    let links = stub.links;
    s.view.xray.value = true;
    frame(e);
    // the same materials, see-through: three.js links their transparent variants
    expect(tableMaterials()).toEqual(clay);
    expect(clay.every((x) => x.transparent && x.opacity <= 0.45 && !x.depthWrite)).toBe(true);
    expect(stub.links).toBeGreaterThan(links);
    links = stub.links;
    const programs = e.renderer.info.programs!.length;
    for (let i = 0; i < 25; i++) {
      s.view.xray.value = !s.view.xray.value;
      frame(e);
      s.doc.updateMaterial(m.plastics[i % 3], { roughness: 0.2 + i / 100 });
      frame(e);
    }
    s.view.xray.value = false;
    frame(e);
    expect(stub.links - links).toBe(0);
    expect(e.renderer.info.programs!.length).toBe(programs);
    expect(clay.every((x) => !x.transparent && x.opacity === 1 && x.depthWrite)).toBe(true);
  });
});
