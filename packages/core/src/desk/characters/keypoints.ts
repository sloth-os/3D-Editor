import type { Mat4, Vec3 } from '../../math/types';
import { invert4, multiply4 } from '../../math/mat4';
import { transformPoint3 } from '../../math/vec3';
import type { ArmatureData } from '../../doc/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { FrameState } from '../../eval/frame-state';
import { axisLengths } from '../../constraints/math';
import { OperatorError } from '../../operators/context';
import { blueprintFor, requireBuiltKind } from './kinds';
import { actorParts, requireActor, restMatrices, type ActorMeta, type Blueprint } from './rig';
import type { ActorInfo, ActorKeypoints, ActorKind } from './types';

/*
 * Measuring actors (spec §8): actorInfo reads the evaluated bones and parts of an actor at the
 * frame a FrameState evaluates; actorKeypoints gives its pose as keypoints. Landmarks that are not
 * joints (nose, eyes, ears, the top of the head, the chest) are fixed offsets on their bones,
 * stored in the kind's blueprint in rest (character) space, and follow their bone.
 */

/**
 * OpenPose-18 (COCO) keypoint order of humanoids; "r_" is the character's own right side.
 * Neck = the base of the neck between the shoulders.
 */
export const OPENPOSE18_KEYPOINTS = [
  'nose',
  'neck',
  'r_shoulder',
  'r_elbow',
  'r_wrist',
  'l_shoulder',
  'l_elbow',
  'l_wrist',
  'r_hip',
  'r_knee',
  'r_ankle',
  'l_hip',
  'l_knee',
  'l_ankle',
  'r_eye',
  'l_eye',
  'r_ear',
  'l_ear',
] as const;

/**
 * Quadruped keypoint order (AP-10K's 17). Shoulders and hips are the legs' roots in the body,
 * elbows (front) and knees (hind) where each leg leaves the body, paws the tips of the hooves or
 * paws; neck = the base of the neck, tail_root = the base of the tail.
 */
export const QUADRUPED_KEYPOINTS = [
  'l_eye',
  'r_eye',
  'nose',
  'neck',
  'tail_root',
  'l_shoulder',
  'l_elbow',
  'l_front_paw',
  'r_shoulder',
  'r_elbow',
  'r_front_paw',
  'l_hip',
  'l_knee',
  'l_back_paw',
  'r_hip',
  'r_knee',
  'r_back_paw',
] as const;

/** Where a keypoint is: a bone's head or tail, a blueprint landmark or named point. */
type Source =
  | { head: string }
  | { tail: string }
  | { landmark: 'nose' | 'eyeL' | 'eyeR' | 'earL' | 'earR' | 'top' }
  | { point: string };

const HUMAN_SOURCES: Source[] = [
  { landmark: 'nose' },
  { head: 'neck' },
  { head: 'upper_arm.R' },
  { head: 'forearm.R' },
  { head: 'hand.R' },
  { head: 'upper_arm.L' },
  { head: 'forearm.L' },
  { head: 'hand.L' },
  { head: 'thigh.R' },
  { head: 'shin.R' },
  { head: 'foot.R' },
  { head: 'thigh.L' },
  { head: 'shin.L' },
  { head: 'foot.L' },
  { landmark: 'eyeR' },
  { landmark: 'eyeL' },
  { landmark: 'earR' },
  { landmark: 'earL' },
];

const QUADRUPED_SOURCES: Source[] = [
  { landmark: 'eyeL' },
  { landmark: 'eyeR' },
  { landmark: 'nose' },
  { head: 'neck' },
  { head: 'tail.1' },
  { head: 'upper_leg.FL' },
  { point: 'elbow.FL' },
  { tail: 'foot.FL' },
  { head: 'upper_leg.FR' },
  { point: 'elbow.FR' },
  { tail: 'foot.FR' },
  { head: 'upper_leg.BL' },
  { point: 'knee.BL' },
  { tail: 'foot.BL' },
  { head: 'upper_leg.BR' },
  { point: 'knee.BR' },
  { tail: 'foot.BR' },
];

/** An actor read from a frame state: world points of its bones and landmarks. */
class Measured {
  readonly meta: ActorMeta;
  readonly kind: ActorKind;
  readonly bp: Blueprint;
  readonly world: Mat4;
  private readonly arm: ArmatureData;
  private readonly rest: Map<string, { matrix: Mat4; length: number }>;
  private readonly deltas = new Map<string, Mat4 | null>();

  constructor(
    readonly fs: FrameState,
    readonly doc: SceneDoc,
    actorId: string,
  ) {
    this.meta = requireActor(doc, actorId);
    this.kind = requireBuiltKind(this.meta.kind);
    const arm = doc.getArmature(this.meta.armature);
    if (!arm) throw new OperatorError(`Actor '${this.meta.name}' has no armature data`, 'FAILED');
    this.arm = arm;
    this.bp = blueprintFor(this.kind, this.meta.height);
    this.rest = restMatrices(arm.bones);
    const world = fs.world(this.meta.id);
    if (!world)
      throw new OperatorError(`Actor '${this.meta.name}' cannot be evaluated (dependency cycle)`, 'FAILED');
    this.world = world;
  }

