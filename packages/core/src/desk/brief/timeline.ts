import type { SceneDoc } from '../../doc/scene-doc';
import type { FCurve, FModifierData, Keyframe, ObjectData } from '../../doc/types';
import { fcurveKey } from '../../doc/scene-doc';
import { evaluateFCurve } from '../../anim/fcurve';
import { sanitizeRigidBodyWorld } from '../../physics/settings';
import { hiddenScale } from '../hide';
import { DESK_PROPS } from '../props';
import { getShots, setShots } from '../shots';
import { inWaterSpans, setInWaterSpans, type FrameSpan } from '../water';
import { RIGID_BODY_BAKED_PROP } from '../physics/common';
import { replaceKeys } from '../rideo/keys';

/*
 * Scene time for brief updates (update.ts), as an editor's ripple edits change it: frames inserted
 * after a frame (a shot grows, or a new one fits between two) or deleted (a shot shrinks, or one goes),
 * everything after moving with them, so that every other shot keeps its staging (its keys, holds,
 * flights, physics) only earlier or later; and an object keyed shown or hidden (by its scale, hide.ts)
 * over a span of frames, the frames around it left as they were.
 *
 * What moves: the keys of every F-curve and the frames of their modifiers, the shots, the scene's and
 * the rigid body world's ranges, bodies' start frames, recorded tether flights, in-water spans, the
 * frame a body floats from and the range a bake records. Drivers that read the frame number cannot be
 * moved: the edit warns of them.
 */

const EPS = 1e-6;
/** The tether flights a flyer records (desk.tether_fly: "lo:hi[hs][@anchor[/bone]]" entries). */
const FLIGHTS = 'desk_tether_flights';
/** The frame an earlier version's flight hid its flyer from. */
const LEGACY_HIDDEN_FROM = 'desk_tether_hidden_from';
/** The F-curve modifier parameters that are frames (restricted ranges, a stepped curve's alignment). */
const MODIFIER_FRAMES = ['frame_start', 'frame_end', 'frame_offset'] as const;

/** A ripple edit: where a frame goes (`start` for the first frame of a range, `end` for its last), and the frames it deletes. */
interface Remap {
  start: (f: number) => number;
  end: (f: number) => number;
  cut: { from: number; to: number } | null;
  /** Whether frame `f` is moved at all (curves and objects without such frames are left alone). */
  touches: (f: number) => boolean;
  what: string;
}

/**
 * Inserts `delta` frames after frame `after`: everything later moves `delta` later; a shot spanning
 * `after` grows. Returns warnings (drivers that read the frame number).
 */
export function insertSceneTime(doc: SceneDoc, after: number, delta: number): string[] {
  if (!(delta > 0)) return [];
  const move = (f: number) => (f > after + EPS ? f + delta : f);
  return remapSceneTime(doc, {
    start: move,
    end: move,
    cut: null,
    touches: (f) => f > after + EPS,
    what: `the ${delta} frame${delta > 1 ? 's' : ''} inserted after frame ${after}`,
  });
}

/**
 * Deletes frames `from`–`to` (inclusive): the keys inside go (each curve keeps, at `from`, the value it
 * had at `to + 1`), everything later moves earlier by their count; a range ending inside them ends at
 * `from - 1`, one starting inside them starts at `from`, one inside them goes. Returns warnings.
 */
export function deleteSceneTime(doc: SceneDoc, from: number, to: number): string[] {
  if (!(to >= from)) return [];
  const n = to - from + 1;
  const inside = (f: number) => f >= from - EPS && f <= to + EPS;
  return remapSceneTime(doc, {
    start: (f) => (f > to + EPS ? f - n : inside(f) ? from : f),
    end: (f) => (f > to + EPS ? f - n : inside(f) ? from - 1 : f),
    cut: { from, to },
    touches: (f) => f >= from - EPS,
    what: `the ${n} frame${n > 1 ? 's' : ''} deleted from frame ${from}`,
  });
}

/** A curve's keys after the edit (null: unchanged). */
function remapKeys(fc: FCurve, r: Remap): Keyframe[] | null {
  if (!fc.keyframes.some((k) => r.touches(k.frame))) return null;
  let keys = fc.keyframes;
  if (r.cut) {
    const { from, to } = r.cut;
    const inside = (k: Keyframe) => k.frame >= from - EPS && k.frame <= to + EPS;
    const gone = keys.filter(inside);
    if (gone.length) {
      // the value the curve had right after the deleted frames is kept where they were
      const after = to + 1;
      const kept = keys.filter((k) => !inside(k));
      if (!kept.some((k) => Math.abs(k.frame - after) < EPS)) {
        const value = evaluateFCurve({ ...fc, modifiers: [] }, after);
        const last = [...keys].reverse().find((k) => k.frame < after - EPS)!;
        if (value !== undefined) kept.push({ ...last, frame: after, value });
      }
      keys = kept;
    }
  }
  return keys.map((k) => ({ ...k, frame: r.start(k.frame) })).sort((a, b) => a.frame - b.frame);
}

/** A "lo:hi…" flight entry moved by the edit (null: it was inside deleted frames). */
function remapFlight(entry: string, r: Remap): string | null {
  const m = /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)(.*)$/.exec(entry);
  if (!m) return entry;
  const lo = r.start(Number(m[1]));
  const hi = r.end(Number(m[2]));
  return hi < lo ? null : `${lo}:${hi}${m[3]}`;
}

