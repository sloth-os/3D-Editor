import { defaultObject } from '../../doc/defaults';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import { UnitError } from './errors';
import type { UnitLinkPlan } from './extract';
import { UNIT_ROOT, requireUnitKey } from './ids';
import { requirePin, type UnitPin } from './insert';
import { UNIT_KINDS } from './kinds';
import { provenanceProps, readInstance, splitPartKey, type UnitPartStamp } from './list';
import { channelsUnder } from './place';

/*
 * Linking the scene's objects to the unit they were published as, once the host has confirmed the
 * publish (unit-ack with linked true): the scene becomes an instance of the new version without a
 * new id anywhere. The root (the prop, the actor, the set's instance root; for a first set publish a
 * new EMPTY at the origin) takes the provenance, with the table of the parts as extraction mapped
 * them (each keeps its scene id); part objects whose parent is outside the instance hang from the
 * root, keeping their world transform, with the very channels extraction wrote into the unit
 * (place.ts), so no part reads as edited. One transaction: the caller chooses its origin by calling
 * it inside its own doc.transact(…, origin) (the desk applies it with its storage origin: not
 * undoable).
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const STAMP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SUM16 = /^[0-9a-f]{16}$/;

/** `link` when it is a link plan extractUnit could have made, else UNIT_BAD_SPEC. */
function requireLink(link: UnitLinkPlan): UnitLinkPlan {
  const ok =
    isRecord(link) &&
    (UNIT_KINDS as readonly unknown[]).includes(link.kind) &&
    typeof link.key === 'string' &&
    (link.rootSceneId === null || typeof link.rootSceneId === 'string') &&
    typeof link.synthesizeSetRoot === 'boolean' &&
    (link.synthesizeSetRoot
      ? link.kind === 'set' && link.rootSceneId === null
      : typeof link.rootSceneId === 'string') &&
    typeof link.name === 'string' &&
    link.name.length > 0 &&
    typeof link.digest === 'string' &&
    /^[0-9a-f]{64}$/.test(link.digest) &&
    isRecord(link.parts) &&
    Object.entries(link.parts).every(
      ([pk, p]) =>
        !!splitPartKey(pk) && isRecord(p) && STAMP_ID.test(String(p.sceneId)) && SUM16.test(String(p.sum16)),
    ) &&
    isRecord(link.parts[`objects:${UNIT_ROOT}`]);
  if (!ok) throw new UnitError('UNIT_BAD_SPEC', 'not a link plan extractUnit made');
  requireUnitKey(link.key);
  return link;
}

/**
 * Makes the scene's published objects an instance of `pin` (see the module comment). Returns the
 * root and warnings (parts no longer in the scene: they count as deleted here). Throws UNIT_BAD_SPEC
 * (link or pin), UNIT_NOT_FOUND (the root is gone), UNIT_INSTANCE_EXISTS / UNIT_ID_TAKEN (a set root
 * to make whose id is taken).
 */
export function adoptUnit(
  doc: SceneDoc,
  link: UnitLinkPlan,
  pin: UnitPin,
): { root: string; warnings: string[] } {
  const p = requirePin(pin);
  const l = requireLink(link);
  const warnings: string[] = [];
  const rootPart = l.parts[`objects:${UNIT_ROOT}`];
  const root = l.synthesizeSetRoot ? rootPart.sceneId : (l.rootSceneId as string);
  if (!l.synthesizeSetRoot && !doc.has('objects', root))
    throw new UnitError(
      'UNIT_NOT_FOUND',
      `the object '${root}' the unit was made from is no longer in the scene`,
    );
  if (l.synthesizeSetRoot && doc.has('objects', root))
    throw readInstance(doc, root)?.key === l.key
      ? new UnitError('UNIT_INSTANCE_EXISTS', `the scene already holds the instance '${l.key}'`)
      : new UnitError('UNIT_ID_TAKEN', `the id ${root} of the set's root is taken`);
  const parts = new Map<string, UnitPartStamp>();
  for (const [pk, part] of Object.entries(l.parts).sort(([a], [b]) => (a < b ? -1 : 1)))
    parts.set(pk, { id: pk === `objects:${UNIT_ROOT}` ? root : part.sceneId, sum: part.sum16 });
  const objectParts = new Set([...parts].filter(([pk]) => pk.startsWith('objects:')).map(([, s]) => s.id));
  doc.transact(() => {
    if (l.synthesizeSetRoot) {
      const { id: _id, ...fields } = defaultObject('EMPTY', root, l.name);
      doc.addRecord('objects', root, fields as unknown as Record<string, unknown> & { name: string });
    }
    let gone = 0;
    const rootWorld = doc.worldMatrix(root);
    const hang: string[] = [];
    for (const [pk, s] of parts) {
      const kp = splitPartKey(pk)!;
      if (!doc.has(kp.kind, s.id)) {
        gone++;
        continue;
      }
      if (kp.kind !== 'objects' || s.id === root) continue;
      const parent = doc.getObject(s.id)?.parent ?? null;
      if (parent === null || !objectParts.has(parent)) {
        if (doc.isAncestor(s.id, root)) warnings.push(`'${s.id}' holds the root and stays where it is`);
        else hang.push(s.id);
      }
    }
    // every channel read before any parent changes (a part may hang below another one)
    const channels = hang.map((id) => [id, channelsUnder(doc, id, rootWorld)!] as const);
    for (const [id, ch] of channels)
      doc.updateObject(id, { parent: root, parent_type: 'OBJECT', parent_bone: '', ...ch });
    if (gone)
      warnings.push(`${gone} part(s) published are no longer in the scene: they count as deleted here`);
    const cur = doc.readRecord('objects', root)!;
    doc.updateObject(root, {
      custom_props: {
        ...(cur.custom_props as ObjectData['custom_props']),
        ...provenanceProps({ ...p, digest: l.digest, kind: l.kind, key: l.key, name: l.name, parts }),
      },
    });
  });
  return { root, warnings };
}
