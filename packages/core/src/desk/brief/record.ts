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
 * shot staged (host id, desk shot id, duration, frames, cast, elements, and digests of its words, of
 * the notes it was given and of its camera's plan), the cast (with the kind staged) and the elements
 * (with who holds them), and a digest of the set as planned. Reads are validated and cached until the
 * document changes.
 */

/** The scene settings key the record is kept under. */
export const BRIEF_RECORD_KEY = 'brief';

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
});

const RecordCastSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(ACTOR_KINDS).nullable(),
  /** Digest of the member's name, description, kind hint and height. */
  digest: z.string(),
});

const RecordElementSchema = z.object({
  id: z.string(),
  kind: z.enum(BRIEF_ELEMENT_KINDS),
  name: z.string(),
  /** The cast member holding it, by the words (null: it stands on the ground). */
  holder: z.string().nullable(),
  digest: z.string(),
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
  shots: z.array(RecordShotSchema),
  cast: z.array(RecordCastSchema),
  elements: z.array(RecordElementSchema),
});
export type BriefRecord = z.infer<typeof BriefRecordSchema>;
export type BriefRecordShot = BriefRecord['shots'][number];

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

/** The digest of the set as planned (plan.ts: the SceneBlocking set the import builds). */
export const setDigest = (plannedSet: unknown): string => digest(canonicalJson(plannedSet));

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
