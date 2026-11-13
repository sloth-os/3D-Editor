import { describe, expect, it } from 'vitest';
import {
  FrameState,
  SceneDoc,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  insertKeyframe,
  selectionPivot,
  type OperatorContext,
  type Vec3,
} from '../src';

/*
 * The parts of Move, Rotate and Scale, the Snap menu and the other operators that read where the
 * scene shows an object at the current frame, each with a case where reading the stored values
 * instead (or the wrong space) gives another result: which of an object's own constraints are part
 * of the space a transform moves it in (Blender's constraints_list_needinv), the axes Scale
 * measures in, the Active Element pivot, Edit Mode, the LOCAL orientation, Selection to Grid,
 * Set Origin of curves, the Edit Mode tools' object matrix, material warnings and sculpting.
 */

const deg = Math.PI / 180;
const reg = createOperatorRegistry();

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_level, message) => reports.push(message),
  };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result as Record<string, unknown>;
  };
  const select = (ids: string[], active = ids[ids.length - 1]) => {
    ctx.state.selectedIds = ids;
    ctx.state.activeId = active;
  };
  const world = (id: string) => new FrameState(doc, ctx.state.frame).world(id)!;
  const origin = (id: string): Vec3 => world(id).slice(12, 15) as Vec3;
  const constrain = (id: string, type: string, params: Record<string, unknown>, target?: string) => {
    select([id]);
    run('object.constraint_add', { type, target, params });
  };
  return { doc, ctx, reports, run, select, world, origin, constrain };
}

type Setup = ReturnType<typeof setup>;

/** An armature at the origin (its bone along +Z, posed) and a cube at [1, 2, 3] parented to the bone. */
function boneChild(t: Setup) {
  t.run('object.armature_add', { location: [0, 0, 0] });
  const arm = t.ctx.state.activeId!;
  t.run('pose.bone_transform_set', { object: arm, bone: 'Bone', rotation_euler: [0.4, 0.2, 0.7] });
  t.run('mesh.primitive_cube_add', { location: [1, 2, 3] });
  const cube = t.ctx.state.activeId!;
  t.select([cube, arm], arm);
  t.run('object.parent_set', { type: 'BONE' });
  t.select([cube]);
  return { arm, cube };
}

