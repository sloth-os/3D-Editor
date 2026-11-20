import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { createCube } from '../src/mesh/primitives';
import { lookAt } from '../src/desk/characters';
import { blueprintFor } from '../src/desk/characters/kinds';
import { multiply4, invert4 } from '../src/math/mat4';
import type { Mat4 } from '../src/math/types';
import { FrameState } from '../src/eval/frame-state';
import { meshWorldBounds } from '../src/store/builtin/kit';
import {
  UNIT_ROOT,
  UnitError,
  decodeUnit,
  deriveUnitId,
  extractUnit,
  insertUnit,
  planUnit,
  rigDigest,
  type UnitRecord,
} from '../src/desk/units';
import {
  KITE,
  MIRA,
  PIP,
  actorOf,
  dress,
  openBrief,
  pin,
  prop,
  propOf,
  stagedDoc,
  unitFrom,
} from './desk-units-helpers';

/*
 * Making units from a staged scene (desk/units/extract.ts): what each kind takes and leaves out, the
 * closure and cut references, F-curves and drivers, scene-owned values, the header, ids that survive
 * a round trip through an instance, determinism, and the size of the files.
 */

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof UnitError ? err.code : `not a UnitError: ${String(err)}`;
  }
  return 'no error';
};

const objectsOf = (unit: { body: { blocks: { objects?: Record<string, UnitRecord> } } }) =>
  unit.body.blocks.objects ?? {};
