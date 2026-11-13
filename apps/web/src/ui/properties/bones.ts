import type { ArmatureData, BoneData } from '@3d-editor/core';

/**
 * The bones of an armature that the editor can show and edit: a stored item that is no bone (from a
 * damaged or foreign file) is left out, so it breaks no panel, menu or picker.
 */
export function readableBones(arm: ArmatureData | null | undefined): BoneData[] {
  if (!arm || !Array.isArray(arm.bones)) return [];
  return arm.bones.filter((b) => !!b && typeof b === 'object' && typeof b.name === 'string');
}
