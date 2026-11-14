import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import type { RunResult } from '../src/operators/registry';
import { FrameState } from '../src/eval/frame-state';
import { estimateOperator } from '../src/operators/memory';
import { STORE_MODEL_MAX_MATERIALS, STORE_MODEL_MAX_OBJECTS } from '../src/operators/memory-desk';
import { STORE_CATEGORIES, type CatalogEntry } from '../src/store';
import { BUILTIN_MODELS } from '../src/store/builtin';
import { NATURE_MODELS } from '../src/store/builtin/nature';
import { ARCHITECTURE_MODELS, STORE_PART_PROP, sizeScale } from '../src/store/builtin/architecture';
import { STREET_MODELS } from '../src/store/builtin/street';
import { OUTDOOR_MODELS } from '../src/store/builtin/outdoor';
import { VEHICLE_MODELS } from '../src/store/builtin/vehicles';
import { SPORTS_MODELS } from '../src/store/builtin/sports';
import { vehicleRig } from '../src/desk/physics/vehicle';
import { invert4 } from '../src/math/mat4';
import type { Mat4, Vec3 } from '../src/math/types';
import type { ObjectData } from '../src/doc/types';

/*
 * The CATALOG-B built-in models (nature, architecture, street, outdoor, vehicles, sports): each builds
 * through store.add into a fresh document without warnings, stands with its base centre on the
 * location asked for at its declared size and triangle count, and names its parts; vehicles follow
 * the vehicle contract (hub-origin wheels spinning about X under steering pivots, saddles), the kite
 * and the balloon carry what desk.tether_fly ties onto, and the build options (size, colour,
 * parameters) work.
 */

const MINE: CatalogEntry[] = [
  ...NATURE_MODELS,
  ...ARCHITECTURE_MODELS,
  ...STREET_MODELS,
  ...OUTDOOR_MODELS,
  ...VEHICLE_MODELS,
  ...SPORTS_MODELS,
];
const byId = (id: string) => MINE.find((e) => e.id === id)!;

/** Models whose origin is their own (a pole's foot, a trunk's base) rather than the bounds' centre. */
const ORIGIN_ANCHORED = new Set([
  'oak_tree',
  'pine_tree',
  'palm_tree',
  'streetlight',
  'traffic_light',
  'stop_sign',
  'signpost',
  'diamond_kite',
]);
/** Boats float with z = 0 at their waterline: their base (the keel) lies this far below. */
const DRAFT: Record<string, number> = { rowboat: 0.12, sailboat: 1.25 };

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (id: string, p: unknown) => reg.run(ctx, id, p) as RunResult<any> & { result: any };
  return { doc, reg, ctx, reports, run };
}

const transform = (m: Readonly<Mat4>, p: readonly number[]): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/** World bounds and triangles of the mesh objects among `ids` (frame 1). */
function measure(doc: SceneDoc, ids: readonly string[]) {
  const fs = new FrameState(doc, 1);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  for (const id of ids) {
    const o = doc.getObject(id)!;
    if (o.type !== 'MESH') continue;
    const mesh = doc.getMesh(o.data!)!;
    for (const f of mesh.faces) triangles += f.length - 2;
    const m = fs.world(id)!;
    const P = mesh.positions;
    for (let i = 0; i < P.length; i += 3) {
      const w = transform(m, [P[i], P[i + 1], P[i + 2]]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], w[k]);
        max[k] = Math.max(max[k], w[k]);
      }
    }
  }
  return { fs, min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) as Vec3, triangles };
}

/** The objects of a build by their part name (store_part). */
function parts(doc: SceneDoc, objects: readonly string[]): Map<string, ObjectData> {
  const out = new Map<string, ObjectData>();
  for (const id of objects.slice(1)) {
    const o = doc.getObject(id)!;
    out.set(String(o.custom_props[STORE_PART_PROP]), o);
  }
  return out;
}

/** Local bounds of a mesh object's data. */
function localBounds(doc: SceneDoc, o: ObjectData) {
  const P = doc.getMesh(o.data!)!.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], P[i + k]);
      max[k] = Math.max(max[k], P[i + k]);
    }
  return { min, max };
}

