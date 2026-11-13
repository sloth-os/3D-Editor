import type { AnimTargetType, DatablockKind } from '@3d-editor/core';
import { evaluateFCurve, hasKeyframeAt, readChannel } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { run } from '../../editor/editor';
import type { FieldState } from '../fields/fields';
import { animatedBlock } from './animated';

type Kind = DatablockKind | 'scene' | 'render' | 'world';

/** Origin for live (uncommitted) drag previews: synced to peers but not tracked by undo. */
export const PREVIEW_ORIGIN = { type: 'preview' };

let drag: { key: string; original: unknown } | null = null;

function readField(s: ProjectSession, kind: Kind, target: string | null, field: string): unknown {
  if (kind === 'scene') return (s.doc.getScene() as unknown as Record<string, unknown>)[field];
  if (kind === 'render') return (s.doc.getRender() as unknown as Record<string, unknown>)[field];
  if (kind === 'world') return (s.doc.getWorld() as unknown as Record<string, unknown>)[field];
  return s.doc.getBlock(kind, target!)?.[field];
}

function writeField(
  s: ProjectSession,
  kind: Kind,
  target: string | null,
  field: string,
  value: unknown,
): void {
  const patch = { [field]: value };
  s.doc.transact(() => {
    if (kind === 'scene') s.doc.updateScene(patch);
    else if (kind === 'render') s.doc.updateRender(patch);
    else if (kind === 'world') s.doc.updateWorld(patch);
    else s.doc.updateBlockByKind(kind, target!, patch);
  }, PREVIEW_ORIGIN);
}

/**
 * Sets a datablock property from the UI. Non-final values (while dragging) are previewed live
 * without undo tracking; the final value runs `data.set_property` so the whole drag becomes a
 * single undo step.
 */
export function setProp(
  s: ProjectSession,
  kind: Kind,
  target: string | null,
  field: string,
  value: unknown,
  final = true,
): void {
  const key = `${kind}:${target}:${field}`;
  // a datablock an agent (or another device) deleted meanwhile takes nothing: no preview that would
  // write a stray entry, and no error toast at the end of the drag or typing
  if (!hasTarget(s, kind, target)) {
    if (drag?.key === key) drag = null;
    return;
  }
  if (!final) {
    if (!drag || drag.key !== key) drag = { key, original: readField(s, kind, target, field) };
    writeField(s, kind, target, field, value);
    return;
  }
  if (drag && drag.key === key) {
    writeField(s, kind, target, field, drag.original);
    drag = null;
  }
  run('data.set_property', { kind, target: target ?? undefined, values: { [field]: value } }, 'ui');
}

/** Whether the datablock a field edits is stored (the scene, render settings and world always are). */
function hasTarget(s: ProjectSession, kind: Kind, target: string | null): boolean {
  if (kind === 'scene' || kind === 'render' || kind === 'world') return true;
  return target !== null && !!s.doc.getBlock(kind, target);
}

export type FieldAnimState = FieldState | null;

/**
 * Animation state of a property channel at the current frame, for field colouring like Blender:
 * 'driven' when a driver sets the channel (also without keyframes; the driver overrides them),
 * 'keyed' on a keyframe of its F-curve, 'animated' between keyframes, else null.
 */
export function animState(
  s: ProjectSession,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
): FieldAnimState {
  const key = `${type}:${id}:${path}:${index}`;
  if (s.doc.getDriver(key)) return 'driven';
  const fc = s.doc.getFCurve(key);
  if (!fc || fc.keyframes.length === 0) return null;
  return hasKeyframeAt(fc, s.state.frame) ? 'keyed' : 'animated';
}

/**
 * Value of a property channel at the current frame, as the viewport and the renderers use it: the
 * value its driver gives (drivers override keyframes), else its F-curve's value, else `base` (the
 * stored value).
 */
export function animatedValue(
  s: ProjectSession,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
  base: number,
): number {
  const key = `${type}:${id}:${path}:${index}`;
  const driver = s.doc.getDriver(key);
  if (driver && !driver.mute) {
    const block = animatedBlock<Record<string, unknown>>(s, type, id);
    const v = block ? readChannel(block, path, index) : undefined;
    if (v !== undefined && Number.isFinite(v)) return v;
  }
  const fc = s.doc.getFCurve(key);
  if (!fc || fc.mute) return base;
  return evaluateFCurve(fc, s.state.frame) ?? base;
}