const maxDiff = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe('an object’s own constraints in the space a transform moves it in (constraints_list_needinv)', () => {
  it('Scale measures each axis where the object shows it, its constraints applied (td->axismtx)', () => {
    // Copy Rotation from a target turned 30° about Z: the object shows turned 30°, so S X 2 along
    // the world X axis scales its X axis by 1.803 and its Y axis by 1.323, as for an object turned 30°
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', rotation_euler: [0, 0, 30 * deg] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A' });
    t.constrain(id, 'COPY_ROTATION', {}, target);
    t.run('transform.resize', { value: [2, 1, 1] });
    expect(maxDiff(t.doc.getObject(id)!.scale, [Math.sqrt(3.25), Math.sqrt(1.75), 1])).toBeLessThan(1e-12);
  });

  it('Copy Rotation mixed Before is part of the space only when rotating', () => {
    // with a target turned 90° about Z: Move ignores it (the location gets the world offset), Rotate
    // turns in the space it makes
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', rotation_euler: [0, 0, 90 * deg] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    t.constrain(id, 'COPY_ROTATION', { mix_mode: 'BEFORE' }, target);
    t.run('transform.translate', { value: [1, 0, 0] });
    expect(t.doc.getObject(id)!.location).toEqual([2, 0, 0]);
  });

  it('Child Of is part of the space only when it inherits the location on all three axes', () => {
    // Child Of a target that then turns 90° about Z and scales 2, inheriting only the X location:
    // Blender switches it off for the transform, so G X 1 adds 1 to the stored X; inheriting all
    // three, it moves the object along X where the constraint shows it
    for (const all of [false, true]) {
      const t = setup();
      const target = t.doc.addObject({ type: 'EMPTY', name: 'T' });
      const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 1, 0] });
      t.constrain(id, 'CHILD_OF', all ? {} : { use_location_y: false, use_location_z: false }, target);
      t.doc.updateObject(target, { location: [3, 0, 0], rotation_euler: [0, 0, 90 * deg], scale: [2, 2, 2] });
      const before = t.origin(id);
      t.run('transform.translate', { value: [1, 0, 0] });
      if (all) expect(maxDiff(t.origin(id), [before[0] + 1, before[1], before[2]])).toBeLessThan(1e-12);
      else expect(t.doc.getObject(id)!.location).toEqual([2, 1, 0]);
    }
  });

  it('a muted constraint is not part of it: the object moves exactly as without it', () => {
    const moved = (muted: boolean) => {
      const t = setup();
      const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [3, 1, 2], scale: [2, 1, 1] });
      const id = t.doc.addObject({
        type: 'EMPTY',
        name: 'A',
        location: [0.3, 0.7, 0.1],
        rotation_euler: [0.4, 0.5, 0.6],
        scale: [1.5, 0.7, 2.5],
      });
      if (muted) {
        t.constrain(id, 'CHILD_OF', {}, target);
        const o = t.doc.getObject(id)!;
        t.doc.updateObject(id, { constraints: o.constraints.map((c) => ({ ...c, mute: true })) });
      }
      t.select([id]);
      t.run('transform.translate', { value: [0.1, 0.2, 0.3] });
      t.run('transform.rotate', { value: 0.7, orient_axis: 'Y', center: [1, 2, 3] });
      t.run('transform.resize', { value: [1.3, 0.9, 1.1], center: [1, 2, 3] });
      const o = t.doc.getObject(id)!;
      return [...o.location, ...o.rotation_euler, ...o.scale];
    };
    expect(moved(true)).toEqual(moved(false));
  });

  it('Active Element pivot of an active object the transform moves: its origin with its constraints switched off', () => {
    // A is shown on its Copy Location target at (5, 0, 0), but its transform reads it at (0, 2, 0)
    // (Blender's td->center), and calculateCenterActive takes that; an active object the transform
    // leaves out (not selected) counts where it is shown
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [5, 0, 0] });
    const a = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [0, 2, 0] });
    const b = t.doc.addObject({ type: 'EMPTY', name: 'B', location: [1, 0, 0] });
    t.constrain(a, 'COPY_LOCATION', {}, target);
    t.select([b, a], a);
    t.ctx.state.pivotPoint = 'ACTIVE_ELEMENT';
    expect(selectionPivot(t.doc, t.ctx.state, 'ACTIVE_ELEMENT', { mode: 'ROTATE' })).toEqual([0, 2, 0]);
    t.select([b], a);
    expect(selectionPivot(t.doc, t.ctx.state, 'ACTIVE_ELEMENT', { mode: 'ROTATE' })).toEqual([5, 0, 0]);
  });
});

