import type { AnimTargetType, DatablockKind } from '@3d-editor/core';
import { evaluateFCurve, hasKeyframeAt } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { run } from '../../editor/editor';

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

export type FieldAnimState = 'keyed' | 'animated' | null;

/** Animation state of a property channel at the current frame (for field colouring). */
export function animState(
  s: ProjectSession,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
): FieldAnimState {
  const fc = s.doc.getFCurve(`${type}:${id}:${path}:${index}`);
  if (!fc || fc.keyframes.length === 0) return null;
  return hasKeyframeAt(fc, s.state.frame) ? 'keyed' : 'animated';
}

/** Value of a property channel including animation. */
export function animatedValue(
  s: ProjectSession,
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
  base: number,
): number {
  const fc = s.doc.getFCurve(`${type}:${id}:${path}:${index}`);
  if (!fc || fc.mute) return base;
  return evaluateFCurve(fc, s.state.frame) ?? base;
}