const props = (r: UnitRecord | undefined) => (r?.custom_props ?? {}) as Record<string, unknown>;
const close = (a: Mat4, b: Mat4, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

/** Twenty built-in models placed round the meadow as set dressing. */
const TWENTY: [string, number, number][] = [
  ['oak_tree', -14, 9],
  ['pine_tree', -12, 14],
  ['bush', -9, 6],
  ['rock', -7, 11],
  ['boulder', -16, 3],
  ['flower_bed', -4, 8],
  ['log', 6, 12],
  ['tree_stump', 8, 9],
  ['reeds', 3, 3],
  ['park_bench', 4, 6],
  ['picnic_table', 10, 4],
  ['streetlight', 12, 8],
  ['signpost', 14, 2],
  ['trash_bin', 11, 11],
  ['mailbox', 16, 10],
  ['swing_set', -10, -6],
  ['picket_fence', 0, 16],
  ['well', 7, -6],
  ['hay_bale', -5, -8],
  ['campfire', 2, -9],
];

describe('extractUnit: a figure', () => {
  it('takes the actor, its bone parts and materials; no animation, no constraints, the root at the origin', () => {
    const doc = stagedDoc();
    const mira = actorOf(doc, MIRA);
    lookAt(doc, mira.id, actorOf(doc, PIP).id, { frame: 10 });
    const { ex, unit } = unitFrom(doc, { kind: 'figure', actor: mira.id });
    const objs = objectsOf(unit);
    const root = objs[UNIT_ROOT];
    expect(Object.keys(unit.body.blocks.armatures ?? {})).toHaveLength(1);
    expect(Object.keys(objs)).toHaveLength(22);
    expect(Object.keys(unit.body.blocks.materials ?? {})).toHaveLength(3);
    expect(Object.keys(unit.body.blocks.cameras ?? {})).toHaveLength(0);
    expect(root).toMatchObject({
      type: 'ARMATURE',
      parent: null,
      location: [0, 0, 0],
      rotation_euler: [0, 0, 0],
      constraints: [],
    });
    const parts = Object.entries(objs).filter(([src]) => src !== UNIT_ROOT);
    for (const [, part] of parts) {
      expect(part).toMatchObject({ parent: UNIT_ROOT, parent_type: 'BONE' });
      expect(props(part).desk_actor).toBe(UNIT_ROOT);
    }
    // the look (DAMPED_TRACK on the neck and head at Pip) is the scene's: gone, with a warning
    const bones = (
      root.pose as {
        bones: Record<string, { constraints?: { target: string | null }[]; location: number[] }>;
      }
    ).bones;
    for (const b of Object.values(bones)) {
      for (const c of b.constraints ?? []) expect(c.target).toBeNull();
      expect(b.location).toEqual([0, 0, 0]);
    }
    expect(
      ex.warnings.some((w) => /^2 constraint\(s\) targeting objects outside the unit were left out/.test(w)),
    ).toBe(true);
    // F-curves of the actor are dropped (units carry none) and said
    expect(doc.listFCurves(mira.id).length).toBeGreaterThan(0);
    expect(ex.warnings.some((w) => /animation curve\(s\) were left out/.test(w))).toBe(true);
    expect(JSON.stringify(unit.body)).not.toContain('fcurve');
  });

  it("keeps the figure's own desk props, drops the scene's, and the parts' names lose their '.NNN'", () => {
    const doc = stagedDoc();
    const mira = actorOf(doc, MIRA);
    const chest = doc.listObjects().find((o) => o.name === 'Mira.chest')!;
    doc.rename('objects', chest.id, 'Chest.004');
    const { unit } = unitFrom(doc, { kind: 'figure', actor: mira.id });
    const root = objectsOf(unit)[UNIT_ROOT];
    expect(props(root)).toEqual({
      desk_role: 'actor',
      desk_kind: 'child',
      desk_height_m: 1.28,
      desk_color: '#ff8a3d',
    });
    const names = Object.values(objectsOf(unit)).map((r) => r.name);
    expect(names).toContain('Chest');
    expect(names.some((n) => /\.\d{3,}$/.test(String(n)))).toBe(false);
    expect(JSON.stringify(unit.body)).not.toMatch(/desk_rideo_|desk_character_id|chr_0123456789mira/);
  });

  it('writes the header: kind, height, colour, bones, parts, the rig digest and the bounds at rest', () => {
    const doc = stagedDoc();
    const { ex } = unitFrom(doc, { kind: 'figure', actor: actorOf(doc, MIRA).id });
    const bones = blueprintFor('child', 1.28).bones.map((b) => b.name);
    expect(ex.header.figure).toMatchObject({
      kind: 'child',
      heightM: 1.28,
      color: '#ff8a3d',
      bones: 22,
      parts: 21,
    });
    expect(ex.header.figure!.rig).toBe(rigDigest(bones));
    // the rig digest does not depend on the height: the bone names are the kind's
    expect(rigDigest(blueprintFor('child', 1.6).bones.map((b) => b.name))).toBe(ex.header.figure!.rig);
    expect(rigDigest(blueprintFor('dog', 0.55).bones.map((b) => b.name))).not.toBe(ex.header.figure!.rig);
    expect(ex.header.bounds!.min[2]).toBeCloseTo(0, 3);
    expect(ex.header.bounds!.max[2]).toBeCloseTo(1.28, 3);
    expect(ex.meta.actor).toEqual({ kind: 'child', heightM: 1.28 });
    expect(ex.from).toEqual({ castId: MIRA });
    expect(ex.basedOn).toBeNull();
    expect(ex.link).toMatchObject({
      kind: 'figure',
      key: `cast:${MIRA}`,
      rootSceneId: actorOf(doc, MIRA).id,
      synthesizeSetRoot: false,
    });
  });
});

describe('extractUnit: a prop', () => {
  it("takes the prop and its parts; its root carries none of the scene's desk props; the tail's animation goes", () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE);
    const { ex, unit } = unitFrom(doc, { kind: 'prop', root: kite.id });
    const objs = objectsOf(unit);
    expect(Object.keys(objs)).toHaveLength(9);
    expect(Object.keys(props(objs[UNIT_ROOT])).filter((k) => k.startsWith('desk_'))).toEqual([]);
    expect(ex.header.credits).toEqual([
      expect.objectContaining({ storeId: 'builtin:diamond_kite', license: 'CC0-1.0', objects: 1 }),
    ]);
    expect(ex.from).toEqual({ elementId: KITE });
    expect(ex.link.key).toBe(`el:${KITE}`);
    expect(ex.warnings.some((w) => /animation curve\(s\) were left out/.test(w))).toBe(true);
    // the string to the kite is the scene's action, never part of the kite
    expect(Object.values(objs).some((r) => r.name === 'Red kite String')).toBe(false);
  });

  it('a built-in dressing model keeps its store id and licence; its base is at the ground', () => {
    const doc = stagedDoc();
    const [bench] = dress(doc, [['park_bench', 4, 6]]);
    doc.updateObject(bench, { rotation_euler: [0, 0, 0.8] });
    const { ex, unit } = unitFrom(doc, { kind: 'prop', root: bench });
    const root = objectsOf(unit)[UNIT_ROOT];
    expect(props(root)).toMatchObject({ store_id: 'builtin:park_bench', license: 'CC0-1.0' });
    expect(root).toMatchObject({ location: [0, 0, 0], rotation_euler: [0, 0, 0] });
    expect(ex.header.prop!.base).toBeCloseTo(0, 3);
    expect(ex.header.prop!.storeId).toBe('builtin:park_bench');
    expect(ex.header.credits.map((c) => c.storeId)).toEqual(['builtin:park_bench']);
    expect(ex.meta.credits).toEqual([
      { name: 'Park Bench', author: '3D Editor built-in', license: 'CC0-1.0' },
    ]);
    expect(ex.from).toBeNull();
    expect(ex.link.key).toMatch(/^lib:[A-Za-z0-9]{16}$/);
  });

  it('refuses cameras, actors and actor parts as props, and a figure from anything but an actor', () => {
    const doc = stagedDoc();
    const mira = actorOf(doc, MIRA);
    const camera = doc.listObjects().find((o) => o.type === 'CAMERA')!;
    const part = doc.listObjects().find((o) => prop(o, 'desk_actor') === mira.id)!;
    expect(code(() => extractUnit(doc, { kind: 'prop', root: camera.id }, { deskVersion: 't' }))).toBe(
      'UNIT_BAD_SPEC',
    );
    expect(code(() => extractUnit(doc, { kind: 'prop', root: mira.id }, { deskVersion: 't' }))).toBe(
      'UNIT_BAD_SPEC',
    );
    expect(code(() => extractUnit(doc, { kind: 'prop', root: part.id }, { deskVersion: 't' }))).toBe(
      'UNIT_BAD_SPEC',
    );
    expect(
      code(() => extractUnit(doc, { kind: 'figure', actor: propOf(doc, KITE).id }, { deskVersion: 't' })),
    ).toBe('UNIT_BAD_SPEC');
    expect(code(() => extractUnit(doc, { kind: 'prop', root: 'nothing-here' }, { deskVersion: 't' }))).toBe(
      'UNIT_NOT_FOUND',
    );
    expect(
      code(() =>
        extractUnit(
          doc,
          { kind: 'prop', root: propOf(doc, KITE).id, name: 'x'.repeat(121) },
          { deskVersion: 't' },
        ),
      ),
    ).toBe('UNIT_BAD_SPEC');
    expect(
      code(() =>
        extractUnit(SceneDoc.create({ empty: true }), { kind: 'set', name: 'Empty' }, { deskVersion: 't' }),
      ),
    ).toBe('UNIT_EMPTY');
  });
});

