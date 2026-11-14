import type { SceneDoc } from '../doc/scene-doc';
import type { DeskLayoutEntry, DeskSettings, ShotData, ShotExternalRef } from '../doc/types';
import {
  DESK_ANGLES,
  DESK_CONTINUITIES,
  DESK_FACINGS,
  DESK_FRAMINGS,
  DESK_HEIGHTS,
  DESK_MOVES,
  DESK_SIDES,
  SHOT_EXTERNAL_SOURCES,
} from '../doc/types';
import { defaultDeskSettings } from '../doc/defaults';
import { docChangeToken } from '../doc/change-token';
import { MAX_SIMULATED_FRAMES } from '../physics/settings';
import { newId } from '../util/id';
import { cloneJson } from '../util/json';

/*
 * The shots of a scene (the cut) and the director's desk settings: the only module that reads and
 * writes SceneSettings.shots and SceneSettings.desk (a test forbids `getScene().shots` / `.desk`
 * elsewhere). Stored values may come from anywhere (data.set_property, other clients, older
 * versions), so every read sanitizes them against the document: enums and ranges are checked,
 * cameras and subjects that are not (or no longer) in the scene are dropped. Reads go to the two
 * keys directly, not through getScene() (which deep-copies every scene setting), and are cached
 * until the document changes (doc/change-token.ts).
 *
 * The shot list is one last-writer-wins value: an operator reads it, changes it and writes the
 * whole array back in its own transaction (setShots), so two concurrent edits of different shots
 * keep only the later one. A per-shot map is the later fix if that matters.
 *
 * Timing: the cut plays the enabled shots in array order; shot k contributes frame_end −
 * frame_start + 1 output frames; shots may overlap in scene time (coverage); pre-roll frames are
 * simulated and animated but never exported.
 */

/** Most shots a scene holds. */
export const MAX_SHOTS = 512;
/** Most subjects, and planned layout entries, per shot. */
export const MAX_SHOT_SUBJECTS = 16;
export const MAX_SHOT_LAYOUT = 16;
/** Longest shot name and notes (characters). */
export const MAX_SHOT_NAME = 64;
export const MAX_SHOT_NOTES = 2000;
/** Lens range a shot may ask for (mm). */
export const SHOT_LENS_MIN = 8;
export const SHOT_LENS_MAX = 800;
/** Largest |frame| of a shot (Blender's MAXFRAME). */
export const MAX_SHOT_FRAME = 1_048_574;
/** Longest pre-roll (frames): the most frames one rigid body simulation steps. */
export const MAX_PRE_ROLL = MAX_SIMULATED_FRAMES;
/** Largest set width / depth (m). */
export const MAX_SET_SIZE = 10_000;
/** Range of the aspect ratio shots are solved for. */
export const DESK_ASPECT_MIN = 0.1;
export const DESK_ASPECT_MAX = 10;
/** Longest video-model take the clamp may name (seconds). */
export const MAX_SHOT_SECONDS = 3600;
/** Longest external reference string (the source's project, scene and shot ids). */
const MAX_EXTERNAL_TEXT = 256;

const ID_RE = /^[0-9A-Za-z]{16}$/;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

/** `s` cut to `max` characters (whole code points). */
function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

/** A non-empty string of at most `max` characters, else null. */
function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length > 0 ? cut(v, max) : null;
}

/** The type of object `id` in `doc` (null when there is none). */
function objectType(doc: SceneDoc, id: string): string | null {
  const y = doc.map('objects').get(id) as { get(key: string): unknown } | undefined;
  if (!y || typeof y.get !== 'function') return null;
  const t = y.get('type');
  return typeof t === 'string' ? t : null;
}

/** A new shot id (16 base62 characters, the document's id generator). */
export function newShotId(): string {
  return newId();
}

/**
 * A 16-character base62 id derived from `seed` (FNV-1a, then xorshift), different from every id in
 * `taken`: the id a stored shot without a valid one gets, the same on every read of the same data.
 */
function derivedId(seed: string, taken: ReadonlySet<string>): string {
  for (let salt = 0; ; salt++) {
    let a = 0x811c9dc5 ^ salt;
    let b = 0x9e3779b9 ^ Math.imul(salt, 0x85ebca6b);
    for (let i = 0; i < seed.length; i++) {
      const c = seed.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193);
      b = Math.imul(b ^ c, 0x5bd1e995);
    }
    let out = '';
    for (let i = 0; i < 16; i++) {
      a ^= a << 13;
      a ^= a >>> 17;
      a ^= a << 5;
      b = Math.imul(b ^ (b >>> 15), 0x2c1b3c6d) + a;
      out += ALPHABET[((a ^ b) >>> 0) % 62];
    }
    if (!taken.has(out)) return out;
  }
}

