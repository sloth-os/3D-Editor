import type { SceneDoc } from '../doc/scene-doc';
import { fcurveKey } from '../doc/scene-doc';
import { defaultPoseBone } from '../doc/defaults';
import type { BoneData, ConstraintData, DriverData, FCurve, ObjectData, PoseBone } from '../doc/types';
import { parseDataPath, type PathSegment } from '../anim/path';
import { uniqueName } from '../util/names';

/*
 * Document-level editing of armatures: bones live in the armature datablock, pose channels on
 * every object using it, and bone names are referenced from F-curves and drivers
 * (`pose.bones["Name"]…`), bone parenting, constraint (pole) sub-targets and the vertex groups
 * of deformed meshes. These helpers keep all of them consistent.
 */

/** Objects whose data is the armature datablock `armatureId`. */
export function armatureUsers(doc: SceneDoc, armatureId: string): ObjectData[] {
  return doc.listObjects().filter((o) => o.type === 'ARMATURE' && o.data === armatureId);
}

/** Formats data path segments back into a path string. */
export function formatDataPath(segs: readonly PathSegment[]): string {
  let out = '';
  for (const s of segs) {
    if (s.kind === 'prop') out += out ? `.${s.name}` : s.name;
    else if (s.kind === 'key') out += `[${JSON.stringify(s.key)}]`;
    else out += `[${s.index}]`;
  }
  return out;
}

/** Bone name addressed by a `pose.bones["Name"]…` path (null for other paths). */
export function poseBoneOfPath(path: string): string | null {
  let segs: PathSegment[];
  try {
    segs = parseDataPath(path);
  } catch {
    return null;
  }
  const [a, b, c] = segs;
  return a?.kind === 'prop' &&
    a.name === 'pose' &&
    b?.kind === 'prop' &&
    b.name === 'bones' &&
    c?.kind === 'key'
    ? c.key
    : null;
}

function renamePoseBonePath(path: string, from: string, to: string): string | null {
  if (poseBoneOfPath(path) !== from) return null;
  const segs = parseDataPath(path).slice();
  segs[2] = { kind: 'key', key: to };
  return formatDataPath(segs);
}

/** Data path of a pose bone channel, e.g. `pose.bones["Arm"].rotation_euler`. */
export function poseBonePath(bone: string, channel: string): string {
  return `pose.bones[${JSON.stringify(bone)}].${channel}`;
}

/**
 * Makes the pose channels of every user of an armature match its bones: missing channels are
 * created with the rest transform, channels of bones that no longer exist are dropped.
 */
export function syncPoseChannels(doc: SceneDoc, armatureId: string): void {
  const arm = doc.getArmature(armatureId);
  if (!arm) return;
  const names = arm.bones.map((b) => b.name);
  for (const o of armatureUsers(doc, armatureId)) {
    const cur = o.pose?.bones ?? {};
    let changed = Object.keys(cur).length !== names.length;
    // own entries only (bone names are user data: never pick up Object.prototype members)
    const next = names.map((n): [string, PoseBone] => {
      if (Object.hasOwn(cur, n) && cur[n]) return [n, cur[n]];
      changed = true;
      return [n, defaultPoseBone()];
    });
    if (changed) doc.updateObject(o.id, { pose: { ...o.pose, bones: Object.fromEntries(next) } });
  }
}

/**
 * Names that cannot key a plain JavaScript object safely (`__proto__`, `constructor`, …). Pose
 * channels are stored in an object keyed by bone name, so bones never get these names.
 */
const RESERVED_NAMES: readonly string[] = Object.getOwnPropertyNames(Object.prototype);

/** Unique bone name within an armature (Blender style "Bone", "Bone.001", …). */
export function uniqueBoneName(bones: readonly BoneData[], base: string, except?: string): string {
  return uniqueName(
    base,
    new Set([...RESERVED_NAMES, ...bones.map((b) => b.name).filter((n) => n !== except)]),
  );
}

function renameInConstraints(
  list: ConstraintData[] | undefined,
  users: Set<string>,
  from: string,
  to: string,
): ConstraintData[] | null {
  if (!list?.length) return null;
  let changed = false;
  const next = list.map((c) => {
    let out = c;
    if (c.target && users.has(c.target) && c.subtarget === from) {
      out = { ...out, subtarget: to };
      changed = true;
    }
    const pole = c.params?.pole_target;
    if (typeof pole === 'string' && users.has(pole) && c.params.pole_subtarget === from) {
      out = { ...out, params: { ...out.params, pole_subtarget: to } };
      changed = true;
    }
    return out;
  });
  return changed ? next : null;
}

/** True when `mesh` object is deformed by (or skinned to) one of the armature objects in `users`. */
export function isDeformedBy(o: ObjectData, users: Set<string>): boolean {
  if (o.type !== 'MESH') return false;
  return o.modifiers.some(
    (m) => m.type === 'ARMATURE' && typeof m.params?.object === 'string' && users.has(m.params.object),
  );
}

/**
 * Renames a bone of an armature datablock and every reference to it (pose channels, child
 * bones, F-curves, drivers, bone parenting, constraint sub-targets, vertex groups of deformed
 * meshes). Returns the final (unique) name.
 */
