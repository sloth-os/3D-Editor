import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  transformPoint3,
  type Mat4,
  type OperatorContext,
  type Vec3,
} from '../src';
import { MAX_LAYOUT_OBJECTS } from '../src/operators/scene-tools';

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
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    expect(JSON.parse(JSON.stringify(r.result ?? null))).toEqual(r.result ?? null);
    return r.result;
  };
  const cube = (name: string, size: number, location: number[], rotation?: number[]) =>
    ok('mesh.primitive_cube_add', { name, size, location, rotation }).object as string;
  const undo = () =>
    new Y.UndoManager(doc.sharedTypes(), { trackedOrigins: new Set([doc.origin]), captureTimeout: 0 });
  /** Evaluated world matrix and world bounds of an object. */
  const world = (id: string) => {
    const ev = new SceneEvaluator(doc).evaluate(ctx.state.frame).byId.get(id)!;
    const m = ev.worldMatrix;
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    const P = ev.mesh?.positions ?? [0, 0, 0];
    for (let i = 0; i < P.length; i += 3) {
      const q = transformPoint3(m, [P[i], P[i + 1], P[i + 2]]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], q[k]);
        max[k] = Math.max(max[k], q[k]);
      }
    }
    return { m, min, max, origin: [m[12], m[13], m[14]] as Vec3, points: P, ev };
  };
  return { doc, reg, ctx, run, ok, cube, undo, world, reports };
}

function expectVec(a: readonly number[], b: readonly number[], digits = 6) {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v, `component ${i}`).toBeCloseTo(b[i], digits));
}

function axis(m: Mat4, k: number): Vec3 {
  const l = Math.hypot(m[k * 4], m[k * 4 + 1], m[k * 4 + 2]);
  return [m[k * 4] / l, m[k * 4 + 1] / l, m[k * 4 + 2] / l];
}

describe('scene tool catalogue', () => {
  it('registers documented Layout tools and read-only Scene queries', () => {
    const { reg } = setup();
    const layout = [
      'object.align',
      'object.distribute',
      'object.drop_to_ground',
      'object.snap_to_surface',
      'object.look_at',
      'object.randomize_transform',
      'object.array_place',
      'object.scatter_on_surface',
      'object.dimensions_set',
    ];
    const queries = ['scene.measure', 'scene.raycast', 'scene.stats'];
    const infos = new Map(reg.describe().map((d) => [d.id, d]));
    for (const id of [...layout, ...queries]) {
      const info = infos.get(id)!;
      expect(info, id).toBeTruthy();
      expect(info.category).toBe(layout.includes(id) ? 'Layout' : 'Scene');
      expect(info.description.length).toBeGreaterThan(150);
      expect(reg.get(id)!.undo).toBe(queries.includes(id) ? false : undefined);
      const props = (info.parameters as { properties: Record<string, { description?: string }> }).properties;
      for (const [name, prop] of Object.entries(props))
        expect(prop.description, `${id}.${name}`).toBeTruthy();
    }
    // mesh.separate already exists (Edit Mode) and is not duplicated
    expect(reg.list().filter((o) => o.id === 'mesh.separate')).toHaveLength(1);
  });
});

describe('object.align', () => {
  it('aligns the MIN / CENTER / MAX sides of world bounding boxes to the world origin', () => {
    const t = setup();
    const a = t.cube('A', 1, [3, 0, 0]);
    const b = t.cube('B', 2, [-4, 1, 0]);
    t.ok('object.align', { objects: [a, b], axis: ['X'], mode: 'MIN', relative_to: 'WORLD' });
    expect(t.world(a).min[0]).toBeCloseTo(0, 9);
    expect(t.world(b).min[0]).toBeCloseTo(0, 9);
    expect(t.world(b).origin[1]).toBeCloseTo(1, 9); // other axes untouched
    t.ok('object.align', { objects: [a, b], axis: ['X', 'Y'], mode: 'MAX', relative_to: 'WORLD' });
    expectVec(t.world(a).max.slice(0, 2), [0, 0]);
    expectVec(t.world(b).max.slice(0, 2), [0, 0]);
    const r = t.ok('object.align', { objects: [a, b], axis: ['Z'], mode: 'CENTER', relative_to: 'CURSOR' });
    expect(r.objects).toHaveLength(2);
    t.ctx.state.cursorLocation = [0, 0, 7];
    t.ok('object.align', { objects: [a, b], axis: ['Z'], relative_to: 'CURSOR' });
    expect(t.world(a).origin[2]).toBeCloseTo(7, 9);
    expect(t.world(b).origin[2]).toBeCloseTo(7, 9);
  });

  it('aligns to the selection box and to the active object (which stays put)', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 2, [5, 0, 3]);
    const c = t.cube('C', 4, [10, 0, -1]);
    t.ok('object.select', { objects: [a, b, c] });
    t.ok('object.align', { axis: ['Z'], mode: 'MAX', relative_to: 'SELECTION' });
    for (const id of [a, b, c]) expect(t.world(id).max[2]).toBeCloseTo(4, 9);
    t.ctx.state.activeId = b;
    t.ok('object.align', { axis: ['Z'], mode: 'MIN' });
    for (const id of [a, b, c]) expect(t.world(id).min[2]).toBeCloseTo(t.world(b).min[2], 9);
    expect(t.world(b).max[2]).toBeCloseTo(4, 9);
    t.ok('object.align', { axis: ['X'], mode: 'CENTER', relative_to: 'ACTIVE', active: 'C' });
    for (const id of [a, b, c]) expect(t.world(id).origin[0]).toBeCloseTo(10, 9);
    t.ctx.state.activeId = null;
    expect(t.run('object.align', { objects: [a, b], relative_to: 'ACTIVE' }).error).toMatch(/active object/);
  });

  it('uses rotated geometry bounds, or origins with use_bounds=false', () => {
    const t = setup();
    const a = t.cube('A', 2, [3, 0, 0], [0, 0, Math.PI / 4]);
    t.ok('object.align', { objects: [a], axis: ['X'], mode: 'MIN', relative_to: 'WORLD' });
    expect(t.world(a).origin[0]).toBeCloseTo(Math.SQRT2, 6);
    t.ok('object.align', { objects: [a], axis: ['X'], mode: 'MIN', relative_to: 'WORLD', use_bounds: false });
    expect(t.world(a).origin[0]).toBeCloseTo(0, 9);
  });

  it('aligns a parent and its child together (the child is not moved twice)', () => {
    const t = setup();
    const p = t.cube('Parent', 1, [2, 0, 0]);
    const c = t.cube('Child', 1, [1, 0, 0]);
    t.doc.updateObject(c, { parent: p }); // child world x = 3
    t.doc.updateObject(p, { scale: [2, 2, 2] }); // child world x = 2 + 2 = 4, size 2
    t.ok('object.align', { objects: [c, p], axis: ['X'], mode: 'MIN', relative_to: 'WORLD' });
    expect(t.world(p).min[0]).toBeCloseTo(0, 9);
    expect(t.world(c).min[0]).toBeCloseTo(0, 9);
  });

  it('is one undo step', () => {
    const t = setup();
    const a = t.cube('A', 1, [3, 2, 1]);
    const um = t.undo();
    t.ok('object.align', { objects: [a], axis: ['X', 'Y', 'Z'], relative_to: 'WORLD' });
    expectVec(t.doc.getObject(a)!.location, [0, 0, 0]);
    um.undo();
    expectVec(t.doc.getObject(a)!.location, [3, 2, 1]);
  });
});

