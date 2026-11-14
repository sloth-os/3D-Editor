import type * as Y from 'yjs';
import type { DriverData, FCurve, Keyframe, ObjectData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import { ydocChangeToken } from '../doc/change-token';
import { sortedKeyframes } from '../anim/fcurve';

/*
 * What every frame state of a document reads from it (eval/frame-state.ts): its objects, the
 * F-curves and drivers by target. It is the same at every frame while the document is unchanged,
 * so it is read once per document state (doc/change-token.ts) and shared by all frame states,
 * whoever builds them (the scene evaluator, transformsAt and the rigid body simulation, operators,
 * the server's render processes): a frame of a 3-minute film with ~800,000 keyframes cost ~0.5 s
 * when every frame state copied every F-curve.
 *
 * - The objects are read (copied) from the document once. A frame state hands out copies of them
 *   (frame-state.ts AnimatedStore): a caller replacing a field of an object it got changes its own
 *   copy only. Nested values (arrays, constraints, poses) are shared until a channel written at the
 *   frame replaces them, and until the document changes, so they must not be changed in place:
 *   every test run of the core, server and web projects freezes the input as it is read
 *   (EVAL_FREEZE_INPUT=1, vitest.config.ts), so that code writing into it throws there instead of
 *   changing the later frames of its document (setFrameInputFreezing switches it for one test).
 * - The F-curves and drivers are the document's stored values themselves, never copied: nothing
 *   changes a stored value in place (SceneDoc stores copies and replaces whole values; Yjs decodes
 *   a remote value into new objects), frame states only read them, and they never leave frame
 *   states.
 * - Each F-curve's keyframes in frame order are found once (the stored order, checked once), so a
 *   frame finds its keys by binary search (the keys passed to anim/fcurve.ts evaluateFCurve).
 *
 * The input is kept per Y.Doc (every SceneDoc of it reads the same) and dropped when the document
 * changes (when a transaction starts; one read during a transaction when that transaction ends) or
 * is destroyed, and with the Y.Doc (a WeakMap entry): at most one copy of the objects per live
 * document. A document without a live Y.Doc (none, or destroyed: no change token) is read anew by
 * every frame state, as before the cache: once per SceneEvaluator.evaluate, by its frame state.
 */

/** `${target_type}:${target_id}` → the target's unmuted F-curves with keys, in the document's order. */
export type CurveIndex = ReadonlyMap<string, readonly FCurve[]>;

/** What a frame state reads from the document (see the module comment). Treat it as immutable. */
export interface FrameInput {
  /** Copies of the document's objects (SceneDoc.listObjects, in its order). */
  readonly raw: readonly ObjectData[];
  readonly rawById: ReadonlyMap<string, ObjectData>;
  readonly curves: CurveIndex;
  /** `${target_type}:${target_id}` → the target's unmuted drivers, in the document's order. */
  readonly drivers: ReadonlyMap<string, readonly DriverData[]>;
  /** `fc`'s keyframes in frame order (anim/fcurve.ts sortedKeyframes), found once per curve. */
  keys(fc: FCurve): Keyframe[];
  /** Estimated heap this input keeps (bytes), see {@link frameInputCacheBytes}. */
  readonly bytes: number;
}

/**
 * Heap the input keeps per object (its copy of the stored object): 0.86 KB measured for meshes and
 * empties (5,000 of each), 1.24 KB on average for the objects of 8 walking actors and their parts;
 * rounded up.
 */
export const FRAME_INPUT_BYTES_PER_OBJECT = 1_500;
/** Heap per pose bone of an armature object (its channels): 0.38 KB measured, rounded up. */
export const FRAME_INPUT_BYTES_PER_POSE_BONE = 500;
/**
 * Heap per F-curve or driver: its place in the index and its keyframes in frame order (the stored
 * array itself when sorted, as stored curves are); the stored values are the document's.
 */
export const FRAME_INPUT_BYTES_PER_CURVE = 160;

/** Whether inputs are frozen as they are read (see {@link setFrameInputFreezing}). */
let frozen =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.EVAL_FREEZE_INPUT === '1';

function indexByTarget<T extends { target_type: string; target_id: string; mute: boolean }>(
  items: Iterable<T>,
  skip: (t: T) => boolean,
): Map<string, T[]> {
  const idx = new Map<string, T[]>();
  for (const it of items) {
    if (it.mute || skip(it)) continue;
    const k = `${it.target_type}:${it.target_id}`;
    const list = idx.get(k);
    if (list) list.push(it);
    else idx.set(k, [it]);
  }
  return idx;
}

const noKeys = (fc: FCurve) => fc.keyframes.length === 0;

/**
 * Reads the input of `doc`: with `stored`, the stored F-curves and drivers are indexed in place,
 * else copies of them (SceneDoc.listFCurves, listDrivers).
 */
function readInput(doc: SceneDoc, stored: boolean): FrameInput {
  const raw = doc.listObjects();
  const curves = indexByTarget<FCurve>(
    stored ? (doc.map('fcurves').values() as IterableIterator<FCurve>) : doc.listFCurves(),
    noKeys,
  );
  const drivers = indexByTarget<DriverData>(
    stored ? (doc.map('drivers').values() as IterableIterator<DriverData>) : doc.listDrivers(),
    () => false,
  );
  let bones = 0;
  for (const o of raw) {
    const b = o.pose?.bones;
    if (b && typeof b === 'object') bones += Object.keys(b).length;
  }
  let entries = 0;
  for (const l of curves.values()) entries += l.length;
  for (const l of drivers.values()) entries += l.length;
  const sorted = new Map<FCurve, Keyframe[]>();
  const input: FrameInput = {
    raw,
    rawById: new Map(raw.map((o) => [o.id, o])),
    curves,
    drivers,
    keys(fc) {
      let k = sorted.get(fc);
      if (!k) sorted.set(fc, (k = sortedKeyframes(fc)));
      return k;
    },
    bytes:
      FRAME_INPUT_BYTES_PER_OBJECT * raw.length +
      FRAME_INPUT_BYTES_PER_POSE_BONE * bones +
      FRAME_INPUT_BYTES_PER_CURVE * entries,
  };
  if (frozen) freezeInput(input);
  return input;
}

interface Entry {
  token: string;
  input: FrameInput;
}

const cache = new WeakMap<Y.Doc, Entry>();
const watched = new WeakSet<Y.Doc>();

/** Drops the entry of `y` when it changes or is destroyed. */
function watch(y: Y.Doc): void {
  if (watched.has(y)) return;
  watched.add(y);
  // a transaction starts: the entry may become stale (and the token changes)
  y.on('beforeTransaction', () => cache.delete(y));
  // one read during the transaction may be older than its last change; one read while its changes
  // are observed (after them) stays
  y.on('afterTransaction', () => {
    const e = cache.get(y);
    if (e && e.token !== ydocChangeToken(y)) cache.delete(y);
  });
  y.on('destroy', () => cache.delete(y));
}

/**
 * The Y.Doc of `doc` when it has one that can be watched, else null: its input is never cached
 * (a destroyed Y.Doc has dropped its listeners, the change token's too).
 */
function ydocOf(doc: SceneDoc): Y.Doc | null {
  const y = doc.ydoc as Y.Doc | undefined;
  return y && typeof y.on === 'function' && !y.isDestroyed ? y : null;
}

/**
 * The input of every frame state of `doc` at its current state: read once per document state and
 * shared (see the module comment). Treat it as immutable.
 */
export function frameInput(doc: SceneDoc): FrameInput {
  const y = ydocOf(doc);
  if (!y) return readInput(doc, false);
  const token = ydocChangeToken(y);
  const hit = cache.get(y);
  if (hit && hit.token === token) return hit.input;
  const input = readInput(doc, true);
  watch(y);
  cache.set(y, { token, input });
  return input;
}

/**
 * Heap the frame states' cached input of `doc` keeps (bytes, estimated: its copies of the objects
 * and its index of the F-curves and drivers, FRAME_INPUT_BYTES_PER_*), 0 when none is cached (the
 * document has not been evaluated since it last changed). One per live document, dropped when the
 * document changes or is destroyed.
 */
export function frameInputCacheBytes(doc: SceneDoc): number {
  const y = ydocOf(doc);
  return (y && cache.get(y)?.input.bytes) || 0;
}

/** Drops the cached input of `doc`: the next frame state reads the document again. */
export function clearFrameInput(doc: SceneDoc): void {
  const y = ydocOf(doc);
  if (y) cache.delete(y);
}

/**
 * Freezes (deeply) every input read from now on: its objects and the stored F-curves and drivers it
 * indexes, so that code changing what frame states share throws instead of changing later frames
 * (tests; `EVAL_FREEZE_INPUT=1` turns it on for a whole run). Returns the previous setting.
 */
export function setFrameInputFreezing(on: boolean): boolean {
  const was = frozen;
  frozen = on;
  return was;
}

/** Freezes `v` and what it holds (a value frozen before is skipped: what it holds is frozen too). */
function deepFreeze(v: unknown): void {
  if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || Object.isFrozen(v)) return;
  Object.freeze(v);
  // without allocating (a test run freezes every reading): a film holds millions of keyframes
  if (Array.isArray(v)) for (let i = 0; i < v.length; i++) deepFreeze(v[i]);
  else for (const k in v) deepFreeze((v as Record<string, unknown>)[k]);
}

function freezeInput(input: FrameInput): void {
  for (const o of input.raw) deepFreeze(o);
  for (const list of input.curves.values()) for (const fc of list) deepFreeze(fc);
  for (const list of input.drivers.values()) for (const d of list) deepFreeze(d);
}
