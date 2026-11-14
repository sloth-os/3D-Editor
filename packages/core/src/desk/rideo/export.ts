import type { Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ArmatureData, DeskMove, ObjectData, PoseBone, ShotData } from '../../doc/types';
import { fcurveKey } from '../../doc/scene-doc';
import { evaluateFCurve } from '../../anim/fcurve';
import { quatFromEuler } from '../../math/quat';
import { linearToSrgb } from '../../render/color';
import { OperatorError } from '../../operators/context';
import { DESK_PROPS } from '../props';
import { getDeskSettings, getShots } from '../shots';
import { DESK_SHAPE_PROP, DeskScene, isWater, toRideo, v3len, v3sub } from '../layout';
import { GROUND_COLORS } from '../set';
import { viewTarget } from '../moves';
import { blueprintFor, posedBones, posesOf, requireBuiltKind } from '../characters/kinds';
import { footprint, restSize, type PartsOf } from './footprint';
import { RIDEO_PROPS, motionDigest, rideoHeightRatio, type RideoOffstage } from './import';
import { rideoPose } from './rules';
import {
  RIDEO_BLOCKING_PALETTE,
  RIDEO_LANDMARK_SHAPES,
  RIDEO_MAX_ACTORS,
  RIDEO_MAX_LANDMARKS,
  RIDEO_MAX_PROPS,
  RideoBlockingActorSchema,
  RideoBlockingMarkSchema,
  RideoSceneBlockingSchema,
  isRideoId,
  rideoLandmarkColor,
  type RideoBlockingActor,
  type RideoBlockingMark,
  type RideoBlockingMove,
  type RideoBlockingPose,
  type RideoBlockingShot,
  type RideoCameraPlacement,
  type RideoLandmarkShape,
  type RideoSceneBlocking,
} from './schema';

/*
 * desk.export_rideo_blocking (spec §11 "Export"): the scene as a SceneBlocking v1 (./schema.ts), for
 * agents that keep a scene's blocking as JSON: the staging the desk renders, in the format's terms.
 *
 * - Actors (those with a character id, in cast order, at most 16): their opening marks are where
 *   the first enabled shot starts them; every shot has a mark for each of them at its start (the
 *   format keeps those of the shot's cast) with the facing and the nearest of its ten poses; toX/toZ is
 *   where an actor ends the shot when it moved more than 0.3 m. A rider stands on its mount's mark.
 * - Cameras: where each shot's camera stands at its start, looking at the point of its view axis at
 *   its subjects' depth (rideo's target), its lens as a 36 mm wide sensor's; `end` where it is at the
 *   shot's end when it moved or turned. The spec keeps the shot's angle and height.
 * - Landmarks and props: their footprints (centre, width × depth × height, rotation) at the first
 *   shot's start; a prop's size is its largest extent; a held prop names its holder (heldBy).
 * - The set: its size and interior from the desk settings, its ground's name, the sun's azimuth and
 *   elevation as rideo measures them.
 * Shots are keyed by their source's shot id (external.shot: a host's, or an imported clip's), else by
 * their own id. Their moves are returned beside the blocking (a host keeps them as the shot's camera
 * move): a move the blocking's end does not name (a tracking shot's end reads as a push in) stays the
 * desk's.
 */

/** How far (m) an actor must move during a shot for its mark to get toX/toZ. */
export const RIDEO_EXPORT_WALK_M = 0.3;

export interface RideoExportResult {
  blocking: RideoSceneBlocking;
  /**
   * The shots exported, in cut order, with the key rideo knows them by and their move (rideo's
   * camera.move: a blocking only names the moves its spec can, so the move travels beside it).
   */
  shots: { id: string; name: string; rideo_shot: string; move: DeskMove | null }[];
  warnings: string[];
}

const round = (v: number, digits = 3) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k + 0;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const coord = (v: number) => round(clamp(v, -500, 500));
const prop = (o: ObjectData | undefined | null, key: string): string => {
  const v = o?.custom_props?.[key];
  return typeof v === 'string' ? v : '';
};
const HEX = /^#[0-9a-f]{6}$/i;

/** rideo facing (degrees, [0, 360)) of an editor floor direction. */
function facingDeg(dir: Readonly<Vec3>): number {
  const d = (Math.atan2(dir[0], -dir[1]) * 180) / Math.PI;
  return round(((d % 360) + 360) % 360, 1) % 360;
}

