import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, fcurveKey } from '../src/doc/scene-doc';
import { createConstraint } from '../src/constraints/catalogue';
import { applyPose, holdProp } from '../src/desk/characters';
import { getShots } from '../src/desk/shots';
import { FrameState } from '../src/eval/frame-state';
import {
  UNIT_ROOT,
  UnitError,
  adoptUnit,
  decodeUnit,
  docHasUnitInstances,
  extractUnit,
  insertUnit,
  listUnits,
  makeLocal,
  unitOf,
  unitStatus,
  unitsInUse,
  updateUnit,
  type UnitBody,
  type UnitPayload,
  type UnitRecord,
} from '../src/desk/units';
import {
  KITE,
  MIRA,
  PIP,
  actorOf,
  dress,
  editedUnit,
  pin,
  propOf,
  stagedDoc,
  unitFrom,
} from './desk-units-helpers';

/*
 * Updating an instance to another version (desk/units/update.ts), making it local, listing and
 * status (list.ts, status.ts) and adoption after a publish (adopt.ts).
 */

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof UnitError ? err.code : `not a UnitError: ${String(err)}`;
  }
  return 'no error';
};

const SHA1 = '1'.repeat(64);
const SHA2 = '2'.repeat(64);

/** The source id of the unit record named `name` (objects by default). */
function srcNamed(body: UnitBody, name: string, kind: keyof UnitBody['blocks'] = 'objects'): string {
  const hit = Object.entries(body.blocks[kind] ?? {}).find(([, r]) => r.name === name);
  if (!hit) throw new Error(`no ${kind} named ${name}`);
  return hit[0];
}

/**
 * A staged scene whose Mira is the library figure (version 1, replacing the procedural actor), who
 * holds the kite and waves: the instance, its unit and the scene ids of a few parts.
 */
function instanceScene() {
  const src = stagedDoc();
  const v1 = unitFrom(src, { kind: 'figure', actor: actorOf(src, MIRA).id }).unit;
  const doc = stagedDoc();
  const mira = actorOf(doc, MIRA).id;
  const r = insertUnit(doc, v1, { ...pin(1, SHA1), key: `cast:${MIRA}`, replace: mira });
  holdProp(doc, mira, propOf(doc, KITE).id, { frame: 10 });
  applyPose(doc, mira, 'wave', { frame: 12 });
  const id = (name: string, kind: keyof UnitBody['blocks'] = 'objects') =>
    r.ids[`${kind}:${srcNamed(v1.body, name, kind)}`];
  return { doc, v1, mira, ids: r.ids, id };
}

const recolour = (body: UnitBody) => {
  body.blocks.materials![srcNamed(body, 'Mira Body', 'materials')].base_color = [0.1, 0.5, 0.2, 1];
};

