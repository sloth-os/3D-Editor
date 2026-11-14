import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  SceneDoc,
  SceneEvaluator,
  cameraForFrame,
  getShots,
  shotAtSequenceFrame,
  type ShotData,
} from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { followedCameraId, followedShot, shotCovers, shotPin, shotsOf } from '../src/viewport/follow-shots';
import {
  blockAt,
  seconds,
  sequenceBlocks,
  sequenceFrameAtX,
  sequenceFrameOf,
  sequencePosition,
  sequenceTotal,
  timecode,
  xOfSequenceFrame,
} from '../src/ui/director/sequence';
import {
  currentSequenceFrame,
  playSequence,
  sequencePlaying,
  showSequenceFrame,
  showShot,
  stopSequence,
  tickSequence,
} from '../src/ui/director/playback';

/*
 * The sequence strip's mapping between the cut (sequence frames) and scene frames, Follow Shots'
 * choice of camera (the shot the strip pinned wins while it covers the frame), and the real-time
 * playback of the cut through the shot cameras.
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

function ok(id: string, params: Record<string, unknown>): Record<string, unknown> {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
  return (r.result ?? {}) as Record<string, unknown>;
}

/** Adds a shot over scene frames start..end with a camera of its own standing at x. */
function addShot(name: string, start: number, end: number, x = 0): string {
  const r = ok('desk.shot_add', {
    name,
    frame_start: start,
    frame_end: end,
    from_view: { position: [x, -8, 1.6], target: [x, 0, 1], lens_mm: 35 },
    solve: false,
  });
  return (r.shot as { id: string }).id;
}

const shot = (s: ProjectSession, name: string): ShotData => getShots(s.doc).find((x) => x.name === name)!;

let s: ProjectSession;
beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  stopSequence();
  sessionSignal.value = null;
  vi.unstubAllGlobals();
});

