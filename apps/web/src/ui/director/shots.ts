import {
  DESK_PROPS,
  DeskScene,
  FrameState,
  SHOT_LENS_MAX,
  SHOT_LENS_MIN,
  deskAspect,
  deskProp,
  isActor,
  shotOutputFrames,
  type ObjectData,
  type SceneDoc,
  type ShotData,
  type Vec3,
} from '@3d-editor/core';
import type { ViewPose } from '../../viewport/navigation';
import { posePosition } from '../../viewport/navigation';

/*
 * What the Director workspace's panels need from the document beyond the operators: the view a new
 * shot starts from, a duplicate's parameters, the objects a shot can frame, and actors.
 */

/** A camera placement of desk.shot_add (`from_view`): where it stands, what it looks at, its lens. */
export interface ShotView {
  position: Vec3;
  target: Vec3;
  lens_mm: number;
}

const clampLens = (mm: number) =>
  Math.round(Math.min(SHOT_LENS_MAX, Math.max(SHOT_LENS_MIN, Number.isFinite(mm) ? mm : 35)) * 100) / 100;
const round = (v: number) => Math.round(v * 1e5) / 1e5;
const vec = (v: ArrayLike<number>): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

/**
 * The shot view of the viewport's navigation pose: its eye and orbit target, and the lens (on the
 * shots' 36 mm wide sensor) whose frame, at the shots' aspect ratio, holds everything the viewport
 * shows: its vertical field of view, or its horizontal one when the viewport is wider than the frame.
 */
export function viewFromPose(pose: ViewPose, viewportAspect: number, shotAspect: number): ShotView {
  const tanV = Math.tan(pose.fovY / 2);
  const widest = Math.max(viewportAspect > 0 ? viewportAspect : 1, shotAspect > 0 ? shotAspect : 16 / 9);
  return {
    position: vec(posePosition(pose).toArray()),
    target: vec(pose.target.toArray()),
    lens_mm: clampLens(18 / (tanV * widest)),
  };
}

/**
 * The shot view of a camera object at a frame (as the desk measures it: its eye, a point ahead of it
 * on its view axis, and the lens on a 36 mm wide sensor showing its horizontal field of view); null
 * when it cannot be evaluated or is orthographic.
 */
export function viewFromCamera(doc: SceneDoc, camera: string, frame: number): ShotView | null {
  const view = new DeskScene(doc, { physics: false }).camera(camera, frame);
  if (!view || view.ortho || !(view.tanH > 0)) return null;
  const p = view.position;
  const f = view.forward;
  return {
    position: vec(p),
    target: vec([p[0] + f[0] * 5, p[1] + f[1] * 5, p[2] + f[2] * 5]),
    lens_mm: clampLens(18 / view.tanH),
  };
}

/** The aspect ratio shots are solved and framed for (desk.aspect, else the render's). */
export function shotAspect(doc: SceneDoc): number {
  return deskAspect(doc);
}

/**
 * desk.shot_add parameters of a duplicate of `shot`: the same description over the same scene
 * frames (coverage of the action from another camera once changed), placed right after it in the
 * cut, with a new camera standing where the shot's camera stands at its first frame (it is not
 * solved again, so the copy looks the same until it is changed).
 */
export function duplicateParams(doc: SceneDoc, shot: ShotData, index: number): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: copyName(shot.name),
    frame_start: shot.frame_start,
    frame_end: shot.frame_end,
    subjects: [...shot.subjects],
    layout: shot.layout.map((e) => ({ ...e })),
    notes: shot.notes,
    continuity: shot.continuity,
    pre_roll: shot.pre_roll,
    index: index + 1,
    solve: false,
  };
  for (const k of ['framing', 'angle', 'height', 'move', 'lens_mm'] as const)
    if (shot[k] !== null) p[k] = shot[k];
  const view = shot.camera ? viewFromCamera(doc, shot.camera, shot.frame_start) : null;
  if (view) p.from_view = view;
  // without a camera to copy, the copy is solved like a new shot
  else p.solve = true;
  return p;
}

/** "<name> copy" within the 64 characters a shot name may have. */
export function copyName(name: string): string {
  const suffix = ' copy';
  return `${Array.from(name)
    .slice(0, 64 - suffix.length)
    .join('')}${suffix}`;
}

/** Output frames of a shot (the cut's length of it). */
export const shotFrames = (shot: Pick<ShotData, 'frame_start' | 'frame_end'>) => shotOutputFrames(shot);

/** The desk role of an object ('' when it has none). */
export const roleOf = (o: Pick<ObjectData, 'custom_props'> | null | undefined) =>
  deskProp(o, DESK_PROPS.role);