describe('object.distribute', () => {
  it('EVEN: equal gaps between bounding boxes, the extremes stay', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 2, [1.5, 0, 0]);
    const c = t.cube('C', 1, [10, 0, 0]);
    const r = t.ok('object.distribute', { objects: [c, b, a], axis: 'X' });
    expect(r.objects.map((o: { name: string }) => o.name)).toEqual(['A', 'B', 'C']);
    expect(r.gap).toBeCloseTo((10.5 - -0.5 - 4) / 2, 9);
    expect(t.world(a).origin[0]).toBeCloseTo(0, 9);
    expect(t.world(c).origin[0]).toBeCloseTo(10, 9);
    expect(t.world(b).min[0] - t.world(a).max[0]).toBeCloseTo(t.world(c).min[0] - t.world(b).max[0], 9);
  });

  it('GAP: fixed spacing from the first object; origins with use_bounds=false', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 2, [0, 7, 0]);
    const c = t.cube('C', 1, [0, 3, 0]);
    t.ok('object.distribute', { objects: [a, b, c], axis: 'Y', mode: 'GAP', gap: 0.25 });
    expect(t.world(c).min[1]).toBeCloseTo(0.75, 9);
    expect(t.world(b).min[1]).toBeCloseTo(0.5 + 0.25 + 1 + 0.25, 9);
    t.ok('object.distribute', { objects: [a, b, c], axis: 'Y', mode: 'GAP', gap: 3, use_bounds: false });
    expectVec([t.world(a).origin[1], t.world(c).origin[1], t.world(b).origin[1]], [0, 3, 6]);
    t.ok('object.distribute', { objects: [a, b, c], axis: 'Y', use_bounds: false });
    expect(t.world(c).origin[1]).toBeCloseTo(3, 9);
    expect(t.run('object.distribute', { objects: [a] }).error).toMatch(/at least two/);
  });

  it('is one undo step', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 1, [1, 0, 0]);
    const c = t.cube('C', 1, [9, 0, 0]);
    const um = t.undo();
    t.ok('object.distribute', { objects: [a, b, c] });
    expect(t.doc.getObject(b)!.location[0]).toBeCloseTo(4.5, 9);
    um.undo();
    expect(t.doc.getObject(b)!.location[0]).toBe(1);
  });
});

describe('object.drop_to_ground', () => {
  it('drops onto the z = 0 plane in an empty scene and lifts objects sunk below it', () => {
    const t = setup();
    const a = t.cube('A', 1, [1, 2, 5]);
    const b = t.cube('B', 2, [4, 0, -0.5]);
    const r = t.ok('object.drop_to_ground', { objects: [a, b] });
    expect(r.objects.map((o: { surface: string }) => o.surface)).toEqual(['ground plane', 'ground plane']);
    expect(t.world(a).min[2]).toBeCloseTo(0, 9);
    expect(t.world(b).min[2]).toBeCloseTo(0, 9);
    expectVec(t.world(a).origin.slice(0, 2), [1, 2]);
    expect(r.objects[0].moved).toBeCloseTo(-4.5, 6);
    expect(r.objects[0].contact[2]).toBe(0);
    expectVec(r.objects[0].normal, [0, 0, 1]);
    const off = t.ok('object.drop_to_ground', { objects: [a], offset: 0.5 });
    expect(off.objects[0].contact[2]).toBe(0); // the surface point; the object floats above it
    expect(t.world(a).min[2]).toBeCloseTo(0.5, 9);
  });

  it('rests on uneven terrain: touching it at the highest point under the footprint without penetrating', () => {
    const t = setup();
    const terrain = t.ok('object.generate_terrain', {
      size: 10,
      subdivisions: 24,
      height: 2,
      seed: 4,
    }).object;
    const box = t.cube('Box', 1.3, [1.1, -0.7, 9]);
    const r = t.ok('object.drop_to_ground', { objects: [box] });
    expect(r.objects[0].surface).toBe('Terrain');
    const bottom = t.world(box).min[2];
    // highest terrain point under the box footprint: terrain vertices inside it and the surface under its corners
    const { min, max } = t.world(box);
    const tw = t.world(terrain);
    let highest = -Infinity;
    for (let i = 0; i < tw.points.length; i += 3) {
      const [x, y, z] = transformPoint3(tw.m, [tw.points[i], tw.points[i + 1], tw.points[i + 2]]);
      if (x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1]) highest = Math.max(highest, z);
    }
    for (const [x, y] of [
      [min[0], min[1]],
      [min[0], max[1]],
      [max[0], min[1]],
      [max[0], max[1]],
    ]) {
      const hit = t.ok('scene.raycast', { origin: [x, y, 50], objects: [terrain] });
      highest = Math.max(highest, hit.point[2]);
    }
    expect(bottom).toBeCloseTo(highest, 5);
  });

  it('aligns to the surface normal, adds an offset and can drop the origin instead', () => {
    const t = setup();
    const slope = t.ok('mesh.primitive_plane_add', { name: 'Slope', size: 20, rotation: [0.3, 0, 0] }).object;
    const box = t.cube('Box', 1, [0, 0, 6]);
    t.ok('object.drop_to_ground', { objects: [box], align_to_normal: true });
    const n: Vec3 = [0, -Math.sin(0.3), Math.cos(0.3)];
    const w = t.world(box);
    expectVec(axis(w.m, 2), n);
    // the whole bottom face lies on the slope: its centre is 0.5 above the plane along the normal
    const o = w.origin;
    expect(o[0] * n[0] + o[1] * n[1] + o[2] * n[2]).toBeCloseTo(0.5, 6);
    expect(t.doc.getObject(slope)!.rotation_euler[0]).toBe(0.3);
    const c = t.cube('C', 1, [3, 3, 4]);
    t.ok('object.drop_to_ground', { objects: [c], surface: [], offset: 0.25 }); // surface [] = default
    // unaligned, the cube rests on the slope with its uphill edge (y = 3.5)
    expect(t.world(c).min[2]).toBeCloseTo(3.5 * Math.tan(0.3) + 0.25, 6);
    const d = t.cube('D', 1, [-2, -2, 4]);
    t.ok('object.drop_to_ground', { objects: [d], use_origin: true });
    expect(t.world(d).origin[2]).toBeCloseTo(-2 * Math.tan(0.3), 6);
  });

  it('only uses the given surfaces, never drops objects onto each other, and reports misses', () => {
    const t = setup();
    const low = t.ok('mesh.primitive_plane_add', { name: 'Low', size: 10, location: [0, 0, -3] }).object;
    t.ok('mesh.primitive_plane_add', { name: 'High', size: 10, location: [0, 0, 1] });
    const a = t.cube('A', 1, [0, 0, 5]);
    const b = t.cube('B', 1, [0, 0, 7]);
    t.ok('object.drop_to_ground', { objects: [a, b], surface: ['Low'] });
    expect(t.world(a).min[2]).toBeCloseTo(-3, 9);
    expect(t.world(b).min[2]).toBeCloseTo(-3, 9);
    expect(low).toBeTruthy();
    const far = t.cube('Far', 1, [50, 50, 5]);
    const r = t.ok('object.drop_to_ground', { objects: [far], ground_plane: false });
    expect(r.objects[0].dropped).toBe(false);
    expect(t.reports.some((x) => x.level === 'WARNING' && /Nothing below/.test(x.message))).toBe(true);
    expectVec(t.doc.getObject(far)!.location, [50, 50, 5]);
  });

  it('drops children of rotated, scaled parents in world space; empties drop their origin', () => {
    const t = setup();
    const parent = t.ok('object.empty_add', {
      location: [0, 0, 3],
      rotation: [0, 0.4, 0.7],
      scale: [2, 1, 0.5],
    }).object;
    const child = t.cube('Child', 1, [0, 0, 0]);
    t.doc.updateObject(child, { parent, location: [1, 1, 4] });
    t.ok('object.drop_to_ground', { objects: [child] });
    expect(t.world(child).min[2]).toBeCloseTo(0, 6);
    expect(t.doc.getObject(child)!.parent).toBe(parent);
    const e = t.ok('object.empty_add', { location: [2, 2, 9] }).object;
    t.ok('object.drop_to_ground', { objects: [e] });
    expect(t.world(e).origin[2]).toBeCloseTo(0, 9);
  });

  it('drops and aligns collection-instance empties by their instanced geometry', () => {
    const t = setup();
    t.ok('collection.create', { name: 'Props' });
    const prop = t.cube('Prop', 1, [0, 0, 2]); // instanced 1.5 m above the empty's origin
    t.ok('object.select', { objects: [prop] });
    t.ok('object.move_to_collection', { collection: 'Props' });
    t.doc.updateObject(prop, { hide_viewport: true });
    const inst = t.ok('object.collection_instance_add', { collection: 'Props', location: [5, 0, 10] }).object;
    const r = t.ok('object.drop_to_ground', { objects: [inst] });
    expect(r.objects[0].moved).toBeCloseTo(-11.5, 6);
    expect(t.world(inst).origin[2]).toBeCloseTo(-1.5, 6);
    const m = t.ok('scene.measure', { objects: [inst] });
    expectVec(m.objects[0].bounds.min, [4.5, -0.5, 0]);
    expect(m.objects[0].has_geometry).toBe(true);
  });

  it('keeps edits of animated objects visible (re-keys the current frame) and is one undo step', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 5]);
    t.ok('object.select', { objects: [a] });
    t.ok('anim.keyframe_insert', { type: 'Location', frame: 1 });
    t.doc.updateObject(a, { location: [0, 0, 9] }); // stored value differs from the keyed one
    const um = t.undo();
    t.ok('object.drop_to_ground', { objects: [a] });
    expect(t.world(a).min[2]).toBeCloseTo(0, 9);
    um.undo();
    expect(t.world(a).origin[2]).toBeCloseTo(5, 9);
  });
});