export function renameBone(doc: SceneDoc, armatureId: string, from: string, to: string): string {
  const arm = doc.getArmature(armatureId);
  if (!arm) throw new Error(`armature ${armatureId} not found`);
  if (!arm.bones.some((b) => b.name === from)) throw new Error(`bone "${from}" not found`);
  const name = uniqueBoneName(arm.bones, to.trim() || from, from);
  if (name === from) return name;
  doc.transact(() => {
    doc.updateArmature(armatureId, {
      bones: arm.bones.map((b) => ({
        ...b,
        name: b.name === from ? name : b.name,
        parent: b.parent === from ? name : b.parent,
      })),
    });
    const userList = armatureUsers(doc, armatureId);
    const users = new Set(userList.map((o) => o.id));
    // pose channels (keep their order)
    for (const o of userList) {
      const bones = Object.entries(o.pose?.bones ?? {}).map(([k, v]): [string, PoseBone] => [
        k === from ? name : k,
        v,
      ]);
      doc.updateObject(o.id, { pose: { ...o.pose, bones: Object.fromEntries(bones) } });
    }
    // animation curves and drivers of the armature objects
    for (const fc of doc.listFCurves()) {
      if (fc.target_type !== 'object' || !users.has(fc.target_id)) continue;
      const path = renamePoseBonePath(fc.path, from, name);
      if (!path) continue;
      doc.removeFCurve(fcurveKey(fc));
      doc.setFCurve({ ...fc, path } as FCurve);
    }
    for (const d of doc.listDrivers()) {
      let next: DriverData = d;
      if (d.target_type === 'object' && users.has(d.target_id)) {
        const path = renamePoseBonePath(d.path, from, name);
        if (path) next = { ...next, path };
      }
      const vars = d.variables.map((v) => {
        if (v.target_type !== 'object' || !users.has(v.target_id)) return v;
        const path = renamePoseBonePath(v.path, from, name);
        return path ? { ...v, path } : v;
      });
      if (vars.some((v, i) => v !== d.variables[i])) next = { ...next, variables: vars };
      if (next === d) continue;
      if (next.path !== d.path) doc.removeDriver(fcurveKey(d));
      doc.setDriver(next);
    }
    // objects referring to the bone
    const renamedGroups = new Set<string>();
    for (const o of doc.listObjects()) {
      const patch: Partial<ObjectData> = {};
      if (o.parent && users.has(o.parent) && o.parent_type === 'BONE' && o.parent_bone === from)
        patch.parent_bone = name;
      const cs = renameInConstraints(o.constraints, users, from, name);
      if (cs) patch.constraints = cs;
      if (o.type === 'ARMATURE' && o.pose?.bones) {
        let changed = false;
        const bones = Object.entries(o.pose.bones).map(([k, pb]): [string, PoseBone] => {
          const bc = renameInConstraints(pb.constraints, users, from, name);
          if (bc) changed = true;
          return [k, bc ? { ...pb, constraints: bc } : pb];
        });
        if (changed)
          patch.pose = { ...(patch.pose ?? doc.getObject(o.id)!.pose), bones: Object.fromEntries(bones) };
      }
      if (Object.keys(patch).length) doc.updateObject(o.id, patch);
      // vertex groups of meshes deformed by this armature follow the bone name
      if (
        o.data &&
        !renamedGroups.has(o.data) &&
        (isDeformedBy(o, users) || (o.parent && users.has(o.parent)))
      ) {
        const groups = doc.getVertexGroups(o.data);
        if (groups.some((g) => g.name === from) && !groups.some((g) => g.name === name)) {
          doc.setVertexGroups(
            o.data,
            groups.map((g) => (g.name === from ? { ...g, name } : g)),
          );
          renamedGroups.add(o.data);
        }
      }
    }
  });
  return name;
}

/**
 * Removes bones from an armature. Children of removed bones are re-parented to the removed
 * bone's parent (disconnected, their heads stay in place); pose channels and the F-curves of
 * the removed bones are deleted. Returns the names that were removed.
 */
export function removeBones(doc: SceneDoc, armatureId: string, names: readonly string[]): string[] {
  const arm = doc.getArmature(armatureId);
  if (!arm) throw new Error(`armature ${armatureId} not found`);
  const remove = new Set(names.filter((n) => arm.bones.some((b) => b.name === n)));
  if (!remove.size) return [];
  const byName = new Map(arm.bones.map((b) => [b.name, b]));
  const survivingParent = (p: string | null): string | null => {
    const seen = new Set<string>();
    while (p && remove.has(p) && !seen.has(p)) {
      seen.add(p);
      p = byName.get(p)?.parent ?? null;
    }
    return p && remove.has(p) ? null : p;
  };
  doc.transact(() => {
    doc.updateArmature(armatureId, {
      bones: arm.bones
        .filter((b) => !remove.has(b.name))
        .map((b) =>
          b.parent && remove.has(b.parent)
            ? { ...b, parent: survivingParent(b.parent), use_connect: false }
            : b,
        ),
    });
    syncPoseChannels(doc, armatureId);
    const users = new Set(armatureUsers(doc, armatureId).map((o) => o.id));
    for (const fc of doc.listFCurves()) {
      if (fc.target_type !== 'object' || !users.has(fc.target_id)) continue;
      const b = poseBoneOfPath(fc.path);
      if (b && remove.has(b)) doc.removeFCurve(fcurveKey(fc));
    }
  });
  return [...remove];
}