describe('updateUnit', () => {
  it('replaces untouched parts in place, ids kept; holds, shots and animation still resolve', () => {
    const { doc, v1, mira, id } = instanceScene();
    const v2 = editedUnit(v1, recolour);
    const body = id('Mira Body', 'materials');
    const kite = propOf(doc, KITE).id;
    const shots = getShots(doc).map((s) => s.subjects);
    const curves = doc.listFCurves(mira).map(fcurveKey).sort();
    const report = updateUnit(doc, mira, v2, pin(2, SHA2));
    expect(report).toMatchObject({
      root: mira,
      noop: false,
      from: { version: 1, digest: v1.header.digest },
      to: { version: 2, digest: v2.header.digest },
    });
    expect(report.updated.map((p) => p.id)).toEqual([body]);
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(doc.getMaterial(body)!.base_color).toEqual([0.1, 0.5, 0.2, 1]);
    expect(getShots(doc).map((s) => s.subjects)).toEqual(shots);
    expect(doc.listFCurves(mira).map(fcurveKey).sort()).toEqual(curves);
    const hold = doc.getObject(kite)!.constraints.find((c) => c.type === 'CHILD_OF')!;
    expect(hold.target).toBe(mira);
    expect(new FrameState(doc, 20).world(kite)).toBeTruthy();
    expect(listUnits(doc)[0]).toMatchObject({ version: 2, sha256: SHA2, digest: v2.header.digest });
    expect(unitStatus(doc, mira)).toEqual({ edited: [], missing: [] });
  });

  it('keeps a part edited here (reason edited), and warns when the new version changed it too', () => {
    const { doc, v1, mira, id } = instanceScene();
    const head = id('Mira.head');
    doc.updateObject(head, { scale: [1.2, 1.2, 1.2] });
    expect(unitStatus(doc, mira).edited.map((p) => p.id)).toEqual([head]);
    const v2 = editedUnit(v1, (b) => {
      recolour(b);
      b.blocks.objects![srcNamed(b, 'Mira.head')].show_wire = true;
    });
    const report = updateUnit(doc, mira, v2, pin(2, SHA2));
    expect(report.kept).toEqual([expect.objectContaining({ id: head, reason: 'edited' })]);
    expect(report.warnings).toContain(
      "'Mira.head' was edited here and changed in the new version: the scene's is kept",
    );
    expect(doc.getObject(head)!.scale).toEqual([1.2, 1.2, 1.2]);
    expect(doc.getObject(head)!.show_wire).toBe(false);
    // still edited after the update: its stamp stays the old one
    expect(unitStatus(doc, mira).edited.map((p) => p.id)).toEqual([head]);
  });

  it('does not bring back a part deleted here, nor its mesh', () => {
    const { doc, v1, mira, id } = instanceScene();
    const toe = id('Mira.toe.L');
    const mesh = doc.getObject(toe)!.data!;
    doc.removeObject(toe);
    expect(doc.has('meshes', mesh)).toBe(false);
    expect(
      unitStatus(doc, mira)
        .missing.map((p) => p.id)
        .sort(),
    ).toEqual([mesh, toe].sort());
    const report = updateUnit(doc, mira, editedUnit(v1, recolour), pin(2, SHA2));
    expect(
      report.kept
        .filter((k) => k.reason === 'deleted')
        .map((k) => k.id)
        .sort(),
    ).toEqual([mesh, toe].sort());
    expect(doc.getObject(toe)).toBeNull();
    expect(doc.has('meshes', mesh)).toBe(false);
  });

  it('adds a new part with a derived id; removes a dropped untouched part with its data; keeps a dropped part the scene animates', () => {
    const { doc, v1, mira, id } = instanceScene();
    const toeL = id('Mira.toe.L');
    const toeR = id('Mira.toe.R');
    const toeLMesh = doc.getObject(toeL)!.data!;
    doc.setFCurve({
      target_type: 'object',
      target_id: toeR,
      path: 'hide_viewport',
      index: 0,
      keyframes: [{ frame: 1, value: 0, interpolation: 'CONSTANT' }],
      extrapolation: 'CONSTANT',
      mute: false,
    });
    const v2 = editedUnit(v1, (b) => {
      const objs = b.blocks.objects!;
      const l = srcNamed(b, 'Mira.toe.L');
      const r = srcNamed(b, 'Mira.toe.R');
      const lMesh = objs[l].data as string;
      const rMesh = objs[r].data as string;
      const hat: UnitRecord = {
        ...structuredClone(objs[srcNamed(b, 'Mira.head')]),
        name: 'Hat',
        location: [0, 0, 0.2],
      };
      delete objs[l];
      delete objs[r];
      if (!Object.values(objs).some((o) => o.data === lMesh)) delete b.blocks.meshes![lMesh];
      if (!Object.values(objs).some((o) => o.data === rMesh)) delete b.blocks.meshes![rMesh];
      objs.hat0000000000001 = hat;
    });
    const report = updateUnit(doc, mira, v2, pin(2, SHA2));
    expect(report.added.map((p) => p.src)).toEqual(['hat0000000000001']);
    const hat = report.added[0].id;
    expect(doc.getObject(hat)).toMatchObject({ parent: mira, parent_type: 'BONE', parent_bone: 'head' });
    expect(doc.getObject(hat)!.custom_props.desk_actor).toBe(mira);
    expect(report.removed.map((p) => p.id)).toContain(toeL);
    expect(doc.getObject(toeL)).toBeNull();
    if (report.removed.some((p) => p.id === toeLMesh)) expect(doc.has('meshes', toeLMesh)).toBe(false);
    expect(report.kept).toContainEqual(expect.objectContaining({ id: toeR, reason: 'dropped-but-used' }));
    expect(doc.getObject(toeR)).toBeTruthy();
    // taken out of the table: no longer a part of the instance
    expect(unitOf(doc, toeR)).toBeNull();
    expect(unitOf(doc, hat)).toBe(mira);
    expect(unitStatus(doc, mira)).toEqual({ edited: [], missing: [] });
  });

  it("keeps the scene's own fields: root placement, constraints, physics, pose, desk props and names", () => {
    const { doc, v1, mira, id } = instanceScene();
    const head = id('Mira.head');
    doc.rename('objects', head, 'Noggin');
    doc.updateObject(mira, {
      location: [3, 4, 0],
      constraints: [createConstraint('LIMIT_LOCATION', {})],
      rigid_body: null,
      custom_props: { ...doc.getObject(mira)!.custom_props, desk_rideo_clip: 'clp_other' },
    });
    const pose = doc.getObject(mira)!.pose;
    const v2 = editedUnit(v1, (b) => {
      recolour(b);
      const h = b.blocks.objects![srcNamed(b, 'Mira.head')];
      h.show_in_front = true;
      const root = b.blocks.objects![UNIT_ROOT];
      root.custom_props = {
        ...(root.custom_props as object),
        desk_color: '#00ff00',
        desk_character_id: 'nope',
      };
    });
    const report = updateUnit(doc, mira, v2, pin(2, SHA2));
    expect(report.updated.map((p) => p.id).sort()).toEqual([mira, head, id('Mira Body', 'materials')].sort());
    const root = doc.getObject(mira)!;
    expect(root.location).toEqual([3, 4, 0]);
    expect(root.constraints.map((c) => c.type)).toEqual(['LIMIT_LOCATION']);
    expect(root.pose).toEqual(pose);
    expect(root.custom_props).toMatchObject({
      desk_rideo_clip: 'clp_other',
      desk_character_id: MIRA,
      desk_color: '#00ff00',
    });
    expect(doc.getObject(head)).toMatchObject({ name: 'Noggin', show_in_front: true });
  });

  it('is a noop for the same content (only the provenance moves), one undo step otherwise', () => {
    const { doc, v1, mira } = instanceScene();
    const before = doc.toSnapshot();
    const same = updateUnit(doc, mira, v1, pin(1, SHA1));
    expect(same.noop).toBe(true);
    expect(doc.toSnapshot()).toEqual(before);
    const moved = updateUnit(doc, mira, v1, pin(5, SHA2));
    expect(moved.noop).toBe(true);
    expect(listUnits(doc)[0]).toMatchObject({ version: 5, sha256: SHA2 });
    const undo = new Y.UndoManager(doc.sharedTypes(), {
      trackedOrigins: new Set([doc.origin]),
      captureTimeout: 0,
    });
    const snap = doc.toSnapshot();
    updateUnit(doc, mira, editedUnit(v1, recolour), pin(6, SHA2));
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(doc.toSnapshot()).toEqual(snap);
  });

  it('relinks the slot to another figure keeping the root id; refuses a unit of another kind', () => {
    const { doc, mira } = instanceScene();
    const src = stagedDoc();
    const dog: UnitPayload = unitFrom(src, { kind: 'figure', actor: actorOf(src, PIP).id }).unit;
    const report = updateUnit(doc, mira, dog, { ref: 'lib_dog', version: 1, sha256: SHA2 });
    expect(report.root).toBe(mira);
    expect(report.added.filter((p) => p.kind === 'objects')).toHaveLength(20);
    expect(report.added.filter((p) => p.kind === 'armatures')).toHaveLength(1);
    // Mira's parts and her rig, untouched and used by nothing else, are gone
    expect(report.removed.filter((p) => p.kind === 'objects')).toHaveLength(21);
    expect(report.removed.filter((p) => p.kind === 'armatures')).toHaveLength(1);
    expect(doc.getArmature(doc.getObject(mira)!.data!)!.bones.map((b) => b.name)).toContain('tail.1');
    expect(doc.getObject(mira)!.custom_props).toMatchObject({
      unit_ref: 'lib_dog',
      unit_key: `cast:${MIRA}`,
    });
    expect(
      report.warnings.some((w) =>
        /^the new figure has no bone '.+' that the scene's animation or holds use$/.test(w),
      ),
    ).toBe(true);
    const [bench] = dress(src, [['park_bench', 1, 1]]);
    const prop = unitFrom(src, { kind: 'prop', root: bench }).unit;
    expect(code(() => updateUnit(doc, mira, prop, pin(2, SHA2)))).toBe('UNIT_KIND_MISMATCH');
    expect(code(() => updateUnit(doc, propOf(doc, KITE).id, prop, pin(2, SHA2)))).toBe('UNIT_NOT_FOUND');
  });
});

