import type { FModifierData } from '../doc/types';

/*
 * F-curve modifiers (Blender FModifier): procedural adjustments applied after keyframe
 * evaluation, in stack order. Muted modifiers are skipped.
 *
 * Phase-0 stub: returns the value unchanged. The animation workstream implements NOISE,
 * STEPPED, GENERATOR, LIMITS and ENVELOPE here (deterministic, pure functions of frame/value).
 */
export function applyFModifiers(mods: FModifierData[], frame: number, value: number): number {
  void mods;
  void frame;
  return value;
}
