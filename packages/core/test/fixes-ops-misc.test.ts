import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  type OperatorContext,
} from '../src';

// Regression tests for phase-3 issues #7 (drop_to_ground on a parent), #17 (scene.measure /
// scene.raycast frame), #29 (object.rename error), #3 (sculpt/paint parameter docs) and #23
// (fill_mode HALF on 3D curves).

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: () => {},
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  return { doc, reg, ctx, run, ok };
}

describe('object.drop_to_ground on a parent (#7)', () => {
  it('rests a parented assembly on the terrain under its children (lighthouse-cove repro)', () => {
    const { ok } = setup();
    ok('object.generate_terrain', { size: 20, subdivisions: 40, height: 2, seed: 1, name: 'Terrain' });
    ok('object.empty_add', { name: 'Group', location: [2, 1, 6] });
    ok('mesh.primitive_cube_add', { name: 'Child', size: 0.5, location: [2, 1, 6.25] });
    ok('object.parent_to', { objects: ['Child'], parent: 'Group' });
    const r = ok('object.drop_to_ground', { objects: ['Group'] });
    expect(r.objects[0]).toMatchObject({
      name: 'Group',
      dropped: true,
      surface: 'Terrain',
      children: ['Child'],
    });
    // the child now rests on the terrain: dropping it on its own does not move it any more
    const again = ok('object.drop_to_ground', { objects: ['Child'] });
    expect(Math.abs(again.objects[0].moved)).toBeLessThan(1e-4);
    // and no corner of its footprint is below the ground
    const m = ok('scene.measure', { objects: ['Child'] }).objects[0];
    for (const [x, y] of [
      [m.bounds.min[0], m.bounds.min[1]],
      [m.bounds.max[0], m.bounds.min[1]],
      [m.bounds.min[0], m.bounds.max[1]],
      [m.bounds.max[0], m.bounds.max[1]],
    ]) {
      const ground = ok('scene.raycast', { origin: [x, y, 50], objects: ['Terrain'] });
      expect(ground.point[2]).toBeLessThanOrEqual(m.bounds.min[2] + 1e-4);
    }
  });

  it('moves objects given together with their parent along with it', () => {
    const { ok, doc } = setup();
    ok('mesh.primitive_plane_add', { name: 'Floor', size: 20 });
    ok('object.empty_add', { name: 'Post', location: [0, 0, 5] });
    ok('mesh.primitive_cube_add', { name: 'Base', size: 1, location: [0, 0, 4] });
    ok('mesh.primitive_cube_add', { name: 'Lamp', size: 0.5, location: [0, 0, 7] });
    ok('object.parent_to', { objects: ['Base', 'Lamp'], parent: 'Post' });
    const r = ok('object.drop_to_ground', { objects: ['Lamp', 'Post'] });
    const byName = Object.fromEntries(r.objects.map((o: { name: string }) => [o.name, o]));
    expect(byName.Post.dropped).toBe(true);
    expect(byName.Post.moved).toBeCloseTo(-3.5, 6); // the base (bottom at 3.5) lands on the floor
    expect(byName.Lamp).toMatchObject({ moved_with: 'Post', dropped: true });
    // the assembly kept its shape
    const ev = new SceneEvaluator(doc).evaluate(1);
    const z = (n: string) => ev.byId.get(doc.findObjectByName(n)!.id)!.worldMatrix[14];
    expect(z('Lamp') - z('Base')).toBeCloseTo(3, 6);
    expect(z('Base')).toBeCloseTo(0.5, 6);
  });

  it('still drops a childless empty by its origin and a hidden child does not count', () => {
    const { ok, doc } = setup();
    ok('object.empty_add', { name: 'Marker', location: [3, 3, 4] });
    ok('object.drop_to_ground', { objects: ['Marker'] });
    expect(doc.findObjectByName('Marker')!.location[2]).toBeCloseTo(0, 9);
    ok('object.empty_add', { name: 'Holder', location: [0, 0, 4] });
    ok('mesh.primitive_cube_add', { name: 'Ghost', size: 2, location: [0, 0, 2] });
    ok('object.parent_to', { objects: ['Ghost'], parent: 'Holder' });
    doc.updateObject(doc.findObjectByName('Ghost')!.id, { hide_viewport: true });
    ok('object.drop_to_ground', { objects: ['Holder'] });
    expect(doc.findObjectByName('Holder')!.location[2]).toBeCloseTo(0, 9);
  });
});

describe('scene.measure / scene.raycast / scene.stats at a frame (#17)', () => {
  it('evaluates the requested frame without changing the current frame', () => {
    const { ok, ctx } = setup();
    ok('mesh.primitive_cube_add', { name: 'Crate', size: 1, location: [0, 0, 0.5] });
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Crate',
      path: 'location',
      frame: 1,
    });
    ok('anim.keyframe_insert_property', {
      target_type: 'object',
      target: 'Crate',
      path: 'location',
      index: 0,
      frame: 50,
      value: 4,
    });
    ok('mesh.primitive_cube_add', { name: 'Gripper', size: 0.2, location: [4, 0, 2] });
    const now = ok('scene.measure', { objects: ['Crate', 'Gripper'] });
    expect(now.frame).toBeUndefined();
    expect(now.objects[0].location[0]).toBeCloseTo(0, 6);
    const later = ok('scene.measure', { objects: ['Crate', 'Gripper'], frame: 50 });
    expect(later.frame).toBe(50);
    expect(later.objects[0].location[0]).toBeCloseTo(4, 6);
    expect(later.distances[0].origin_distance).toBeCloseTo(1.5, 6);
    expect(ctx.state.frame).toBe(1);
    // ray casts see the crate where it is at that frame
    expect(ok('scene.raycast', { origin: [4, 0, 1.5], exclude: ['Gripper'] }).hit).toBe(false);
    const hit = ok('scene.raycast', { origin: [4, 0, 1.5], exclude: ['Gripper'], frame: 50 });
    expect(hit).toMatchObject({ hit: true, name: 'Crate', frame: 50 });
    expect(hit.point[2]).toBeCloseTo(1, 6);
    expect(ok('scene.stats', { frame: 50 }).objects).toBeDefined();
    expect(ctx.state.frame).toBe(1);
  });
});

