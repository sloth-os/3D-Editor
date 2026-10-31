import type { ArmatureData, PoseBone } from '../doc/types';
import type { ArmaturePose, PoseContext } from './types';

/**
 * Computes rest and posed bone matrices of an armature (parents first). With
 * `arm.pose_position === 'REST'` pose transforms are ignored. Pose bone transforms are relative to
 * the rest pose in the bone's local space (Blender convention); bone constraints (IK…) apply last.
 *
 * Phase-0 stub: returns an empty pose. The armature workstream implements it.
 */
export function computePose(
  arm: ArmatureData,
  pose: Record<string, PoseBone>,
  ctx: PoseContext,
): ArmaturePose {
  void arm;
  void pose;
  void ctx;
  return { bones: new Map(), order: [] };
}