describe('object.snap_to_surface', () => {
  it('puts the origin (or the bounding box bottom) on the ray hit, with an offset along the normal', () => {
    const t = setup();
    const ground = t.cube('Ground', 4, [0, 0, -2]); // top at z = 0
    const a = t.cube('A', 1, [9, 9, 9]);
    const r = t.ok('object.snap_to_surface', { objects: [a], ray_origin: [1, 0.5, 10] });
    expect(r.hit.name).toBe('Ground');
    expectVec(r.hit.point, [1, 0.5, 0]);
    expectVec(t.world(a).origin, [1, 0.5, 0]);
    t.ok('object.snap_to_surface', {
      objects: [a],
      ray_origin: [1, 0.5, 10],
      snap_point: 'BOTTOM',
      offset: 0.1,
    });
    expect(t.world(a).min[2]).toBeCloseTo(0.1, 9);
    // a side face, hit horizontally: offset goes along that face's normal
    t.ok('object.snap_to_surface', {
      objects: [a],
      ray_origin: [10, 0, -1],
      ray_direction: [-1, 0, 0],
      offset: 0.5,
    });
    expectVec(t.world(a).origin, [2.5, 0, -1]);
    expect(ground).toBeTruthy();
  });

  it('aligns to the normal and moves a group rigidly around the reference object', () => {
    const t = setup();
    t.ok('mesh.primitive_plane_add', {
      name: 'Wall',
      size: 10,
      rotation: [Math.PI / 2, 0, 0],
      location: [0, 5, 0],
    });
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 1, [2, 0, 0]);
    t.ctx.state.activeId = a;
    t.ok('object.snap_to_surface', {
      objects: [a, b],
      ray_origin: [0, -5, 1],
      ray_direction: [0, 1, 0],
      align_to_normal: true,
    });
    const wa = t.world(a);
    expectVec(wa.origin, [0, 5, 1]);
    expectVec(axis(wa.m, 2), [0, -1, 0]); // +Z faces back along the ray (the wall's front side)
    const wb = t.world(b);
    expect(
      Math.hypot(wb.origin[0] - wa.origin[0], wb.origin[1] - wa.origin[1], wb.origin[2] - wa.origin[2]),
    ).toBeCloseTo(2, 6);
    expectVec(axis(wb.m, 2), [0, -1, 0]);
  });

  it('is one undo step', () => {
    const t = setup();
    t.cube('Ground', 4, [0, 0, -2]);
    const a = t.cube('A', 1, [5, 5, 5], [0.2, 0.1, 0]);
    const um = t.undo();
    t.ok('object.snap_to_surface', { objects: [a], ray_origin: [0, 0, 10], align_to_normal: true });
    expectVec(t.world(a).origin, [0, 0, 0]);
    um.undo();
    expectVec(t.doc.getObject(a)!.location, [5, 5, 5]);
    expectVec(t.doc.getObject(a)!.rotation_euler, [0.2, 0.1, 0]);
  });

  it('fails without changes when the ray hits nothing', () => {
    const t = setup();
    const a = t.cube('A', 1, [1, 2, 3]);
    const r = t.run('object.snap_to_surface', { objects: [a], ray_origin: [0, 0, 10] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hit no surface/);
    expectVec(t.doc.getObject(a)!.location, [1, 2, 3]);
    expect(
      t.run('object.snap_to_surface', { objects: [a], ray_origin: [0, 0, 10], ray_direction: [0, 0, 0] })
        .error,
    ).toMatch(/must not be zero/);
  });
});

describe('object.look_at', () => {
  it('points a camera (−Z) at a target object with its up axis towards +Z', () => {
    const t = setup();
    const cam = t.ok('object.camera_add', { location: [10, -4, 3] }).object;
    t.cube('Target', 1, [0, 2, 1]);
    t.ok('object.look_at', { objects: [cam], target: 'Target' });
    const w = t.world(cam);
    const d = [-10, 6, -2].map((v) => v / Math.hypot(10, 6, 2));
    expectVec(
      axis(w.m, 2).map((v) => -v),
      d,
    );
    expect(axis(w.m, 1)[2]).toBeGreaterThan(0);
    expect(Math.abs(axis(w.m, 0)[2])).toBeLessThan(1e-9); // no roll
    expectVec(w.origin, [10, -4, 3]);
  });

  it('supports other track axes, points, keeps scale and handles parents', () => {
    const t = setup();
    const chair = t.cube('Chair', 1, [3, 0, 0]);
    t.doc.updateObject(chair, { scale: [1, 2, 3] });
    t.ok('object.look_at', { objects: [chair], point: [3, 5, 0], track_axis: '-Y' });
    const w = t.world(chair);
    expectVec(axis(w.m, 1), [0, -1, 0]);
    expectVec(axis(w.m, 2), [0, 0, 1]);
    expectVec(t.doc.getObject(chair)!.scale, [1, 2, 3]);
    const parent = t.ok('object.empty_add', { rotation: [0.3, 0.2, 1], scale: [2, 2, 2] }).object;
    const child = t.cube('Child', 1, [0, 0, 0]);
    t.doc.updateObject(child, { parent, location: [1, 0, 0] });
    t.ok('object.look_at', { objects: [child], point: [0, 0, 10], track_axis: 'X' });
    const cw = t.world(child);
    const dir = [0, 0, 10].map((v, k) => v - cw.origin[k]);
    expectVec(
      axis(cw.m, 0),
      dir.map((v) => v / Math.hypot(...dir)),
    );
  });

  it('is one undo step and works on the selection by default', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 1, [4, 0, 0]);
    t.ok('object.select', { objects: [a, b] });
    const um = t.undo();
    const r = t.ok('object.look_at', { point: [2, 10, 0], track_axis: 'Y' });
    expect(r.objects).toHaveLength(2);
    for (const id of [a, b]) {
      const w = t.world(id);
      const dir = [2 - w.origin[0], 10 - w.origin[1], 0];
      expectVec(
        axis(w.m, 1),
        dir.map((v) => v / Math.hypot(...dir)),
      );
    }
    um.undo();
    expectVec(t.doc.getObject(a)!.rotation_euler, [0, 0, 0]);
    expectVec(t.doc.getObject(b)!.rotation_euler, [0, 0, 0]);
  });

  it('validates its inputs', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    expect(t.run('object.look_at', { objects: [a] }).error).toMatch(/target/);
    expect(
      t.run('object.look_at', { objects: [a], point: [1, 0, 0], track_axis: 'Y', up_axis: 'Y' }).error,
    ).toMatch(/different/);
    t.ok('object.look_at', { objects: [a], point: [0, 0, 0] });
    expect(t.reports.some((r) => /at the target point/.test(r.message))).toBe(true);
    expectVec(t.doc.getObject(a)!.rotation_euler, [0, 0, 0]);
  });
});

