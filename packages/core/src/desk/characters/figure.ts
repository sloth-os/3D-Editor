import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';
import { rigDigest, type UnitHeader, type UnitPayload } from '../units/format';
import { insertUnit, type UnitPin } from '../units/insert';
import { readInstance } from '../units/list';
import { makeLocal, updateUnit } from '../units/update';
import { actorMaterials, buildActorParts, keyPose } from './actor';
import { refreshAttached } from './index';
import { BUILT_KINDS, blueprintFor, isActorKind } from './kinds';
import { DEG, requireActor } from './rig';
import type { ActorKind } from './types';

/*
 * Library figures (desk/units 'figure' units) as actors: an actor's look (its parts, materials and
 * attachments) from a unit, on the desk's own rig for the figure's kind and height, so poses, gaits,
 * holds, mounts and keypoints work as on a mannequin.
 *
 * - createFigureActor puts a figure in as a new actor (the unit's armature is the actor: desk_role
 *   'actor', desk_kind, desk_height_m and desk_color are the unit's), standing where it is told.
 * - restyleActor swaps the look of an actor in place, keeping its armature object and with it its id,
 *   its location and pose keys, holds, rides and the shots that name it: to a figure (the actor is
 *   made the unit's root, or its instance updated to another version), or back to the mannequin of
 *   its kind and height. It does so only when the figure's kind and height are the actor's
 *   (figureFits: the same kind, heights within 5 mm): a figure of another kind or height would need
 *   the actor rebuilt, which an update leaves to staging the brief in a new project.
 */

/** Heights (m) closer than this are the same rig: a figure restyles an actor in place. */
export const FIGURE_HEIGHT_TOLERANCE_M = 0.005;

/** A figure's kind, height and colour (a unit header's figure facts). */
export interface FigureLook {
  kind: ActorKind;
  heightM: number;
  color: string;
}

/** Why a figure header cannot be an actor here: 'figure_kind' (a kind the desk does not build), 'figure_rig'. */
export function figureProblem(figure: UnitHeader['figure']): 'figure_kind' | 'figure_rig' | null {
  if (!figure || !isActorKind(figure.kind) || !BUILT_KINDS.includes(figure.kind)) return 'figure_kind';
  return figure.rig === kindRig(figure.kind, figure.heightM) ? null : 'figure_rig';
}

/** The rig digest of a built kind: its blueprint's bone names in order (the same at every height). */
export function kindRig(kind: ActorKind, heightM: number): string {
  return rigDigest(blueprintFor(kind, heightM).bones.map((b) => b.name));
}

/** Whether actor `actorId` has figure `f`'s rig: the same kind, and heights within 5 mm. */
export function figureFits(doc: SceneDoc, actorId: string, f: Pick<FigureLook, 'kind' | 'heightM'>): boolean {
  const o = doc.getObject(actorId);
  const kind = o?.custom_props?.[DESK_PROPS.kind];
  const height = Number(o?.custom_props?.[DESK_PROPS.heightM]);
  return (
    kind === f.kind && Number.isFinite(height) && Math.abs(height - f.heightM) < FIGURE_HEIGHT_TOLERANCE_M
  );
}

/** The actor's mesh parts (desk_actor) and attachments: its children but cameras and other actors, deep. */
function lookParts(doc: SceneDoc, actorId: string): string[] {
  const index = doc.childrenIndex();
  const out: string[] = [];
  const walk = (id: string) => {
    for (const child of index.get(id) ?? []) {
      const o = doc.getObject(child);
      if (!o || o.type === 'CAMERA' || o.custom_props?.[DESK_PROPS.role] === 'actor') continue;
      out.push(child);
      walk(child);
    }
  };
  walk(actorId);
  return out;
}

/** The actor's parts (desk_actor = it), as the rig knows them. */
const partsOf = (doc: SceneDoc, actorId: string): string[] =>
  doc
    .listObjects()
    .filter((o) => o.custom_props?.[DESK_PROPS.actor] === actorId)
    .map((o) => o.id);

