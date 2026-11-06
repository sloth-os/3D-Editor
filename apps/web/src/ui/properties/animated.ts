import { FrameState, type AnimTargetType } from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';

interface Memo {
  revision: number;
  frame: number;
  state: FrameState;
}
const memo = new WeakMap<ProjectSession, Memo>();

/**
 * A datablock (material, light, camera, world …) as it is at the current frame, with its keyframes,
 * F-curve modifiers and drivers applied: the values the viewport and the renderers use. Property
 * panels display these, so an animated field shows the value at the frame (dragging it changes the
 * stored value, which the animation overrides, like in Blender). Null when the datablock has no
 * animation (its stored values are the values) or does not exist.
 *
 * One lazy frame state per document revision and frame is shared by every panel of a redraw (only
 * the datablocks asked for are animated); reading it subscribes the calling component to document
 * and frame changes.
 */
export function animatedBlock<T>(s: ProjectSession, type: AnimTargetType, id: string): T | null {
  const frame = s.state.frame;
  const revision = s.revision.value;
  try {
    const animated =
      s.doc.listFCurves(id).some((fc) => fc.target_type === type && !fc.mute && fc.keyframes.length > 0) ||
      s.doc.listDrivers(id).some((d) => d.target_type === type && !d.mute);
    if (!animated) return null;
    let m = memo.get(s);
    if (!m || m.revision !== revision || m.frame !== frame) {
      m = { revision, frame, state: new FrameState(s.doc, frame) };
      memo.set(s, m);
    }
    return m.state.get<T>(type, id);
  } catch (e) {
    console.error('animated values unavailable', e);
    return null;
  }
}