describe('pivots, orientations and the Snap menu read where the scene shows the objects', () => {
  it('Individual Origins: the rotation center leaves out a selected child of a selected parent (TD_NOCENTER)', () => {
    const t = setup();
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [3, 0, 0], parent: p });
    t.select([p, c], p);
    t.ctx.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
    expect(selectionPivot(t.doc, t.ctx.state, 'INDIVIDUAL_ORIGINS', { mode: 'ROTATE' })).toEqual([0, 0, 0]);
    // the child still turns about its own origin
    t.run('transform.rotate', { value: 90 * deg, orient_axis: 'Z' });
    expect(maxDiff(t.origin(c), [0, 3, 0])).toBeLessThan(1e-12);
    expect(t.doc.getObject(c)!.rotation_euler[2]).toBeCloseTo(90 * deg, 12);
  });

  it('Edit Mode pivot: the selected vertices where the scene shows them', () => {
    const t = setup();
    const { cube } = boneChild(t);
    t.run('object.mode_set', { mode: 'EDIT' });
    const mesh = t.doc.getMesh(t.doc.getObject(cube)!.data!)!;
    t.ctx.state.meshSelection = { verts: new Set([0]), edges: new Set(), faces: new Set() };
    const w = t.world(cube);
    const p = [mesh.positions[0], mesh.positions[1], mesh.positions[2]];
    const shown = [0, 1, 2].map((r) => w[r] * p[0] + w[4 + r] * p[1] + w[8 + r] * p[2] + w[12 + r]);
    expect(maxDiff(selectionPivot(t.doc, t.ctx.state), shown)).toBeLessThan(1e-12);
  });

  it('LOCAL orientation: the axes the active object shows (an animated rotation at the frame)', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 90 * deg, 'LINEAR');
    t.doc.setFCurve(fc);
    t.ctx.state.frame = 6;
    t.select([id]);
    t.run('transform.translate', { value: [1, 0, 0], orient_type: 'LOCAL' });
    expect(maxDiff(t.origin(id), [1 + Math.cos(45 * deg), Math.sin(45 * deg), 0])).toBeLessThan(1e-12);
  });

  it('Selection to Grid moves a selected child of a selected parent from where it was, as Blender', () => {
    // P at x 0.4 and its child C at x 1.7: P moves by −0.4, C by +0.3 in its parent's space and
    // follows P's move, so it ends at x 1.6
    const t = setup();
    const p = t.doc.addObject({ type: 'EMPTY', name: 'P', location: [0.4, 0, 0] });
    const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [1.3, 0, 0], parent: p });
    t.select([p, c], p);
    t.run('view3d.snap_selected_to_grid', { grid_size: 1 });
    expect(maxDiff(t.origin(p), [0, 0, 0])).toBeLessThan(1e-12);
    expect(maxDiff(t.origin(c), [1.6, 0, 0])).toBeLessThan(1e-12);
  });
});