describe('sequence blocks', () => {
  it('lays the enabled shots end to end in cut order, as long as their frames', () => {
    addShot('A', 1, 48);
    addShot('B', 49, 168);
    addShot('C', 169, 192);
    ok('desk.shot_update', { shot: 'B', enabled: false });
    const blocks = sequenceBlocks(getShots(s.doc));
    expect(blocks.map((b) => [b.shot.name, b.index, b.start, b.frames])).toEqual([
      ['A', 0, 0, 48],
      ['C', 2, 48, 24],
    ]);
    expect(sequenceTotal(blocks)).toBe(72);
    expect(sequenceTotal([])).toBe(0);
    expect(blockAt(blocks, 0)?.shot.name).toBe('A');
    expect(blockAt(blocks, 47)?.shot.name).toBe('A');
    expect(blockAt(blocks, 48)?.shot.name).toBe('C');
    expect(blockAt(blocks, 72)).toBeNull();
    expect(blockAt(blocks, -1)).toBeNull();
  });

  it('agrees with core shotAtSequenceFrame frame by frame, and maps scene frames back', () => {
    addShot('A', 1, 30);
    addShot('B', 100, 109);
    // B is placed before A in the cut: cut order, not scene order
    ok('desk.shot_move', { shot: 'B', index: 0 });
    addShot('C', 31, 40);
    const shots = getShots(s.doc);
    const blocks = sequenceBlocks(shots);
    const total = sequenceTotal(blocks);
    expect(total).toBe(50);
    for (let k = 0; k < total; k++) {
      const pos = sequencePosition(shots, k)!;
      const core = shotAtSequenceFrame(shots, k)!;
      expect(pos.shot.id).toBe(core.shot.id);
      expect(pos.sceneFrame).toBe(core.sceneFrame);
      const b = blockAt(blocks, k)!;
      expect(b.shot.id).toBe(pos.shot.id);
      expect(pos.sceneFrame).toBe(b.shot.frame_start + (k - b.start));
      // and back: the scene frame (in that shot) is shown at sequence frame k
      expect(sequenceFrameOf(blocks, pos.sceneFrame, pos.shot.id)).toBe(k);
    }
    expect(sequencePosition(shots, total)).toBeNull();
    expect(sequencePosition(shots, -1)).toBeNull();
  });

  it('shows a scene frame in the pinned shot while it covers it, else in the first covering shot', () => {
    // coverage: two shots of the same action from two cameras
    addShot('Wide', 1, 48, 0);
    addShot('Close', 1, 48, 3);
    addShot('Next', 49, 72, 0);
    const blocks = sequenceBlocks(getShots(s.doc));
    const close = shot(s, 'Close').id;
    expect(sequenceFrameOf(blocks, 10, null)).toBe(9);
    expect(sequenceFrameOf(blocks, 10, close)).toBe(48 + 9);
    // fractions belong to the frame they start in
    expect(sequenceFrameOf(blocks, 10.75, close)).toBe(48 + 9);
    // the pin does not hold outside its shot
    expect(sequenceFrameOf(blocks, 50, close)).toBe(96 + 1);
    // before the cut, after it, and in a gap
    expect(sequenceFrameOf(blocks, 0, null)).toBeNull();
    expect(sequenceFrameOf(blocks, 73, null)).toBeNull();
    expect(sequenceFrameOf(blocks, 10, 'no-such-shot')).toBe(9);
  });

  it('maps pointer x to sequence frames and back, clamped into the cut', () => {
    expect(sequenceFrameAtX(0, 800, 100)).toBe(0);
    expect(sequenceFrameAtX(7.99, 800, 100)).toBe(0);
    expect(sequenceFrameAtX(8, 800, 100)).toBe(1);
    expect(sequenceFrameAtX(799.9, 800, 100)).toBe(99);
    expect(sequenceFrameAtX(5000, 800, 100)).toBe(99);
    expect(sequenceFrameAtX(-40, 800, 100)).toBe(0);
    expect(sequenceFrameAtX(100, 0, 100)).toBe(0);
    expect(sequenceFrameAtX(100, 800, 0)).toBe(0);
    expect(sequenceFrameAtX(Number.NaN, 800, 100)).toBe(0);
    expect(xOfSequenceFrame(25, 800, 100)).toBe(200);
    expect(xOfSequenceFrame(25, 800, 0)).toBe(0);
    for (const k of [0, 1, 37, 99]) expect(sequenceFrameAtX(xOfSequenceFrame(k, 800, 100), 800, 100)).toBe(k);
  });

  it('formats timecodes and lengths', () => {
    expect(timecode(0, 24)).toBe('00:00:00');
    expect(timecode(25, 24)).toBe('00:01:01');
    expect(timecode(24 * 61 + 5, 24)).toBe('01:01:05');
    expect(timecode(24 * 3600, 24)).toBe('01:00:00:00');
    expect(timecode(-5, 24)).toBe('00:00:00');
    // non-integer rates count whole frames of the rounded rate
    expect(timecode(30, 29.97)).toBe('00:01:00');
    expect(seconds(120, 24)).toBe('5 s');
    expect(seconds(36, 24)).toBe('1.5 s');
    expect(seconds(10, 0)).toBe('10 s');
  });
});

describe('follow shots', () => {
  it('looks through the shot at the frame, the pinned one first, the scene camera between shots', () => {
    addShot('Wide', 1, 48, 0);
    addShot('Close', 1, 48, 3);
    addShot('Later', 60, 70, 6);
    const wide = shot(s, 'Wide');
    const close = shot(s, 'Close');
    const scene = s.doc.getScene().camera;
    expect(followedCameraId(s.doc, 10, null)).toBe(wide.camera);
    expect(followedCameraId(s.doc, 10, null)).toBe(cameraForFrame(s.doc, 10));
    expect(followedCameraId(s.doc, 10, close.id)).toBe(close.camera);
    expect(followedShot(s.doc, 10, close.id)?.name).toBe('Close');
    // the pin holds only while its shot covers the frame
    expect(followedCameraId(s.doc, 65, close.id)).toBe(shot(s, 'Later').camera);
    expect(followedShot(s.doc, 55, close.id)).toBeNull();
    expect(followedCameraId(s.doc, 55, close.id)).toBe(scene);
    // a disabled pinned shot is not shown
    ok('desk.shot_update', { shot: 'Close', enabled: false });
    expect(followedCameraId(s.doc, 10, close.id)).toBe(wide.camera);
    // a pinned shot without a camera of its own looks through the scene camera
    ok('desk.shot_update', { shot: 'Wide', camera: null });
    expect(followedCameraId(s.doc, 10, wide.id)).toBe(scene);
  });

  it('covers frame_start up to (not including) frame_end + 1', () => {
    const shotRange = { frame_start: 10, frame_end: 20 };
    expect(shotCovers(shotRange, 9.999)).toBe(false);
    expect(shotCovers(shotRange, 10)).toBe(true);
    expect(shotCovers(shotRange, 20.999)).toBe(true);
    expect(shotCovers(shotRange, 21)).toBe(false);
  });

  it('reads the shots once per document change', () => {
    addShot('A', 1, 10);
    const first = shotsOf(s.doc);
    expect(shotsOf(s.doc)).toBe(first);
    ok('desk.shot_update', { shot: 'A', name: 'A2' });
    const second = shotsOf(s.doc);
    expect(second).not.toBe(first);
    expect(second[0].name).toBe('A2');
  });

  it('keeps one pin per view state', () => {
    const other = new ViewState();
    shotPin(s.view).value = 'x';
    expect(shotPin(s.view).value).toBe('x');
    expect(shotPin(other).value).toBeNull();
  });
});

