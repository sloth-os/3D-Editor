import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { DatablockKind, ObjectData } from '../src/doc/types';
import { createConstraint } from '../src/constraints/catalogue';
import { createCube } from '../src/mesh/primitives';
import { modifierObjectParams } from '../src/modifiers/builtin';
import {
  UNIT_BLOCK_KINDS,
  UNIT_ROOT,
  collectRecordRefs,
  decodeUnit,
  extractUnit,
  insertUnit,
  mapRecordRefs,
  type UnitRecord,
} from '../src/desk/units';
import { MIRA, actorOf, pin, stagedDoc, unitFrom } from './desk-units-helpers';

/*
 * Every field of a stored record that holds a datablock id (desk/units/refs.ts), one row each:
 * extraction writes it as a source id of the unit (no scene id is left in the manifest), insertion
 * writes it as the derived id of that datablock (every reference resolves inside the instance), and
 * references given by name are resolved first.
 */

const MODIFIER_TYPES = [
  'ARMATURE',
  'ARRAY',
  'BOOLEAN',
  'CAST',
  'CURVE',
  'MIRROR',
  'SCREW',
  'SHRINKWRAP',
  'SIMPLE_DEFORM',
  'WAVE',
];

const modifier = (type: string, params: Record<string, unknown>) => ({
  id: `m_${type}`,
  name: type,
  type,
  show_viewport: false,
  show_render: false,
  show_in_editmode: false,
  show_expanded: false,
  params,
});

/** A prop that uses every kind of reference, and what each row expects to find. */
function richScene() {
  const doc = SceneDoc.create({ empty: true });
  const image = doc.addImage({
    name: 'Grain',
    mime: 'image/png',
    width: 1,
    height: 1,
    data: new Uint8Array([1, 2, 3, 4]),
  });
  const material = doc.addMaterial({
    name: 'Wood',
    textures: { base_color: { image, scale: [1, 1], offset: [0, 0] } },
  });
  const root = doc.addObject({ type: 'EMPTY', name: 'Rig' });
  const body = doc.addObject({
    type: 'MESH',
    name: 'Body',
    data: doc.addMesh('Body', createCube()),
    parent: root,
    material_slots: [material],
  });
  const child = doc.addObject({
    type: 'MESH',
    name: 'Child',
    data: doc.addMesh('Child', createCube({ size: 1 })),
    parent: body,
  });
  const arm = doc.addArmature({
    name: 'Bones',
    bones: [
      {
        name: 'b1',
        parent: null,
        head: [0, 0, 0],
        tail: [0, 0, 1],
        roll: 0,
        use_connect: false,
        use_deform: true,
        envelope_distance: 0.25,
        envelope_weight: 1,
        head_radius: 0.1,
        tail_radius: 0.05,
      },
    ],
  });
  const armObj = doc.addObject({
    type: 'ARMATURE',
    name: 'Skeleton',
    data: arm,
    parent: root,
    pose: {
      bones: {
        b1: {
          location: [0, 0, 0],
          rotation_euler: [0, 0, 0],
          scale: [1, 1, 1],
          constraints: [
            createConstraint('IK', { target: body, params: { pole_target: child } }),
            createConstraint('COPY_LOCATION', { target: child }),
          ],
        },
      },
    },
  });
  const curve = doc.addCurve({ name: 'Path', bevel_object: child });
  const curveObj = doc.addObject({ type: 'CURVE', name: 'PathObj', data: curve, parent: root });
  // collections: a parent collection and a child one, each instanced by an empty of the prop
  const colP = doc.addCollection({ name: 'Outer' });
  const colA = doc.addCollection({ name: 'Inner', parent: colP });
  const member = doc.addObject({
    type: 'MESH',
    name: 'Member',
    data: doc.addMesh('Member', createCube()),
    collection: colA,
  });
  const inst = doc.addObject({
    type: 'EMPTY',
    name: 'InstA',
    parent: root,
    instance_type: 'COLLECTION',
    instance_collection: colA,
  });
  const inst2 = doc.addObject({
    type: 'EMPTY',
    name: 'InstP',
    parent: root,
    instance_type: 'COLLECTION',
    instance_collection: colP,
  });
  // an object outside the subtree, named (not by id) by a modifier: resolved, then pulled in
  const cutter = doc.addObject({
    type: 'MESH',
    name: 'Cutter',
    data: doc.addMesh('Cutter', createCube()),
    location: [5, 0, 0],
  });
  // an object outside the prop that a constraint of the prop follows: cut, never written
  const elsewhere = doc.addObject({
    type: 'MESH',
    name: 'Elsewhere',
    data: doc.addMesh('Elsewhere', createCube()),
    material_slots: [doc.addMaterial({ name: 'Paint' })],
  });
  doc.updateObject(child, { constraints: [createConstraint('COPY_LOCATION', { target: elsewhere })] });
  const mods = MODIFIER_TYPES.map((type) => {
    const params: Record<string, unknown> = {};
    for (const k of modifierObjectParams(type))
      params[k] =
        type === 'ARMATURE' ? armObj : type === 'CURVE' ? curveObj : type === 'BOOLEAN' ? 'Cutter' : child;
    return modifier(type, params);
  });
  doc.updateObject(body, {
    modifiers: mods as ObjectData['modifiers'],
    constraints: [createConstraint('COPY_ROTATION', { target: child })],
    particle_systems: [
      {
        id: 'ps',
        name: 'Scatter',
        show_viewport: false,
        show_render: false,
        settings: {
          instance_object: child,
          instance_collection: colA,
          instance_weights: [{ object: child, weight: 1 }],
        },
      },
    ],
  });
  doc.setDriver({
    target_type: 'object',
    target_id: body,
    path: 'location',
    index: 2,
    expression: 'v',
    variables: [{ name: 'v', target_type: 'object', target_id: child, path: 'location', index: 0 }],
    mute: false,
  });
  return {
    doc,
    root,
    body,
    child,
    armObj,
    arm,
    curve,
    curveObj,
    colP,
    colA,
    member,
    inst,
    inst2,
    cutter,
    elsewhere,
    material,
    image,
  };
}

