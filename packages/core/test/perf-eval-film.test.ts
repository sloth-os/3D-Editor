import { describe, expect, it, vi } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { FCurve } from '../src/doc/types';
import { sortedKeyframes } from '../src/anim/fcurve';
import { createActor } from '../src/desk/characters';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import { frameInput } from '../src/eval/frame-input';
import { cpuMs } from './timing-helpers';

/*
 * A frame of a film costs the same whatever the film's length: the frame states of a document share
 * one reading of it (eval/frame-input.ts) and find their keys by binary search. When every frame
 * state copied every F-curve, a frame of this 3-minute film took about 0.5 s and a frame of the same
 * film 10 seconds long 40 ms; both take a few milliseconds now. So a frame of the long film is
 * timed against a frame of the short one, on the same machine and at the same time: in CPU time,
 * which leaves out the time a busy machine keeps the test waiting, of batches of frames (the clock
 * counts in steps of a few milliseconds here), the least of a few rounds in which the films take
 * turns (a collection of the long film's larger heap, or a machine slowed meanwhile, then counts in
 * one round at most). What makes it hold is checked as well: one reading of the document for every
 * frame, and the keys of each curve put in frame order once.
 */

// the calls that put a curve's keys in frame order (made by eval/frame-input.ts only)
vi.mock('../src/anim/fcurve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/anim/fcurve')>();
  return { ...actual, sortedKeyframes: vi.fn(actual.sortedKeyframes) };
});

const FPS = 24;
const KINDS = ['adult', 'woman', 'child', 'man', 'horse', 'dog', 'pony', 'cow'] as const;
/** The frames timed per round, and the rounds. */
const BATCH = 24;
const ROUNDS = 5;

/**
 * Eight actors keyed on every frame of `seconds`, as a long walk keys them: their position and
 * heading, and the rotation of ten bones each (272 F-curves; about 1.2 million keyframes in three
 * minutes). Its last frame is `last`.
 */
function film(seconds: number): { doc: SceneDoc; last: number } {
  const last = 1 + FPS * seconds;
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ frame_start: 1, frame_end: last });
  const actors = KINDS.map(
    (kind, i) => createActor(doc, { kind, location: [i * 3, 0, 0], facing_deg: 180 }).actor,
  );
  doc.transact(() =>
    actors.forEach((actor, i) => {
      const bones = Object.keys(doc.getObject(actor)!.pose.bones).slice(0, 10);
      const channels: [string, number][] = [
        ['location', 0],
        ['location', 1],
        ['location', 2],
        ['rotation_euler', 2],
        ...bones.flatMap((b) =>
          [0, 1, 2].map((k): [string, number] => [`pose.bones["${b}"].rotation_euler`, k]),
        ),
      ];
      channels.forEach(([path, index], c) => {
        const keyframes = Array.from({ length: last }, (_, f) => ({
          frame: f + 1,
          value: 0.2 * Math.sin((f + 7 * i + 3 * c) * 0.05),
          interpolation: 'BEZIER' as const,
        }));
        const fc: FCurve = {
          target_type: 'object',
          target_id: actor,
          path,
          index,
          keyframes,
          extrapolation: 'CONSTANT',
          mute: false,
        };
        doc.setFCurve(fc);
      });
    }),
  );
  return { doc, last };
}

/** What a frame of a film costs, two ways (each frame is evaluated once). */
function timer(f: { doc: SceneDoc; last: number }) {
  const ids = f.doc.objectIds();
  const ev = new SceneEvaluator(f.doc);
  // `BATCH` frames spread over the film, a frame later each round: a frame state reading every
  // object's world matrix (transformsAt, bakes, desk checks)
  const spread = (round: number) =>
    Array.from(
      { length: BATCH },
      (_, i) => 1 + round + Math.round((i * (f.last - ROUNDS - 1)) / (BATCH - 1)),
    );
  // consecutive frames from the middle of the film, the evaluated scene as renders read it (poses,
  // skinned meshes)
  const middle = Math.floor(f.last / 2);
  const consecutive = (round: number) => Array.from({ length: BATCH }, (_, i) => middle + round * BATCH + i);
  /** CPU time per frame of `frames`. */
  const perFrame = (frames: number[], step: (frame: number) => void) => {
    const t0 = cpuMs();
    for (const frame of frames) step(frame);
    return (cpuMs() - t0) / frames.length;
  };
  const worlds = (frame: number) => {
    const fs = new FrameState(f.doc, frame);
    for (const id of ids) fs.world(id);
  };
  const evaluate = (frame: number) => ev.evaluate(frame, { forRender: true });
  return {
    /** The first frames, which read the film (not timed). */
    warm: () => {
      for (const frame of [1, middle - 2, f.last]) worlds(frame);
      for (const frame of [middle - 3, middle - 2, middle - 1]) evaluate(frame);
    },
    worlds: (round: number) => perFrame(spread(round), worlds),
    evaluated: (round: number) => perFrame(consecutive(round), evaluate),
  };
}

describe('a frame of a 3-minute film of 8 actors', () => {
  it('costs what a frame of the same film 10 seconds long costs, at any frame, from one reading of the film', () => {
    const long = film(180);
    const short = film(10);
    const { doc } = long;
    const curves = new Set(doc.map('fcurves').values() as IterableIterator<FCurve>);
    expect([...curves].reduce((n, fc) => n + fc.keyframes.length, 0)).toBeGreaterThan(1_100_000);
    expect(curves.size).toBe(272);
    // what reading the document does (eval/frame-input.ts): its objects copied, its F-curves indexed,
    // the keys of each curve put in frame order as the curve is first evaluated
    const reads = vi.spyOn(doc, 'listObjects');
    const indexed = vi.spyOn(doc.map('fcurves'), 'values');
    const ordered = vi.mocked(sortedKeyframes);
    ordered.mockClear();
    const timeLong = timer(long);
    const timeShort = timer(short);
    timeLong.warm();
    timeShort.warm();
    const input = frameInput(doc);
    const least = { worlds: [Infinity, Infinity], evaluated: [Infinity, Infinity] };
    for (let round = 0; round < ROUNDS; round++)
      for (const kind of ['worlds', 'evaluated'] as const) {
        least[kind][0] = Math.min(least[kind][0], timeLong[kind](round));
        least[kind][1] = Math.min(least[kind][1], timeShort[kind](round));
      }
    // a few milliseconds a frame for both films here, the long film's 0.9 to 1.3 times the short
    // film's, with coverage and on a busy machine too; 2.9 times when a curve's keys were searched one
    // by one, 3.9 times when each frame state read the film itself, 9 times when each evaluation of a
    // curve copied its keys
    for (const kind of ['worlds', 'evaluated'] as const) {
      const [longMs, shortMs] = least[kind];
      expect(
        longMs,
        `${kind}: ${longMs.toFixed(2)} ms a frame, ${shortMs.toFixed(2)} ms in 10 s`,
      ).toBeLessThan(2 * shortMs + 1);
    }
    // every frame state and evaluation of the long film read it once, and put each curve's keys in
    // order once
    expect(reads).toHaveBeenCalledTimes(1);
    expect(indexed).toHaveBeenCalledTimes(1);
    expect(frameInput(doc)).toBe(input);
    const sorted = ordered.mock.calls.map(([fc]) => fc).filter((fc) => curves.has(fc));
    expect(new Set(sorted).size).toBe(curves.size);
    expect(sorted).toHaveLength(curves.size);
  }, 120_000);
});
