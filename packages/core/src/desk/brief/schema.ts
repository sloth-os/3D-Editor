import { z } from 'zod';
import { DESK_FRAMINGS, DESK_MOVES, type DeskMove } from '../../doc/types';
import { HOST_ID_PATTERN } from '../rideo/schema';

/*
 * The SceneBrief of the desk embed protocol, version 1 (docs/embedding.md; the contract is frozen): a
 * host's scene in words, with no positions. The host says who is in it, what props and places it
 * has, its shots in order with their durations, framings and planned layouts; the desk stages it
 * (stage.ts). Validated exactly as the contract states it: limits, the id pattern, even sizes, shot
 * indexes strictly increasing, unique ids, and every id a shot names (cast, elements, layout) one of
 * the brief's.
 */

/** A host's id (the contract's Id): 1–100 characters, a letter or digit first, then letters, digits and `_ . : -`. */
export const BriefIdSchema = z.string().regex(HOST_ID_PATTERN, 'an id of 1–100 letters, digits and _ . : -');

/** The desk's 20 named camera moves (the contract's Move: DESK_MOVES). */
export type Move = DeskMove;
export const MoveSchema = z.enum(DESK_MOVES);

/** Times of day a brief may give the set (stage.ts lights the set from TIME_OF_DAY_SUN). */
export const TIMES_OF_DAY = ['dawn', 'morning', 'noon', 'afternoon', 'golden_hour', 'dusk', 'night'] as const;
export type TimeOfDay = (typeof TIMES_OF_DAY)[number];

/** The kinds of a brief's elements: the place, a prop, or something else (a style, a vehicle …). */
export const BRIEF_ELEMENT_KINDS = ['location', 'prop', 'other'] as const;
export type BriefElementKind = (typeof BRIEF_ELEMENT_KINDS)[number];

/** Limits of a brief (the contract's). */
export const BRIEF_LIMITS = {
  name: 200,
  setDescription: 4000,
  cast: 16,
  castName: 120,
  castDescription: 4000,
  kindHint: 60,
  minHeightM: 0.1,
  maxHeightM: 4,
  elements: 64,
  elementName: 120,
  elementDescription: 2000,
  shots: 200,
  maxDurationSec: 600,
  shotText: 4000,
  movement: 60,
  minLensMm: 8,
  maxLensMm: 800,
  layout: 8,
  minFps: 1,
  maxFps: 120,
  minSize: 16,
  maxSize: 4096,
} as const;

const L = BRIEF_LIMITS;

const evenSize = z
  .number()
  .int()
  .min(L.minSize)
  .max(L.maxSize)
  .refine((v) => v % 2 === 0, 'an even number of pixels');

export const BriefSetSchema = z.object({
  description: z.string().max(L.setDescription),
  /** null: decided from the words. */
  interior: z.boolean().nullable(),
  /** null: the desk's default sun. */
  timeOfDay: z.enum(TIMES_OF_DAY).nullable(),
});

export const BriefCastSchema = z.object({
  id: BriefIdSchema,
  name: z.string().min(1).max(L.castName),
  description: z.string().max(L.castDescription),
  /** A hint such as "person", "child", "dog", "horse"; null: from the words. */
  kind: z.string().max(L.kindHint).nullable(),
  heightM: z.number().min(L.minHeightM).max(L.maxHeightM).nullable(),
});

export const BriefElementSchema = z.object({
  id: BriefIdSchema,
  name: z.string().min(1).max(L.elementName),
  description: z.string().max(L.elementDescription),
  kind: z.enum(BRIEF_ELEMENT_KINDS),
});

export const BriefLayoutSchema = z.object({
  castId: BriefIdSchema,
  side: z.enum(['left', 'centre', 'right']),
  facing: z.enum(['left', 'right', 'camera', 'away']),
});