function sanitizeExternal(v: unknown): ShotExternalRef | null {
  const source = isRecord(v) ? oneOf(SHOT_EXTERNAL_SOURCES, v.source) : null;
  if (!isRecord(v) || !source) return null;
  const index = isFiniteNumber(v.index) && v.index >= 0 ? Math.min(Math.round(v.index), 1_000_000) : null;
  return {
    source,
    project: text(v.project, MAX_EXTERNAL_TEXT),
    clip: text(v.clip, MAX_EXTERNAL_TEXT),
    shot: text(v.shot, MAX_EXTERNAL_TEXT),
    index,
  };
}

/** Object ids among `v` (strings, each once; with `doc`, only objects it has), at most `max`. */
function objectIds(v: unknown, max: number, doc: SceneDoc | undefined): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of v) {
    if (out.length >= max) break;
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (doc && !objectType(doc, id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitizeLayout(v: unknown, doc: SceneDoc | undefined): DeskLayoutEntry[] {
  if (!Array.isArray(v)) return [];
  const out: DeskLayoutEntry[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (out.length >= MAX_SHOT_LAYOUT) break;
    if (!isRecord(e) || typeof e.subject !== 'string' || !e.subject || seen.has(e.subject)) continue;
    const side = oneOf(DESK_SIDES, e.side);
    const facing = oneOf(DESK_FACINGS, e.facing);
    if (!side || !facing) continue;
    if (doc && !objectType(doc, e.subject)) continue;
    seen.add(e.subject);
    out.push({ subject: e.subject, side, facing });
  }
  return out;
}

function frame(v: unknown, fallback: number): number {
  return isFiniteNumber(v) ? Math.round(clamp(v, -MAX_SHOT_FRAME, MAX_SHOT_FRAME)) : fallback;
}

/**
 * One stored shot made valid. `id`: the id it keeps, or null to derive one that is not in
 * `blocked` (the valid ids of the list and those given so far).
 */
function sanitizeShot(
  raw: Record<string, unknown>,
  index: number,
  doc: SceneDoc | undefined,
  id: string | null,
  blocked: ReadonlySet<string>,
): ShotData {
  const name = typeof raw.name === 'string' && raw.name.trim() ? cut(raw.name, MAX_SHOT_NAME) : '';
  const frame_start = frame(raw.frame_start, 1);
  const frame_end = Math.max(frame_start, frame(raw.frame_end, frame_start));
  let camera = typeof raw.camera === 'string' && raw.camera ? raw.camera : null;
  if (camera && doc && objectType(doc, camera) !== 'CAMERA') camera = null;
  return {
    id:
      id ??
      derivedId(
        `${index}\u0000${name}\u0000${frame_start}\u0000${frame_end}\u0000${camera ?? ''}\u0000${String(raw.id ?? '')}`,
        blocked,
      ),
    name: name || `Shot ${index + 1}`,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    camera,
    frame_start,
    frame_end,
    notes: typeof raw.notes === 'string' ? cut(raw.notes, MAX_SHOT_NOTES) : '',
    framing: oneOf(DESK_FRAMINGS, raw.framing),
    angle: oneOf(DESK_ANGLES, raw.angle),
    height: oneOf(DESK_HEIGHTS, raw.height),
    move: oneOf(DESK_MOVES, raw.move),
    lens_mm: isFiniteNumber(raw.lens_mm) ? clamp(raw.lens_mm, SHOT_LENS_MIN, SHOT_LENS_MAX) : null,
    subjects: objectIds(raw.subjects, MAX_SHOT_SUBJECTS, doc),
    layout: sanitizeLayout(raw.layout, doc),
    continuity: oneOf(DESK_CONTINUITIES, raw.continuity) ?? 'cut',
    pre_roll: isFiniteNumber(raw.pre_roll) ? Math.round(clamp(raw.pre_roll, 0, MAX_PRE_ROLL)) : 0,
    external: sanitizeExternal(raw.external),
  };
}

/**
 * A valid shot list from any stored or given value (spec §2): entries that are not objects are
 * left out, at most MAX_SHOTS are kept; ids are kept when they are 16 base62 characters and unused
 * by an earlier shot, otherwise derived from the shot's position and content (the same on every
 * read of the same data; setShots stores them); names are cut to 64 characters (empty: "Shot
 * <n>"), notes to 2000; enums that are not rideo's values become null; frames are integers
 * (frame_end ≥ frame_start), lens_mm is clamped to 8–800, pre_roll to 0–MAX_PRE_ROLL; continuity
 * defaults to 'cut'; an external reference keeps a source of SHOT_EXTERNAL_SOURCES (else none).
 * With `doc`, a camera that is not a CAMERA object of it becomes null and subjects and layout
 * entries of objects it does not have are dropped.
 */
export function sanitizeShots(raw: unknown, doc?: SceneDoc): ShotData[] {
  if (!Array.isArray(raw)) return [];
  const validId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
  // derived ids never take a valid id of a later shot, nor one given before
  const blocked = new Set<string>();
  for (const s of raw) if (isRecord(s) && validId(s.id)) blocked.add(s.id);
  const used = new Set<string>();
  const out: ShotData[] = [];
  for (const s of raw) {
    if (out.length >= MAX_SHOTS) break;
    if (!isRecord(s)) continue;
    // the first shot with a valid id keeps it; a repeated one gets a derived id
    const shot = sanitizeShot(s, out.length, doc, validId(s.id) && !used.has(s.id) ? s.id : null, blocked);
    used.add(shot.id);
    blocked.add(shot.id);
    out.push(shot);
  }
  return out;
}

/**
 * Valid desk settings from any stored or given value: set sizes 0–MAX_SET_SIZE (0 = unknown), the
 * aspect DESK_ASPECT_MIN–DESK_ASPECT_MAX or null, the shot-length clamp (0, MAX_SHOT_SECONDS] or null
 * with min_shot_s ≤ max_shot_s; main_pair two different object ids (objects of `doc` when given)
 * or null.
 */
export function sanitizeDeskSettings(raw: unknown, doc?: SceneDoc): DeskSettings {
  const d = defaultDeskSettings();
  if (!isRecord(raw)) return d;
  const size = (v: unknown) => (isFiniteNumber(v) ? clamp(v, 0, MAX_SET_SIZE) : 0);
  const seconds = (v: unknown) => (isFiniteNumber(v) && v > 0 ? Math.min(v, MAX_SHOT_SECONDS) : null);
  let main_pair: [string, string] | null = null;
  if (Array.isArray(raw.main_pair) && raw.main_pair.length === 2) {
    const [a, b] = raw.main_pair as unknown[];
    if (
      typeof a === 'string' &&
      typeof b === 'string' &&
      a &&
      b &&
      a !== b &&
      (!doc || (objectType(doc, a) && objectType(doc, b)))
    )
      main_pair = [a, b];
  }
  const max_shot_s = seconds(raw.max_shot_s);
  let min_shot_s = seconds(raw.min_shot_s);
  if (min_shot_s !== null && max_shot_s !== null && min_shot_s > max_shot_s) min_shot_s = max_shot_s;
  return {
    set_width: size(raw.set_width),
    set_depth: size(raw.set_depth),
    interior: typeof raw.interior === 'boolean' ? raw.interior : d.interior,
    main_pair,
    aspect:
      isFiniteNumber(raw.aspect) && raw.aspect > 0
        ? clamp(raw.aspect, DESK_ASPECT_MIN, DESK_ASPECT_MAX)
        : null,
    max_shot_s,
    min_shot_s,
  };
}

// ---------------------------------------------------------------- cached reads

interface DeskCache {
  token: string;
  shots: readonly ShotData[] | null;
  desk: DeskSettings | null;
}

const caches = new WeakMap<SceneDoc, DeskCache>();

/** The cache entry of `doc` for its current change token (a fresh one after any change). */
function cacheOf(doc: SceneDoc): DeskCache {
  const token = docChangeToken(doc);
  const c = caches.get(doc);
  if (c && token !== null && c.token === token) return c;
  const fresh: DeskCache = { token: token ?? '', shots: null, desk: null };
  if (token !== null) caches.set(doc, fresh);
  return fresh;
}

/** The scene's sanitized shots, shared with the cache: never mutate (getShots gives a copy). */
function cachedShots(doc: SceneDoc): readonly ShotData[] {
  const c = cacheOf(doc);
  if (!c.shots) c.shots = sanitizeShots(doc.map('scene').get('shots'), doc);
  return c.shots;
}

function cachedDesk(doc: SceneDoc): DeskSettings {
  const c = cacheOf(doc);
  if (!c.desk) c.desk = sanitizeDeskSettings(doc.map('scene').get('desk'), doc);
  return c.desk;
}

/** The scene's shots in cut order, sanitized against the document (a copy the caller may change). */
export function getShots(doc: SceneDoc): ShotData[] {
  return cloneJson(cachedShots(doc) as ShotData[]);
}

/** The scene's director's desk settings, sanitized against the document (a copy). */
export function getDeskSettings(doc: SceneDoc): DeskSettings {
  return cloneJson(cachedDesk(doc));
}

/**
 * Index in `shots` of the shot `ref` names: its id, else the first shot with that exact name;
 * -1 when none has it.
 */
export function findShotIndex(shots: readonly Pick<ShotData, 'id' | 'name'>[], ref: string): number {
  const byId = shots.findIndex((s) => s.id === ref);
  return byId >= 0 ? byId : shots.findIndex((s) => s.name === ref);
}

/**
 * Replaces the scene's shot list with `shots` (sanitized against the document) in one transaction
 * (`origin`: the transaction's origin; inside an operator's transaction its origin applies). Throws
 * when more than MAX_SHOTS shots are given. Returns the list as stored.
 */
export function setShots(doc: SceneDoc, shots: readonly unknown[], origin?: unknown): ShotData[] {
  const given = shots.filter(isRecord).length;
  if (given > MAX_SHOTS) throw new Error(`A scene holds at most ${MAX_SHOTS} shots (${given} given)`);
  const clean = sanitizeShots(shots, doc);
  doc.transact(() => doc.updateScene({ shots: clean }), origin ?? doc.origin);
  return clean;
}

/**
 * Changes the scene's desk settings: `patch` over the current ones, sanitized, written in one
 * transaction. Returns the settings as stored.
 */
export function setDeskSettings(doc: SceneDoc, patch: Partial<DeskSettings>, origin?: unknown): DeskSettings {
  const clean = sanitizeDeskSettings({ ...cachedDesk(doc), ...patch }, doc);
  doc.transact(() => doc.updateScene({ desk: clean }), origin ?? doc.origin);
  return clean;
}

// ---------------------------------------------------------------- sequence timing

type Timed = Pick<ShotData, 'enabled' | 'frame_start' | 'frame_end'>;

/** Frames a shot contributes to the cut: frame_end − frame_start + 1 (pre-roll never counts). */
export function shotOutputFrames(shot: Pick<ShotData, 'frame_start' | 'frame_end'>): number {
  return Math.max(0, Math.round(shot.frame_end) - Math.round(shot.frame_start) + 1);
}

/** Frames of the whole cut: the output frames of the enabled shots. */
export function sequenceLength(shots: readonly Timed[]): number {
  let n = 0;
  for (const s of shots) if (s.enabled) n += shotOutputFrames(s);
  return n;
}

/** Where a frame of the cut comes from. */
export interface SequencePosition<S extends Timed = ShotData> {
  shot: S;
  /** The shot's index in the list given (disabled shots counted). */
  index: number;
  /** The scene frame shown. */
  sceneFrame: number;
  /** Frames into the shot (0 = its frame_start). */
  offset: number;
}

/**
 * The shot and scene frame of frame `s` of the cut (0 = the first frame of the first enabled shot;
 * fractions are rounded down), or null outside the cut.
 */
export function shotAtSequenceFrame<S extends Timed>(
  shots: readonly S[],
  s: number,
): SequencePosition<S> | null {
  if (!Number.isFinite(s) || s < 0) return null;
  let rest = Math.floor(s);
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index];
    if (!shot.enabled) continue;
    const n = shotOutputFrames(shot);
    if (rest < n) return { shot, index, sceneFrame: Math.round(shot.frame_start) + rest, offset: rest };
    rest -= n;
  }
  return null;
}

/** The scene frame shown at frame `s` of the cut (null outside it). */
export function sceneFrameForSequenceFrame(shots: readonly Timed[], s: number): number | null {
  return shotAtSequenceFrame(shots, s)?.sceneFrame ?? null;
}

/** The first frame of the cut that shows shot `index` (null when it is disabled or not in the list). */
export function shotSequenceStart(shots: readonly Timed[], index: number): number | null {
  if (!(index >= 0 && index < shots.length) || !shots[index].enabled) return null;
  let start = 0;
  for (let i = 0; i < index; i++) if (shots[i].enabled) start += shotOutputFrames(shots[i]);
  return start;
}

/**
 * The camera that shows scene frame `frame` when the view follows the shots: the camera of the
 * first enabled shot covering it (frame_start ≤ frame < frame_end + 1, so a fraction of a frame
 * belongs to the frame it starts), else (no shot covers it, or that shot has no camera) the scene
 * camera. The core evaluator does not call it: the viewport and renders that follow shots do.
 */
export function cameraForFrame(doc: SceneDoc, frame: number): string | null {
  const scene = doc.map('scene').get('camera') as unknown;
  const sceneCamera = typeof scene === 'string' && scene ? scene : null;
  for (const shot of cachedShots(doc)) {
    if (!shot.enabled) continue;
    if (frame >= shot.frame_start && frame < shot.frame_end + 1) return shot.camera ?? sceneCamera;
  }
  return sceneCamera;
}