describe('object.rename errors (#29)', () => {
  it('names the missing object', () => {
    const { run, ok } = setup();
    const r = run('object.rename', { object: 'NoSuch', name: 'X' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Object 'NoSuch' not found");
    expect(r.code).toBe('NOT_FOUND');
    ok('mesh.primitive_cube_add', { name: 'Box' });
    expect(ok('object.rename', { object: 'Box', name: 'Crate' })).toMatchObject({
      old_name: 'Box',
      name: 'Crate',
    });
    // without `object` the active object is renamed; an empty scene has none
    const empty = setup();
    expect(empty.run('object.rename', { name: 'X' }).error).toContain('No active object to rename');
  });
});

describe('sculpt and paint parameter documentation (#3)', () => {
  it('describes every parameter of sculpt.* and paint.* operators', () => {
    const { reg } = setup();
    const ops = reg.describe().filter((o) => o.id.startsWith('sculpt.') || o.id.startsWith('paint.'));
    expect(ops.map((o) => o.id).sort()).toEqual([
      'paint.vertex_color_set',
      'paint.vertex_color_set_data',
      'paint.vertex_color_stroke',
      'sculpt.brush_stroke',
    ]);
    for (const o of ops) {
      const props = (o.parameters as { properties: Record<string, { description?: string }> }).properties;
      for (const [k, v] of Object.entries(props)) expect(v.description, `${o.id}.${k}`).toBeTruthy();
    }
    const stroke = ops.find((o) => o.id === 'sculpt.brush_stroke')!;
    expect(stroke.description).toContain('SPHERE');
    expect(stroke.description).toContain('cannot level a pad on a slope');
    expect(ops.find((o) => o.id === 'paint.vertex_color_stroke')!.description).toContain('MULTIPLY');
    expect(ops.find((o) => o.id === 'paint.vertex_color_set_data')!.description).toContain('MULTIPLY');
  });

  it('GRAB moves the vertex at the first point by exactly grab_delta', () => {
    const { ok, doc } = setup();
    ok('mesh.primitive_grid_add', { name: 'G', x_subdivisions: 10, y_subdivisions: 10, size: 10 });
    ok('sculpt.brush_stroke', {
      object: 'G',
      brush: 'GRAB',
      points: [[0, 0, 0]],
      radius: 3,
      grab_delta: [0, 0, 1.5],
    });
    const m = doc.getMesh(doc.findObjectByName('G')!.data!)!;
    let top = -Infinity;
    for (let i = 2; i < m.positions.length; i += 3) top = Math.max(top, m.positions[i]);
    expect(top).toBeCloseTo(1.5, 6);
  });

  it('names a missing sculpt target', () => {
    const { run } = setup();
    expect(run('sculpt.brush_stroke', { object: 'Nope', points: [[0, 0, 0]] }).error).toBe(
      "Object 'Nope' not found",
    );
  });
});

describe('fill_mode HALF on 3D curves (#23)', () => {
  const path = (tilt: number) =>
    [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ].map((co) => ({ co, tilt }));

  it('keeps the left half (a channel opening sideways) and opens upward with tilt -π/2, as documented', () => {
    const { ok, reg, doc } = setup();
    const describe = reg.describe().find((o) => o.id === 'curve.add_from_points')!;
    const fillDoc = (describe.parameters as { properties: Record<string, { description: string }> })
      .properties.fill_mode.description;
    expect(fillDoc).toContain('tilt -π/2');
    expect(fillDoc).toContain('opening sideways to the RIGHT');
    const bounds = (name: string) => {
      const m = new SceneEvaluator(doc).evaluate(1).byId.get(doc.findObjectByName(name)!.id)!.mesh!;
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.positions.length; i += 3)
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], m.positions[i + k]);
          max[k] = Math.max(max[k], m.positions[i + k]);
        }
      return { min, max };
    };
    const common = {
      type: 'POLY',
      dimensions: '3D',
      bevel_depth: 0.5,
      fill_mode: 'HALF',
      twist_mode: 'Z_UP',
    };
    ok('curve.add_from_points', { ...common, name: 'Side', points: path(0) });
    const side = bounds('Side');
    expect(side.min[1]).toBeCloseTo(0, 6); // only the left (+Y) half of a path running along +X
    expect(side.max[1]).toBeCloseTo(0.5, 6);
    ok('curve.add_from_points', {
      ...common,
      name: 'Gutter',
      points: path(-Math.PI / 2),
      location: [0, 5, 0],
    });
    const gutter = bounds('Gutter');
    expect(gutter.max[2]).toBeCloseTo(0, 6); // the lower half: a U opening upward
    expect(gutter.min[2]).toBeCloseTo(-0.5, 6);
    const hit = ok('scene.raycast', { origin: [1, 5, 3], objects: ['Gutter'] });
    expect(hit.point[2]).toBeCloseTo(-0.5, 6); // the ray falls into the gutter and hits its bottom
    expect(hit.front).toBe(false); // the inside shows the back of the faces, as documented
  });
});
