import { describe, expect, it, vi } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { FCurve } from '../src/doc/types';
import { sortedKeyframes } from '../src/anim/fcurve';
import { createActor } from '../src/desk/characters';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import { frameInput } from '../src/eval/frame-input';

/*
 * A frame of a film costs the same whatever the film's length: the frame states of a document share
 * one reading of it (eval/frame-input.ts) and find their keys by binary search. When every frame
 * state copied every F-curve, a frame of this 3-minute film took about 0.5 s (and a 10-second one
 * 40 ms); it takes a few milliseconds now. The time bound is generous (busy machines, coverage), so
 * what makes it hold is checked as well: one reading of the document for every frame, and the keys of
 * each curve put in frame order once (without them a frame took 11–22 ms here, under the bound).
 */

// the calls that put a curve's keys in frame order (made by eval/frame-input.ts only)
vi.mock('../src/anim/fcurve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/anim/fcurve')>();
  return { ...actual, sortedKeyframes: vi.fn(actual.sortedKeyframes) };
});

const FPS = 24;
const SECONDS = 180;
const LAST = 1 + FPS * SECONDS;
const KINDS = ['adult', 'woman', 'child', 'man', 'horse', 'dog', 'pony', 'cow'] as const;

/**
 * Eight actors keyed on every frame of three minutes, as a long walk keys them: their position and
 * heading, and the rotation of ten bones each (272 F-curves, about 1.2 million keyframes).
 */
function film(): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ frame_start: 1, frame_end: LAST });
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
        const keyframes = Array.from({ length: LAST }, (_, f) => ({
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
  return doc;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

describe('a frame of a 3-minute film of 8 actors', () => {
  it('is evaluated in less than 40 ms after the first, at any frame, from one reading of the film', () => {
    const doc = film();
    let keys = 0;
    let curves = 0;
    for (const fc of doc.map('fcurves').values() as IterableIterator<FCurve>) {
      keys += fc.keyframes.length;
      curves++;
    }
    expect(keys).toBeGreaterThan(1_100_000);
    expect(curves).toBe(272);
    // what reading the document does (eval/frame-input.ts): its objects copied, its F-curves indexed,
    // the keys of each curve put in frame order as the curve is first evaluated
    const reads = vi.spyOn(doc, 'listObjects');
    const indexed = vi.spyOn(doc.map('fcurves'), 'values');
    const ordered = vi.mocked(sortedKeyframes);
    ordered.mockClear();
    const ids = doc.objectIds();
    const frames = Array.from({ length: 24 }, (_, i) => 1 + Math.round((i * (LAST - 1)) / 23));
    // a frame state reading every object's world matrix (transformsAt, bakes, desk checks)
    const worlds = (frame: number) => {
      const t0 = performance.now();
      const fs = new FrameState(doc, frame);
      for (const id of ids) fs.world(id);
      return performance.now() - t0;
    };
    for (const f of frames.slice(0, 3)) worlds(f);
    const input = frameInput(doc);
    expect(median(frames.map(worlds))).toBeLessThan(40);
    // the evaluated scene as renders read it (poses, skinned meshes), consecutive frames
    const ev = new SceneEvaluator(doc);
    for (let f = 2000; f < 2003; f++) ev.evaluate(f, { forRender: true });
    const evaluated = Array.from({ length: 12 }, (_, i) => {
      const t0 = performance.now();
      ev.evaluate(2003 + i, { forRender: true });
      return performance.now() - t0;
    });
    expect(median(evaluated)).toBeLessThan(40);
    // 27 frame states and 15 evaluations read the film once, and put each curve's keys in order once
    expect(reads).toHaveBeenCalledTimes(1);
    expect(indexed).toHaveBeenCalledTimes(1);
    expect(frameInput(doc)).toBe(input);
    expect(new Set(ordered.mock.calls.map(([fc]) => fc)).size).toBe(curves);
    expect(ordered).toHaveBeenCalledTimes(curves);
  });
});