describe('object.randomize_transform', () => {
  it('follows Blender: offsets within ±loc/±rot, scale × (1 − u); deterministic per seed', () => {
    const t = setup();
    const ids = [0, 1, 2, 3, 4, 5].map((i) => t.cube(`C${i}`, 1, [i, 0, 0]));
    const params = { objects: ids, random_seed: 5, loc: [1, 2, 0], rot: [0, 0, 3], scale: [0.5, 0.5, 0.5] };
    const r1 = t.ok('object.randomize_transform', params);
    for (const [i, o] of r1.objects.entries()) {
      expect(Math.abs(o.location[0] - i)).toBeLessThanOrEqual(1);
      expect(Math.abs(o.location[1])).toBeLessThanOrEqual(2);
      expect(o.location[2]).toBe(0);
      expect(Math.abs(o.rotation_euler[2])).toBeLessThanOrEqual(3);
      expect(o.rotation_euler[0]).toBe(0);
      for (const s of o.scale) {
        expect(s).toBeGreaterThanOrEqual(0.5);
        expect(s).toBeLessThanOrEqual(1.5);
      }
    }
    const t2 = setup();
    const ids2 = [0, 1, 2, 3, 4, 5].map((i) => t2.cube(`C${i}`, 1, [i, 0, 0]));
    const r2 = t2.ok('object.randomize_transform', { ...params, objects: ids2 });
    expect(r2.objects.map((o: { location: number[] }) => o.location)).toEqual(
      r1.objects.map((o: { location: number[] }) => o.location),
    );
    const r3 = t2.ok('object.randomize_transform', { ...params, objects: ids2, random_seed: 6 });
    expect(r3.objects[0].location).not.toEqual(r2.objects[0].location);
  });

  it('scale_even scales uniformly; the use_* switches keep channels; defaults randomize scale 0×..2×', () => {
    const t = setup();
    const a = t.cube('A', 1, [1, 2, 3]);
    t.doc.updateObject(a, { scale: [2, 2, 2] });
    const r = t.ok('object.randomize_transform', {
      objects: [a],
      scale_even: true,
      scale: [0.3, 0, 0],
      loc: [5, 5, 5],
      use_loc: false,
    });
    const s = r.objects[0].scale;
    expect(s[0]).toBeCloseTo(s[1], 12);
    expect(s[1]).toBeCloseTo(s[2], 12);
    expect(s[0]).toBeGreaterThanOrEqual(1.4);
    expect(s[0]).toBeLessThanOrEqual(2.6);
    expect(r.objects[0].location).toEqual([1, 2, 3]);
    const scales: number[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const id = t.cube(`S${seed}`, 1, [0, 0, 0]);
      scales.push(
        ...t.ok('object.randomize_transform', { objects: [id], random_seed: seed }).objects[0].scale,
      );
    }
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...scales)).toBeLessThanOrEqual(2);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(1);
  });

  it('is one undo step', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const um = t.undo();
    t.ok('object.randomize_transform', { objects: [a], loc: [1, 1, 1] });
    um.undo();
    expect(t.doc.getObject(a)!.location).toEqual([0, 0, 0]);
    expect(t.doc.getObject(a)!.scale).toEqual([1, 1, 1]);
  });
});

describe('object.array_place', () => {
  it('LINE: count items (originals included) each offset further; linked data; selection', () => {
    const t = setup();
    const a = t.cube('Post', 0.2, [0, 0, 0]);
    const r = t.ok('object.array_place', { objects: [a], count: 4, offset: [1.5, 0, 0] });
    expect(r.count).toBe(3);
    expect(r.objects.map((id: string) => t.doc.getObject(id)!.location[0])).toEqual([1.5, 3, 4.5]);
    expect(r.objects.map((id: string) => t.doc.getObject(id)!.name)).toEqual([
      'Post.001',
      'Post.002',
      'Post.003',
    ]);
    for (const id of r.objects) expect(t.doc.getObject(id)!.data).toBe(t.doc.getObject(a)!.data);
    expect(t.ctx.state.selectedIds).toEqual([a, ...r.objects]);
    expect(t.ctx.state.activeId).toBe(a);
    const copies = t.ok('object.array_place', { objects: [a], count: 2, linked: false });
    const copy = t.doc.getObject(copies.objects[0])!;
    expect(copy.data).not.toBe(t.doc.getObject(a)!.data);
    expect(t.doc.getMesh(copy.data!)).toEqual(t.doc.getMesh(t.doc.getObject(a)!.data!));
  });

  it('GRID: columns along X and rows along Y', () => {
    const t = setup();
    const a = t.cube('A', 1, [1, 1, 0]);
    const r = t.ok('object.array_place', {
      objects: [a],
      pattern: 'GRID',
      columns: 3,
      rows: 2,
      spacing: [2, 5],
    });
    const locs = r.objects.map((id: string) => t.doc.getObject(id)!.location.slice(0, 2));
    expect(locs).toEqual([
      [3, 1],
      [5, 1],
      [1, 6],
      [3, 6],
      [5, 6],
    ]);
    expect(r.items).toHaveLength(5);
  });

  it('CIRCLE: copies rotate around the centre (or only move with rotate=false)', () => {
    const t = setup();
    const chair = t.cube('Chair', 0.5, [2, 0, 0]);
    const r = t.ok('object.array_place', {
      objects: [chair],
      pattern: 'CIRCLE',
      count: 4,
      center: [0, 0, 0],
    });
    const pos = r.objects.map((id: string) => t.world(id).origin);
    expectVec(pos[0], [0, 2, 0]);
    expectVec(pos[1], [-2, 0, 0]);
    expectVec(pos[2], [0, -2, 0]);
    expect(t.doc.getObject(r.objects[0])!.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 9);
    const fixed = t.ok('object.array_place', {
      objects: [chair],
      pattern: 'CIRCLE',
      count: 3,
      radius: 1,
      rotate: false,
    });
    // default centre: 1 m along −X from the chair
    expectVec(t.world(fixed.objects[0]).origin, [
      1 + Math.cos((2 * Math.PI) / 3),
      Math.sin((2 * Math.PI) / 3),
      0,
    ]);
    expectVec(t.doc.getObject(fixed.objects[0])!.rotation_euler, [0, 0, 0]);
    const arc = t.ok('object.array_place', {
      objects: [chair],
      pattern: 'CIRCLE',
      count: 3,
      center: [0, 0, 0],
      angle: Math.PI,
    });
    expectVec(t.world(arc.objects[1]).origin, [-2, 0, 0]); // half circle including both ends
  });

  it('copies a parent + child group, re-linking the copied child to the copied parent', () => {
    const t = setup();
    const table = t.cube('Table', 1, [0, 0, 0]);
    const cup = t.cube('Cup', 0.1, [0, 0, 0]);
    t.doc.updateObject(cup, { parent: table, location: [0.2, 0, 0.55] });
    const r = t.ok('object.array_place', { objects: [cup, table], count: 2, offset: [0, 3, 0] });
    const [cupCopy, tableCopy] = r.items[0].map((id: string) => t.doc.getObject(id)!);
    const cc = r.items[0].find((id: string) => t.doc.getObject(id)!.name.startsWith('Cup'));
    const tc = r.items[0].find((id: string) => t.doc.getObject(id)!.name.startsWith('Table'));
    expect(t.doc.getObject(cc)!.parent).toBe(tc);
    expectVec(t.world(cc).origin, [0.2, 3, 0.55]);
    expect(cupCopy && tableCopy).toBeTruthy();
  });

  it('enforces the object limit and is one undo step', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    const b = t.cube('B', 1, [0, 0, 0]);
    const r = t.run('object.array_place', { objects: [a, b], count: MAX_LAYOUT_OBJECTS });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/limit/);
    const um = t.undo();
    t.ok('object.array_place', { objects: [a, b], count: 3 });
    expect(t.doc.listObjects()).toHaveLength(6);
    um.undo();
    expect(t.doc.listObjects()).toHaveLength(2);
  });
});