/** sRGB hex of a linear colour. */
function hexOf(c: readonly number[]): string {
  const byte = (v: number) =>
    Math.round(clamp(linearToSrgb(clamp(v, 0, 1)), 0, 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${byte(c[0] ?? 0)}${byte(c[1] ?? 0)}${byte(c[2] ?? 0)}`;
}

/** rideo's name of a ground colour (the first word of its table that names it), else 'ground'. */
function groundName(doc: SceneDoc): string {
  const ground = doc
    .listObjects()
    .find((o) => prop(o, DESK_PROPS.role) === 'set' && prop(o, DESK_PROPS.label) === 'ground');
  if (!ground) return 'ground';
  const named = prop(ground, RIDEO_PROPS.ground);
  if (named) return named.slice(0, 80);
  const mat = ground.material_slots[0] ? doc.getMaterial(ground.material_slots[0]) : null;
  if (mat) {
    const hex = hexOf(mat.base_color);
    for (const [re, h] of GROUND_COLORS) if (h === hex) return re.source.split('|')[0].replace(/[^a-z]/g, '');
  }
  return 'ground';
}

/** The move of rideo's blocking spec a desk move is ('none' for the moves a spec cannot name). */
function blockingMove(move: DeskMove | null): RideoBlockingMove {
  switch (move) {
    case 'push_in':
    case 'pull_out':
    case 'dolly_left':
    case 'dolly_right':
    case 'orbit_left':
    case 'orbit_right':
    case 'crane_up':
      return move;
    default:
      return 'none';
  }
}

// ---------------------------------------------------------------- poses

/** Angle (radians) between two Euler rotations. */
function rotationAngle(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const qa = quatFromEuler(a);
  const qb = quatFromEuler(b);
  const d = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
  return 2 * Math.acos(Math.min(1, d));
}

/**
 * The editor pose an actor's bones are nearest at a frame state (the poses of its kind as CHARACTERS
 * builds them, compared bone by bone), cached per actor; 'stand' when it cannot be told.
 */
class PoseReader {
  private readonly candidates = new Map<string, { pose: string; bones: Record<string, PoseBone> }[]>();

  constructor(private readonly doc: SceneDoc) {}

  private posesOf(o: ObjectData): { pose: string; bones: Record<string, PoseBone> }[] {
    const cached = this.candidates.get(o.id);
    if (cached) return cached;
    let list: { pose: string; bones: Record<string, PoseBone> }[] = [];
    try {
      const kind = requireBuiltKind(prop(o, DESK_PROPS.kind));
      const height = Number(o.custom_props?.[DESK_PROPS.heightM]);
      const arm = o.data ? (this.doc.getArmature(o.data) as ArmatureData | null) : null;
      if (arm && height > 0) {
        const bp = blueprintFor(kind, height);
        list = posesOf(kind).map((pose) => ({ pose, bones: posedBones(kind, arm, bp, pose) }));
      }
    } catch {
      list = [];
    }
    this.candidates.set(o.id, list);
    return list;
  }

  nearest(scene: DeskScene, id: string, frame: number): string {
    const o = scene.objects.get(id);
    if (!o) return 'stand';
    const list = this.posesOf(o);
    const live = scene.frameState(frame).get<ObjectData>('object', id)?.pose?.bones ?? o.pose.bones;
    const height = Number(o.custom_props?.[DESK_PROPS.heightM]) || 1.7;
    let best = 'stand';
    let bestD = Infinity;
    for (const c of list) {
      let d = 0;
      for (const [bone, pb] of Object.entries(c.bones)) {
        const cur = live[bone];
        if (!cur) continue;
        d += rotationAngle(cur.rotation_euler, pb.rotation_euler);
        if (bone === 'hips') d += v3len(v3sub(cur.location, pb.location)) / height;
      }
      if (d < bestD) {
        bestD = d;
        best = c.pose;
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------- attachments

/** The value of an object's constraint influence at a frame (its F-curve, else its stored value). */
function influenceAt(doc: SceneDoc, o: ObjectData, name: string, stored: number, frame: number): number {
  const fc = doc.getFCurve(
    fcurveKey({
      target_type: 'object',
      target_id: o.id,
      path: `constraints[${JSON.stringify(name)}].influence`,
      index: 0,
    }),
  );
  const v = fc ? evaluateFCurve(fc, frame) : undefined;
  return v ?? stored;
}

/** The object a CHILD_OF constraint named `prefix…` ties `o` to at `frame` (influence ≥ 0.5), or null. */
function attachedTo(doc: SceneDoc, o: ObjectData, prefix: string, frame: number): string | null {
  for (const c of o.constraints ?? []) {
    if (c.type !== 'CHILD_OF' || !c.name.startsWith(prefix) || !c.target || c.mute) continue;
    if (influenceAt(doc, o, c.name, c.influence ?? 1, frame) >= 0.5) return c.target;
  }
  return null;
}

/**
 * rideo's actors in no shot, as the import recorded them on the set's ground (RIDEO_PROPS.offstage):
 * none when there is no record or it does not read as one.
 */
function offstageOf(objects: readonly ObjectData[]): RideoOffstage {
  const ground = objects.find(
    (o) => prop(o, DESK_PROPS.role) === 'set' && prop(o, DESK_PROPS.label) === 'ground',
  );
  const raw = prop(ground, RIDEO_PROPS.offstage);
  const none: RideoOffstage = { actors: [], marks: {} };
  if (!raw) return none;
  try {
    const j = JSON.parse(raw) as { actors?: unknown; marks?: unknown };
    const actors = RideoBlockingActorSchema.array().safeParse(j.actors);
    const marks: RideoOffstage['marks'] = {};
    if (j.marks && typeof j.marks === 'object')
      for (const [shot, byCast] of Object.entries(j.marks as Record<string, unknown>))
        if (byCast && typeof byCast === 'object')
          for (const [cid, m] of Object.entries(byCast as Record<string, unknown>)) {
            const mark = RideoBlockingMarkSchema.safeParse(m);
            if (mark.success) (marks[shot] ??= {})[cid] = mark.data;
          }
    return actors.success ? { actors: actors.data, marks } : none;
  } catch {
    return none;
  }
}

// ---------------------------------------------------------------- the export

/** A unique short id: `preferred` when it is free and fits rideo's 1–40 characters, else `<letter><n>`. */
function uniqueId(preferred: string, letter: string, taken: Set<string>): string {
  if (preferred && preferred.length <= 40 && !taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }
  for (let n = 1; ; n++) {
    const id = `${letter}${n}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Exports the scene as a rideo SceneBlocking v1 (see the module comment). */
export function exportRideoBlocking(doc: SceneDoc, o: { now?: string } = {}): RideoExportResult {
  const warnings: string[] = [];
  const scene = new DeskScene(doc);
  const shots = getShots(doc).filter((s) => s.enabled);
  const frame0 = shots[0]?.frame_start ?? doc.getScene().frame_start;
  const objects = [...scene.objects.values()];
  const parts: PartsOf = { object: (id) => scene.objects.get(id), children: (id) => scene.children(id) };
  const poses = new PoseReader(doc);

  // ------------------------------------------------------------ shots and their keys
  const keyOf = new Map<string, string>();
  const usedKeys = new Set<string>();
  for (const s of shots) {
    let key = s.external?.shot ? s.external.shot : s.id;
    if (usedKeys.has(key)) {
      warnings.push(`shot '${s.name}' has the source shot id of an earlier shot: exported under its own id`);
      key = s.id;
    }
    if (!s.external?.shot)
      warnings.push(
        `shot '${s.name}' has no source shot id: exported under its own id (a host keeps only its own shots)`,
      );
    usedKeys.add(key);
    keyOf.set(s.id, key);
  }

  // ------------------------------------------------------------ actors in cast order
  const actorObjects = objects.filter((x) => prop(x, DESK_PROPS.role) === 'actor');
  const order: ObjectData[] = [];
  for (const s of shots)
    for (const id of s.subjects) {
      const a = actorObjects.find((x) => x.id === id);
      if (a && !order.includes(a)) order.push(a);
    }
  for (const a of actorObjects) if (!order.includes(a)) order.push(a);
  const exported: ObjectData[] = [];
  const seenCharacters = new Set<string>();
  for (const a of order) {
    const cid = prop(a, DESK_PROPS.characterId);
    if (!isRideoId(cid)) {
      warnings.push(`actor '${a.name}' has no character id: left out`);
      continue;
    }
    if (seenCharacters.has(cid)) {
      warnings.push(`actor '${a.name}' plays ${cid} a second time: left out`);
      continue;
    }
    if (exported.length >= RIDEO_MAX_ACTORS) {
      warnings.push(`a blocking holds at most ${RIDEO_MAX_ACTORS} characters: '${a.name}' left out`);
      continue;
    }
    seenCharacters.add(cid);
    exported.push(a);
  }
  const characterOf = new Map(exported.map((a) => [a.id, prop(a, DESK_PROPS.characterId)]));
  // rideo's actors in no shot, which the import left out of the scene: written back as rideo has
  // them (with their marks, and as the holders of what they hold) unless the desk has them now
  const offstage = offstageOf(objects);
  const offstageBack: RideoBlockingActor[] = [];
  for (const a of offstage.actors) {
    if (seenCharacters.has(a.characterId)) continue;
    if (exported.length + offstageBack.length >= RIDEO_MAX_ACTORS) {
      warnings.push(`a blocking holds at most ${RIDEO_MAX_ACTORS} characters: ${a.characterId} left out`);
      continue;
    }
    seenCharacters.add(a.characterId);
    offstageBack.push(a);
  }

  /** Where an actor stands at a frame, as rideo marks it (a rider on its mount's mark, seated). */
  const markAt = (a: ObjectData, frame: number): RideoBlockingMark => {
    const steed = attachedTo(doc, a, 'Ride ', frame);
    const at = steed && scene.objects.has(steed) ? steed : a.id;
    const p = scene.origin(at, frame);
    const pose: RideoBlockingPose = steed ? 'sit' : rideoPose(poses.nearest(scene, a.id, frame));
    return {
      x: coord(p[0]),
      z: coord(-p[1]),
      facingDeg: facingDeg(scene.facing(at, frame)),
      pose,
      toX: null,
      toZ: null,
    };
  };

  const taken = new Set<string>();
  const actors: RideoSceneBlocking['actors'] = exported.map((a, i) => {
    const m = markAt(a, frame0);
    const color = prop(a, DESK_PROPS.color);
    // the desk sizes an animal by its withers, rideo's mannequins by their top
    const h = Number(a.custom_props?.[DESK_PROPS.heightM]) * heightRatioOf(prop(a, DESK_PROPS.kind));
    return {
      id: uniqueId(prop(a, RIDEO_PROPS.id), 'a', taken),
      characterId: characterOf.get(a.id)!,
      color: HEX.test(color)
        ? color.toLowerCase()
        : RIDEO_BLOCKING_PALETTE[i % RIDEO_BLOCKING_PALETTE.length].color,
      heightM: round(clamp(Number.isFinite(h) && h > 0 ? h : 1.7, 0.3, 4)),
      x: m.x,
      z: m.z,
      facingDeg: m.facingDeg,
      pose: m.pose,
    };
  });
  for (const a of offstageBack) actors.push({ ...a, id: uniqueId(a.id, 'a', taken) });

  // ------------------------------------------------------------ shots: marks and cameras
  const blockingShots: Record<string, RideoBlockingShot> = {};
  const exportedShots: RideoExportResult['shots'] = [];
  for (const s of shots) {
    const key = keyOf.get(s.id)!;
    const marks: Record<string, RideoBlockingMark> = {};
    for (const a of exported) {
      const start = markAt(a, s.frame_start);
      const end = markAt(a, s.frame_end);
      if (Math.hypot(end.x - start.x, end.z - start.z) > RIDEO_EXPORT_WALK_M) {
        start.toX = end.x;
        start.toZ = end.z;
      }
      marks[characterOf.get(a.id)!] = start;
    }
    for (const a of offstageBack) {
      const m = offstage.marks[key]?.[a.characterId];
      if (m) marks[a.characterId] = m;
    }
    const camera = s.camera ? cameraOf(scene, s) : null;
    if (!camera) {
      warnings.push(
        `shot '${s.name}' has no camera: left out of the blocking's shots (an import solves one)`,
      );
      continue;
    }
    const subjects = s.subjects
      .map((id) => characterOf.get(id))
      .filter((x): x is string => !!x)
      .slice(0, 8);
    blockingShots[key] = {
      marks,
      camera,
      spec:
        s.angle !== null || s.height !== null
          ? { subjects, angle: s.angle ?? 'front', height: s.height ?? 'eye', move: blockingMove(s.move) }
          : null,
    };
    exportedShots.push({ id: s.id, name: s.name, rideo_shot: key, move: s.move });
  }

  // ------------------------------------------------------------ landmarks
  const isRoot = (x: ObjectData, role: string) => {
    for (let p = x.parent; p; p = scene.objects.get(p)?.parent ?? null)
      if (prop(scene.objects.get(p), DESK_PROPS.role) === role) return false;
    return true;
  };
  const landmarks: RideoSceneBlocking['set']['landmarks'] = [];
  const landmarkIds = new Set<string>();
  for (const l of objects.filter((x) => prop(x, DESK_PROPS.role) === 'landmark' && isRoot(x, 'landmark'))) {
    if (landmarks.length >= RIDEO_MAX_LANDMARKS) {
      warnings.push(`a blocking's set holds at most ${RIDEO_MAX_LANDMARKS} landmarks: '${l.name}' left out`);
      continue;
    }
    const f = footprint(doc, scene.frameState(frame0), parts, l.id);
    if (!f) {
      warnings.push(`landmark '${l.name}' has no geometry: left out`);
      continue;
    }
    const declared = prop(l, DESK_SHAPE_PROP) as RideoLandmarkShape;
    const shape: RideoLandmarkShape = (RIDEO_LANDMARK_SHAPES as readonly string[]).includes(declared)
      ? declared
      : isWater(l)
        ? 'water'
        : 'box';
    const label = (prop(l, DESK_PROPS.label) || l.name).slice(0, 80);
    const stored = Number(l.custom_props?.[DESK_PROPS.heightM]);
    const height = shape === 'water' && Number.isFinite(stored) && stored > 0 ? stored : f.height;
    const color = prop(l, DESK_PROPS.color);
    const element = prop(l, DESK_PROPS.elementId);
    landmarks.push({
      id: uniqueId(prop(l, RIDEO_PROPS.id), 'l', landmarkIds),
      label,
      shape,
      x: coord(f.x),
      z: coord(f.z),
      width: round(clamp(f.width, 0.05, 500)),
      depth: round(clamp(f.depth, 0.05, 500)),
      height: round(clamp(height, 0.01, 200)),
      rotationDeg: round(f.rotationDeg, 2),
      color: HEX.test(color) ? color.toLowerCase() : rideoLandmarkColor(label, shape),
      elementId: isRideoId(element) ? element : null,
    });
  }

  // ------------------------------------------------------------ props
  const strings = objects.filter((x) => typeof x.custom_props?.desk_string_to === 'string');
  const props: RideoSceneBlocking['props'] = [];
  const propIds = new Set<string>();
  for (const p of objects.filter(
    (x) =>
      prop(x, DESK_PROPS.role) === 'prop' && isRoot(x, 'prop') && x.custom_props?.desk_tail_of === undefined,
  )) {
    if (props.length >= RIDEO_MAX_PROPS) {
      warnings.push(`a blocking holds at most ${RIDEO_MAX_PROPS} props: '${p.name}' left out`);
      continue;
    }
    let holder: string | null = null;
    for (const s of shots) {
      const h = attachedTo(doc, p, 'Hold ', s.frame_start);
      if (h && characterOf.has(h)) {
        holder = characterOf.get(h)!;
        break;
      }
    }
    if (!holder) {
      const str = strings.find((x) => x.custom_props?.desk_string_to === p.id);
      const anchor =
        typeof str?.custom_props?.desk_string_from === 'string' ? str.custom_props.desk_string_from : '';
      if (anchor && characterOf.has(anchor)) holder = characterOf.get(anchor)!;
    }
    // held by one of rideo's actors in no shot: the desk has no hold of theirs, rideo's stands
    const recorded = prop(p, RIDEO_PROPS.heldBy);
    if (!holder && recorded && offstageBack.some((a) => a.characterId === recorded)) holder = recorded;
    const at = scene.origin(p.id, frame0);
    const color = prop(p, DESK_PROPS.color);
    const element = prop(p, DESK_PROPS.elementId);
    props.push({
      id: uniqueId(prop(p, RIDEO_PROPS.id), 'p', propIds),
      elementId: isRideoId(element) ? element : null,
      label: (prop(p, DESK_PROPS.label) || p.name).slice(0, 80),
      x: coord(at[0]),
      z: coord(-at[1]),
      size: round(clamp(restSize(doc, parts, p.id) || 0.4, 0.05, 20)),
      color: HEX.test(color) ? color.toLowerCase() : '#c9a227',
      heldBy: holder,
    });
  }

  // ------------------------------------------------------------ the set
  const desk = getDeskSettings(doc);
  const toward = toRideo(scene.sun(frame0));
  const el = (Math.asin(clamp(toward.y, -1, 1)) * 180) / Math.PI;
  const az = (Math.atan2(toward.x, toward.z) * 180) / Math.PI;
  const blocking = {
    version: 1 as const,
    source: 'user' as const,
    updatedAt: o.now ?? new Date().toISOString(),
    set: {
      width: round(clamp(desk.set_width > 0 ? desk.set_width : 12, 2, 200)),
      depth: round(clamp(desk.set_depth > 0 ? desk.set_depth : 10, 2, 200)),
      ground: groundName(doc),
      interior: desk.interior,
      sun: { azimuthDeg: round(((az % 360) + 360) % 360, 1) % 360, elevationDeg: round(clamp(el, 2, 90), 1) },
      landmarks,
    },
    actors,
    props,
    shots: blockingShots,
  };
  const r = RideoSceneBlockingSchema.safeParse(blocking);
  if (!r.success)
    throw new OperatorError(
      `the exported blocking does not validate: ${r.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      'FAILED',
    );
  return { blocking: r.data, shots: exportedShots, warnings };
}

/** rideoHeightRatio of an actor kind as stored (1 for a kind the desk does not build). */
function heightRatioOf(kind: string): number {
  try {
    return rideoHeightRatio(requireBuiltKind(kind));
  } catch {
    return 1;
  }
}

/**
 * rideo's own blocked camera of a shot, as the import placed it (RIDEO_PROPS.camera), while the
 * camera is as the import left it (RIDEO_PROPS.motion); null once it was moved, keyed or solved again.
 */
function importedCamera(doc: SceneDoc, s: ShotData): RideoBlockingShot['camera'] | null {
  const o = s.camera ? doc.getObject(s.camera) : null;
  const text = o?.custom_props?.[RIDEO_PROPS.camera];
  const recorded = o?.custom_props?.[RIDEO_PROPS.motion];
  if (!o || typeof text !== 'string' || typeof recorded !== 'string') return null;
  if (!s.external?.shot) return null;
  if (motionDigest(doc, o.id) !== recorded) return null;
  try {
    const kept = JSON.parse(text) as { shot?: unknown; camera?: RideoBlockingShot['camera'] };
    return kept.shot === s.external.shot && kept.camera ? kept.camera : null;
  } catch {
    return null;
  }
}

/**
 * A shot's camera as rideo blocks it: its start, its lens (36 mm wide sensor) and its end; rideo's
 * own placement while the camera is as a rideo import placed it (importedCamera).
 */
function cameraOf(scene: DeskScene, s: ShotData): RideoBlockingShot['camera'] | null {
  const imported = importedCamera(scene.doc, s);
  if (imported) return imported;
  const a = scene.camera(s.camera!, s.frame_start);
  if (!a) return null;
  const b = scene.camera(s.camera!, s.frame_end);
  const placement = (view: NonNullable<typeof a>, frame: number): RideoCameraPlacement => {
    const p = toRideo(view.position);
    const t = toRideo(viewTarget(scene, view, s.subjects, frame));
    return {
      x: coord(p.x),
      y: round(clamp(p.y, -10, 200)),
      z: coord(p.z),
      targetX: coord(t.x),
      targetY: round(clamp(t.y, -10, 200)),
      targetZ: coord(t.z),
    };
  };
  const lens = a.ortho ? 35 : 18 / Math.max(1e-6, a.tanH);
  const start = placement(a, s.frame_start);
  let end: RideoCameraPlacement | null = null;
  if (b && s.frame_end > s.frame_start) {
    const moved = v3len(v3sub(b.position, a.position)) > 0.01;
    const cos = a.forward[0] * b.forward[0] + a.forward[1] * b.forward[1] + a.forward[2] * b.forward[2];
    if (moved || cos < Math.cos((0.5 * Math.PI) / 180)) end = placement(b, s.frame_end);
  }
  return { ...start, lensMm: round(clamp(lens, 8, 800), 2), end };
}