  /** World matrix taking rest (character) space points on `bone` to where the posed bone has them. */
  private delta(bone: string): Mat4 | null {
    if (this.deltas.has(bone)) return this.deltas.get(bone)!;
    const posed = this.fs.boneMatrix(this.meta.id, bone);
    const rest = this.rest.get(bone);
    const d = posed && rest ? multiply4(posed.matrix, invert4(rest.matrix)) : null;
    this.deltas.set(bone, d);
    return d;
  }

  /** World position of a rest-space point carried by `bone` (null when the bone is missing). */
  at(bone: string, p: Readonly<Vec3>): Vec3 | null {
    const d = this.delta(bone);
    return d ? transformPoint3(d, p) : null;
  }

  head(bone: string): Vec3 | null {
    const b = this.arm.bones.find((x) => x.name === bone);
    return b ? this.at(bone, b.head) : null;
  }

  tail(bone: string): Vec3 | null {
    const b = this.arm.bones.find((x) => x.name === bone);
    return b ? this.at(bone, b.tail) : null;
  }

  source(s: Source): Vec3 | null {
    if ('head' in s) return this.head(s.head);
    if ('tail' in s) return this.tail(s.tail);
    if ('landmark' in s) return this.at('head', this.bp.head[s.landmark]);
    const n = this.bp.points[s.point];
    return n ? this.at(n.bone, n.point) : null;
  }
}

const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * The actor measured at the frame `fs` evaluates (world space): its feet (the middle of its feet,
 * at the lowest sole or hoof), eyes, the top of its head, chest, horizontal facing and the bounds of
 * its parts. height_m is its built height (people: to the top of the head; animals: at the withers)
 * times the object's scale.
 */
export function measureActor(fs: FrameState, doc: SceneDoc, actorId: string): ActorInfo {
  const m = new Measured(fs, doc, actorId);
  const { bp } = m;
  // feet: the ground probes on the feet (soles, toes, hooves)
  let sx = 0;
  let sy = 0;
  let n = 0;
  let low = Infinity;
  for (const p of bp.probes) {
    if (!p.bone.startsWith('foot.') && !p.bone.startsWith('toe.')) continue;
    const w = m.at(p.bone, p.point);
    if (!w) continue;
    sx += w[0];
    sy += w[1];
    n++;
    low = Math.min(low, w[2] - p.radius);
  }
  const origin: Vec3 = [m.world[12], m.world[13], m.world[14]];
  const feet: Vec3 = n ? [sx / n, sy / n, low] : origin;
  const eyeL = m.source({ landmark: 'eyeL' });
  const eyeR = m.source({ landmark: 'eyeR' });
  const eyes = eyeL && eyeR ? mid(eyeL, eyeR) : origin;
  const headTop = m.source({ landmark: 'top' }) ?? origin;
  const chest = m.at('chest', bp.chest) ?? origin;
  // facing: the object's front (−Y) made horizontal; a pitched object falls back on its up axis
  let fx = -m.world[4];
  let fy = -m.world[5];
  if (Math.hypot(fx, fy) < 1e-6) {
    fx = m.world[8];
    fy = m.world[9];
  }
  const fl = Math.hypot(fx, fy) || 1;
  const facing: Vec3 = Math.hypot(fx, fy) < 1e-9 ? [0, -1, 0] : [fx / fl, fy / fl, 0];
  // bounds of the parts: their vertices placed by their world matrices (a few thousand)
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: Readonly<Vec3>) => {
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  };
  const q: Vec3 = [0, 0, 0];
  for (const id of actorParts(doc, m.meta.id).values()) {
    const o = doc.getObject(id);
    const mesh = o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    const w = mesh ? fs.world(id) : null;
    if (!mesh || !w) continue;
    const pos = mesh.positions;
    for (let i = 0; i + 2 < pos.length; i += 3) {
      const x = pos[i];
      const y = pos[i + 1];
      const z = pos[i + 2];
      q[0] = w[0] * x + w[4] * y + w[8] * z + w[12];
      q[1] = w[1] * x + w[5] * y + w[9] * z + w[13];
      q[2] = w[2] * x + w[6] * y + w[10] * z + w[14];
      grow(q);
    }
  }
  if (!Number.isFinite(min[0])) {
    // no parts left: the skeleton's joints and the landmarks
    for (const b of doc.getArmature(m.meta.armature)?.bones ?? []) {
      const h = m.head(b.name);
      const t = m.tail(b.name);
      if (h) grow(h);
      if (t) grow(t);
    }
    grow(headTop);
    grow(feet);
  }
  const scale = axisLengths(m.world)[2];
  return {
    kind: m.kind,
    height_m: m.meta.height * (Number.isFinite(scale) && scale > 0 ? scale : 1),
    feet,
    eyes,
    head_top: headTop,
    chest,
    facing,
    bounds: { min, max },
  };
}

/** Keypoints of the actor at the frame `fs` evaluates (OPENPOSE18_KEYPOINTS or QUADRUPED_KEYPOINTS order). */
export function keypointsOf(fs: FrameState, doc: SceneDoc, actorId: string): ActorKeypoints {
  const m = new Measured(fs, doc, actorId);
  const human = m.bp.family === 'humanoid';
  const sources = human ? HUMAN_SOURCES : QUADRUPED_SOURCES;
  return { format: human ? 'openpose18' : 'quadruped', points: sources.map((s) => m.source(s)) };
}