export const BriefShotSchema = z.object({
  id: BriefIdSchema,
  index: z.number().int().min(0),
  durationSec: z.number().positive().max(L.maxDurationSec),
  description: z.string().max(L.shotText),
  action: z.string().max(L.shotText),
  castIds: z.array(BriefIdSchema),
  elementIds: z.array(BriefIdSchema),
  framing: z.enum(DESK_FRAMINGS).nullable(),
  /** The host's words for the camera movement ("dolly_in", "tracking"). */
  movement: z.string().max(L.movement).nullable(),
  /** A named move the shot must have. */
  move: MoveSchema.nullable(),
  lensMm: z.number().int().min(L.minLensMm).max(L.maxLensMm).nullable(),
  continuity: z.enum(['cut', 'continuous']),
  /** The planned first frame: who is on which side, facing which way. */
  layout: z.array(BriefLayoutSchema).max(L.layout),
});

const BriefObjectSchema = z.object({
  id: BriefIdSchema,
  name: z.string().min(1).max(L.name),
  fps: z.number().int().min(L.minFps).max(L.maxFps),
  width: evenSize,
  height: evenSize,
  set: BriefSetSchema,
  cast: z.array(BriefCastSchema).max(L.cast),
  elements: z.array(BriefElementSchema).max(L.elements),
  shots: z.array(BriefShotSchema).min(1).max(L.shots),
});

/** A host's scene, as the contract types it. */
export type SceneBrief = z.infer<typeof BriefObjectSchema>;
export type BriefCast = SceneBrief['cast'][number];
export type BriefElement = SceneBrief['elements'][number];
export type BriefShot = SceneBrief['shots'][number];

/** How a brief differs from the one a scene was staged from (the contract's BriefChanges). */
export interface BriefChanges {
  /** Shots in the brief, not staged. */
  added: string[];
  /** Shots staged, no longer in the brief. */
  removed: string[];
  /** Shots whose duration changed (or whose frame count, when the frame rate did). */
  retimed: string[];
  /** Shots whose cast changed. */
  recast: string[];
  cast: { added: string[]; removed: string[] };
}

/** The ids in `ids` that occur more than once. */
function repeated(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of ids) (seen.has(id) ? twice : seen).add(id);
  return [...twice];
}

/**
 * A SceneBrief (the contract's), validated: every limit, the id pattern, even sizes, at least one
 * shot, shot indexes strictly increasing in order, the ids of the cast, of the elements and of the
 * shots each unique, and every cast or element id a shot names (castIds, elementIds, layout) one of the
 * brief's. Unknown fields are left out of the result.
 */
export const SceneBriefSchema: z.ZodType<SceneBrief> = BriefObjectSchema.superRefine((b, ctx) => {
  const castIds = new Set(b.cast.map((c) => c.id));
  const elementIds = new Set(b.elements.map((e) => e.id));
  for (const [list, ids] of [
    ['cast', b.cast.map((c) => c.id)],
    ['elements', b.elements.map((e) => e.id)],
    ['shots', b.shots.map((s) => s.id)],
  ] as const)
    for (const id of repeated(ids))
      ctx.addIssue({ code: 'custom', path: [list], message: `the id '${id}' is used twice` });
  b.shots.forEach((s, i) => {
    if (i > 0 && !(s.index > b.shots[i - 1].index))
      ctx.addIssue({
        code: 'custom',
        path: ['shots', i, 'index'],
        message: `shot indexes must increase strictly (${s.index} after ${b.shots[i - 1].index})`,
      });
    s.castIds.forEach((id, k) => {
      if (!castIds.has(id))
        ctx.addIssue({ code: 'custom', path: ['shots', i, 'castIds', k], message: `no cast member '${id}'` });
    });
    s.elementIds.forEach((id, k) => {
      if (!elementIds.has(id))
        ctx.addIssue({ code: 'custom', path: ['shots', i, 'elementIds', k], message: `no element '${id}'` });
    });
    s.layout.forEach((e, k) => {
      if (!castIds.has(e.castId))
        ctx.addIssue({
          code: 'custom',
          path: ['shots', i, 'layout', k, 'castId'],
          message: `no cast member '${e.castId}'`,
        });
    });
  });
});

/** The first problems of a brief that does not validate, as one line ("shots.0.castIds.1: no cast member …"). */
export function briefProblems(error: z.ZodError, max = 5): string {
  return error.issues
    .slice(0, max)
    .map((i) => `${i.path.join('.') || '(brief)'}: ${i.message}`)
    .join('; ');
}