describe('sequence playback', () => {
  /** Animation frames never run by themselves: the tests call tickSequence with their own clock. */
  function stubFrames(): void {
    let n = 0;
    vi.stubGlobal('requestAnimationFrame', () => ++n);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
  }

  it('shows a sequence frame through its shot: frame, pin, Follow Shots and camera view', () => {
    addShot('Wide', 1, 48, 0);
    addShot('Close', 1, 48, 3);
    const close = shot(s, 'Close');
    expect(showSequenceFrame(s, 48 + 5)).toBe(6);
    expect(s.state.frame).toBe(6);
    expect(shotPin(s.view).value).toBe(close.id);
    expect(s.view.followShots.value).toBe(true);
    expect(s.view.cameraView.value).toBe(true);
    expect(currentSequenceFrame(s)).toBe(53);
    expect(showSequenceFrame(s, 96)).toBeNull();
    expect(s.state.frame).toBe(6);
  });

  it('looks through an enabled shot at its first frame', () => {
    addShot('A', 1, 10);
    addShot('B', 11, 20);
    ok('desk.shot_update', { shot: 'B', enabled: false });
    expect(showShot(s, shot(s, 'A').id)).toBe(true);
    expect(s.state.frame).toBe(1);
    expect(showShot(s, shot(s, 'B').id)).toBe(false);
    expect(showShot(s, 'missing')).toBe(false);
  });

  it('plays the cut in real time across shots and stops at its end', () => {
    stubFrames();
    addShot('A', 1, 24);
    addShot('B', 101, 124, 3);
    s.view.playing.value = true;
    playSequence(s, 1000);
    expect(sequencePlaying.value).toBe(true);
    // the timeline's playback stops: one clock drives the frame
    expect(s.view.playing.value).toBe(false);
    expect(s.state.frame).toBe(1);
    // half a second at 24 fps: 12 frames in
    expect(tickSequence(1500)).toBe(true);
    expect(s.state.frame).toBe(13);
    // a second and a half: 36 frames in, 12 into the second shot
    expect(tickSequence(2500)).toBe(true);
    expect(s.state.frame).toBe(113);
    expect(shotPin(s.view).value).toBe(shot(s, 'B').id);
    // past the end: shows the last frame and stops
    expect(tickSequence(9000)).toBe(false);
    expect(s.state.frame).toBe(124);
    expect(sequencePlaying.value).toBe(false);
  });

  it('starts from the frame shown, or from the top at the end of the cut', () => {
    stubFrames();
    addShot('A', 1, 24);
    addShot('B', 25, 48);
    showSequenceFrame(s, 30);
    playSequence(s, 0);
    expect(currentSequenceFrame(s)).toBe(30);
    stopSequence();
    showSequenceFrame(s, 47);
    playSequence(s, 0);
    expect(s.state.frame).toBe(1);
  });

  it('stops when the frame is moved elsewhere, the timeline plays, or the project closes', () => {
    stubFrames();
    addShot('A', 1, 240);
    playSequence(s, 0);
    s.state.frame = 100;
    expect(tickSequence(100)).toBe(false);
    expect(sequencePlaying.value).toBe(false);
    expect(s.state.frame).toBe(100);

    playSequence(s, 0);
    s.view.playing.value = true;
    expect(tickSequence(100)).toBe(false);

    s.view.playing.value = false;
    playSequence(s, 0);
    sessionSignal.value = null;
    expect(tickSequence(100)).toBe(false);
    expect(sequencePlaying.value).toBe(false);
  });

  it('does nothing without shots in the cut', () => {
    stubFrames();
    playSequence(s, 0);
    expect(sequencePlaying.value).toBe(false);
    expect(tickSequence(0)).toBe(false);
  });
});