describe('a part whose source id is named like a member of Object.prototype', () => {
  it("is dropped like any other when the next version lacks it ('toString' is not Object.prototype.toString)", () => {
    const src = stagedDoc();
    const kite = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id }).unit;
    // the sail (a mesh nothing hangs from) renamed 'toString' in v1; v2 drops it
    const leaf = srcNamed(kite.body, 'sail');
    expect(Object.values(kite.body.blocks.objects!).some((r) => r.parent === leaf)).toBe(false);
    const name: string = 'toString';
    const v1 = editedUnit(kite, (body) => {
      const objects = body.blocks.objects!;
      objects[name] = objects[leaf];
      delete objects[leaf];
    });
    const v2 = editedUnit(v1, (body) => {
      const mesh = body.blocks.objects![name].data as string;
      delete body.blocks.objects![name];
      if (!Object.values(body.blocks.objects!).some((r) => r.data === mesh)) delete body.blocks.meshes![mesh];
    });
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, v1, { ...pin(1, SHA1), key: `el:${KITE}` });
    const part = r.ids['objects:toString'];
    const before = doc.getObject(part)!;
    expect(before.type).toBe('MESH');
    const rep = updateUnit(doc, r.root, v2, pin(2, SHA2));
    expect(rep.removed.map((p) => p.id)).toContain(part);
    expect(rep.updated.map((p) => p.id)).not.toContain(part);
    expect(doc.getObject(part)).toBeNull();
    expect(unitStatus(doc, r.root)).toEqual({ edited: [], missing: [] });
  });
});

