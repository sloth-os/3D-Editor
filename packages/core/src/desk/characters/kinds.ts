import type { ArmatureData, PoseBone } from '../../doc/types';
import { OperatorError } from '../../operators/context';
import { HUMANOID_DEFAULT_HEIGHTS, humanoidBlueprint, humanoidStoop, type HumanoidKind } from './mannequin';
import { QUADRUPED_DEFAULT_HEIGHTS, quadrupedBlueprint, type QuadrupedKind } from './quadruped';
import {
  HUMAN_POSE_SPECS,
  animalPoseSpec,
  animalRotations,
  groundedPose,
  humanRotations,
  lowestPoint,
  poseBones,
  type AnimalPoseSpec,
} from './poses';
import { partSurfaces, type Blueprint } from './rig';
import { ACTOR_KINDS, ANIMAL_POSES, HUMAN_POSES, HUMANOID_KINDS, type ActorKind } from './types';

/*
 * Kind registry: which kinds are built, their default heights, blueprints (cached per kind and
 * height) and poses.
 */

/** Kinds built so far (the others throw a clear OperatorError). */
export const BUILT_KINDS: readonly ActorKind[] = [
  'adult',
  'man',
  'woman',
  'child',
  'toddler',
  'elder',
  'horse',
  'pony',
  'dog',
];

export function isActorKind(k: string): k is ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(k);
}

export function isHumanoidKind(k: string): k is HumanoidKind {
  return (HUMANOID_KINDS as readonly string[]).includes(k);
}

/** A kind that is built, or an OperatorError naming the ones that are. */
export function requireBuiltKind(kind: string): ActorKind {
  if (!isActorKind(kind))
    throw new OperatorError(
      `Unknown actor kind '${kind}' (kinds: ${ACTOR_KINDS.join(', ')})`,
      'INVALID_PARAMS',
    );
  if (!BUILT_KINDS.includes(kind))
    throw new OperatorError(
      `Actor kind '${kind}' is not built yet; built kinds: ${BUILT_KINDS.join(', ')}`,
      'INVALID_PARAMS',
    );
  return kind;
}

/** Default height of a kind: humanoids to the top of the head, quadrupeds at the withers. */
export function defaultHeight(kind: ActorKind): number {
  if (isHumanoidKind(kind)) return HUMANOID_DEFAULT_HEIGHTS[kind];
  return QUADRUPED_DEFAULT_HEIGHTS[kind as QuadrupedKind] ?? 1;
}

const blueprints = new Map<string, Blueprint>();

/** The blueprint of a built kind at a height (cached). */
export function blueprintFor(kind: ActorKind, height: number): Blueprint {
  const key = `${kind}:${height}`;
  let bp = blueprints.get(key);
  if (!bp) {
    const k = requireBuiltKind(kind);
    bp = isHumanoidKind(k) ? humanoidBlueprint(k, height) : quadrupedBlueprint(k as QuadrupedKind, height);
    if (blueprints.size > 256) blueprints.clear();
    blueprints.set(key, bp);
  }
  return bp;
}

/** Poses a kind accepts. */
export function posesOf(kind: ActorKind): readonly string[] {
  return isHumanoidKind(kind) ? HUMAN_POSES : ANIMAL_POSES;
}

/** A pose of the kind, or an INVALID_PARAMS OperatorError. */
export function requirePose(kind: ActorKind, pose: string): string {
  const ok = posesOf(kind);
  if (!ok.includes(pose))
    throw new OperatorError(
      `Pose '${pose}' does not fit a ${kind} (${isHumanoidKind(kind) ? 'humanoid' : 'quadruped'} poses: ${ok.join(', ')})`,
      'INVALID_PARAMS',
    );
  return pose;
}

/** Grounded pose bones of a pose for an actor of `kind` (its armature data and blueprint). */
export function posedBones(
  kind: ActorKind,
  arm: ArmatureData,
  bp: Blueprint,
  pose: string,
): Record<string, PoseBone> {
  requirePose(kind, pose);
  const surface = partSurfaces(bp);
  if (isHumanoidKind(kind)) {
    const spec = HUMAN_POSE_SPECS[pose];
    const { rot, shift } = humanRotations(spec, humanoidStoop(kind), bp.height);
    return groundedPose(
      arm,
      bp.probes,
      rot,
      shift,
      spec.ground ?? 'lowest',
      (spec.lift ?? 0) * bp.height,
      surface,
    );
  }
  let spec = animalPoseSpec(kind, pose);
  if (spec.seated) spec = { ...spec, body: seatedPitch(arm, bp, spec) };
  if (spec.graze) spec = { ...spec, neck: grazingNeck(arm, bp, spec) };
  const { rot, shift } = animalRotations(spec);
  return groundedPose(arm, bp.probes, rot, shift, spec.ground ?? 'lowest', 0, surface);
}

/**
 * The neck angle (degrees, raised > 0) of a grazing quadruped pose at which the tip of the muzzle
 * is just above the ground (a twentieth of the actor's height), bisected; the lowest angle tried
 * when the neck is too short.
 */
function grazingNeck(arm: ArmatureData, bp: Blueprint, spec: AnimalPoseSpec): number {
  const surface = partSurfaces(bp);
  const muzzle = [{ bone: 'head', point: bp.head.nose, radius: 0 }];
  const clearance = 0.05 * bp.height;
  // the muzzle's height above the lowest point of the body, less the clearance (falls as the neck lowers)
  const above = (neck: number) => {
    const bones = poseBones(arm, animalRotations({ ...spec, neck }).rot, [0, 0, 0]);
    return lowestPoint(arm, bones, muzzle) - lowestPoint(arm, bones, bp.probes, surface) - clearance;
  };
  // the muzzle keeps falling until the neck points about 105° below its rest angle
  let hi = 0;
  let lo = -105;
  if (above(lo) > 0) return lo;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (above(mid) > 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The body pitch (degrees, nose up < 0) of a seated quadruped pose at which its straight front legs
 * stand on the ground while its rump sits on it: the pitch where the front feet and the rest of the
 * body reach the same lowest height (scanned, then bisected).
 */
function seatedPitch(arm: ArmatureData, bp: Blueprint, spec: AnimalPoseSpec): number {
  const front = (bone: string) => /\.F[LR]$/.test(bone) && !bone.startsWith('upper_leg');
  const surface = partSurfaces(bp);
  const frontSurface = surface.filter((p) => front(p.bone));
  const restSurface = surface.filter((p) => !front(p.bone));
  const frontProbes = bp.probes.filter((p) => front(p.bone));
  const restProbes = bp.probes.filter((p) => !front(p.bone));
  // front feet above the rest (> 0) once the body is pitched up far enough
  const gap = (body: number) => {
    const bones = poseBones(arm, animalRotations({ ...spec, body }).rot, [0, 0, 0]);
    return (
      lowestPoint(arm, bones, frontProbes, frontSurface) - lowestPoint(arm, bones, restProbes, restSurface)
    );
  };
  let lo = -2;
  if (gap(lo) >= 0) return lo;
  for (let b = -6; b >= -80; b -= 4) {
    if (gap(b) < 0) {
      lo = b;
      continue;
    }
    let hi = b;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (gap(mid) >= 0) hi = mid;
      else lo = mid;
    }
    return hi;
  }
  return spec.body ?? 0;
}