describe('object.scatter_on_surface', () => {
  it('places linked copies with their origins on the surface, deterministically', () => {
    const run = () => {
      const t = setup();
      t.ok('mesh.primitive_plane_add', { name: 'Ground', size: 20, location: [0, 0, 2] });
      const tree = t.cube('Tree', 1, [0, 0, 0]);
      const r = t.ok('object.scatter_on_surface', { surface: 'Ground', objects: [tree], count: 30, seed: 4 });
      return { t, r, tree };
    };
    const { t, r, tree } = run();
    expect(r.count).toBe(30);
    expect(r.objects).toHaveLength(30);
    const locs = r.objects.map((id: string) => t.doc.getObject(id)!.location);
    for (const id of r.objects) {
      const o = t.doc.getObject(id)!;
      expect(o.data).toBe(t.doc.getObject(tree)!.data);
      expect(o.location[2]).toBeCloseTo(2, 9);
      expect(Math.abs(o.location[0])).toBeLessThanOrEqual(10);
      expect(o.rotation_euler[0]).toBeCloseTo(0, 9); // upright
      expect(o.scale[0]).toBeGreaterThanOrEqual(0.8);
      expect(o.scale[0]).toBeLessThanOrEqual(1.2);
      expect(o.parent).toBeNull();
    }
    expect(t.ctx.state.selectedIds).toEqual(r.objects);
    expect(run().r.objects.map((id: string) => t.doc.getObject(id)?.location)).toBeDefined();
    const again = run();
    expect(again.r.objects.map((id: string) => again.t.doc.getObject(id)!.location)).toEqual(locs);
  });

  it('keeps a minimum distance, respects max_slope and picks several sources', () => {
    const t = setup();
    t.cube('Box', 10, [0, 0, 0]);
    const a = t.cube('A', 0.2, [20, 0, 0]);
    const b = t.cube('B', 0.4, [30, 0, 0]);
    const r = t.ok('object.scatter_on_surface', {
      surface: 'Box',
      objects: [a, b],
      count: 200,
      min_distance: 1.5,
      max_slope: 0.2,
    });
    expect(r.count).toBeLessThan(200);
    expect(r.count).toBeGreaterThan(10);
    expect(t.reports.some((x) => x.level === 'WARNING')).toBe(true);
    const pts = r.objects.map((id: string) => t.doc.getObject(id)!.location);
    for (const p of pts) expect(p[2]).toBeCloseTo(5, 9); // only the top face
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        expect(Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])).toBeGreaterThanOrEqual(1.5 - 1e-9);
    const data = new Set(r.objects.map((id: string) => t.doc.getObject(id)!.data));
    expect(data.size).toBe(2);
  });

  it('aligns copies to the normal of a sphere and applies the offset along it', () => {
    const t = setup();
    t.ok('mesh.primitive_uv_sphere_add', { name: 'Planet', radius: 5, segments: 24, ring_count: 12 });
    const rock = t.cube('Rock', 0.2, [20, 0, 0]);
    const r = t.ok('object.scatter_on_surface', {
      surface: 'Planet',
      objects: [rock],
      count: 20,
      align_to_normal: true,
      rotation_random: 0,
      scale_min: 1,
      scale_max: 1,
      offset: 0.5,
    });
    for (const id of r.objects) {
      const w = t.world(id);
      const radial = w.origin.map((v) => v / Math.hypot(...w.origin));
      expect(Math.hypot(...w.origin)).toBeGreaterThan(5.2);
      expect(Math.hypot(...w.origin)).toBeLessThanOrEqual(5.5 + 1e-9);
      // the copy's +Z is the face normal, which is close to radial on a fine sphere
      const z = axis(w.m, 2);
      expect(z[0] * radial[0] + z[1] * radial[1] + z[2] * radial[2]).toBeGreaterThan(0.97);
      expectVec(t.doc.getObject(id)!.scale, [1, 1, 1]);
    }
  });

  it('copies survive a snapshot round trip with their data still shared', () => {
    const t = setup();
    t.ok('mesh.primitive_plane_add', { name: 'Ground', size: 10 });
    const rock = t.ok('object.generate_rock', { detail: 2, location: [20, 0, 0] }).object;
    const r = t.ok('object.scatter_on_surface', { surface: 'Ground', objects: [rock], count: 6, seed: 1 });
    const arr = t.ok('object.array_place', { objects: [rock], count: 3, linked: false });
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(t.doc.toSnapshot())));
    for (const id of r.objects) {
      expect(copy.getObject(id)).toEqual(t.doc.getObject(id));
      expect(copy.getObject(id)!.data).toBe(t.doc.getObject(rock)!.data);
    }
    expect(copy.dataUsers(t.doc.getObject(rock)!.data!)).toBe(7);
    for (const id of arr.objects)
      expect(copy.getMesh(copy.getObject(id)!.data!)).toEqual(t.doc.getMesh(t.doc.getObject(rock)!.data!));
  });

  it('defaults to the selection (minus the surface), validates input and undoes in one step', () => {
    const t = setup();
    const ground = t.ok('mesh.primitive_plane_add', { name: 'Ground', size: 4 }).object;
    const a = t.cube('A', 0.2, [9, 0, 0]);
    t.ok('object.select', { objects: [a, ground] });
    t.ctx.state.activeId = ground;
    const um = t.undo();
    const r = t.ok('object.scatter_on_surface', { count: 5 });
    expect(r.surface).toBe(ground);
    expect(r.objects).toHaveLength(5);
    um.undo();
    expect(t.doc.listObjects()).toHaveLength(2);
    const e = t.ok('object.empty_add', {}).object;
    expect(t.run('object.scatter_on_surface', { surface: e, objects: [a] }).error).toMatch(
      /no surface geometry/,
    );
    expect(t.run('object.scatter_on_surface', { surface: ground, objects: [ground] }).error).toMatch(
      /No objects/,
    );
    expect(
      t.run('object.scatter_on_surface', { surface: ground, objects: [a], scale_min: 2, scale_max: 1 }).ok,
    ).toBe(false);
    expect(t.run('object.scatter_on_surface', { surface: 'Nope', objects: [a] }).error).toMatch(/not found/);
  });
});

