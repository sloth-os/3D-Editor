import { z } from 'zod';
import type { SceneDoc } from '../../doc/scene-doc';
import { docChangeToken } from '../../doc/change-token';
import { cloneJson } from '../../util/json';
import { ACTOR_KINDS } from '../characters/types';
import { BRIEF_ELEMENT_KINDS, type SceneBrief } from './schema';

/*
 * The brief record: what a scene was staged from, kept in the document (the scene settings' `brief`
 * key, read and written only here) so that a later brief can be compared with it (changes.ts) and
 * the staging updated (update.ts) wherever the document goes (the desk state a host stores is the
 * document). It holds the host's scene id, a hash of the whole brief, the frame rate and size, each
 * shot staged (host id, desk shot id, duration, the frames the brief gives it, cast, elements, the
 * lens and move it gave, and digests of its words, of the notes it was given and of its camera's
 * plan; a shot removed in the desk that an update kept removed stays in it), the cast (with the kind
 * staged, the height given and the name the desk gave its actor) and the elements (with who holds
 * them), and a digest of the set as planned. It records the brief, not the desk: a shot made longer
 * or shorter in the desk keeps the brief's frames here, so that a later brief is compared with the
 * brief before it; an actor renamed in the desk keeps the name staged here, so that an update tells
 * the desk's names from its own. Reads are validated and cached until the document changes.
 *
 * Library pins (brief/units.ts): the set (`setUnit`), a cast member and an element (`unit`) keep the
 * pin of the brief staged with what the scene holds for it (RecordPin: `staged` 'unit' when the slot
 * holds that version, or held it before the person made it local; 'pending' when it was staged from
 * the words and is tried again at the next open; 'refused' when the unit cannot be used, tried again
 * only when the brief pins another version), with the reason (`why`) of the last two. The keys are
 * written only when the slot has a pin, so the record of a brief without pins is what it was before
 * pins. A set planned from a unit digests as the unit's pin and the sun (setDigest): its facts never
 * take part in change detection.
 */

/** The scene settings key the record is kept under. */
export const BRIEF_RECORD_KEY = 'brief';

/** What a record keeps of a slot's pin: what the scene holds for it (see the module comment). */
export const RECORD_PIN_STAGED = ['unit', 'pending', 'refused'] as const;
export type RecordPinStaged = (typeof RECORD_PIN_STAGED)[number];

const RecordPinSchema = z.object({
  ref: z.string(),
  version: z.number(),
  sha256: z.string(),
  staged: z.enum(RECORD_PIN_STAGED),
  /** Pending or refused: why (docs/embedding.md "When a unit is not used"). */
  why: z.string().optional(),
});
export type RecordPin = z.infer<typeof RecordPinSchema>;

const RecordShotSchema = z.object({
  id: z.string(),
  desk: z.string(),
  index: z.number(),
  durationSec: z.number(),
  frames: z.number().int(),
  castIds: z.array(z.string()),
  elementIds: z.array(z.string()),
  /** Digest of the shot's description and action. */
  text: z.string(),
  /** Digest of the notes the desk shot was given (an update rewrites them only while they are unchanged). */
  notes: z.string(),
  /** Digest of what the shot's camera is solved from: framing, movement, lens, move, layout, continuity. */
  camera: z.string(),
  /**
   * The lens and move the brief gave the shot (records written before them have only `camera`): a
   * later brief whose lens or move gives back what the desk staged agrees with these.
   */
  lensMm: z.number().nullable().optional(),
  move: z.string().nullable().optional(),
});

const RecordCastSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ACTOR_KINDS).nullable(),
  /** The height the brief gave (records written before it have only `digest`). */
  heightM: z.number().nullable().optional(),
  /**
   * The name the desk gave the member's actor when it staged it or an update renamed it: the brief's
   * name, or that name made unique ("Guard.001" beside another "Guard"). An actor whose name differs
   * from it was renamed in the desk. Absent for a member without an actor, and in records written
   * before it (renamedInDesk then reads the brief's name, or it made unique, as the staged one).
   */
  actorName: z.string().optional(),
  /** Digest of the member's name, description, kind hint and height. */
  digest: z.string(),
  /** The member's figure pin and what was staged for it (absent: the brief pins none). */
  unit: RecordPinSchema.optional(),
});

const RecordElementSchema = z.object({
  id: z.string(),
  kind: z.enum(BRIEF_ELEMENT_KINDS),
  name: z.string(),
  /** The cast member holding it, by the words (null: it stands on the ground). */
  holder: z.string().nullable(),
  digest: z.string(),
  /** The element's prop pin and what was staged for it (absent: the brief pins none). */
  unit: RecordPinSchema.optional(),
});

