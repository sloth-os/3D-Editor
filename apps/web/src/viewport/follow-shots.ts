import { signal, type Signal } from '@preact/signals';
import { cameraForFrame, docChangeToken, getShots, type SceneDoc, type ShotData } from '@3d-editor/core';

/*
 * Follow Shots (view3d.toggle_follow_shots): the viewport's camera view and the browser's final
 * renders look through the camera of the shot at the frame, core cameraForFrame: the camera of the
 * first enabled shot covering the frame (frame_start ≤ f < frame_end + 1), else the scene camera.
 *
 * Shots may overlap in scene time (coverage of one action from several cameras). The sequence strip
 * plays and scrubs the cut shot by shot, so it pins the shot it shows: while the frame stays inside
 * the pinned shot, that shot wins over the first covering one.
 */

const pins = new WeakMap<object, Signal<string | null>>();

/**
 * The shot (id) the sequence strip pinned for a viewport's view state (one per project session);
 * null when none is.
 */
export function shotPin(view: object): Signal<string | null> {
  let pin = pins.get(view);
  if (!pin) {
    pin = signal<string | null>(null);
    pins.set(view, pin);
  }
  return pin;
}

const shotCache = new WeakMap<SceneDoc, { token: string; shots: readonly ShotData[] }>();

/**
 * The scene's shots in cut order, read once per document change (getShots copies them on every
 * call; the viewport asks on every frame it draws). Never mutate the result.
 */
export function shotsOf(doc: SceneDoc): readonly ShotData[] {
  const token = docChangeToken(doc);
  const hit = shotCache.get(doc);
  if (token !== null && hit?.token === token) return hit.shots;
  const shots = getShots(doc);
  if (token !== null) shotCache.set(doc, { token, shots });
  return shots;
}

/** Whether a shot shows scene frame `frame` (cameraForFrame's rule: a fraction belongs to the frame it starts). */
export function shotCovers(shot: Pick<ShotData, 'frame_start' | 'frame_end'>, frame: number): boolean {
  return frame >= shot.frame_start && frame < shot.frame_end + 1;
}

/** The pinned shot when it is enabled and covers `frame`, else null. */
function pinnedShot(doc: SceneDoc, frame: number, pinned: string | null): ShotData | null {
  if (!pinned) return null;
  const shot = shotsOf(doc).find((s) => s.id === pinned);
  return shot && shot.enabled && shotCovers(shot, frame) ? shot : null;
}

/**
 * The shot Follow Shots shows at scene frame `frame`: the pinned shot while it is enabled and covers
 * the frame, else the first enabled shot in cut order covering it; null when none does.
 */
export function followedShot(doc: SceneDoc, frame: number, pinned: string | null): ShotData | null {
  return (
    pinnedShot(doc, frame, pinned) ?? shotsOf(doc).find((s) => s.enabled && shotCovers(s, frame)) ?? null
  );
}

/**
 * The camera object Follow Shots looks through at scene frame `frame`: the pinned shot's camera (the
 * scene camera when it has none) while that shot is enabled and covers the frame, else
 * cameraForFrame. Null without a camera; the caller checks that the id is an evaluated camera.
 */
export function followedCameraId(doc: SceneDoc, frame: number, pinned: string | null): string | null {
  const shot = pinnedShot(doc, frame, pinned);
  if (shot) return shot.camera ?? doc.getScene().camera;
  return cameraForFrame(doc, frame);
}