/** A hash of every mesh position and face of a build (determinism). */
function fingerprint(doc: SceneDoc, objects: readonly string[]): string {
  let h = 0;
  for (const id of objects) {
    const o = doc.getObject(id)!;
    const parts = [...o.location, ...o.rotation_euler];
    if (o.type === 'MESH') {
      const mesh = doc.getMesh(o.data!)!;
      parts.push(...mesh.positions, ...mesh.faces.flat());
    }
    for (const v of parts) h = (Math.imul(h, 31) + Math.round(v * 1e6)) | 0;
  }
  return h.toString(16);
}

describe('CATALOG-B built-in models: catalog data', () => {
  it('declare unique snake_case ids, valid categories, rigs and real data', () => {
    const ids = new Set<string>();
    for (const e of MINE) {
      expect(e.id, e.id).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
      expect(ids.has(e.id), `duplicate ${e.id}`).toBe(false);
      ids.add(e.id);
      expect(STORE_CATEGORIES).toContain(e.category);
      expect(e.name.length, e.id).toBeGreaterThan(2);
      expect(e.description.length, e.id).toBeGreaterThan(20);
      expect(e.tags.length, e.id).toBeGreaterThan(2);
      expect(e.synonyms.length, e.id).toBeGreaterThan(2);
      expect(e.rig, e.id).toBe(VEHICLE_MODELS.includes(e) ? 'vehicle' : null);
      expect(e.dimensions_m.every((v) => v > 0)).toBe(true);
      // low/mid poly (a few flat pieces such as a road slab need fewer than 100)
      expect(e.triangles, e.id).toBeGreaterThan(40);
      expect(e.triangles, e.id).toBeLessThanOrEqual(5000);
    }
    expect(MINE.length).toBeGreaterThanOrEqual(85);
    for (const list of [
      NATURE_MODELS,
      ARCHITECTURE_MODELS,
      STREET_MODELS,
      OUTDOOR_MODELS,
      VEHICLE_MODELS,
      SPORTS_MODELS,
    ])
      expect(list.length).toBeGreaterThanOrEqual(10);
  });

  it('are in the assembled catalog, with ids no other list uses', () => {
    for (const e of MINE)
      expect(
        BUILTIN_MODELS.filter((b) => b.id === e.id),
        e.id,
      ).toEqual([e]);
  });

  it('cover the asked-for models', () => {
    const want = [
      'oak_tree',
      'pine_tree',
      'palm_tree',
      'bush',
      'rock',
      'boulder',
      'grass_tuft',
      'flower_bed',
      'hill',
      'mountain_backdrop',
      'lake',
      'sea',
      'sand_dune',
      'log',
      'tree_stump',
      'reeds',
      'house',
      'cottage',
      'log_cabin',
      'barn',
      'stable',
      'storefront',
      'beach_hut',
      'lifeguard_tower',
      'footbridge',
      'pier',
      'brick_wall',
      'stone_wall',
      'room',
      'door',
      'window',
      'gate',
      'stairs',
      'column',
      'arch',
      'picket_fence',
      'apartment_building',
      'road',
      'road_corner',
      'sidewalk',
      'streetlight',
      'traffic_light',
      'traffic_cone',
      'stop_sign',
      'mailbox',
      'fire_hydrant',
      'bus_stop',
      'park_bench',
      'picnic_table',
      'fountain',
      'signpost',
      'trash_bin',
      'beach_umbrella',
      'beach_lounger',
      'tent',
      'campfire',
      'hay_bale',
      'haystack',
      'water_trough',
      'well',
      'swing_set',
      'slide',
      'sandcastle',
      'bucket_and_spade',
      'sedan',
      'hatchback',
      'suv',
      'pickup_truck',
      'van',
      'bus',
      'bicycle',
      'motorcycle',
      'rowboat',
      'sailboat',
      'soccer_ball',
      'basketball',
      'beach_ball',
      'tennis_ball',
      'diamond_kite',
      'kite_spool',
      'frisbee',
      'skateboard',
      'surfboard',
      'balloon',
    ];
    const have = new Set(MINE.map((e) => e.id));
    expect(want.filter((id) => !have.has(id))).toEqual([]);
  });
});