/** Every id of every datablock in the document. */
function allIds(doc: SceneDoc): string[] {
  const out: string[] = [];
  for (const k of UNIT_BLOCK_KINDS) out.push(...doc.map(k).keys());
  return out;
}

describe('references in a unit', () => {
  const s = richScene();
  const ex = extractUnit(s.doc, { kind: 'prop', root: s.root }, { deskVersion: 'test' });
  const unit = decodeUnit(ex.data);
  const dst = SceneDoc.create({ empty: true });
  const ins = insertUnit(dst, unit, { ...pin(), key: 'el:ele_rig' });
  const idOf = (kind: DatablockKind, sceneId: string) => {
    const src = Object.entries(ex.link.parts).find(
      ([pk, p]) => pk.startsWith(`${kind}:`) && p.sceneId === sceneId,
    )?.[0];
    return src ? ins.ids[src] : undefined;
  };
  const obj = (sceneId: string) => dst.getObject(idOf('objects', sceneId)!)!;

  it('leaves no id of a datablock outside the unit anywhere in the manifest', () => {
    const manifest = JSON.stringify(unit.body);
    const inside = new Set(Object.values(ex.link.parts).map((p) => p.sceneId));
    const outside = allIds(s.doc).filter((id) => !inside.has(id));
    expect(outside).toContain(s.elsewhere);
    expect(outside.length).toBe(3);
    expect(obj(s.child).constraints).toEqual([]);
    expect(
      ex.warnings.some((w) => /^1 constraint\(s\) targeting objects outside the unit were left out/.test(w)),
    ).toBe(true);
    for (const id of outside) expect(manifest.includes(id), id).toBe(false);
    // the root is written as '@root' only, never by its scene id
    expect(manifest.includes(s.root)).toBe(false);
    expect(unit.body.blocks.objects?.[UNIT_ROOT]).toBeTruthy();
  });

  it('resolves every reference of every inserted record inside the instance', () => {
    const inside = new Set(Object.values(ins.ids));
    let refs = 0;
    for (const [pk, id] of Object.entries(ins.ids)) {
      const kind = pk.slice(0, pk.indexOf(':')) as DatablockKind;
      for (const r of collectRecordRefs(kind, dst.readRecord(kind, id)!)) {
        refs++;
        expect(inside.has(r.id), `${pk} ${r.site} → ${r.id}`).toBe(true);
        expect(dst.has(r.kind, r.id)).toBe(true);
      }
    }
    expect(refs).toBeGreaterThan(25);
  });

  const rows: [string, () => [unknown, unknown]][] = [
    ['parent', () => [obj(s.child).parent, idOf('objects', s.body)]],
    ['data (mesh)', () => [obj(s.body).data, idOf('meshes', s.doc.getObject(s.body)!.data!)]],
    ['data (armature)', () => [obj(s.armObj).data, idOf('armatures', s.arm)]],
    ['data (curve)', () => [obj(s.curveObj).data, idOf('curves', s.curve)]],
    ['material_slots', () => [obj(s.body).material_slots[0], idOf('materials', s.material)]],
    ['constraint target', () => [obj(s.body).constraints[0].target, idOf('objects', s.child)]],
    [
      'IK target (pose bone)',
      () => [obj(s.armObj).pose.bones.b1.constraints![0].target, idOf('objects', s.body)],
    ],
    [
      'IK pole_target',
      () => [obj(s.armObj).pose.bones.b1.constraints![0].params.pole_target, idOf('objects', s.child)],
    ],
    [
      'pose-bone constraint',
      () => [obj(s.armObj).pose.bones.b1.constraints![1].target, idOf('objects', s.child)],
    ],
    ['instance_collection', () => [obj(s.inst).instance_collection, idOf('collections', s.colA)]],
    ['object collection', () => [obj(s.member).collection, idOf('collections', s.colA)]],
    [
      'collection parent',
      () => [
        dst.readRecord('collections', idOf('collections', s.colA)!)!.parent,
        idOf('collections', s.colP),
      ],
    ],
    [
      'particle instance_object',
      () => [obj(s.body).particle_systems[0].settings.instance_object, idOf('objects', s.child)],
    ],
    [
      'particle instance_collection',
      () => [obj(s.body).particle_systems[0].settings.instance_collection, idOf('collections', s.colA)],
    ],
    [
      'particle instance_weights',
      () => [
        (obj(s.body).particle_systems[0].settings.instance_weights as { object: string }[])[0].object,
        idOf('objects', s.child),
      ],
    ],
    [
      'bevel_object',
      () => [dst.readRecord('curves', idOf('curves', s.curve)!)!.bevel_object, idOf('objects', s.child)],
    ],
    [
      'texture image',
      () => [
        (
          dst.readRecord('materials', idOf('materials', s.material)!)!.textures as {
            base_color: { image: string };
          }
        ).base_color.image,
        idOf('images', s.image),
      ],
    ],
    [
      'driver target and variable',
      () => {
        const d = dst.listDrivers()[0];
        return [
          [d.target_id, d.variables[0].target_id],
          [idOf('objects', s.body), idOf('objects', s.child)],
        ];
      },
    ],
    [
      'a reference by name (BOOLEAN object: Cutter)',
      () => [
        obj(s.body).modifiers.find((m) => m.type === 'BOOLEAN')!.params.object,
        idOf('objects', s.cutter),
      ],
    ],
  ];
  for (const type of MODIFIER_TYPES)
    for (const k of modifierObjectParams(type))
      if (type !== 'BOOLEAN')
        rows.push([
          `modifier ${type}.${k}`,
          () => [
            obj(s.body).modifiers.find((m) => m.type === type)!.params[k],
            idOf('objects', type === 'ARMATURE' ? s.armObj : type === 'CURVE' ? s.curveObj : s.child),
          ],
        ]);

  it.each(rows)('%s points at the inserted datablock', (_name, read) => {
    const [got, want] = read();
    expect(want).toBeTruthy();
    expect(got).toEqual(want);
  });

  it('desk_actor: every part of an inserted figure names the inserted root', () => {
    const src = stagedDoc();
    const { unit: figure } = unitFrom(src, { kind: 'figure', actor: actorOf(src, MIRA).id });
    const d = SceneDoc.create({ empty: true });
    const r = insertUnit(d, figure, { ...pin(), key: `cast:${MIRA}` });
    const parts = d.listObjects().filter((o) => o.id !== r.root);
    expect(parts).toHaveLength(21);
    for (const p of parts) expect(p.custom_props.desk_actor).toBe(r.root);
  });
});