describe('operators on object data use the object’s matrix where the scene shows it', () => {
  it('Set Origin of a curve parented to a bone puts the origin on the 3D cursor and keeps the points in place', () => {
    const t = setup();
    t.run('object.armature_add', { location: [0, 0, 0] });
    const arm = t.ctx.state.activeId!;
    t.run('pose.bone_transform_set', { object: arm, bone: 'Bone', rotation_euler: [0.4, 0.2, 0.7] });
    const curveObj = t.run('curve.primitive_bezier_curve_add', { location: [1, 2, 3] }).object as string;
    t.select([curveObj, arm], arm);
    t.run('object.parent_set', { type: 'BONE' });
    t.select([curveObj]);
    const points = () => {
      const w = t.world(curveObj);
      const c = t.doc.getCurve(t.doc.getObject(curveObj)!.data!)!;
      return c.splines[0].points.map((pt) =>
        [0, 1, 2].map((r) => w[r] * pt.co[0] + w[4 + r] * pt.co[1] + w[8 + r] * pt.co[2] + w[12 + r]),
      );
    };
    const before = points();
    t.ctx.state.cursorLocation = [0.5, 2.5, 3.5];
    t.run('object.origin_set', { type: 'ORIGIN_CURSOR' });
    expect(maxDiff(t.origin(curveObj), [0.5, 2.5, 3.5])).toBeLessThan(1e-9);
    points().forEach((p, i) => expect(maxDiff(p, before[i]), `point ${i}`).toBeLessThan(1e-9));
  });

  it('Set Origin of a selected parent and its selected child puts both origins on the cursor, the geometry stays', () => {
    // the parent goes first: moving its origin rewrites the child's location (keeping its world
    // matrix), and the child's own Set Origin starts from that rewritten location
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [1, 0, 0] });
    const p = t.ctx.state.activeId!;
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], size: 0.5 });
    const c = t.ctx.state.activeId!;
    t.doc.updateObject(c, { parent: p, location: [2, 0, 0], rotation_euler: [0, 0, 0.3] });
    const corner = (id: string) => {
      const w = t.world(id);
      const m = t.doc.getMesh(t.doc.getObject(id)!.data!)!;
      return [0, 1, 2].map(
        (r) => w[r] * m.positions[0] + w[4 + r] * m.positions[1] + w[8 + r] * m.positions[2] + w[12 + r],
      );
    };
    const before = [corner(p), corner(c)];
    t.select([p, c], c);
    t.ctx.state.cursorLocation = [0, 0, 1];
    t.run('object.origin_set', { type: 'ORIGIN_CURSOR' });
    expect(maxDiff(t.origin(p), [0, 0, 1])).toBeLessThan(1e-9);
    expect(maxDiff(t.origin(c), [0, 0, 1])).toBeLessThan(1e-9);
    expect(maxDiff(corner(p), before[0])).toBeLessThan(1e-6);
    expect(maxDiff(corner(c), before[1])).toBeLessThan(1e-6);
  });

  it('Apply Rotation of an object whose animated rotation shows 0 resets the stored rotation, the mesh is not stored again', () => {
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0], rotation: [0, 0, 0.5] });
    const cube = t.ctx.state.activeId!;
    let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 1, 'LINEAR');
    t.doc.setFCurve(fc);
    t.ctx.state.frame = 1;
    const meshes = t.doc.map('meshes');
    let meshWrites = 0;
    const count = (tr: { changed: Map<unknown, unknown> }) => {
      for (const type of tr.changed.keys())
        if ((type as { parent?: unknown }).parent === meshes) meshWrites++;
    };
    t.doc.ydoc.on('afterTransaction', count);
    t.run('object.transform_apply', { rotation: true, scale: false });
    t.doc.ydoc.off('afterTransaction', count);
    expect(t.doc.getObject(cube)!.rotation_euler).toEqual([0, 0, 0]);
    expect(meshWrites).toBe(0);
  });

  it('Edit Mode tools (Merge at the cursor, adding a primitive) place geometry in world space as shown', () => {
    const t = setup();
    const { cube } = boneChild(t);
    t.run('object.mode_set', { mode: 'EDIT' });
    t.ctx.state.meshSelection = { verts: new Set([0, 1]), edges: new Set(), faces: new Set() };
    t.ctx.state.cursorLocation = [2, -1, 4];
    t.run('mesh.merge', { type: 'CURSOR' });
    const mesh = t.doc.getMesh(t.doc.getObject(cube)!.data!)!;
    const w = t.world(cube);
    const shown = (i: number) =>
      [0, 1, 2].map(
        (r) =>
          w[r] * mesh.positions[i * 3] +
          w[4 + r] * mesh.positions[i * 3 + 1] +
          w[8 + r] * mesh.positions[i * 3 + 2] +
          w[12 + r],
      );
    const merged = [...Array(mesh.positions.length / 3).keys()].map(shown);
    expect(Math.min(...merged.map((p) => maxDiff(p, [2, -1, 4])))).toBeLessThan(1e-6);
  });

  it('material warnings measure the scale the object is drawn with (an animated scale at the frame)', () => {
    const t = setup();
    t.run('mesh.primitive_cube_add', { location: [0, 0, 0] });
    const cube = t.ctx.state.activeId!;
    for (let i = 0; i < 3; i++) {
      let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'scale', index: i });
      fc = insertKeyframe(fc, 1, 1, 'LINEAR');
      fc = insertKeyframe(fc, 11, 3, 'LINEAR');
      t.doc.setFCurve(fc);
    }
    t.ctx.state.frame = 6;
    t.run('material.new', { name: 'M' });
    t.reports.length = 0;
    t.run('material.procedural_set', { material: 'M', procedural: { type: 'CHECKER', mapping: 'OBJECT' } });
    expect(t.reports.some((r) => r.includes('is scaled by (2, 2, 2)'))).toBe(true);
  });

  it('sculpting reaches the vertices where the scene shows them', () => {
    // GRAB at a corner of the cube parented to a posed bone moves that corner by exactly grab_delta
    const t = setup();
    const { cube } = boneChild(t);
    const corner = () => {
      const w = t.world(cube);
      const m = t.doc.getMesh(t.doc.getObject(cube)!.data!)!;
      return [0, 1, 2].map(
        (r) => w[r] * m.positions[0] + w[4 + r] * m.positions[1] + w[8 + r] * m.positions[2] + w[12 + r],
      );
    };
    const before = corner();
    t.run('sculpt.brush_stroke', {
      object: cube,
      brush: 'GRAB',
      points: [before],
      radius: 0.2,
      grab_delta: [0, 0, 0.5],
    });
    expect(maxDiff(corner(), [before[0], before[1], before[2] + 0.5])).toBeLessThan(1e-6);
  });
});