describe('CATALOG-B built-in models: builds', () => {
  it.each(MINE.map((e) => [e.id, e] as const))(
    '%s builds at the location asked for, at its declared size and triangle count',
    (_id, e) => {
      const t = setup();
      const location: Vec3 = [1.5, -2, 0.25];
      const res = t.run('store.add', { model: e.id, location });
      expect(res.ok, res.error).toBe(true);
      expect(t.reports.filter((r) => r.level !== 'INFO')).toEqual([]);
      const { root, objects } = res.result;
      const r = t.doc.getObject(root)!;
      expect(r.type).toBe('EMPTY');
      expect(r.name).toBe(e.name);
      expect(r.location).toEqual(location);
      expect(r.custom_props).toMatchObject({
        store_id: `builtin:${e.id}`,
        store_source: 'builtin',
        license: 'CC0-1.0',
        author: '3D Editor built-in',
      });
      expect(objects[0]).toBe(root);
      expect(objects.length).toBeGreaterThan(1);
      expect(objects.length).toBeLessThanOrEqual(STORE_MODEL_MAX_OBJECTS);
      expect(new Set(objects).size).toBe(objects.length);
      const names = new Set<string>();
      for (const id of objects.slice(1)) {
        const o = t.doc.getObject(id)!;
        expect(t.doc.isAncestor(root, id)).toBe(true);
        expect(['MESH', 'EMPTY']).toContain(o.type);
        const part = o.custom_props[STORE_PART_PROP];
        expect(typeof part).toBe('string');
        expect(names.has(part as string), `${e.id}: part ${part} twice`).toBe(false);
        names.add(part as string);
        if (o.type !== 'MESH') continue;
        // a valid mesh: finite positions, real faces, a material in every slot the faces use
        const mesh = t.doc.getMesh(o.data!)!;
        expect(mesh.positions.every(Number.isFinite), `${e.id}/${o.name}`).toBe(true);
        const nv = mesh.positions.length / 3;
        expect(mesh.faces.every((f) => f.length >= 3 && f.every((v) => v >= 0 && v < nv))).toBe(true);
        const slots = Math.max(...mesh.faces.map((_, f) => mesh.faceMaterials[f] ?? 0)) + 1;
        expect(o.material_slots.length, `${e.id}/${o.name}`).toBeGreaterThanOrEqual(slots);
        expect(o.material_slots.every((m) => m && t.doc.getMaterial(m))).toBe(true);
      }
      expect(names.size).toBeGreaterThan(0);
      const m = measure(t.doc, objects);
      // the base on its ground (boats: their keel below the waterline at the location)
      expect(Math.abs(m.min[2] - (location[2] - (DRAFT[e.id] ?? 0))), `${e.id} base`).toBeLessThan(0.003);
      if (ORIGIN_ANCHORED.has(e.id)) {
        // the origin (the foot of the pole or trunk) lies inside the bounds
        for (const k of [0, 1]) {
          expect(location[k]).toBeGreaterThan(m.min[k]);
          expect(location[k]).toBeLessThan(m.max[k]);
        }
      } else {
        expect((m.min[0] + m.max[0]) / 2).toBeCloseTo(location[0], 4);
        expect((m.min[1] + m.max[1]) / 2).toBeCloseTo(location[1], 4);
      }
      for (let k = 0; k < 3; k++)
        expect(Math.abs(m.size[k] / e.dimensions_m[k] - 1), `${e.id} axis ${k}`).toBeLessThan(0.1);
      expect(Math.abs(m.triangles / e.triangles - 1), e.id).toBeLessThan(0.1);
      expect(res.result.dimensions_m.map((v: number, k: number) => Math.abs(v - m.size[k]) < 1e-3)).toEqual([
        true,
        true,
        true,
      ]);
      // the store.add memory estimate covers what the model adds
      const est = estimateOperator('store.add', t.ctx, t.reg.parseParams('store.add', { model: e.id }))!;
      expect(est.faces).toBeGreaterThanOrEqual(m.triangles);
      expect(est.objects).toBeGreaterThanOrEqual(objects.length);
      expect(t.doc.listMaterials().length).toBeLessThanOrEqual(STORE_MODEL_MAX_MATERIALS);
    },
  );

  it('are deterministic: the same build twice, seeds change the seeded ones', () => {
    for (const e of [
      byId('oak_tree'),
      byId('sedan'),
      byId('stone_wall'),
      byId('soccer_ball'),
      byId('diamond_kite'),
    ]) {
      const a = SceneDoc.create({ empty: true });
      const b = SceneDoc.create({ empty: true });
      expect(fingerprint(a, e.build(a, {}).objects), e.id).toBe(fingerprint(b, e.build(b, {}).objects));
    }
    for (const id of ['rock', 'mountain_backdrop', 'stone_wall', 'oak_tree']) {
      const e = byId(id);
      const a = SceneDoc.create({ empty: true });
      const b = SceneDoc.create({ empty: true });
      const fa = fingerprint(a, e.build(a, { params: { seed: 1 } }).objects);
      expect(fingerprint(b, e.build(b, { params: { seed: 2 } }).objects), id).not.toBe(fa);
    }
  });
});

