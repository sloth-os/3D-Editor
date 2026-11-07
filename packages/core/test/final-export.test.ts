import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  encodePNG,
  exportScene,
  importFile,
  type OperatorContext,
} from '../src';
import { uvOverlapFraction } from '../src/io/bake-procedural';
import { parseGltf, readAccessor } from './fixes-export-gltf-check';

// glTF export: bake resolution, names of per-mesh bakes, overlapping UVs, sheen and curved paths
// (clockwork-orrery, domino-cascade and product-shot issues of the final project runs).

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => {},
  };
  const run = (id: string, params?: unknown) => {
    const r = reg.run<any>(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error ?? JSON.stringify(r)}`);
    return r.result;
  };
  return { doc, ctx, run };
}

/** Width and height of a PNG image of the GLB. */
function pngSize(json: any, bin: Uint8Array, image: number): [number, number] {
  const bv = json.bufferViews[json.images[image].bufferView];
  const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [dv.getUint32(16), dv.getUint32(20)];
}

const OBJECT_NOISE = {
  type: 'NOISE',
  mapping: 'OBJECT',
  scale: 4,
  color_a: [0.1, 0.1, 0.1, 1],
  color_b: [0.9, 0.8, 0.6, 1],
};

describe('glTF export: procedural bakes', () => {
  it('scales the bake resolution with the size of the surface, and takes an explicit size', () => {
    const { doc, run } = setup();
    run('mesh.primitive_plane_add', { name: 'Floor', size: 24 });
    run('material.new', { name: 'Big' });
    run('material.procedural_set', { material: 'Big', procedural: OBJECT_NOISE });
    run('mesh.primitive_cube_add', { name: 'Small', size: 0.2, location: [0, 0, 1] });
    run('material.new', { name: 'Tiny' });
    run('material.procedural_set', { material: 'Tiny', procedural: OBJECT_NOISE });
    const auto = parseGltf(exportScene(doc, 'glb').data);
    const sizeOf = (g: { json: any; bin: Uint8Array }, name: string) =>
      pngSize(
        g.json,
        g.bin,
        g.json.images.findIndex((i: any) => i.name === `${name} base color`),
      );
    // a 24 m floor used to get 512 × 512 like everything else (2 m per texel)
    expect(sizeOf(auto, 'Big')).toEqual([2048, 2048]);
    expect(sizeOf(auto, 'Tiny')).toEqual([512, 512]);
    const fixed = parseGltf(exportScene(doc, 'glb', { bakeResolution: 256 }).data);
    expect(sizeOf(fixed, 'Big')).toEqual([256, 256]);
    expect(sizeOf(fixed, 'Tiny')).toEqual([256, 256]);
    // the export operator takes it too
    const op = run('export_scene.gltf', { bake_resolution: 128 });
    const viaOp = parseGltf(Uint8Array.from(atob(op.data_base64), (c) => c.charCodeAt(0)));
    expect(sizeOf(viaOp, 'Big')).toEqual([128, 128]);
  });

  it('names the per-mesh copies of one material apart and says so', () => {
    const { doc, run } = setup();
    run('material.new', { name: 'Beech', assign: false });
    run('material.procedural_set', { material: 'Beech', procedural: OBJECT_NOISE });
    // four different meshes (an OBJECT-mapped texture is baked once per distinct mesh)
    for (const [i, size] of [0.2, 0.3, 0.4, 0.5].entries()) {
      run('mesh.primitive_cube_add', { name: `Dowel.${i + 1}`, size, location: [i, 0, 0] });
      run('object.material_assign', { material: 'Beech' });
    }
    const res = exportScene(doc, 'glb');
    const { json } = parseGltf(res.data);
    const names = json.materials.map((m: any) => m.name).sort();
    expect(names).toEqual(['Beech', 'Beech.001', 'Beech.002', 'Beech.003']);
    const images = json.images.map((m: any) => m.name).sort();
    expect(images).toEqual([
      'Beech base color',
      'Beech.001 base color',
      'Beech.002 base color',
      'Beech.003 base color',
    ]);
    expect(res.warnings?.some((w) => /Material 'Beech' is exported as 4 glTF materials/.test(w))).toBe(true);
  });

  it('does not bake position-dependent textures into overlapping UVs', () => {
    const { doc, run } = setup();
    run('mesh.primitive_cube_add', { name: 'Stacked' });
    run('material.new', { name: 'Stone' });
    run('material.procedural_set', { material: 'Stone', procedural: OBJECT_NOISE });
    // every face of the cube mapped onto the whole UV square (stacked islands)
    const obj = doc.listObjects().find((o) => o.name === 'Stacked')!;
    const mesh = doc.getMesh(obj.data!)!;
    doc.setMesh(obj.data!, { ...mesh, uvs: mesh.faces.map(() => [0, 0, 1, 0, 1, 1, 0, 1]) });
    const res = exportScene(doc, 'glb');
    expect(res.warnings?.some((w) => /Mesh 'Stacked': its UVs overlap .*generated UVs/.test(w))).toBe(true);
    const { json, bin } = parseGltf(res.data);
    // the written UVs are a non-overlapping layout, not the stacked squares
    const uv = readAccessor(json, bin, json.meshes[0].primitives[0].attributes.TEXCOORD_0);
    const distinct = new Set<string>();
    for (let i = 0; i < uv.length; i += 2) distinct.add(`${uv[i].toFixed(3)},${uv[i + 1].toFixed(3)}`);
    expect(distinct.size).toBeGreaterThan(4);
    // an image texture needs the mesh's own UVs: they are kept, with a warning
    const img = doc.addImage({
      name: 'Label',
      mime: 'image/png',
      width: 1,
      height: 1,
      data: encodePNG({ width: 1, height: 1, data: new Uint8ClampedArray([200, 200, 200, 255]) }),
    });
    const mat = doc.listMaterials().find((m) => m.name === 'Stone')!;
    doc.updateMaterial(mat.id, {
      textures: { ...mat.textures, roughness: { image: img, procedural: null } as never },
    });
    const kept = exportScene(doc, 'glb');
    expect(kept.warnings?.some((w) => /its UVs overlap .*wrong where faces share texels/.test(w))).toBe(true);
  });

  it('bakes a beveled cylinder into its own UVs without overlaps (product-shot repro)', () => {
    const { doc, run } = setup();
    run('mesh.primitive_cylinder_add', { name: 'C', vertices: 16, radius: 0.1, depth: 0.05 });
    run('object.modifier_add', {
      type: 'BEVEL',
      params: { width: 0.004, segments: 3, limit_method: 'ANGLE', angle_limit: 0.6 },
    });
    run('material.preset_apply', { preset: 'marble', objects: ['C'] });
    // the bevel keeps every face in its UV island: nothing for the bake to overwrite
    const ev = [...new SceneEvaluator(doc).evaluate(1, { forRender: true }).byId.values()].find(
      (o) => o.name === 'C',
    )!;
    expect(uvOverlapFraction(ev.mesh!)).toBe(0);
    const res = exportScene(doc, 'glb');
    expect(res.warnings?.filter((w) => /UV/.test(w)) ?? []).toEqual([]);
  });
});

describe('glTF export: materials', () => {
  it('writes sheen as KHR_materials_sheen and imports it back', () => {
    const { doc, run } = setup();
    run('mesh.primitive_uv_sphere_add', { name: 'S' });
    run('material.new', { name: 'Velvet', base_color: [0.5, 0.1, 0.1, 1] });
    run('material.update', { material: 'Velvet', sheen_weight: 0.8, sheen_tint: [1, 0.5, 0.5] });
    const res = exportScene(doc, 'glb');
    const { json } = parseGltf(res.data);
    expect(json.extensionsUsed).toContain('KHR_materials_sheen');
    const sheen = json.materials[0].extensions.KHR_materials_sheen;
    expect(sheen.sheenColorFactor[0]).toBeCloseTo(0.8, 6);
    expect(sheen.sheenColorFactor[1]).toBeCloseTo(0.4, 6);
    expect(sheen.sheenRoughnessFactor).toBeCloseTo(0.5, 6);
    const back = SceneDoc.create({ empty: true });
    importFile(back, 'glb', res.data);
    const m = back.listMaterials().find((x) => x.name === 'Velvet')!;
    expect(m.sheen_weight).toBeCloseTo(0.8, 5);
    expect(m.sheen_tint[1]).toBeCloseTo(0.5, 5);
  });
});

describe('glTF export: animation of objects on curved paths', () => {
  it('samples a fast orbit at sub-frames so the linear keys stay on the circle', () => {
    const { doc, run } = setup();
    doc.updateScene({ frame_start: 1, frame_end: 24, fps: 24 });
    // a moon kept on a 50 mm orbit, 45° per frame, in world space (no parent: world-space keys)
    run('mesh.primitive_uv_sphere_add', { name: 'Moon', radius: 0.005 });
    run('anim.driver_add', {
      target: 'Moon',
      path: 'location',
      index: 0,
      expression: 'cos(frame * pi / 4) * 0.05',
    });
    run('anim.driver_add', {
      target: 'Moon',
      path: 'location',
      index: 1,
      expression: 'sin(frame * pi / 4) * 0.05',
    });
    const res = exportScene(doc, 'glb');
    const { json, bin } = parseGltf(res.data);
    const ch = json.animations[0].channels.find((c: any) => c.target.path === 'translation');
    const sampler = json.animations[0].samplers[ch.sampler];
    const times = readAccessor(json, bin, sampler.input);
    const values = readAccessor(json, bin, sampler.output);
    // more than one key per frame
    expect(times.length).toBeGreaterThan(24 * 2);
    // play it like a glTF viewer (linear interpolation) at 240 Hz: the distance to the orbit center
    // stayed between 43.9 and 50 mm with one key per frame
    let worst = 0;
    for (let k = 0; k <= 230; k++) {
      const t = k / 240;
      let i = 0;
      while (i + 2 < times.length && times[i + 1] < t) i++;
      const f = Math.min(1, Math.max(0, (t - times[i]) / (times[i + 1] - times[i])));
      // glTF is Y-up: editor X → glTF X, editor Y → glTF −Z
      const x = values[i * 3] + (values[i * 3 + 3] - values[i * 3]) * f;
      const z = values[i * 3 + 2] + (values[i * 3 + 5] - values[i * 3 + 2]) * f;
      worst = Math.max(worst, Math.abs(Math.hypot(x, z) - 0.05));
    }
    expect(worst).toBeLessThan(0.0006);
    expect(res.warnings?.some((w) => /curved path/.test(w)) ?? false).toBe(false);
  });

  it('keeps one key per frame where the motion only turns at frames (LINEAR zigzag keys)', () => {
    const { doc, run } = setup();
    doc.updateScene({ frame_start: 1, frame_end: 41 });
    run('mesh.primitive_cube_add', { name: 'Box', size: 0.1 });
    const frames = Array.from({ length: 21 }, (_, i) => 1 + 2 * i);
    run('anim.keyframes_insert_many', {
      target: 'Box',
      path: 'location',
      index: 0,
      frames,
      values: frames.map((_, i) => i * 0.05),
      interpolation: 'LINEAR',
    });
    run('anim.keyframes_insert_many', {
      target: 'Box',
      path: 'location',
      index: 1,
      frames,
      values: frames.map((_, i) => (i % 2) * 0.05),
      interpolation: 'LINEAR',
    });
    // a moon on a fast orbit in the same scene still gets keys between the frames
    run('mesh.primitive_uv_sphere_add', { name: 'Moon', radius: 0.005 });
    run('anim.driver_add', {
      target: 'Moon',
      path: 'location',
      index: 0,
      expression: 'cos(frame * pi / 4) * 0.05',
    });
    run('anim.driver_add', {
      target: 'Moon',
      path: 'location',
      index: 1,
      expression: 'sin(frame * pi / 4) * 0.05',
    });
    const res = exportScene(doc, 'glb');
    const { json, bin } = parseGltf(res.data);
    const keys = (name: string) => {
      const node = json.nodes.findIndex((n: any) => n.name === name);
      const ch = json.animations[0].channels.find(
        (c: any) => c.target.node === node && c.target.path === 'translation',
      );
      return readAccessor(json, bin, json.animations[0].samplers[ch.sampler].input).length;
    };
    // the zigzag got 3 keys per frame and "'Box' moves on a strongly curved path … 2.4 mm"
    expect(keys('Box')).toBe(41);
    expect(keys('Moon')).toBeGreaterThan(41 * 2);
    expect(res.warnings?.filter((w) => /curved path/.test(w)) ?? []).toEqual([]);
  });

  it('keeps one key per frame for a rigid body bouncing down a slope', () => {
    const { doc, run } = setup();
    doc.updateScene({ frame_start: 1, frame_end: 60 });
    run('mesh.primitive_cube_add', { name: 'Floor', size: 4 });
    run('object.transform_set', { objects: ['Floor'], scale: [1, 1, 0.05], rotation_euler: [0.35, 0, 0] });
    run('rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE' });
    run('mesh.primitive_uv_sphere_add', { name: 'Ball', radius: 0.1, location: [0, 0, 1.5] });
    run('rigidbody.object_add', { objects: ['Ball'], type: 'ACTIVE' });
    run('rigidbody.world_set', { enabled: true, frame_start: 1, frame_end: 60 });
    const res = exportScene(doc, 'glb');
    const { json, bin } = parseGltf(res.data);
    // the simulation is linear between frames: the bounce looked like a tight curve ("chords of up to
    // 19.5 mm") and got 2–4 keys per frame that lay within 3.4e-7 m of the per-frame path
    for (const ch of json.animations[0].channels)
      expect(readAccessor(json, bin, json.animations[0].samplers[ch.sampler].input).length).toBe(60);
    expect(res.warnings?.filter((w) => /curved path/.test(w)) ?? []).toEqual([]);
  });

  it('keeps one key per frame for straight motion', () => {
    const { doc, run } = setup();
    doc.updateScene({ frame_start: 1, frame_end: 24 });
    run('mesh.primitive_cube_add', { name: 'Slider' });
    run('anim.driver_add', { target: 'Slider', path: 'location', index: 0, expression: 'frame * 0.1' });
    const { json, bin } = parseGltf(exportScene(doc, 'glb').data);
    const sampler = json.animations[0].samplers[0];
    expect(readAccessor(json, bin, sampler.input).length).toBe(24);
  });
});