function remapSceneTime(doc: SceneDoc, r: Remap): string[] {
  // every animation curve, whatever it animates
  for (const fc of doc.listFCurves()) {
    const keys = remapKeys(fc, r);
    const mods = (fc.modifiers ?? []).some((m) =>
      MODIFIER_FRAMES.some((p) => typeof m.params[p] === 'number' && r.touches(m.params[p] as number)),
    );
    if (!keys && !mods) continue;
    const next: FCurve = { ...fc, keyframes: keys ?? fc.keyframes };
    if (fc.modifiers)
      next.modifiers = fc.modifiers.map((m): FModifierData => {
        const params = { ...m.params };
        for (const p of MODIFIER_FRAMES)
          if (typeof params[p] === 'number')
            params[p] = p === 'frame_end' ? r.end(params[p] as number) : r.start(params[p] as number);
        return { ...m, params };
      });
    doc.setFCurve(next);
  }
  // the shots: later ones move, one spanning an insertion grows, one spanning a deletion shrinks
  const shots = getShots(doc);
  if (shots.some((s) => r.touches(s.frame_end))) {
    const moved = shots.map((s) => {
      const start = r.start(s.frame_start);
      return { ...s, frame_start: start, frame_end: Math.max(start, r.end(s.frame_end)) };
    });
    setShots(doc, moved);
  }
  // the scene's range and the rigid body world's
  const scene = doc.getScene();
  if (r.touches(scene.frame_end)) {
    const start = r.start(scene.frame_start);
    doc.updateScene({ frame_start: start, frame_end: Math.max(start, r.end(scene.frame_end)) });
  }
  const world = sanitizeRigidBodyWorld(scene.rigidbody_world);
  if (r.touches(world.frame_end)) {
    const start = r.start(world.frame_start);
    doc.updateScene({
      rigidbody_world: { ...world, frame_start: start, frame_end: Math.max(start, r.end(world.frame_end)) },
    });
  }
  // what objects record of frames
  for (const o of doc.listObjects()) {
    const patch: Partial<ObjectData> = {};
    if (o.rigid_body && typeof o.rigid_body.start_frame === 'number' && r.touches(o.rigid_body.start_frame))
      patch.rigid_body = { ...o.rigid_body, start_frame: r.start(o.rigid_body.start_frame) };
    const props = { ...o.custom_props };
    let changed = false;
    const flights = props[FLIGHTS];
    if (typeof flights === 'string') {
      const moved = flights
        .split(/\s+/)
        .filter(Boolean)
        .map((e) => remapFlight(e, r))
        .filter((e): e is string => e !== null)
        .join(' ');
      if (moved !== flights) {
        props[FLIGHTS] = moved;
        changed = true;
      }
    }
    for (const key of [LEGACY_HIDDEN_FROM, DESK_PROPS.floats]) {
      const v = props[key];
      if (typeof v === 'number' && r.touches(v)) {
        props[key] = r.start(v);
        changed = true;
      }
    }
    const baked = props[RIGID_BODY_BAKED_PROP];
    if (typeof baked === 'string') {
      const moved = baked.replace(
        /frames (-?\d+)-(-?\d+)/,
        (_m, a: string, b: string) => `frames ${r.start(Number(a))}-${r.end(Number(b))}`,
      );
      if (moved !== baked) {
        props[RIGID_BODY_BAKED_PROP] = moved;
        changed = true;
      }
    }
    if (changed) patch.custom_props = props;
    if (Object.keys(patch).length) doc.updateObject(o.id, patch);
    // in-water spans (water.ts writes them back in its own form; open ends stay open)
    const spans = inWaterSpans(doc.getObject(o.id));
    if (spans.some(([a, b]) => r.touches(a) || r.touches(b)))
      setInWaterSpans(
        doc,
        o.id,
        spans
          .map(([a, b]): FrameSpan => [
            Number.isFinite(a) ? r.start(a) : a,
            Number.isFinite(b) ? r.end(b) : b,
          ])
          .filter(([a, b]) => b >= a),
      );
  }
  const readsFrame = doc.listDrivers().filter((d) => !d.mute && /\bframe\b/.test(d.expression));
  return readsFrame.length
    ? [
        `${readsFrame.length} driver${readsFrame.length > 1 ? 's read' : ' reads'} the frame number: ${readsFrame.length > 1 ? 'they do' : 'it does'} not follow ${r.what}`,
      ]
    : [];
}

/** The scale an object channel has at `frame` (its F-curve, else its stored value). */
function scaleAt(doc: SceneDoc, id: string, i: number, frame: number, stored: readonly number[]): number {
  const fc = doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'scale', index: i }));
  return (fc ? evaluateFCurve(fc, frame) : undefined) ?? stored[i];
}

/**
 * Keys object `id` shown (at its stored scale) or hidden (shrunk to a point: hide.ts) over frames
 * `from`–`to`, the frame before and the frame after keeping the scale they had (CONSTANT keys); the
 * keys its scale had inside the span are replaced. Nothing is keyed for an object shown that has no
 * scale curve.
 */
export function keyVisible(doc: SceneDoc, id: string, from: number, to: number, visible: boolean): void {
  const o = doc.getObject(id);
  if (!o) return;
  const stored = o.scale;
  const curves = [0, 1, 2].map((i) =>
    doc.getFCurve(fcurveKey({ target_type: 'object', target_id: id, path: 'scale', index: i })),
  );
  if (visible && curves.every((c) => !c)) return;
  for (let i = 0; i < 3; i++) {
    const before = scaleAt(doc, id, i, from - 1, stored);
    const after = scaleAt(doc, id, i, to + 1, stored);
    replaceKeys(doc, id, 'scale', i, from - 1, to + 1, [
      { frame: from - 1, value: before, interpolation: 'CONSTANT' },
      { frame: from, value: visible ? stored[i] : hiddenScale(stored[i]), interpolation: 'CONSTANT' },
      { frame: to + 1, value: after, interpolation: 'CONSTANT' },
    ]);
  }
}