describe('CATALOG-B built-in models: options', () => {
  it('scale to a requested size, turn about Z and take a name', () => {
    const t = setup();
    const [w, d, h] = byId('van').dimensions_m;
    const tall = t.run('store.add', { model: 'van', height_m: h * 1.5 }).result;
    const s = measure(t.doc, tall.objects).size;
    expect(s[2]).toBeCloseTo(h * 1.5, 3);
    expect(s[0] / s[1]).toBeCloseTo(w / d, 2);
    const turned = t.run('store.add', { model: 'bus', rotation_deg: 90, name: 'Line 12' }).result;
    const s2 = measure(t.doc, turned.objects).size;
    const [bw, bd] = byId('bus').dimensions_m;
    expect(s2[0]).toBeCloseTo(bd, 2);
    expect(s2[1]).toBeCloseTo(bw, 2);
    expect(t.doc.getObject(turned.root)!.name).toBe('Line 12');
    // the kit's size rule: given axes set their own scale, the others follow their geometric mean
    expect(sizeScale([2, 4, 1], { width_m: 4, depth_m: 2 })).toEqual([2, 0.5, 1]);
    expect(sizeScale([2, 4, 1], { scale: 3 })).toEqual([3, 3, 3]);
  });

  it('recolour only the main material, named after the colour and shared by copies', () => {
    const t = setup();
    t.run('store.add', { model: 'sedan' });
    const before = t.doc.listMaterials().length;
    t.run('store.add', { model: 'sedan' });
    expect(t.doc.listMaterials().length).toBe(before);
    const green = t.run('store.add', { model: 'sedan', color: '#00FF00' }).result;
    const body = parts(t.doc, green.objects).get('body')!;
    const paint = t.doc.getMaterial(body.material_slots[0]!)!;
    expect(paint.name).toBe('Sedan Paint #00ff00');
    expect(paint.base_color[1]).toBeCloseTo(1, 5);
    expect(paint.base_color[0]).toBeCloseTo(0, 5);
    // one new material: the glass, trim and wheels stay shared
    expect(t.doc.listMaterials().length).toBe(before + 1);
    const wheel = parts(t.doc, green.objects).get('wheel.FL')!;
    expect(t.doc.getMaterial(wheel.material_slots[0]!)!.name).toBe('Tyre Rubber');
  });

  it('check their parameters', () => {
    const t = setup();
    for (const [model, params] of [
      ['sedan', { doors: 2 }],
      ['hay_bale', { shape: 'triangle' }],
      ['road', { lanes: 0 }],
      ['rowboat', { oars: 'up' }],
      ['lake', { width: -3 }],
    ] as const) {
      const r = t.run('store.add', { model, params });
      expect(r.ok, `${model} ${JSON.stringify(params)}`).toBe(false);
      expect(r.error).toMatch(/param/i);
    }
    expect(t.doc.listObjects()).toEqual([]);
    // and use them
    const shipped = measure(t.doc, t.run('store.add', { model: 'rowboat' }).result.objects).size;
    const out = measure(
      t.doc,
      t.run('store.add', { model: 'rowboat', params: { oars: 'out' } }).result.objects,
    ).size;
    expect(out[0]).toBeGreaterThan(shipped[0] * 2.5);
    const lake = measure(
      t.doc,
      t.run('store.add', { model: 'lake', params: { width: 30, depth: 20 } }).result.objects,
    );
    expect(lake.size[0]).toBeGreaterThan(30);
    expect(lake.size[0]).toBeLessThan(34);
    const road = measure(
      t.doc,
      t.run('store.add', { model: 'road', params: { length: 25, lanes: 4 } }).result.objects,
    );
    expect(road.size[1]).toBeCloseTo(25, 3);
    expect(road.size[0]).toBeCloseTo(14, 3);
  });

  it('keep part names in store_part when a document holds two copies', () => {
    const t = setup();
    t.run('store.add', { model: 'bicycle' });
    const second = t.run('store.add', { model: 'bicycle' }).result;
    const p = parts(t.doc, second.objects);
    expect(p.get('wheel.F')!.name).toBe('wheel.F.001');
    expect([...p.keys()]).toEqual(
      expect.arrayContaining(['body', 'wheel.F', 'wheel.B', 'steer.F', 'saddle']),
    );
  });
});