describe('what an update writes is what it stamps', () => {
  it('a part whose new reference points at a part deleted here reads untouched after the update', () => {
    const src = stagedDoc();
    const kite = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id }).unit;
    const tail5 = srcNamed(kite.body, 'tail.5');
    const bridle = srcNamed(kite.body, 'bridle');
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, kite, { ...pin(1, SHA1), key: `el:${KITE}` });
    doc.removeObjects([r.ids[`objects:${tail5}`]]);
    // v2 has the bridle follow tail.5, which is no longer in this scene: the reference is cut here
    const v2 = editedUnit(kite, (b) => {
      b.blocks.objects![bridle].constraints = [createConstraint('COPY_LOCATION', { target: tail5 })];
    });
    const rep = updateUnit(doc, r.root, v2, pin(2, SHA2));
    const id = r.ids[`objects:${bridle}`];
    expect(rep.updated.map((p) => p.id)).toContain(id);
    expect(doc.getObject(id)!.constraints).toEqual([]);
    expect(unitStatus(doc, r.root).edited).toEqual([]);
  });
});

describe('a part the new version drops is kept while the scene still uses it', () => {
  it("by a camera's focus or a part the update keeps", () => {
    const src = stagedDoc();
    const kite = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id }).unit;
    const [tail2, tail3, sail] = ['tail.2', 'tail.3', 'sail'].map((n) => srcNamed(kite.body, n));
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, kite, { ...pin(1, SHA1), key: `el:${KITE}` });
    const id = (s: string) => r.ids[`objects:${s}`];
    // a camera focuses on tail.2; the sail (edited here, so kept) follows tail.3
    const cam = doc.addCamera({ name: 'Cam', dof_focus_object: id(tail2) });
    doc.addObject({ type: 'CAMERA', name: 'Cam', data: cam });
    doc.updateObject(id(sail), {
      constraints: [createConstraint('COPY_ROTATION', { target: id(tail3) })],
    });
    const v2 = editedUnit(kite, (b) => {
      for (const t of [tail2, tail3]) {
        const mesh = b.blocks.objects![t].data as string;
        delete b.blocks.objects![t];
        if (!Object.values(b.blocks.objects!).some((o) => o.data === mesh)) delete b.blocks.meshes![mesh];
      }
    });
    const rep = updateUnit(doc, r.root, v2, pin(2, SHA2));
    expect(rep.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: id(tail2), reason: 'dropped-but-used' }),
        expect.objectContaining({ id: id(tail3), reason: 'dropped-but-used' }),
      ]),
    );
    expect(doc.getObject(id(tail2))).toBeTruthy();
    expect(doc.getObject(id(tail3))).toBeTruthy();
    // and so does what they use
    expect(rep.removed).toEqual([]);
    for (const t of [tail2, tail3]) expect(doc.has('meshes', String(doc.getObject(id(t))!.data))).toBe(true);
  });
});