describe('object.dimensions_set', () => {
  it('scales to target dimensions along the object axes (Blender dimensions)', () => {
    const t = setup();
    const a = t.cube('A', 2, [0, 0, 0], [0, 0, 0.7]);
    const r = t.ok('object.dimensions_set', { objects: [a], x: 4, z: 1 });
    expectVec(t.doc.getObject(a)!.scale, [2, 1, 0.5]);
    expectVec(r.objects[0].dimensions, [4, 2, 1]);
    t.ok('object.dimensions_set', { objects: [a], y: 6, proportional: true });
    expectVec(t.doc.getObject(a)!.scale, [6, 3, 1.5]);
    // proportional with several targets: fit inside all of them
    t.ok('object.dimensions_set', { objects: [a], x: 4, y: 100, proportional: true });
    expectVec(t.doc.getObject(a)!.scale, [2, 1, 0.5]);
  });

  it('measures evaluated geometry, keeps the sign of mirrored scales and skips flat axes and empties', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    t.ok('object.modifier_add', { type: 'ARRAY', object: a });
    t.doc.updateObject(a, { scale: [-1, 1, 1] });
    t.ok('object.dimensions_set', { objects: [a], x: 4 });
    const s = t.doc.getObject(a)!.scale[0];
    expect(s).toBeLessThan(0);
    const ev = t.world(a);
    expect(ev.max[0] - ev.min[0]).toBeCloseTo(4, 6);
    const plane = t.ok('mesh.primitive_plane_add', { size: 2 }).object;
    t.ok('object.dimensions_set', { objects: [plane], z: 3, x: 4 });
    expectVec(t.doc.getObject(plane)!.scale, [2, 1, 1]);
    expect(t.reports.some((r) => /flat along Z/.test(r.message))).toBe(true);
    const e = t.ok('object.empty_add', {}).object;
    t.ok('object.dimensions_set', { objects: [e], x: 2 });
    expect(t.reports.some((r) => /no geometry/.test(r.message))).toBe(true);
    expect(t.run('object.dimensions_set', { objects: [a] }).error).toMatch(/at least one/);
  });

  it('is one undo step', () => {
    const t = setup();
    const a = t.cube('A', 2, [0, 0, 0]);
    const um = t.undo();
    t.ok('object.dimensions_set', { objects: [a], x: 5 });
    um.undo();
    expect(t.doc.getObject(a)!.scale).toEqual([1, 1, 1]);
  });
});

describe('scene.measure / scene.raycast / scene.stats (read-only)', () => {
  it('measures bounds, dimensions and pairwise distances without touching the document', () => {
    const t = setup();
    const a = t.cube('A', 2, [0, 0, 1]);
    t.cube('B', 1, [4, 0, 0.5], [0, 0, 0.3]);
    const before = Y.encodeStateVector(t.doc.ydoc);
    const r = t.ok('scene.measure', { objects: ['A', 'B'] });
    expect(Y.encodeStateVector(t.doc.ydoc)).toEqual(before);
    expect(r.objects[0]).toMatchObject({ name: 'A', type: 'MESH', has_geometry: true, location: [0, 0, 1] });
    expectVec(r.objects[0].bounds.min, [-1, -1, 0]);
    expectVec(r.objects[0].bounds.size, [2, 2, 2]);
    expectVec(r.objects[1].dimensions, [1, 1, 1]);
    expect(r.objects[1].bounds.size[0]).toBeGreaterThan(1); // rotated: wider world box
    expectVec(r.bounds.min, [-1, -1, 0]);
    const d = r.distances[0];
    expect(d.origin_distance).toBeCloseTo(Math.hypot(4, 0, 0.5), 6);
    expect(d.bounds_gap).toBeCloseTo(4 - 1 - r.objects[1].bounds.size[0] / 2, 5);
    expect(d.surface_distance).toBeGreaterThanOrEqual(d.bounds_gap - 1e-9);
    expect(d.surface_distance).toBeCloseTo(4 - 1 - (Math.cos(0.3) + Math.sin(0.3)) / 2, 5);
    expect(d.intersecting).toBe(false);
    // defaults: the selection, else every visible object
    t.ok('object.select', { objects: [a] });
    expect(t.ok('scene.measure', {}).objects).toHaveLength(1);
    t.ok('object.select_all', { action: 'DESELECT' });
    expect(t.ok('scene.measure', {}).objects).toHaveLength(2);
  });

  it('ray casts against objects and instances, with all hits, exclusions and restrictions', () => {
    const t = setup();
    t.cube('Low', 2, [0, 0, 0]);
    const high = t.cube('High', 2, [0, 0, 5]);
    const hit = t.ok('scene.raycast', { origin: [0.1, 0.2, 20] });
    expect(hit).toMatchObject({ hit: true, name: 'High', instancer: null, front: true });
    expectVec(hit.point, [0.1, 0.2, 6]);
    expectVec(hit.normal, [0, 0, 1]);
    expect(hit.distance).toBeCloseTo(14, 9);
    expect(t.ok('scene.raycast', { origin: [0, 0, 20], exclude: ['High'] }).name).toBe('Low');
    expect(t.ok('scene.raycast', { origin: [0, 0, 20], max_distance: 5 }).hit).toBe(false);
    expect(t.ok('scene.raycast', { origin: [9, 9, 20] })).toEqual({ hit: false });
    const all = t.ok('scene.raycast', { origin: [0, 0, 20], all: true });
    expect(all.hits.map((h: { name: string }) => h.name)).toEqual(['High', 'High', 'Low', 'Low']);
    t.doc.updateObject(high, { hide_viewport: true });
    expect(t.ok('scene.raycast', { origin: [0, 0, 20] }).name).toBe('Low');
    expect(t.ok('scene.raycast', { origin: [0, 0, 20], objects: ['High'] }).name).toBe('High');
    expect(t.run('scene.raycast', { origin: [0, 0, 20], direction: [0, 0, 0] }).ok).toBe(false);
    // collection instances are hit and report their instancer
    t.ok('collection.create', { name: 'Props' });
    const prop = t.cube('Prop', 1, [0, 0, 0]);
    t.ok('object.select', { objects: [prop] });
    t.ok('object.move_to_collection', { collection: 'Props' });
    const inst = t.ok('object.collection_instance_add', { collection: 'Props', location: [10, 0, 0] }).object;
    const ih = t.ok('scene.raycast', { origin: [10, 0, 20] });
    expect(ih).toMatchObject({ hit: true, object: prop, instancer: inst });
    expect(ih.point[2]).toBeCloseTo(0.5, 9);
    expect(t.ok('scene.raycast', { origin: [10, 0, 20], include_instances: false }).hit).toBe(false);
  });

  it('counts objects, evaluated geometry, instances and data-blocks', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    t.cube('B', 1, [3, 0, 0]);
    t.ok('object.empty_add', {});
    t.ok('object.modifier_add', { type: 'SUBSURF', object: a });
    const s = t.ok('scene.stats', {});
    expect(s.objects).toMatchObject({ total: 3, visible: 3, by_type: { MESH: 2, EMPTY: 1 } });
    expect(s.geometry.faces).toBe(6 * 4 + 6);
    expect(s.geometry.vertices).toBe(26 + 8);
    expect(s.geometry.triangles).toBe(2 * (6 * 4 + 6));
    expect(s.datablocks.meshes).toBe(2);
    expectVec(s.bounds.min, [-0.5, -0.5, -0.5]);
    t.ok('object.select', { objects: ['B'] });
    const sel = t.ok('scene.stats', { selected_only: true });
    expect(sel.geometry.faces).toBe(6);
    expect(sel.objects.selected).toBe(1);
  });
});