describe('CATALOG-B vehicles: the vehicle contract', () => {
  const WHEELED: Record<string, { wheels: string[]; steer: string[] }> = {
    sedan: { wheels: ['wheel.FL', 'wheel.FR', 'wheel.BL', 'wheel.BR'], steer: ['steer.FL', 'steer.FR'] },
    hatchback: { wheels: ['wheel.FL', 'wheel.FR', 'wheel.BL', 'wheel.BR'], steer: ['steer.FL', 'steer.FR'] },
    suv: { wheels: ['wheel.FL', 'wheel.FR', 'wheel.BL', 'wheel.BR'], steer: ['steer.FL', 'steer.FR'] },
    pickup_truck: {
      wheels: ['wheel.FL', 'wheel.FR', 'wheel.BL', 'wheel.BR'],
      steer: ['steer.FL', 'steer.FR'],
    },
    van: { wheels: ['wheel.FL', 'wheel.FR', 'wheel.BL', 'wheel.BR'], steer: ['steer.FL', 'steer.FR'] },
    bus: { wheels: ['wheel.FL', 'wheel.FR', 'wheel.BL', 'wheel.BR'], steer: ['steer.FL', 'steer.FR'] },
    bicycle: { wheels: ['wheel.F', 'wheel.B'], steer: ['steer.F'] },
    motorcycle: { wheels: ['wheel.F', 'wheel.B'], steer: ['steer.F'] },
  };

  it('every vehicle is a body under an EMPTY root; riders sit on saddles', () => {
    for (const e of VEHICLE_MODELS) {
      const t = setup();
      const res = e.build(t.doc, {});
      const p = parts(t.doc, res.objects);
      expect(t.doc.getObject(res.root)!.type).toBe('EMPTY');
      expect(p.get('body')?.type, e.id).toBe('MESH');
      expect(p.get('body')!.parent).toBe(res.root);
      if (['bicycle', 'motorcycle', 'rowboat', 'sailboat'].includes(e.id))
        expect(p.get('saddle')?.type, e.id).toBe('EMPTY');
    }
  });

  it.each(Object.entries(WHEELED))(
    '%s: hub-origin wheels rolling about X under steering pivots',
    (id, want) => {
      const t = setup();
      const location: Vec3 = [3, 4, 0.5];
      const res = byId(id).build(t.doc, { location, rotation_deg: 30 });
      const p = parts(t.doc, res.objects);
      const fs = new FrameState(t.doc, 1);
      const root = t.doc.getObject(res.root)!;
      const rootWorld = fs.world(res.root)!;
      for (const name of want.wheels) {
        const w = p.get(name)!;
        expect(w?.type, `${id} ${name}`).toBe('MESH');
        // the origin is the hub: the centre of the wheel's own bounds, round about X
        const b = localBounds(t.doc, w);
        for (let k = 0; k < 3; k++)
          expect(Math.abs((b.min[k] + b.max[k]) / 2), `${id} ${name} axis ${k}`).toBeLessThan(1e-3);
        const radius = (b.max[2] - b.min[2]) / 2;
        expect((b.max[1] - b.min[1]) / 2).toBeCloseTo(radius, 3);
        expect(b.max[0] - b.min[0]).toBeLessThan(radius);
        // the hub at the wheel's radius above the ground, the wheel's X along the vehicle's X
        const world = fs.world(w.id)!;
        expect(world[14] - radius).toBeCloseTo(location[2], 2);
        const x: Vec3 = [world[0], world[1], world[2]];
        const rx: Vec3 = [rootWorld[0], rootWorld[1], rootWorld[2]];
        expect(x[0] * rx[0] + x[1] * rx[1] + x[2] * rx[2]).toBeCloseTo(1, 6);
        // front wheels hang from a steering pivot, rear wheels from the root
        const front = /^wheel\.F/.test(name);
        const parent = t.doc.getObject(w.parent!)!;
        if (front) expect(want.steer).toContain(parent.custom_props[STORE_PART_PROP]);
        else expect(w.parent).toBe(res.root);
      }
      for (const name of want.steer) expect(p.get(name)?.type, `${id} ${name}`).toBe('EMPTY');
      // the own left (+X) wheels are on +X, the front ones toward −Y
      if (want.wheels.length === 4) {
        const inRoot = (name: string) =>
          transform(invert4(rootWorld), [
            fs.world(p.get(name)!.id)![12],
            fs.world(p.get(name)!.id)![13],
            fs.world(p.get(name)!.id)![14],
          ]);
        expect(inRoot('wheel.FL')[0]).toBeGreaterThan(0);
        expect(inRoot('wheel.FR')[0]).toBeLessThan(0);
        expect(inRoot('wheel.FL')[1]).toBeLessThan(inRoot('wheel.BL')[1]);
      }
      // desk.vehicle_drive reads the same rig
      const rig = vehicleRig(t.doc, fs, root);
      expect(rig.wheels.length).toBe(want.wheels.length);
      expect(rig.wheels.every((w) => w.sign === 1)).toBe(true);
      expect(rig.wheels.filter((w) => w.front).length).toBe(want.wheels.length / 2);
      expect(rig.steering.length).toBe(want.steer.length);
      expect(rig.wheelbase).toBeGreaterThan(0.8);
    },
  );

  it('bicycle and motorcycle steer about their raked head tube', () => {
    for (const id of ['bicycle', 'motorcycle']) {
      const t = setup();
      const res = byId(id).build(t.doc, {});
      const p = parts(t.doc, res.objects);
      const fs = new FrameState(t.doc, 1);
      const steer = fs.world(p.get('steer.F')!.id)!;
      // the steering axis (the pivot's Z) leans back (+Y) from vertical by the rake
      const rake = Math.atan2(steer[9], steer[10]);
      expect(rake, id).toBeGreaterThan(0.2);
      expect(rake, id).toBeLessThan(0.5);
      // the fork, front wheel (and handlebar) turn with the pivot
      expect(p.get('wheel.F')!.parent).toBe(p.get('steer.F')!.id);
      expect(p.get('fork')!.parent).toBe(p.get('steer.F')!.id);
      // steering 30° about the axis moves the front wheel's hub only a little (it lies near the axis)
      const hub0 = fs.world(p.get('wheel.F')!.id)!;
      t.doc.updateObject(p.get('steer.F')!.id, { rotation_euler: [0, 0, Math.PI / 6] });
      const hub1 = new FrameState(t.doc, 1).world(p.get('wheel.F')!.id)!;
      expect(Math.hypot(hub1[12] - hub0[12], hub1[13] - hub0[13], hub1[14] - hub0[14])).toBeLessThan(0.06);
    }
  });

  it('boats float on their waterline and the rower faces aft', () => {
    for (const id of ['rowboat', 'sailboat']) {
      const t = setup();
      const res = byId(id).build(t.doc, {});
      const m = measure(t.doc, res.objects);
      expect(m.min[2]).toBeCloseTo(-DRAFT[id], 3);
      expect(m.max[2]).toBeGreaterThan(0.4);
    }
    const t = setup();
    const res = byId('rowboat').build(t.doc, {});
    const p = parts(t.doc, res.objects);
    expect(p.get('saddle')!.rotation_euler[2]).toBeCloseTo(Math.PI, 9);
    expect(p.get('saddle.2')!.rotation_euler[2]).toBe(0);
    for (const oar of ['oar.L', 'oar.R']) expect(p.get(oar)?.type).toBe('MESH');
    const sail = parts(t.doc, byId('sailboat').build(t.doc, {}).objects);
    // the mainsail swings with the boom about the mast
    expect(sail.get('mainsail')!.parent).toBe(sail.get('boom')!.id);
    expect(sail.get('rudder')?.type).toBe('MESH');
  });
});