describe('extractUnit: credits', () => {
  it('keeps at most 64 credits, and leaves the longest out of a header that would pass 64 KiB', () => {
    const doc = SceneDoc.create({ empty: true });
    const root = doc.addObject({ type: 'EMPTY', name: 'Shelf' });
    for (let i = 0; i < 70; i++)
      doc.addObject({
        type: 'EMPTY',
        name: `Model ${i} ${'n'.repeat(105)}`,
        parent: root,
        custom_props: {
          store_id: `store:${String(i).padStart(3, '0')}:${'s'.repeat(180)}`,
          store_source: 'store',
          license: 'CC-BY-4.0',
          author: `${i} ${'a'.repeat(190)}`,
          source_url: `https://example.org/${i}/${'u'.repeat(470)}`,
        },
      });
    const { ex } = unitFrom(doc, { kind: 'prop', root });
    expect(ex.warnings).toContain('6 credits were left out of the unit (it holds at most 64)');
    expect(ex.warnings).toContain("a credit was left out of the unit's header (it holds at most 64 KiB)");
    expect(ex.header.credits.length).toBeLessThan(64);
    expect(ex.header.credits.length).toBeGreaterThan(40);
    expect(new TextEncoder().encode(JSON.stringify(ex.header)).length).toBeLessThanOrEqual(64 * 1024);
    expect(ex.meta.credits.length).toBeLessThanOrEqual(32);
  });
});

