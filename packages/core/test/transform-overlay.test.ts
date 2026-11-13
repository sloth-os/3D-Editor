import { describe, expect, it } from 'vitest';
import {
  FrameState,
  ObjectTransform,
  SceneDoc,
  compose4,
  createConstraint,
  createFCurve,
  defaultBone,
  defaultPoseBone,
  defaultSpline,
  defaultSplinePoint,
  insertKeyframe,
  translation4,
  type ConstraintData,
  type Mat4,
  type PivotPoint,
  type TransformChannels,
  type TransformMode,
  type Vec3,
} from '../src';

/*
 * The world matrices the modal Move, Rotate and Scale preview while the pointer moves
 * (ObjectTransform.worlds): a frame state replacing the channels of the moved objects that
 * evaluates only the objects the move can change and reads everything else from the frame state
 * the transform started from (FrameStateOptions.affected). It must give exactly what evaluating
 * the whole scene with those channels gives, and the objects it leaves out must be the ones the
 * move leaves where they are.
 */

const zero: Vec3 = [0, 0, 0];
const one: Vec3 = [1, 1, 1];

/** What a full evaluation of the scene with `channels` gives for every object. */
function fullWorlds(fs: FrameState, channels: ReadonlyMap<string, TransformChannels>) {
  const full = new FrameState(fs.doc, fs.frame, fs.simulated, { base: fs, channels });
  return (id: string) => full.world(id);
}