export const BriefRecordSchema = z.object({
  version: z.literal(1),
  sceneId: z.string(),
  hash: z.string(),
  fps: z.number(),
  width: z.number(),
  height: z.number(),
  /** Digest of the set as planned (size, ground, interior, sun, landmarks: setDigest). */
  set: z.string(),
  /** The set's pin and what was staged for it (absent: the brief pins none). */
  setUnit: RecordPinSchema.optional(),
  shots: z.array(RecordShotSchema),
  cast: z.array(RecordCastSchema),
  elements: z.array(RecordElementSchema),
});
export type BriefRecord = z.infer<typeof BriefRecordSchema>;
export type BriefRecordShot = BriefRecord['shots'][number];
export type BriefRecordCast = BriefRecord['cast'][number];

/** A name without the suffix that made it unique ("Guard.001": "Guard"), trimmed as the desk trims names. */
const nameStem = (name: string): string => name.trim().replace(/\.\d{3,}$/, '');

/**
 * Whether the actor of recorded cast member `was`, named `name` now, was renamed in the desk: its
 * name is not the one the desk staged it with or an update gave it (`actorName`). For a record written
 * before it kept that name, the brief's name or that name made unique ("Guard.001") is the staged one.
 */
export function renamedInDesk(name: string, was: Pick<BriefRecordCast, 'name' | 'actorName'>): boolean {
  return was.actorName !== undefined ? name !== was.actorName : nameStem(name) !== nameStem(was.name);
}

// ---------------------------------------------------------------- digests

/** A JSON text of `v` with object keys sorted (the same for equal values, whatever their key order). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** A 64-bit FNV-1a digest of a text, as 16 hex digits (two 32-bit lanes; no Node or Web Crypto needed). */
export function digest(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c ^ (h1 >>> 7), 0x01000193);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${hex(h1)}${hex(h2)}`;
}

/** The frames a shot of `durationSec` takes at `fps` (at least one). */
export const briefFrames = (durationSec: number, fps: number): number =>
  Math.max(1, Math.round(durationSec * fps));

/** The hash of a validated brief: the digest of its canonical JSON (equal briefs, equal hashes). */
export const briefHash = (brief: SceneBrief): string => digest(canonicalJson(brief));

/** The digest of a shot's words. */
export const shotTextDigest = (s: Pick<SceneBrief['shots'][number], 'description' | 'action'>): string =>
  digest(`${s.description}\u0000${s.action}`);

/** The digest of a cast member's words. */
export const castDigest = (c: SceneBrief['cast'][number]): string =>
  digest(canonicalJson([c.name, c.description, c.kind, c.heightM]));

/** The digest of an element's words. */
export const elementDigest = (e: SceneBrief['elements'][number]): string =>
  digest(canonicalJson([e.name, e.description, e.kind]));

/** The digest of what a shot's camera is solved from. */
export const shotCameraDigest = (s: SceneBrief['shots'][number]): string =>
  digest(canonicalJson([s.framing, s.movement, s.lensMm, s.move, s.layout, s.continuity]));

/**
 * The digest of the set as planned (plan.ts: the SceneBlocking set the import builds). A set planned
 * from a library unit (one with `unit`) digests as its pin and its sun only.
 */
export function setDigest(plannedSet: unknown): string {
  const s = plannedSet as { unit?: { ref: string; version: number; sha256: string }; sun?: unknown } | null;
  if (s && typeof s === 'object' && s.unit)
    return digest(
      canonicalJson({
        unit: { ref: s.unit.ref, version: s.unit.version, sha256: s.unit.sha256 },
        sun: s.sun,
      }),
    );
  return digest(canonicalJson(plannedSet));
}

// ---------------------------------------------------------------- reads and writes

const cache = new WeakMap<SceneDoc, { token: string; record: BriefRecord | null }>();

/** The document's brief record, validated (null: none, or one that does not read as a record). A copy. */
export function readBriefRecord(doc: SceneDoc): BriefRecord | null {
  const token = docChangeToken(doc);
  const hit = cache.get(doc);
  if (hit && token !== null && hit.token === token) return hit.record && cloneJson(hit.record);
  const parsed = BriefRecordSchema.safeParse(doc.map('scene').get(BRIEF_RECORD_KEY));
  const record = parsed.success ? parsed.data : null;
  if (token !== null) cache.set(doc, { token, record });
  return record && cloneJson(record);
}

/** Writes (null: removes) the document's brief record in one transaction (the caller's when inside one). */
export function writeBriefRecord(doc: SceneDoc, record: BriefRecord | null): void {
  doc.transact(() => {
    if (record) doc.map('scene').set(BRIEF_RECORD_KEY, cloneJson(BriefRecordSchema.parse(record)));
    else doc.map('scene').delete(BRIEF_RECORD_KEY);
  });
}

/** What a document was staged from: the host's scene id and the hash of the brief (null: not staged from a brief). */
export function briefRecord(doc: SceneDoc): { sceneId: string; hash: string } | null {
  const r = readBriefRecord(doc);
  return r && { sceneId: r.sceneId, hash: r.hash };
}