describe("a unit's drivers in an instance", () => {
  /** The kite, a version of it whose sail is driven by `expression` (none: null), and the sail. */
  function kites() {
    const src = stagedDoc();
    const kite = unitFrom(src, { kind: 'prop', root: propOf(src, KITE).id }).unit;
    const sail = srcNamed(kite.body, 'sail');
    const version = (expression: string | null, edit?: (b: UnitBody) => void) =>
      editedUnit(kite, (b) => {
        b.drivers =
          expression === null
            ? []
            : [
                {
                  target_type: 'object',
                  target_id: sail,
                  path: 'rotation_euler',
                  index: 0,
                  expression,
                  variables: [
                    { name: 'f', target_type: 'scene', target_id: '', path: 'frame_end', index: 0 },
                  ],
                  mute: false,
                },
              ];
        edit?.(b);
      });
    return { kite, sail, version };
  }
  const placed = (u: UnitPayload, sail: string) => {
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, u, { ...pin(1, SHA1), key: `el:${KITE}` });
    return { doc, root: r.root, sail: r.ids[`objects:${sail}`] };
  };
  const expressions = (doc: SceneDoc, id: string) => doc.listDrivers(id).map((d) => d.expression);

  it('one the scene left untouched takes the next version, and goes when a later one drops it', () => {
    const { sail, version } = kites();
    const { doc, root, sail: id } = placed(version('frame / 10'), sail);
    expect(expressions(doc, id)).toEqual(['frame / 10']);
    const v2 = updateUnit(doc, root, version('frame / 20'), pin(2, SHA2));
    expect(v2.warnings).toEqual([]);
    expect(expressions(doc, id)).toEqual(['frame / 20']);
    updateUnit(doc, root, version(null), pin(3, '3'.repeat(64)));
    expect(doc.listDrivers()).toEqual([]);
    expect(unitStatus(doc, root)).toEqual({ edited: [], missing: [] });
  });

  it('one deleted in the scene stays deleted at the next version', () => {
    const { sail, version } = kites();
    const { doc, root, sail: id } = placed(version('frame / 10'), sail);
    doc.removeDriver(fcurveKey(doc.listDrivers(id)[0]));
    const recoloured = version('frame / 10', (b) => {
      const m = Object.values(b.blocks.materials!)[0];
      m.base_color = [0.9, 0.1, 0.1, 1];
    });
    updateUnit(doc, root, recoloured, pin(2, SHA2));
    expect(doc.listDrivers()).toEqual([]);
  });

  it('one edited in the scene is kept, with a warning when the next version changed it too', () => {
    const { sail, version } = kites();
    const { doc, root, sail: id } = placed(version('frame / 10'), sail);
    doc.setDriver({ ...doc.listDrivers(id)[0], expression: 'frame / 5' });
    const rep = updateUnit(doc, root, version('frame / 20'), pin(2, SHA2));
    expect(expressions(doc, id)).toEqual(['frame / 5']);
    expect(rep.warnings).toEqual([expect.stringContaining('rotation_euler[0]')]);
    // and a version dropping it leaves it (it is the scene's now)
    updateUnit(doc, root, version(null), pin(3, '3'.repeat(64)));
    expect(expressions(doc, id)).toEqual(['frame / 5']);
  });

  it('a part the next version drops goes, and the driver the unit gave it is no use of it', () => {
    const { kite } = kites();
    const tail2 = srcNamed(kite.body, 'tail.2');
    const v1 = editedUnit(kite, (b) => {
      b.drivers = [
        {
          target_type: 'object',
          target_id: tail2,
          path: 'rotation_euler',
          index: 0,
          expression: 'frame / 10',
          variables: [],
          mute: false,
        },
      ];
    });
    const v2 = editedUnit(kite, (b) => {
      const mesh = b.blocks.objects![tail2].data as string;
      delete b.blocks.objects![tail2];
      if (!Object.values(b.blocks.objects!).some((o) => o.data === mesh)) delete b.blocks.meshes![mesh];
    });
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, v1, { ...pin(1, SHA1), key: `el:${KITE}` });
    const id = r.ids[`objects:${tail2}`];
    expect(doc.listDrivers(id)).toHaveLength(1);
    const rep = updateUnit(doc, r.root, v2, pin(2, SHA2));
    expect(rep.removed.map((p) => p.id)).toContain(id);
    expect(doc.getObject(id)).toBeFalsy();
    expect(doc.listDrivers()).toEqual([]);
  });

  describe('a part the next version drops that the scene keeps keeps the driver the unit gave it', () => {
    /** The kite whose tail.2 is driven by tail.3's height, and a next version dropping both tails. */
    function tails() {
      const { kite } = kites();
      const [tail2, tail3] = ['tail.2', 'tail.3'].map((n) => srcNamed(kite.body, n));
      const v1 = editedUnit(kite, (b) => {
        b.drivers = [
          {
            target_type: 'object',
            target_id: tail2,
            path: 'rotation_euler',
            index: 0,
            expression: 'z / 10',
            variables: [{ name: 'z', target_type: 'object', target_id: tail3, path: 'location', index: 2 }],
            mute: false,
          },
        ];
      });
      const v2 = editedUnit(kite, (b) => {
        for (const t of [tail2, tail3]) {
          const mesh = b.blocks.objects![t].data as string;
          delete b.blocks.objects![t];
          if (!Object.values(b.blocks.objects!).some((o) => o.data === mesh)) delete b.blocks.meshes![mesh];
        }
      });
      const doc = SceneDoc.create({ empty: true });
      const r = insertUnit(doc, v1, { ...pin(1, SHA1), key: `el:${KITE}` });
      const id = (s: string) => r.ids[`objects:${s}`];
      const table = () => JSON.parse(String(doc.getObject(r.root)!.custom_props.unit_drivers)) as object;
      return { doc, root: r.root, v2, two: id(tail2), three: id(tail3), table };
    }
    /** The objects an update kept, with why, sorted. */
    const objectsKept = (rep: ReturnType<typeof updateUnit>) =>
      rep.kept
        .filter((p) => p.kind === 'objects')
        .map((p) => [p.id, p.reason])
        .sort();

    it("used: it stays driven, and what its driver reads stays with it, out of the unit's tables", () => {
      const { doc, root, v2, two, three, table } = tails();
      expect(Object.keys(table())).toHaveLength(1);
      // a camera focuses on tail.2
      const cam = doc.addCamera({ name: 'Cam', dof_focus_object: two });
      doc.addObject({ type: 'CAMERA', name: 'Cam', data: cam });
      const rep = updateUnit(doc, root, v2, pin(2, SHA2));
      expect(objectsKept(rep)).toEqual(
        [
          [two, 'dropped-but-used'],
          [three, 'dropped-but-used'],
        ].sort(),
      );
      expect(rep.removed).toEqual([]);
      expect(doc.listDrivers(two).map((d) => d.expression)).toEqual(['z / 10']);
      expect(doc.getObject(three)).toBeTruthy();
      // the scene's now: a later version leaves it
      expect(table()).toEqual({});
      const v3 = editedUnit(v2, (b) => {
        Object.values(b.blocks.materials!)[0].base_color = [0.9, 0.1, 0.1, 1];
      });
      expect(updateUnit(doc, root, v3, pin(3, '3'.repeat(64))).updated).not.toEqual([]);
      expect(doc.listDrivers(two).map((d) => d.expression)).toEqual(['z / 10']);
    });

    it('edited: it stays driven', () => {
      const { doc, root, v2, two, three } = tails();
      doc.updateObject(two, { location: [0.3, 0.2, 0.1] });
      const rep = updateUnit(doc, root, v2, pin(2, SHA2));
      expect(objectsKept(rep)).toEqual(
        [
          [two, 'dropped-but-edited'],
          [three, 'dropped-but-used'],
        ].sort(),
      );
      expect(doc.listDrivers(two).map((d) => d.expression)).toEqual(['z / 10']);
    });

    it('unused: both tails go, and the driver with them', () => {
      const { doc, root, v2, two, three } = tails();
      const rep = updateUnit(doc, root, v2, pin(2, SHA2));
      expect(rep.removed.map((p) => p.id)).toEqual(expect.arrayContaining([two, three]));
      expect(rep.kept).toEqual([]);
      expect(doc.listDrivers()).toEqual([]);
    });
  });

  it('unitStatus names the drivers the unit gave that the scene edited or deleted', () => {
    const { sail, version } = kites();
    const { doc, root, sail: id } = placed(version('frame / 10'), sail);
    const key = `object:${sail}:rotation_euler:0`;
    expect(unitStatus(doc, root)).toEqual({ edited: [], missing: [] });
    doc.setDriver({ ...doc.listDrivers(id)[0], expression: 'frame / 5' });
    expect(unitStatus(doc, root)).toEqual({
      edited: [],
      missing: [],
      drivers: { edited: [{ key, target: id }], missing: [] },
    });
    doc.removeDriver(fcurveKey(doc.listDrivers(id)[0]));
    expect(unitStatus(doc, root).drivers).toEqual({ edited: [], missing: [{ key, target: id }] });
    // the scene's own drivers on its parts are not the unit's
    updateUnit(doc, root, version(null), pin(2, SHA2));
    doc.setDriver({ ...version('frame / 10').body.drivers[0], target_id: id } as never);
    expect(unitStatus(doc, root)).toEqual({ edited: [], missing: [] });
  });

  it('a published scene adopts its drivers: the next version updates them', () => {
    const doc = stagedDoc();
    const kiteRoot = propOf(doc, KITE).id;
    const sailId = doc.listObjects().find((o) => o.parent === kiteRoot && o.name.startsWith('sail'))!.id;
    doc.setDriver({
      target_type: 'object',
      target_id: sailId,
      path: 'rotation_euler',
      index: 0,
      expression: 'frame / 10',
      variables: [],
      mute: false,
    });
    const ex = extractUnit(doc, { kind: 'prop', root: kiteRoot }, { deskVersion: 'test' });
    expect(ex.link.drivers).toEqual({
      [`object:${srcNamed(decodeUnit(ex.data).body, 'sail')}:rotation_euler:0`]: expect.any(String),
    });
    const { root } = adoptUnit(doc, ex.link, pin(1, ex.sha256));
    const v2 = editedUnit(decodeUnit(ex.data), (b) => {
      b.drivers[0].expression = 'frame / 20';
    });
    updateUnit(doc, root, v2, pin(2, SHA2));
    expect(expressions(doc, sailId)).toEqual(['frame / 20']);
  });
});