/** The actor (armature object id) object `id` is or is a part of; null when it is neither. */
export function actorOf(doc: SceneDoc, id: string | null): string | null {
  if (!id) return null;
  if (isActor(doc, id)) return id;
  const owner = deskProp(doc.getObject(id), DESK_PROPS.actor);
  return owner && isActor(doc, owner) ? owner : null;
}

/** Desk roles of objects that are never a subject of their own (set pieces, strings, cameras). */
const NOT_SUBJECTS = new Set(['set', 'string', 'camera']);

/** Desk roles of objects that are subjects of their own wherever they are parented. */
const OWN_SUBJECTS = new Set(['prop', 'landmark']);

/** Whether an object is the root of a store model (store.add and store.insert_files give it a store_id). */
const isStoreRoot = (o: Pick<ObjectData, 'custom_props'> | null | undefined) =>
  deskProp(o, DESK_PROPS.storeId) !== '';

/**
 * The root of the store model object `id` belongs to: `id` itself when it is one, else its nearest
 * ancestor that is (store.add and store.insert_files put a model's parts under an EMPTY root with the
 * model's store_id, the object shots, checks and agents follow; the desk measures it together with
 * its parts). Null for an object of no store model.
 */
export function storeRoot(doc: SceneDoc, id: string | null): string | null {
  const seen = new Set<string>();
  for (
    let o = id ? doc.getObject(id) : null;
    o && !seen.has(o.id);
    o = o.parent ? doc.getObject(o.parent) : null
  ) {
    if (isStoreRoot(o)) return o.id;
    seen.add(o.id);
  }
  return null;
}

/**
 * The subject a selected object stands for: its actor (a part counts as its actor), itself when it
 * is a prop or a landmark, else the store model it is (a part of): a model placed from the Asset
 * Browser frames as a whole. Null for anything else (the set, cameras, plain objects).
 */
export function subjectOf(doc: SceneDoc, id: string): string | null {
  const actor = actorOf(doc, id);
  if (actor) return actor;
  if (OWN_SUBJECTS.has(roleOf(doc.getObject(id)))) return id;
  const root = storeRoot(doc, id);
  return root && !NOT_SUBJECTS.has(roleOf(doc.getObject(root))) ? root : null;
}

/**
 * Whether an object is a part of an actor, of the set or of a store model (never a subject of its
 * own: its actor or model is, as {@link subjectOf} says). Actors, store models, props and landmarks
 * stay subjects of their own when they are parented to a model (a cup put on a table).
 */
function isPart(doc: SceneDoc, o: ObjectData): boolean {
  if (deskProp(o, DESK_PROPS.actor) || NOT_SUBJECTS.has(roleOf(o))) return true;
  if (isActor(doc, o.id) || isStoreRoot(o) || OWN_SUBJECTS.has(roleOf(o))) return false;
  return o.parent ? storeRoot(doc, o.parent) !== null : false;
}

/** Object types a shot can frame. */
const FRAMEABLE = new Set(['MESH', 'EMPTY', 'CURVE', 'FONT', 'ARMATURE']);

/**
 * Objects a shot can frame, actors first, then props (store models count as props) and landmarks,
 * then other objects (meshes, empties, curves, text), each by name; actor parts, the parts of store
 * models, set pieces and cameras are left out.
 */
export function subjectCandidates(doc: SceneDoc): { id: string; name: string; role: string }[] {
  const rank = (role: string) => (role === 'actor' ? 0 : role === 'prop' ? 1 : role === 'landmark' ? 2 : 3);
  return doc
    .listObjects()
    .filter((o) => FRAMEABLE.has(o.type) && !isPart(doc, o) && (o.type !== 'ARMATURE' || isActor(doc, o.id)))
    .map((o) => ({ id: o.id, name: o.name, role: roleOf(o) || (isStoreRoot(o) ? 'prop' : '') }))
    .sort((a, b) => rank(a.role) - rank(b.role) || a.name.localeCompare(b.name));
}

/** The shot whose camera object `id` is (by the camera's desk_shot, else the first shot shooting with it). */
export function shotOfCamera(doc: SceneDoc, shots: readonly ShotData[], id: string | null): ShotData | null {
  if (!id) return null;
  const o = doc.getObject(id);
  if (o?.type !== 'CAMERA') return null;
  const tagged = deskProp(o, DESK_PROPS.shot);
  return shots.find((s) => s.id === tagged && s.camera === id) ?? shots.find((s) => s.camera === id) ?? null;
}

/** Where an object stands at a frame (its evaluated world position), or null. */
export function positionAt(doc: SceneDoc, id: string, frame: number): Vec3 | null {
  const m = new FrameState(doc, frame).world(id);
  return m ? [m[12], m[13], m[14]] : null;
}