describe('CATALOG-B tethered flyers and attachment points', () => {
  it('the kite faces −Y nose up with a bridle in front and a tail hanging from its bottom tip', () => {
    const t = setup();
    const res = byId('diamond_kite').build(t.doc, {});
    const p = parts(t.doc, res.objects);
    const fs = new FrameState(t.doc, 1);
    const sail = localBounds(t.doc, p.get('sail')!);
    expect(sail.max[1] - sail.min[1]).toBeLessThan(0.01);
    const bridle = p.get('bridle')!;
    expect(bridle.type).toBe('EMPTY');
    const bw = fs.world(bridle.id)!;
    expect(bw[13]).toBeLessThan(-0.1);
    expect(bw[14]).toBeGreaterThan(sail.min[2]);
    expect(bw[14]).toBeLessThan(sail.max[2]);
    // tail.1 … tail.5: an empty at the bottom tip, then segments hanging straight down, evenly
    const tail = ['tail.1', 'tail.2', 'tail.3', 'tail.4', 'tail.5'].map((n) => p.get(n)!);
    expect(tail.every(Boolean)).toBe(true);
    expect(tail[0].type).toBe('EMPTY');
    expect(fs.world(tail[0].id)![14]).toBeCloseTo(sail.min[2], 6);
    const z = tail.map((o) => fs.world(o.id)![14]);
    const gaps = z.slice(1).map((v, i) => z[i] - v);
    expect(gaps.every((g) => Math.abs(g - gaps[0]) < 1e-9 && g > 0.2)).toBe(true);
    // each segment reaches from its origin up to the node before it
    for (const o of tail.slice(1)) {
      expect(o.type).toBe('MESH');
      const b = localBounds(t.doc, o);
      expect(b.max[2]).toBeCloseTo(gaps[0], 6);
    }
    // the base of the model is the tail's end
    expect(measure(t.doc, res.objects).min[2]).toBeCloseTo(0, 6);
  });

  it('the balloon ties on at its knot; the spool lets its line out at the top', () => {
    const t = setup();
    const location: Vec3 = [1, 2, 3];
    const res = byId('balloon').build(t.doc, { location });
    const p = parts(t.doc, res.objects);
    const fs = new FrameState(t.doc, 1);
    const knot = fs.world(p.get('string_point')!.id)!;
    expect(
      [knot[12], knot[13], knot[14]].map((v, k) => v - location[k]).every((v) => Math.abs(v) < 1e-9),
    ).toBe(true);
    expect(measure(t.doc, res.objects).min[2]).toBeCloseTo(location[2], 6);
    const spool = byId('kite_spool').build(t.doc, {});
    const sp = parts(t.doc, spool.objects);
    const line = new FrameState(t.doc, 1).world(sp.get('string_point')!.id)!;
    expect(line[14]).toBeGreaterThan(0.1);
  });

  it('water lies in parts named water', () => {
    for (const id of ['lake', 'sea', 'fountain', 'water_trough', 'well']) {
      const t = setup();
      const res = byId(id).build(t.doc, {});
      const water = parts(t.doc, res.objects).get('water');
      expect(water?.type, id).toBe('MESH');
    }
  });

  it('trees and poles keep their own origin at the foot of the trunk or pole', () => {
    const t = setup();
    for (const id of ['oak_tree', 'streetlight', 'stop_sign']) {
      const res = byId(id).build(t.doc, {});
      for (const pid of res.objects.slice(1)) {
        const o = t.doc.getObject(pid)!;
        expect(o.location[0], id).toBe(0);
        expect(o.location[1], id).toBe(0);
      }
    }
  });
});