describe('makeLocal, listUnits and unitsInUse', () => {
  it('lists instances with their pins; makeLocal leaves no unit_* props and the instance is gone', () => {
    const { doc, mira, ids } = instanceScene();
    const src = stagedDoc();
    const [bench] = dress(src, [['park_bench', 1, 1]]);
    const benchUnit = unitFrom(src, { kind: 'prop', root: bench }).unit;
    const b1 = insertUnit(doc, benchUnit, {
      ref: 'lib_bench',
      version: 2,
      sha256: SHA2,
      key: 'lib:aaaaaaaaaaaaaaaa',
    });
    insertUnit(doc, benchUnit, { ref: 'lib_bench', version: 2, sha256: SHA2, key: 'lib:bbbbbbbbbbbbbbbb' });
    expect(docHasUnitInstances(doc)).toBe(true);
    expect(listUnits(doc).map((u) => [u.key, u.kind, u.binding])).toEqual([
      [`cast:${MIRA}`, 'figure', { castId: MIRA }],
      ['lib:aaaaaaaaaaaaaaaa', 'prop', null],
      ['lib:bbbbbbbbbbbbbbbb', 'prop', null],
    ]);
    expect(unitsInUse(doc)).toEqual([
      { ref: 'lib_0123456789test', version: 1, sha256: SHA1 },
      { ref: 'lib_bench', version: 2, sha256: SHA2 },
    ]);
    const part = Object.entries(ids).find(([pk, x]) => pk.startsWith('objects:') && x !== mira)![1];
    expect(unitOf(doc, part)).toBe(mira);
    expect(unitOf(doc, mira)).toBe(mira);
    const res = makeLocal(doc, mira);
    expect(res).toEqual({ root: mira, parts: Object.keys(ids).length });
    expect(Object.keys(doc.getObject(mira)!.custom_props).filter((k) => k.startsWith('unit_'))).toEqual([]);
    expect(listUnits(doc).map((u) => u.key)).toEqual(['lib:aaaaaaaaaaaaaaaa', 'lib:bbbbbbbbbbbbbbbb']);
    expect(unitOf(doc, part)).toBeNull();
    expect(doc.getObject(part)).toBeTruthy();
    makeLocal(doc, b1.root);
    expect(unitsInUse(doc)).toEqual([{ ref: 'lib_bench', version: 2, sha256: SHA2 }]);
    expect(code(() => makeLocal(doc, b1.root))).toBe('UNIT_NOT_FOUND');
  });

  it('reads malformed provenance as no instance', () => {
    const { doc, mira } = instanceScene();
    const props = doc.getObject(mira)!.custom_props;
    doc.updateObject(mira, {
      custom_props: { ...props, unit_parts: '{"objects:@root":"elsewhere0000000:0123456789abcdef"}' },
    });
    expect(listUnits(doc)).toEqual([]);
    expect(docHasUnitInstances(doc)).toBe(false);
    doc.updateObject(mira, { custom_props: { ...props, unit_version: '1' } });
    expect(listUnits(doc)).toEqual([]);
    doc.updateObject(mira, { custom_props: props });
    expect(listUnits(doc)).toHaveLength(1);
  });
});