describe('review regressions', () => {
  it('drop_to_ground lifts objects generated at z = 0 under a terrain onto it', () => {
    const t = setup();
    t.ok('object.generate_terrain', { name: 'Land', subdivisions: 32 });
    expect(t.ok('scene.raycast', { origin: [-8, -5, 50], objects: ['Land'] }).point[2]).toBeGreaterThan(1.5);
    const rock = t.ok('object.generate_rock', { name: 'Stone', location: [-8, -5, 0] }).object;
    const um = t.undo();
    const r = t.ok('object.drop_to_ground', { objects: ['Stone'] });
    expect(r.objects[0]).toMatchObject({ dropped: true, surface: 'Land' });
    expect(r.objects[0].moved).toBeGreaterThan(1.5);
    // no rock vertex is below the terrain any more, and the rock rests on it
    const w = t.world(rock);
    let deepest = -Infinity;
    for (let i = 0; i < w.points.length; i += 9) {
      const p = transformPoint3(w.m, [w.points[i], w.points[i + 1], w.points[i + 2]]);
      const g = t.ok('scene.raycast', { origin: [p[0], p[1], 100], objects: ['Land'] });
      deepest = Math.max(deepest, g.point[2] - p[2]);
    }
    expect(deepest).toBeLessThan(1e-6);
    const m = t.ok('scene.measure', { objects: ['Stone', 'Land'] });
    expect(m.distances[0].surface_distance).toBeLessThan(1e-4);
    um.undo();
    expect(t.world(rock).origin).toEqual([-8, -5, 0]);
  });

  it('drop_to_ground and snap_to_surface land on instanced geometry, like scene.raycast sees it', () => {
    const t = setup();
    t.ok('collection.create', { name: 'Env' });
    const floor = t.ok('mesh.primitive_plane_add', { name: 'Floor', size: 20, location: [0, 0, 2] }).object;
    t.ok('object.select', { objects: [floor] });
    t.ok('object.move_to_collection', { collection: 'Env' });
    t.doc.updateObject(floor, { hide_viewport: true });
    const inst = t.ok('object.collection_instance_add', { collection: 'Env' }).object;
    const box = t.cube('Box', 1, [1, 1, 10]);
    expect(t.ok('scene.raycast', { origin: [1, 1, 20], exclude: ['Box'] })).toMatchObject({
      hit: true,
      name: 'Floor',
      instancer: inst,
    });
    const d = t.ok('object.drop_to_ground', { objects: ['Box'] });
    expect(d.objects[0]).toMatchObject({ surface: 'Floor', moved: -7.5, location: [1, 1, 2.5] });
    t.doc.updateObject(box, { location: [3, 3, 9] });
    const s = t.ok('object.snap_to_surface', {
      objects: ['Box'],
      ray_origin: [3, 3, 20],
      snap_point: 'BOTTOM',
    });
    expect(s.hit).toMatchObject({ name: 'Floor', instancer: inst });
    expectVec(t.world(box).origin, [3, 3, 2.5]);
    // an instance of the moved object itself is never its own ground
    t.ok('collection.create', { name: 'Props' });
    t.ok('object.select', { objects: [box] });
    t.ok('object.move_to_collection', { collection: 'Props' });
    t.ok('object.collection_instance_add', { collection: 'Props', location: [0, 0, -4] });
    t.doc.updateObject(box, { location: [3, 3, 9] });
    expect(t.ok('object.drop_to_ground', { objects: ['Box'] }).objects[0].surface).toBe('Floor');
  });

  it('array_place points constraint targets and modifier objects inside each copied group at the copies', () => {
    const t = setup();
    const target = t.ok('object.empty_add', { name: 'Target', location: [0, 5, 0] }).object;
    const outside = t.ok('object.empty_add', { name: 'Outside', location: [9, 9, 9] }).object;
    const lamp = t.cube('Lamp', 1, [0, 0, 3]);
    t.ok('object.constraint_add', { type: 'TRACK_TO', object: 'Lamp', target: 'Target' });
    t.ok('object.constraint_add', { type: 'COPY_SCALE', object: 'Lamp', target: 'Outside' });
    t.ok('object.modifier_add', { type: 'MIRROR', object: lamp, params: { mirror_object: target } });
    const um = t.undo();
    const r = t.ok('object.array_place', {
      objects: ['Target', 'Lamp'],
      pattern: 'LINE',
      count: 3,
      offset: [10, 0, 0],
    });
    expect(r.items).toHaveLength(2);
    for (const item of r.items as string[][]) {
      const copies = item.map((id) => t.doc.getObject(id)!);
      const tCopy = copies.find((o) => o.name.startsWith('Target'))!;
      const lCopy = copies.find((o) => o.name.startsWith('Lamp'))!;
      expect(lCopy.constraints[0].target).toBe(tCopy.id);
      expect(lCopy.constraints[1].target).toBe(outside); // outside the copied group: unchanged
      expect(lCopy.modifiers[0].params.mirror_object).toBe(tCopy.id);
    }
    // the original keeps its own references
    expect(t.doc.getObject(lamp)!.constraints[0].target).toBe(target);
    um.undo();
    expect(t.doc.listObjects()).toHaveLength(3);
  });

  it('look_at and align_to_normal write compatible eulers, so keyed rotations never flip', () => {
    const t = setup();
    const cam = t.ok('object.camera_add', { name: 'Cam', location: [0, 0, 0] }).object;
    t.ctx.state.autoKeying = true;
    const deg = Math.PI / 180;
    const at = (a: number) => [10 * Math.cos(a * deg), 10 * Math.sin(a * deg), 0];
    t.ctx.state.frame = 1;
    t.ok('object.look_at', { objects: ['Cam'], point: at(260) });
    t.ctx.state.frame = 11;
    const r = t.ok('object.look_at', { objects: ['Cam'], point: at(280) });
    expect(r.objects[0].rotation_euler[2]).toBeCloseTo(190 * deg, 6); // not -170°
    t.ctx.state.frame = 6;
    const w = t.world(cam).m;
    const heading = (Math.atan2(-w[9], -w[8]) / deg + 360) % 360;
    expect(heading).toBeCloseTo(270, 0);
    // align_to_normal on flat ground keeps a rotation beyond π as it is (decompose4 wrapped it)
    t.ctx.state.autoKeying = false;
    const b = t.cube('Spun', 1, [5, 5, 3], [0, 0, 4]);
    t.ok('object.drop_to_ground', { objects: ['Spun'], align_to_normal: true });
    expectVec(t.doc.getObject(b)!.rotation_euler, [0, 0, 4]);
    expect(t.world(b).min[2]).toBeCloseTo(0, 9);
  });

  it('independent (linked=false) copies are created in linear time with their own data', () => {
    const t = setup();
    const c = t.cube('C', 0.5, [0, 0, 0]);
    const meshName = t.doc.getMeshBlock(t.doc.getObject(c)!.data!)!.name;
    const t0 = performance.now();
    const r = t.ok('object.array_place', {
      objects: ['C'],
      pattern: 'GRID',
      columns: 100,
      rows: 100,
      spacing: [1, 1],
      linked: false,
    });
    // ~100 s with a full rescan of the mesh names per copy before
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(r.count).toBe(9999);
    const blocks = t.doc.listMeshBlocks();
    expect(blocks).toHaveLength(10_000);
    expect(new Set(blocks.map((b) => b.name)).size).toBe(10_000);
    expect(blocks.map((b) => b.name)).toContain(`${meshName}.9999`);
    const first = t.doc.getObject(r.objects[0])!;
    expect(first.data).not.toBe(t.doc.getObject(c)!.data);
    expect(t.doc.getMesh(first.data!)).toEqual(t.doc.getMesh(t.doc.getObject(c)!.data!));
  }, 60_000);

  it('unlinked copies share one data copy per item for objects that share data, and round trip', () => {
    const t = setup();
    const a = t.cube('A', 1, [0, 0, 0]);
    t.ok('object.select', { objects: [a] });
    t.ok('object.duplicate', { linked: true, offset: [2, 0, 0] });
    const b = t.ctx.state.selectedIds[0];
    expect(t.doc.getObject(b)!.data).toBe(t.doc.getObject(a)!.data);
    const r = t.ok('object.array_place', { objects: [a, b], count: 3, offset: [0, 5, 0], linked: false });
    const datas = (r.items as string[][]).map((item) => new Set(item.map((id) => t.doc.getObject(id)!.data)));
    for (const d of datas) expect(d.size).toBe(1);
    expect(new Set(datas.map((d) => [...d][0])).size).toBe(2);
    // editing one item's data leaves the others alone
    const firstData = [...datas[0]][0]!;
    const moved = t.doc.getMeshCopy(firstData)!;
    moved.positions[0] += 1;
    t.doc.setMesh(firstData, moved);
    expect(t.doc.getMesh([...datas[1]][0]!)!.positions[0]).toBe(
      t.doc.getMesh(t.doc.getObject(a)!.data!)!.positions[0],
    );
    const copy = SceneDoc.fromSnapshot(JSON.parse(JSON.stringify(t.doc.toSnapshot())));
    for (const id of r.objects as string[]) {
      expect(copy.getObject(id)).toEqual(t.doc.getObject(id));
      expect(copy.getMesh(copy.getObject(id)!.data!)).toEqual(t.doc.getMesh(t.doc.getObject(id)!.data!));
    }
  });

  it('refuses to copy more than MAX_COPY_BYTES of data in one run, before creating anything', () => {
    const t = setup();
    t.ok('object.generate_terrain', { name: 'Big', subdivisions: 300 });
    const before = [t.doc.listObjects().length, t.doc.listMeshBlocks().length];
    const r = t.run('object.array_place', { objects: ['Big'], count: 40, linked: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/MB of object data \(limit 64 MB\): use linked=true/);
    expect([t.doc.listObjects().length, t.doc.listMeshBlocks().length]).toEqual(before);
    expect(t.ok('object.array_place', { objects: ['Big'], count: 40 }).count).toBe(39); // linked is fine
  });

  it('dimensions_set targets world sizes (parent scale included); LOCAL keeps Blender dimensions', () => {
    const t = setup();
    const root = t.ok('object.empty_add', { name: 'Root', scale: [2, 2, 2] }).object;
    const c = t.cube('C', 1, [0, 0, 0]);
    t.doc.setParent(c, root, true);
    expectVec(t.doc.getObject(c)!.scale, [0.5, 0.5, 0.5]);
    const r = t.ok('object.dimensions_set', { objects: ['C'], x: 4 });
    expect(r).toMatchObject({ space: 'WORLD' });
    expectVec(r.objects[0].dimensions, [4, 1, 1]);
    expectVec(r.objects[0].scale, [2, 0.5, 0.5]);
    const m = t.ok('scene.measure', { objects: ['C'] }).objects[0];
    expectVec(m.bounds.size, [4, 1, 1]);
    expectVec(m.world_dimensions, [4, 1, 1]);
    expectVec(m.dimensions, [2, 0.5, 0.5]);
    const l = t.ok('object.dimensions_set', { objects: ['C'], y: 3, space: 'LOCAL' });
    expectVec(l.objects[0].dimensions, [2, 3, 0.5]);
    expectVec(t.ok('scene.measure', { objects: ['C'] }).objects[0].bounds.size, [4, 6, 1]);
  });

  it('array_place CIRCLE counts angles within 0.01 of 2π as a full turn', () => {
    for (const [angle, expected] of [
      [6.283185, [0, 90, 180, -90]],
      [6.28, [0, 90, 180, -90]],
      [-6.2832, [0, -90, 180, 90]],
      [(330 * Math.PI) / 180, [0, 110, -140, -30]], // a real partial arc still ends at its angle
    ] as [number, number[]][]) {
      const t = setup();
      const c = t.cube('C', 1, [5, 0, 0]);
      const r = t.ok('object.array_place', {
        objects: ['C'],
        pattern: 'CIRCLE',
        count: 4,
        center: [0, 0, 0],
        angle,
      });
      const got = [c, ...r.objects].map((id: string) => {
        const o = t.world(id).origin;
        const a = Math.round((Math.atan2(o[1], o[0]) * 180) / Math.PI);
        return a === -180 ? 180 : a;
      });
      expect(got, `angle ${angle}`).toEqual(expected);
    }
  });

  it('scatter_on_surface places copies upright on mirrored (negative scale) surfaces', () => {
    const t = setup();
    t.ok('mesh.primitive_plane_add', { name: 'Ground', size: 10, scale: [-1, 1, 1] });
    t.cube('Box', 1, [0, 0, 5]);
    expect(
      t.ok('object.scatter_on_surface', { surface: 'Ground', objects: ['Box'], count: 10, max_slope: 0.5 })
        .count,
    ).toBe(10);
    const r = t.ok('object.scatter_on_surface', {
      surface: 'Ground',
      objects: ['Box'],
      count: 3,
      align_to_normal: true,
      rotation_random: 0,
    });
    for (const id of r.objects) expectVec(axis(t.world(id).m, 2), [0, 0, 1]);
  });

  it('scene.measure reports the exact surface distance of crossing beams and of instance geometry', () => {
    const t = setup();
    t.ok('mesh.primitive_cube_add', { name: 'A', size: 2, location: [0, 0, 0], scale: [5, 0.1, 0.1] });
    t.ok('mesh.primitive_cube_add', { name: 'B', size: 2, location: [0, 0, 0.5], scale: [0.1, 5, 0.1] });
    const d = t.ok('scene.measure', { objects: ['A', 'B'] }).distances[0];
    expect(d).toMatchObject({ bounds_gap: 0.3, surface_distance: 0.3, intersecting: false });
    expect(d.closest_points[0][2]).toBeCloseTo(0.1, 9);
    expect(d.closest_points[1][2]).toBeCloseTo(0.4, 9);
    t.ok('collection.create', { name: 'Props' });
    const prop = t.cube('Prop', 1, [0, 0, 0]);
    t.ok('object.select', { objects: [prop] });
    t.ok('object.move_to_collection', { collection: 'Props' });
    t.doc.updateObject(prop, { hide_viewport: true });
    t.ok('object.collection_instance_add', { collection: 'Props', name: 'Inst', location: [0, 0, 3] });
    const di = t.ok('scene.measure', { objects: ['Inst', 'B'] }).distances[0];
    expect(di.surface_distance).toBeCloseTo(3 - 0.5 - 0.6, 9);
  });
});