/**
 * Puts figure `unit` in as a new actor, in one transaction: an instance of `pin` with key `key`
 * ('cast:<castId>'), named `name`, standing at `location` facing `facing_deg`, in `pose` (unkeyed),
 * with `character_id` and the scene's `props` on its armature. Returns the armature object, its parts,
 * its name and the insert's warnings.
 */
export function createFigureActor(
  doc: SceneDoc,
  unit: UnitPayload,
  o: {
    pin: UnitPin;
    key: string;
    name: string;
    location: Vec3;
    facing_deg: number;
    pose: string;
    character_id?: string;
    props?: Record<string, string | number | boolean>;
  },
): { actor: string; parts: string[]; name: string; warnings: string[] } {
  return doc.transact(() => {
    const r = insertUnit(doc, unit, {
      ...o.pin,
      key: o.key,
      name: o.name,
      location: [o.location[0], o.location[1], o.location[2]],
      rotation_euler: [0, 0, o.facing_deg * DEG],
      rootProps: {
        ...(o.character_id ? { [DESK_PROPS.characterId]: o.character_id } : {}),
        ...(o.props ?? {}),
      },
    });
    requireActor(doc, r.root);
    keyPose(doc, r.root, o.pose);
    return {
      actor: r.root,
      parts: partsOf(doc, r.root),
      name: doc.getObject(r.root)!.name,
      warnings: r.warnings,
    };
  });
}

/** What restyleActor gives an actor: a figure (a unit version, in slot `key`), or its mannequin. */
export type ActorLook = { figure: UnitPayload; pin: UnitPin; key: string } | { mannequin: { color: string } };

/**
 * Swaps the look of actor `actorId` in place (see the module comment), in one transaction: to a
 * figure whose kind and height are the actor's (INVALID_PARAMS otherwise), or back to the mannequin
 * of the actor's kind and height in `color` (a figure instance is made local first). The armature
 * object, its id, keys, holds and rides stay. Returns the actor's parts and warnings.
 */
export function restyleActor(
  doc: SceneDoc,
  actorId: string,
  look: ActorLook,
): { parts: string[]; warnings: string[] } {
  const meta = requireActor(doc, actorId);
  const warnings: string[] = [];
  doc.transact(() => {
    if ('figure' in look) {
      const f = look.figure.header.figure;
      if (!f || !figureFits(doc, actorId, f))
        throw new OperatorError(
          `'${meta.name}' is a ${meta.kind} of ${meta.height} m: the library figure '${look.figure.header.name}' (${f ? `a ${f.kind} of ${f.heightM} m` : 'no figure'}) does not fit its rig`,
          'INVALID_PARAMS',
        );
      if (readInstance(doc, actorId))
        warnings.push(...updateUnit(doc, actorId, look.figure, look.pin).warnings);
      else
        warnings.push(
          ...insertUnit(doc, look.figure, { ...look.pin, key: look.key, replace: actorId }).warnings,
        );
    } else {
      if (readInstance(doc, actorId)) makeLocal(doc, actorId);
      const old = lookParts(doc, actorId);
      const materials = new Set(old.flatMap((id) => doc.getObject(id)?.material_slots ?? []));
      doc.removeObjects(old);
      const used = new Set(doc.listObjects().flatMap((x) => x.material_slots));
      for (const m of materials) if (m && !used.has(m)) doc.removeMaterial(m);
      const kind = meta.kind as ActorKind;
      const bp = blueprintFor(kind, meta.height);
      const color = look.mannequin.color.toLowerCase();
      buildActorParts(doc, actorId, meta.name, bp, actorMaterials(doc, meta.name, color, bp));
      const o = doc.getObject(actorId)!;
      doc.updateObject(actorId, { custom_props: { ...o.custom_props, [DESK_PROPS.color]: color } });
    }
    refreshAttached(doc, actorId);
  });
  return { parts: partsOf(doc, actorId), warnings };
}