describe('extractUnit: a set', () => {
  it('takes the ground, the pond and the dressing; leaves out actors, cameras, the brief props, the string and the sun', () => {
    const doc = stagedDoc();
    const dressing = dress(doc, TWENTY);
    const sun = doc.addObject({
      type: 'LIGHT',
      name: 'Sun',
      data: doc.addLight({ type: 'SUN', name: 'Sun' }),
    });
    const plan = planUnit(doc, { kind: 'set', name: 'Meadow' });
    const taken = new Set(plan.objects.map((o) => o.id));
    const ground = doc.listObjects().find((o) => prop(o, 'desk_label') === 'ground')!;
    const pond = doc.listObjects().find((o) => o.name === 'pond')!;
    for (const id of [ground.id, pond.id, ...dressing]) expect(taken.has(id)).toBe(true);
    const why = Object.fromEntries(plan.excluded.map((e) => [e.name, e.reason]));
    expect(why).toMatchObject({
      Mira: 'an actor',
      Pip: 'an actor',
      'Shot 1': 'a camera',
      'Shot 2': 'a camera',
      'Red kite': "a prop of the scene's action",
      'Red kite String': 'a kite string',
      Sun: 'the sun',
      'Mira.chest': 'under an object the set leaves out',
      sail: 'under an object the set leaves out',
    });
    expect(plan.root).toBeNull();
    expect(plan.instance).toBeNull();
    expect(taken.has(sun)).toBe(false);

    const { ex, unit } = unitFrom(doc, { kind: 'set', name: 'Meadow' });
    const objs = objectsOf(unit);
    const root = objs[UNIT_ROOT];
    expect(root).toMatchObject({ type: 'EMPTY', name: 'Meadow', parent: null, location: [0, 0, 0] });
    // every top-level piece hangs from the made root
    const tops = Object.entries(objs).filter(([src]) => [ground.id, pond.id, ...dressing].includes(src));
    expect(tops).toHaveLength(22);
    for (const [, r] of tops) expect(r.parent).toBe(UNIT_ROOT);
    expect(ex.header.set).toMatchObject({ width: 20, depth: 10, interior: false, hasGround: true });
    const pondMark = ex.header.set!.landmarks.find((l) => l.label === 'pond');
    expect(pondMark).toMatchObject({ role: 'landmark', water: true });
    expect(ex.header.set!.landmarks.filter((l) => l.role === 'dressing').length).toBeGreaterThanOrEqual(10);
    expect(ex.header.credits.length).toBe(20);
    expect(ex.link).toMatchObject({ kind: 'set', key: 'set', rootSceneId: null, synthesizeSetRoot: true });
    expect(ex.link.parts[`objects:${UNIT_ROOT}`].sceneId).toBe(deriveUnitId('set', UNIT_ROOT));
    expect(ex.from).toEqual({ set: true });
    // the set's root takes the scene's desk props only from the caller when it is inserted
    expect(Object.keys(props(root))).toEqual([]);
  });

  it("gives the set's own size: its stage and the height of its pieces, not the world beyond the set", () => {
    // the words' meadow (20 × 10 m): its ground, and the pond 2 cm above it; the ground's ring out to
    // the horizon (180 m each way here) is the world beyond the set, which counts for nothing
    const meadow = extractUnit(stagedDoc(), { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    expect(meadow.meta.dimensionsM).toEqual([20, 10, 0.02]);
    expect(meadow.header.bounds).toEqual({ min: [-10, -5, 0], max: [10, 5, 0.02] });
    // a room from the words: its stage and its 3.2 m walls
    const brief = openBrief();
    brief.set.interior = true;
    const room = extractUnit(stagedDoc(brief), { kind: 'set', name: 'Room' }, { deskVersion: 'test' });
    const { width, depth } = room.header.set!;
    expect(room.meta.dimensionsM).toEqual([width, depth, 3.2]);
    // an edited set: a 4 m tower beyond the stage's edge and the ground tilted 3° (which lifts the
    // ring tens of metres out by metres): the stage keeps its size, and the height is the tower's
    // over the tilted stage's low edge
    const doc = stagedDoc();
    doc.addObject({
      type: 'MESH',
      name: 'Tower',
      data: doc.addMesh('Tower', createCube()),
      location: [14, 2, 2],
      scale: [0.5, 0.5, 2],
    });
    const ground = doc.listObjects().find((o) => prop(o, 'desk_label') === 'ground')!;
    const tilt = (3 * Math.PI) / 180;
    doc.updateObject(ground.id, { rotation_euler: [tilt, 0, 0] });
    const edited = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    const [w, d, h] = edited.meta.dimensionsM;
    expect([w, d]).toEqual([20, 10]);
    expect(h).toBeCloseTo(4 + 5 * Math.sin(tilt), 3);
    expect(edited.header.bounds!.max[0]).toBeCloseTo(14.5, 4);
  });
});

describe('extractUnit: set landmarks', () => {
  it('sort the same whatever order the scene holds its pieces in (equal pieces by where they stand)', () => {
    // two equal crates; the unit holds pieces in id order, so the ids decide which comes first
    const marks = (leftId: string, rightId: string) => {
      const doc = stagedDoc();
      for (const [id, x] of [
        [leftId, -4],
        [rightId, 4],
      ] as const)
        doc.addObject(
          { type: 'MESH', name: 'Crate', data: doc.addMesh('Crate', createCube()), location: [x, 6, 1] },
          id,
        );
      return extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' }).header.set!.landmarks;
    };
    const a = marks('aaaaaaaa', 'zzzzzzzz');
    const b = marks('zzzzzzzz', 'aaaaaaaa');
    const crates = a.filter((l) => l.label === 'Crate');
    expect(crates.map((l) => l.x)).toEqual([-4, 4]);
    expect(b).toEqual(a);
  });
});

describe('extractUnit: the closure and cut references', () => {
  it('pulls in an ARRAY cap outside the subtree under the root, its place relative to the root kept', () => {
    const doc = stagedDoc();
    const [bench] = dress(doc, [['park_bench', 4, 6]]);
    doc.updateObject(bench, { rotation_euler: [0, 0, 0.6], scale: [1.5, 1.5, 1.5] });
    const [rock] = dress(doc, [['rock', 9, 2]]);
    doc.updateObject(rock, { rotation_euler: [0.1, 0.2, 1.3] });
    const seat = doc.listObjects().find((o) => o.parent === bench && o.type === 'MESH')!;
    const mira = actorOf(doc, MIRA);
    doc.updateObject(seat.id, {
      modifiers: [
        ...seat.modifiers,
        {
          id: 'arr',
          name: 'Array',
          type: 'ARRAY',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { count: 2, start_cap: rock, offset_object: mira.id },
        },
      ],
    });
    const { ex, unit } = unitFrom(doc, { kind: 'prop', root: bench });
    const objs = objectsOf(unit);
    const rockSrc = Object.keys(objs).find((src) => objs[src].name === doc.getObject(rock)!.name)!;
    expect(rockSrc).toBeTruthy();
    expect(objs[rockSrc].parent).toBe(UNIT_ROOT);
    const arr = (
      objs[Object.keys(objs).find((s) => objs[s].name === seat.name)!].modifiers as {
        type: string;
        params: Record<string, unknown>;
      }[]
    ).find((m) => m.type === 'ARRAY')!;
    expect(arr.params.start_cap).toBe(rockSrc);
    expect(arr.params.offset_object).toBeNull();
    expect(
      ex.warnings.some((w) => /references cut where they leave the unit: .*Mira \(an actor\)/.test(w)),
    ).toBe(true);
    // the cap keeps its place relative to the root: in the probe, and inserted where the bench stood
    const probe = ex.probe;
    const probeRoot = probe.listObjects().find((o) => o.parent === null)!;
    const probeRock = probe.listObjects().find((o) => o.name === doc.getObject(rock)!.name)!;
    const rel = (d: SceneDoc, root: string, id: string) =>
      multiply4(invert4(d.worldMatrix(root)), d.worldMatrix(id));
    expect(close(rel(probe, probeRoot.id, probeRock.id), rel(doc, bench, rock))).toBe(true);
    const dst = SceneDoc.create({ empty: true });
    const b = doc.getObject(bench)!;
    const ins = insertUnit(dst, decodeUnit(ex.data), {
      ...pin(),
      key: 'el:ele_bench',
      location: b.location,
      rotation_euler: b.rotation_euler,
    });
    expect(close(dst.worldMatrix(ins.ids[`objects:${rockSrc}`]), doc.worldMatrix(rock), 1e-9)).toBe(true);
  });

  it('never pulls in an ancestor of the root (adoption would hang it from its own child)', () => {
    const doc = stagedDoc();
    const [bench] = dress(doc, [['park_bench', 4, 6]]);
    const [rock] = dress(doc, [['rock', 9, 2]]);
    doc.setParent(bench, rock, true);
    const seat = doc.listObjects().find((o) => o.parent === bench && o.type === 'MESH')!;
    doc.updateObject(seat.id, {
      modifiers: [
        {
          id: 'arr',
          name: 'Array',
          type: 'ARRAY',
          show_viewport: true,
          show_render: true,
          show_in_editmode: true,
          show_expanded: true,
          params: { count: 2, end_cap: rock },
        },
      ],
    });
    const { ex, unit } = unitFrom(doc, { kind: 'prop', root: bench });
    expect(Object.values(objectsOf(unit)).some((r) => r.name === doc.getObject(rock)!.name)).toBe(false);
    expect(ex.warnings.some((w) => /an ancestor of the unit's root/.test(w))).toBe(true);
  });

  it('keeps a driver only when its target and every variable lie inside the unit', () => {
    const doc = stagedDoc();
    const [bench] = dress(doc, [['park_bench', 4, 6]]);
    const seat = doc.listObjects().find((o) => o.parent === bench && o.type === 'MESH')!;
    const mira = actorOf(doc, MIRA);
    const v = (id: string) => ({
      name: 'v',
      target_type: 'object' as const,
      target_id: id,
      path: 'location',
      index: 0,
    });
    doc.setDriver({
      target_type: 'object',
      target_id: seat.id,
      path: 'location',
      index: 2,
      expression: 'v * 0.1',
      variables: [v(bench)],
      mute: false,
    });
    doc.setDriver({
      target_type: 'object',
      target_id: seat.id,
      path: 'location',
      index: 0,
      expression: 'v',
      variables: [v(mira.id)],
      mute: false,
    });
    doc.setDriver({
      target_type: 'object',
      target_id: mira.id,
      path: 'location',
      index: 1,
      expression: 'v',
      variables: [v(seat.id)],
      mute: false,
    });
    const { ex, unit } = unitFrom(doc, { kind: 'prop', root: bench });
    expect(unit.body.drivers).toHaveLength(1);
    const seatSrc = Object.keys(objectsOf(unit)).find((s) => objectsOf(unit)[s].name === seat.name)!;
    expect(unit.body.drivers[0]).toMatchObject({
      target_id: seatSrc,
      index: 2,
      variables: [{ target_id: UNIT_ROOT }],
    });
    expect(ex.header.counts.drivers).toBe(1);
  });
});

describe('extractUnit: ids, determinism and a round trip through an instance', () => {
  it('gives the same bytes for the same scene, and for a copy of it', () => {
    const doc = stagedDoc();
    const kite = propOf(doc, KITE).id;
    const a = extractUnit(doc, { kind: 'prop', root: kite }, { deskVersion: 'test' });
    const b = extractUnit(doc, { kind: 'prop', root: kite }, { deskVersion: 'test' });
    const c = extractUnit(
      SceneDoc.fromUpdate(doc.encodeState()),
      { kind: 'prop', root: kite },
      { deskVersion: 'test' },
    );
    expect(b.sha256).toBe(a.sha256);
    expect(c.sha256).toBe(a.sha256);
    expect([...c.data]).toEqual([...a.data]);
    // the scene is not changed by an extraction
    const before = doc.encodeState();
    extractUnit(doc, { kind: 'figure', actor: actorOf(doc, MIRA).id }, { deskVersion: 'test' });
    expect([...doc.encodeState()]).toEqual([...before]);
  });

  it('extracting again from an inserted instance gives the same source ids and the same body', () => {
    const src = stagedDoc();
    const { ex, unit } = unitFrom(src, { kind: 'figure', actor: actorOf(src, MIRA).id });
    const dst = stagedDoc();
    const ins = insertUnit(dst, unit, {
      ...pin(1, ex.sha256),
      key: `cast:${MIRA}`,
      replace: actorOf(dst, MIRA).id,
    });
    const again = unitFrom(dst, { kind: 'figure', actor: ins.root });
    for (const k of ['objects', 'meshes', 'materials', 'armatures'] as const)
      expect(Object.keys(again.unit.body.blocks[k] ?? {}).sort()).toEqual(
        Object.keys(unit.body.blocks[k] ?? {}).sort(),
      );
    expect(again.ex.header.digest).toBe(ex.header.digest);
    expect(again.ex.basedOn).toEqual({ ref: 'lib_0123456789test', version: 1 });
    expect(again.ex.link.key).toBe(`cast:${MIRA}`);
    expect(again.ex.link.rootSceneId).toBe(ins.root);
  });
});

describe('the size of unit files', () => {
  it('stays within budget: a figure, a built-in prop, a set staged from a brief alone', () => {
    const doc = stagedDoc();
    const figure = extractUnit(
      doc,
      { kind: 'figure', actor: actorOf(doc, MIRA).id },
      { deskVersion: 'test' },
    );
    const [bench] = dress(doc, [['park_bench', 4, 6]]);
    const benchUnit = extractUnit(doc, { kind: 'prop', root: bench }, { deskVersion: 'test' });
    const set = extractUnit(stagedDoc(), { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    expect(figure.data.length).toBeLessThanOrEqual(40 * 1024);
    expect(benchUnit.data.length).toBeLessThanOrEqual(16 * 1024);
    expect(set.data.length).toBeLessThanOrEqual(8 * 1024);
    // identical part meshes are stored once: the left and right parts share their bytes
    expect(figure.header.counts.blobBytes).toBeLessThan(figure.header.bodyBytes);
  });

  it('measures the probe: bounds at rest equal a figure made at rest', () => {
    const doc = stagedDoc();
    const { ex } = unitFrom(doc, { kind: 'figure', actor: actorOf(doc, MIRA).id });
    const ids = ex.probe
      .listObjects()
      .filter((o) => o.type === 'MESH')
      .map((o) => o.id);
    const b = meshWorldBounds(ex.probe, ids, 0)!;
    expect(b.min[2]).toBeCloseTo(ex.header.bounds!.min[2], 4);
    expect(b.max[0]).toBeCloseTo(ex.header.bounds!.max[0], 4);
    expect(
      new FrameState(ex.probe, 0).world(ex.probe.listObjects().find((o) => o.type === 'ARMATURE')!.id),
    ).toBeTruthy();
  });
});