describe('the preview of a transform evaluates only the objects it can change', () => {
  it('gives what the whole scene evaluates in random scenes, and leaves out only objects that stay (seeded)', () => {
    let seed = 11;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    const rand3 = (s = 2): Vec3 => [rnd() * 2 * s - s, rnd() * 2 * s - s, rnd() * 2 * s - s];
    const types = [
      'COPY_LOCATION',
      'COPY_ROTATION',
      'COPY_SCALE',
      'COPY_TRANSFORMS',
      'TRACK_TO',
      'DAMPED_TRACK',
      'CHILD_OF',
      'LIMIT_DISTANCE',
      'FOLLOW_PATH',
      'CLAMP_TO',
    ] as const;
    const modes: TransformMode[] = ['TRANSLATE', 'ROTATE', 'RESIZE'];
    const pivots: PivotPoint[] = ['MEDIAN_POINT', 'INDIVIDUAL_ORIGINS', 'CURSOR'];
    let readers = 0;
    let bones = 0;
    let driven = 0;
    let paths = 0;
    for (let scene = 0; scene < 150; scene++) {
      const doc = SceneDoc.create({ empty: true });
      // two free empties (no relations): the only objects the rig's bone constraints and the
      // drivers read, so no cycle runs through a pose or a driver (whose result would depend on
      // the order objects are evaluated in, in a full evaluation too)
      const free = [0, 1].map((i) =>
        doc.addObject({ type: 'EMPTY', name: `F${i}`, location: rand3(), rotation_euler: rand3(1) }),
      );
      const ids = Array.from({ length: 6 }, (_, i) =>
        doc.addObject({
          type: 'EMPTY',
          name: `O${i}`,
          location: rand3(),
          rotation_euler: rand3(1),
          scale: [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
        }),
      );
      const rigBones = [
        defaultBone('B0', [0, 0, 0], [0, 0, 1]),
        { ...defaultBone('B1', [0, 0, 1], [0, 1, 2]), parent: 'B0' },
      ];
      const rig = doc.addObject({
        type: 'ARMATURE',
        name: 'Rig',
        location: rand3(),
        data: doc.addArmature({ bones: rigBones }),
      });
      const points = [
        defaultSplinePoint([0, 0, 0]),
        defaultSplinePoint([3, 0, 0]),
        defaultSplinePoint([3, 3, 0]),
      ];
      const data = doc.addCurve({ splines: [{ ...defaultSpline('POLY'), points }] });
      const curve = doc.addObject({ type: 'CURVE', name: 'Path', data, location: rand3() });
      const related = [rig, ...ids, curve];
      const all = [...free, ...related];
      // random object and bone parents (each among the objects listed before it: no parent
      // loops), constraints on objects and on the curve (cycles through constraints and parents
      // included) and bone constraints of the rig
      related.forEach((id, i) => {
        const parent = rnd() < 0.5 ? all[Math.floor(rnd() * (i + free.length))] : null;
        if (parent === rig && rnd() < 0.7)
          doc.updateObject(id, { parent, parent_type: 'BONE', parent_bone: pick(['B0', 'B1']) });
        else if (parent) doc.updateObject(id, { parent });
        if (id === rig) return;
        const constraints = Array.from({ length: Math.floor(rnd() * 3) }, () => {
          const type = pick(types);
          const target = type === 'FOLLOW_PATH' || type === 'CLAMP_TO' ? curve : pick(all);
          const subtarget = target === rig && rnd() < 0.7 ? pick(['B0', 'B1']) : '';
          // the copy constraints in LOCAL spaces read their owner's and target's own channels
          const spaces = type.startsWith('COPY_')
            ? { params: { target_space: pick(['WORLD', 'LOCAL']), owner_space: pick(['WORLD', 'LOCAL']) } }
            : {};
          return createConstraint(type, { target, subtarget, influence: rnd() < 0.3 ? 0.5 : 1, ...spaces });
        });
        doc.updateObject(id, { constraints });
      });
      if (rnd() < 0.6) {
        const ik: ConstraintData = {
          ...createConstraint('IK' as ConstraintData['type'], { target: free[0] }),
          params: { chain_count: 2, ...(rnd() < 0.5 ? { pole_target: free[1] } : {}) },
        };
        const copy = createConstraint('COPY_LOCATION', { target: pick(free) });
        doc.updateObject(rig, {
          pose: {
            bones: {
              B0: defaultPoseBone(),
              B1: { ...defaultPoseBone(), constraints: [rnd() < 0.5 ? ik : copy] },
            },
          },
        });
      }
      // drivers of objects and of the curve's data, reading a free empty's location
      const drive = (target_type: 'object' | 'curve', target_id: string, path: string, index: number) =>
        doc.setDriver({
          target_type,
          target_id,
          path,
          index,
          expression: 'v * 0.5 + 1',
          variables: [
            { name: 'v', target_type: 'object', target_id: pick(free), path: 'location', index: 0 },
          ],
          mute: false,
        });
      if (rnd() < 0.5) drive('object', pick(related), 'location', 1);
      if (rnd() < 0.3) drive('object', pick(related), 'rotation_euler', 2);
      if (rnd() < 0.3) drive('curve', data, 'eval_time', 0);
      // animation: the transform starts from what the scene shows at frame 4
      if (rnd() < 0.5) {
        const id = pick(all);
        let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 2 });
        fc = insertKeyframe(insertKeyframe(fc, 1, 0), 9, 4);
        doc.setFCurve(fc);
      }
      const fs = new FrameState(doc, 4);
      const moved = Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => pick(all));
      const mode = pick(modes);
      const xf = new ObjectTransform(fs, moved, pick(pivots), mode);
      const m: Mat4 =
        mode === 'TRANSLATE'
          ? translation4(rand3())
          : mode === 'ROTATE'
            ? compose4(zero, rand3(Math.PI), one)
            : compose4(zero, zero, [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()]);
      const channels = xf.channels(m, xf.pivot({ cursorLocation: rand3(), activeId: moved[0] }));
      const out = xf.worlds(channels);
      const full = fullWorlds(fs, channels);
      for (const id of all) expect(out.get(id) ?? fs.world(id), `scene ${scene}`).toEqual(full(id));
      // what the scenes exercise
      const outside = [...out.keys()].filter((id) => !channels.has(id));
      if (outside.length) readers++;
      if (outside.some((id) => doc.getObject(id)!.parent_type === 'BONE')) bones++;
      if (outside.some((id) => doc.listDrivers().some((d) => d.target_id === id))) driven++;
      if (outside.includes(curve) && !channels.has(curve)) paths++;
    }
    expect(readers).toBeGreaterThan(100);
    expect(bones).toBeGreaterThan(10);
    expect(driven).toBeGreaterThan(10);
    expect(paths).toBeGreaterThan(3);
  });

  it('evaluates a long chain of readers in dependency order, never recursing through it', () => {
    // M moves; C1 copies M's location plus its own [1, 0, 0], C2 copies C1 the same way … C1500;
    // X, a child of M (so found right after M), copies C1500: evaluated before the chain, it would
    // recurse through all of it (deep enough to overflow the stack, which a constraint reports as
    // its error, leaving X where the chain does not put it)
    const doc = SceneDoc.create({ empty: true });
    const n = 1500;
    const chain: string[] = [];
    let m = '';
    let x = '';
    doc.transact(() => {
      m = doc.addObject({ type: 'EMPTY', name: 'M' });
      for (let i = 0; i < n; i++)
        chain.push(
          doc.addObject({ type: 'EMPTY', name: `C${String(i).padStart(5, '0')}`, location: [1, 0, 0] }),
        );
      chain.forEach((id, i) =>
        doc.updateObject(id, {
          constraints: [
            createConstraint('COPY_LOCATION', { target: i ? chain[i - 1] : m, params: { use_offset: true } }),
          ],
        }),
      );
      x = doc.addObject({
        type: 'EMPTY',
        name: 'X',
        parent: m,
        constraints: [createConstraint('COPY_LOCATION', { target: chain[n - 1] })],
      });
    });
    const fs = new FrameState(doc, 1);
    const xf = new ObjectTransform(fs, [m], 'MEDIAN_POINT', 'TRANSLATE');
    const out = xf.worlds(xf.channels(translation4([0, 2, 0]), [0, 0, 0]));
    expect(out.size).toBe(n + 2);
    expect(out.get(x)!.slice(12, 15)).toEqual([n, 2, 0]);
    expect(out.get(chain[699])!.slice(12, 15)).toEqual([700, 2, 0]);
  });

  it('reads what the move does not change from the frame state it started from', () => {
    const doc = SceneDoc.create({ empty: true });
    const moved = doc.addObject({ type: 'EMPTY', name: 'Moved' });
    const child = doc.addObject({ type: 'EMPTY', name: 'Child', parent: moved, location: [0, 0, 1] });
    const other = doc.addObject({ type: 'EMPTY', name: 'Other', location: [5, 0, 0] });
    const rig = doc.addObject({
      type: 'ARMATURE',
      name: 'Rig',
      data: doc.addArmature({ bones: [defaultBone('B', [0, 0, 0], [0, 0, 1])] }),
    });
    // a pose problem the frame state the move started from reports, the preview does not again
    doc.updateObject(rig, {
      pose: { bones: { B: { ...defaultPoseBone(), location: 'up' as unknown as Vec3 } } },
    });
    const data = doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([1, 0, 0])] },
      ],
    });
    const driven = doc.addCurve({
      splines: [
        { ...defaultSpline('POLY'), points: [defaultSplinePoint([0, 0, 0]), defaultSplinePoint([1, 0, 0])] },
      ],
    });
    const path = doc.addObject({ type: 'CURVE', name: 'Path', data });
    const drivenPath = doc.addObject({ type: 'CURVE', name: 'Driven path', data: driven });
    doc.setDriver({
      target_type: 'curve',
      target_id: driven,
      path: 'eval_time',
      index: 0,
      expression: 'v',
      variables: [{ name: 'v', target_type: 'object', target_id: moved, path: 'location', index: 0 }],
      mute: false,
    });
    // a broken driver on an object the move leaves alone: the frame state the move started from
    // reports it, the preview does not evaluate that object again
    doc.setDriver({
      target_type: 'object',
      target_id: other,
      path: 'location',
      index: 1,
      expression: 'nope',
      variables: [],
      mute: false,
    });
    const fs = new FrameState(doc, 1);
    expect(fs.errors.map((e) => e.source)).toEqual([expect.stringContaining(other)]);
    const location: Vec3 = [3, 0, 0];
    const channels = new Map([[moved, { location, rotation_euler: zero, scale: one }]]);
    const affected = new Set([moved, child, drivenPath]);
    const after = new FrameState(doc, 1, null, { base: fs, channels, affected });
    // objects, poses and datablocks the move leaves alone are the base's
    expect(after.get('object', other)).toBe(fs.get('object', other));
    expect(after.world(other)).toBe(fs.world(other));
    expect(after.local(other)).toBe(fs.local(other));
    expect(after.parent(other)).toBe(fs.parent(other));
    expect(after.pose(rig)).toBe(fs.pose(rig));
    expect(fs.errors.map((e) => e.source)).toContain(`pose:${rig}`);
    expect(after.boneMatrix(rig, 'B')).toEqual(fs.boneMatrix(rig, 'B'));
    expect(after.curve(data)).toBe(fs.curve(data));
    expect(after.curvePath(path)!.path).toBe(fs.curvePath(path)!.path);
    // the moved object and its child are evaluated anew, a datablock with a driver too
    expect(after.world(moved)!.slice(12, 15)).toEqual(location);
    expect(after.world(child)!.slice(12, 15)).toEqual([3, 0, 1]);
    expect(after.parent(child)).toEqual(after.world(moved));
    expect(after.local(child)).toEqual(fs.local(child));
    expect(after.curve(driven)!.eval_time).toBe(3);
    expect(fs.curve(driven)!.eval_time).toBe(0);
    expect(after.curvePath(drivenPath)!.curve.eval_time).toBe(3);
    expect(after.curvePath(drivenPath)!.path).not.toBe(fs.curvePath(drivenPath)!.path);
    expect(after.errors).toEqual([]);
    // listing the scene's objects gives every object, the moved one with its new channels
    expect(after.objects.map((o) => o.id)).toEqual(fs.objects.map((o) => o.id));
    expect(after.byId.get(moved)!.location).toEqual(location);
    expect(after.byId.get(other)).toBe(fs.byId.get(other));
    // without `affected`, or with a base at another frame or with other simulated matrices,
    // every object is evaluated anew
    const anew = new FrameState(doc, 1, null, { base: fs, channels });
    expect(anew.get('object', other)).not.toBe(fs.get('object', other));
    expect(anew.errors.map((e) => e.source)).toEqual([expect.stringContaining(other)]);
    const elsewhere = new FrameState(doc, 2, null, { base: fs, channels, affected });
    expect(elsewhere.get('object', other)).not.toBe(fs.get('object', other));
    expect(elsewhere.world(child)!.slice(12, 15)).toEqual([3, 0, 1]);
    const simulated = new FrameState(doc, 1, new Map(), { base: fs, channels, affected });
    expect(simulated.get('object', other)).not.toBe(fs.get('object', other));
  });

  it('finds the constraints on a dependency cycle as the scene does', () => {
    // A (moved) is the parent of B; B tracks C and C tracks B: both constraints are on a cycle
    const doc = SceneDoc.create({ empty: true });
    const a = doc.addObject({ type: 'EMPTY', name: 'A' });
    const b = doc.addObject({ type: 'EMPTY', name: 'B', parent: a, location: [1, 0, 0] });
    const c = doc.addObject({ type: 'EMPTY', name: 'C', location: [0, 3, 0] });
    doc.updateObject(b, { constraints: [createConstraint('DAMPED_TRACK', { target: c })] });
    doc.updateObject(c, { constraints: [createConstraint('DAMPED_TRACK', { target: b })] });
    const fs = new FrameState(doc, 1);
    const xf = new ObjectTransform(fs, [a], 'MEDIAN_POINT', 'TRANSLATE');
    const channels = xf.channels(translation4([0, 0, 2]), [0, 0, 0]);
    const out = xf.worlds(channels);
    const full = fullWorlds(fs, channels);
    expect([...out.keys()].sort()).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) expect(out.get(id)).toEqual(full(id));
    expect(out.get(b)!.slice(12, 15)).toEqual([1, 0, 2]);
    // the cycle leaves both untracked: B keeps its parent's orientation
    expect(out.get(b)!.slice(0, 3)).toEqual([1, 0, 0]);
  });
});