describe('adoptUnit', () => {
  for (const kind of ['figure', 'prop', 'set'] as const)
    it(`links the scene to the published ${kind}: no part reads as edited, and the next unit has the same body`, () => {
      const doc = stagedDoc();
      const dressing = dress(doc);
      doc.updateObject(dressing[1], { rotation_euler: [0, 0, 1.234567] });
      const spec =
        kind === 'figure'
          ? ({ kind, actor: actorOf(doc, MIRA).id } as const)
          : kind === 'prop'
            ? ({ kind, root: dressing[0] } as const)
            : ({ kind, name: 'Meadow' } as const);
      expect(docHasUnitInstances(doc)).toBe(false);
      const ex = extractUnit(doc, spec, { deskVersion: 'test' });
      const link = structuredClone(ex.link);
      const res = adoptUnit(doc, link, { ref: 'lib_new', version: 1, sha256: ex.sha256 });
      expect(res.warnings).toEqual([]);
      if (kind === 'set') {
        expect(res.root).toBe('SIqO3S2CV5o0gCvB');
        expect(doc.getObject(res.root)).toMatchObject({ type: 'EMPTY', name: 'Meadow', parent: null });
        for (const d of dressing) expect(doc.getObject(d)!.parent).toBe(res.root);
      } else expect(res.root).toBe(ex.link.rootSceneId);
      expect(docHasUnitInstances(doc)).toBe(true);
      expect(unitStatus(doc, res.root)).toEqual({ edited: [], missing: [] });
      const again = extractUnit(
        doc,
        kind === 'figure' ? { kind, actor: res.root } : kind === 'prop' ? { kind, root: res.root } : spec,
        {
          deskVersion: 'test',
        },
      );
      expect(again.header.digest).toBe(ex.header.digest);
      expect(again.basedOn).toEqual({ ref: 'lib_new', version: 1 });
      expect(again.link.key).toBe(ex.link.key);
    });

  it("adopts a set made local: the made-local root takes the provenance (a new root's id is that one)", () => {
    const src = stagedDoc();
    const meadow = unitFrom(src, { kind: 'set', name: 'Meadow' }).unit;
    const doc = SceneDoc.create({ empty: true });
    const r = insertUnit(doc, meadow, { ...pin(1, SHA1), key: 'set', rootProps: { desk_role: 'set' } });
    makeLocal(doc, r.root);
    expect(listUnits(doc)).toEqual([]);
    const ex = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    expect(ex.link).toMatchObject({ synthesizeSetRoot: false, rootSceneId: r.root });
    const res = adoptUnit(doc, ex.link, pin(2, ex.sha256));
    expect(res.root).toBe(r.root);
    expect(listUnits(doc).map((u) => [u.key, u.root, u.version])).toEqual([['set', r.root, 2]]);
    expect(unitStatus(doc, r.root)).toEqual({ edited: [], missing: [] });
  });

  it('refuses a plan it did not make, a set root whose id is taken, and a root no longer there', () => {
    const doc = stagedDoc();
    const ex = extractUnit(doc, { kind: 'set', name: 'Meadow' }, { deskVersion: 'test' });
    expect(code(() => adoptUnit(doc, { ...ex.link, digest: 'x' }, pin()))).toBe('UNIT_BAD_SPEC');
    expect(code(() => adoptUnit(doc, ex.link, pin(0)))).toBe('UNIT_BAD_SPEC');
    adoptUnit(doc, ex.link, pin());
    expect(code(() => adoptUnit(doc, ex.link, pin()))).toBe('UNIT_INSTANCE_EXISTS');
    const kite = propOf(doc, KITE).id;
    const exProp = extractUnit(doc, { kind: 'prop', root: kite }, { deskVersion: 'test' });
    doc.removeObject(kite);
    expect(code(() => adoptUnit(doc, exProp.link, pin()))).toBe('UNIT_NOT_FOUND');
  });
});