describe('mapRecordRefs', () => {
  it('maps a camera focus object and cuts what the map does not give', () => {
    const cam = { name: 'Cam', dof_focus_object: 'obj1' } as UnitRecord;
    expect(mapRecordRefs('cameras', cam, () => 'src1').dof_focus_object).toBe('src1');
    expect(mapRecordRefs('cameras', cam, () => null).dof_focus_object).toBeNull();
    const o = {
      name: 'O',
      type: 'MESH',
      parent: 'p',
      parent_type: 'BONE',
      parent_bone: 'hand',
      collection: 'c',
      material_slots: ['m', null],
      constraints: [{ type: 'CHILD_OF', target: 'x', params: {} }],
      custom_props: { desk_actor: 'a', keep: 1 },
    } as UnitRecord;
    const cut = mapRecordRefs('objects', o, () => null);
    expect(cut).toMatchObject({
      parent: null,
      parent_type: 'OBJECT',
      parent_bone: '',
      collection: 'root',
      material_slots: [null, null],
      constraints: [],
    });
    expect(cut.custom_props).toEqual({ keep: 1 });
    // the input is not changed
    expect(o.parent).toBe('p');
    expect((o.constraints as unknown[]).length).toBe(1);
    const mat = {
      name: 'M',
      textures: { base_color: { image: 'i', scale: [1, 1], offset: [0, 0] }, normal: null },
    } as UnitRecord;
    expect(
      (mapRecordRefs('materials', mat, () => null).textures as Record<string, { image: string } | null>)
        .base_color!.image,
    ).toBe('');
  });
});
