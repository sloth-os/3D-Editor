import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData, ShotData } from '../../doc/types';
import { createEditorState, OperatorError, type OperatorContext } from '../../operators/context';
import { solveShotCameras } from '../../operators/desk-shots';
import type { ActorKind } from '../characters/types';
import type { DeskIssue, DeskIssueSeverity } from '../checks';
import { getShots } from '../shots';
import { isActor } from '../characters';
import { DESK_PROPS } from '../props';
import { RIDEO_PROPS, importRideoBlocking, type StagedFigure, type StagedProp } from '../rideo/import';
import { insertUnit } from '../units/insert';
import { setUnitRoot } from '../set';
import { planBrief, shotCast } from './plan';
import {
  briefFrames,
  briefHash,
  castDigest,
  digest,
  elementDigest,
  readBriefRecord,
  setDigest,
  shotCameraDigest,
  shotTextDigest,
  writeBriefRecord,
  type BriefRecord,
  type BriefRecordShot,
  type RecordPin,
} from './record';
import { SceneBriefSchema, briefProblems, type BriefChanges, type SceneBrief } from './schema';
import {
  UNIT_FACTS_PROP,
  afterOf,
  decodeHeld,
  failSlot,
  heldPropFacts,
  planUnitsOf,
  recordPinOf,
  reportRowOf,
  resolveUnits,
  unitWarnings,
  type PropPlanInfo,
  type FigurePlanInfo,
  type ResolvedUnits,
  type SetPlanInfo,
  type SlotUnit,
  type StageUnitRow,
  type UnitSource,
} from './units';

/*
 * stageBrief: a host's SceneBrief (schema.ts) staged in an empty project, in one transaction (one
 * undo step): the scene's frame rate and render size, the set, the cast as actors, the props, a
 * shot per brief shot (round(durationSec × fps) frames, at least one, in brief order from the scene's
 * first frame; a cut where a rider gets on or off a mount between two shots gets a pre-roll before
 * it, `preRollFrames` long, where the import animates the change; the host's ids kept as the shots'
 * external reference, source 'host', and as the actors' character ids), each
 * camera solved from its framing and fitted to its planned layout, the actors not cast in a shot
 * hidden in it, and the desk's checks run. plan.ts decides what the brief's words leave open; the
 * SceneBlocking import (desk/rideo/import.ts) is the staging engine. A record of the brief is kept
 * in the document (record.ts) for later updates (update.ts).
 *
 * Library pins (brief/units.ts): with `units`, the library units the desk holds, a pinned set unit is
 * placed as the scene's set before the import (its cameras are solved with the set there), a figure
 * as its cast member's actor and a prop unit as its element's prop; a pin whose unit is not held, or
 * cannot be used, is staged from the words (a warning says so) and recorded 'pending' or 'refused'.
 *
 * Pure core: no DOM, no Node API, so it runs in a web worker as well as on the server.
 */

/** A desk check of the staged scene, with the host's shot id when it concerns a shot. */
export interface BriefIssue {
  code: string;
  severity: DeskIssueSeverity;
  message: string;
  /** The host's shot id (null: the whole scene, or a shot not from the brief). */
  shotId: string | null;
}

/**
 * What staging (or updating) a brief did:
 * - `sceneId`, `hash`: the brief now staged (briefRecord gives the same);
 * - `shots`: every shot of the brief, in brief order, with the desk's shot id, its frames and camera;
 * - `cast`: every cast member staged, with its actor object, name, kind and why that kind;
 * - `props`: every element staged as a prop, with its object and the cast member holding it;
 * - `changes`: how the brief differed from the one staged before (updateFromBrief; null otherwise);
 * - `solved`: the host shots whose cameras were solved by this call;
 * - `units`: per library pin of the brief, whether the scene holds it;
 * - `warnings`: what the desk read differently from the brief, or could not stage as it says;
 * - `issues`: the desk's checks of the brief's shots after staging.
 */
export interface StageBriefReport {
  sceneId: string;
  hash: string;
  shots: { shotId: string; deskShotId: string; frames: number; camera: string | null }[];
  cast: { castId: string; object: string; name: string; kind: ActorKind; reason: string }[];
  props: { elementId: string; object: string; heldBy: string | null }[];
  changes: BriefChanges | null;
  solved: string[];
  /**
   * The brief's library pins, one row per slot it pins (the set, a cast member staged, a prop or
   * 'other' element): whether the scene holds the pinned version ('unit') or not ('words', with why).
   * [] for a brief without pins.
   */
  units: StageUnitRow[];
  warnings: string[];
  issues: BriefIssue[];
}

/** Options of staging a brief. */
export interface StageBriefOptions {
  /** The gap before a cut where marks jump (see stageBrief). */
  preRollFrames?: number;
  /** The library units the desk holds (brief/units.ts unitSourceOf); without it every pin is staged from the words. */
  units?: UnitSource;
}

/** A brief validated by SceneBriefSchema, or INVALID_PARAMS naming its first problems. */
export function parseBrief(raw: unknown): SceneBrief {
  const r = SceneBriefSchema.safeParse(raw);
  if (!r.success) throw new OperatorError(`invalid brief: ${briefProblems(r.error)}`, 'INVALID_PARAMS');
  return r.data;
}

/**
 * The operator context brief staging runs the solver in: `ctx`'s document, state and origin, with
 * its reports kept in `warnings` (the solver warns of shots whose camera widens or loses its plan).
 */
export function briefContext(ctx: OperatorContext, warnings: string[]): OperatorContext {
  return {
    ...ctx,
    report: (level, message) => {
      if (level !== 'INFO') warnings.push(message);
    },
  };
}

/** A context for `doc` alone (the functions' callers have no operator context: a worker, a tool). */
export function docContext(doc: SceneDoc): OperatorContext {
  return { doc, state: createEditorState(), origin: doc.origin, source: 'api', report: () => {} };
}

/** The shots of `doc` staged from the scene `sceneId` (source 'host'), by host shot id. */
export function hostShots(doc: SceneDoc, sceneId: string): Map<string, ShotData> {
  const out = new Map<string, ShotData>();
  for (const s of getShots(doc))
    if (
      s.external?.source === 'host' &&
      s.external.clip === sceneId &&
      s.external.shot &&
      !out.has(s.external.shot)
    )
      out.set(s.external.shot, s);
  return out;
}

/** A role's objects staged from scene `sceneId` (`desk_role`, `rideo_clip`), by key (the first of each key). */
export function stagedBy(
  doc: SceneDoc,
  role: string,
  sceneId: string,
  key: (o: ObjectData) => unknown,
): Map<string, ObjectData> {
  const out = new Map<string, ObjectData>();
  for (const o of doc.listObjects()) {
    if (o.custom_props?.[DESK_PROPS.role] !== role || o.custom_props?.[RIDEO_PROPS.clip] !== sceneId)
      continue;
    const k = key(o);
    if (typeof k === 'string' && k && !out.has(k)) out.set(k, o);
  }
  return out;
}

/** The actors staged from `sceneId`, by cast id. */
export const stagedActors = (doc: SceneDoc, sceneId: string): Map<string, ObjectData> =>
  new Map(
    [...stagedBy(doc, 'actor', sceneId, (o) => o.custom_props?.[DESK_PROPS.characterId])].filter(([, o]) =>
      isActor(doc, o.id),
    ),
  );

/** The issues of `issues` with the host's shot ids. */
export function briefIssues(issues: readonly DeskIssue[], hostOf: ReadonlyMap<string, string>): BriefIssue[] {
  return issues.map((i) => ({
    code: i.code,
    severity: i.severity,
    message: i.message,
    shotId: i.shot ? (hostOf.get(i.shot) ?? null) : null,
  }));
}

/**
 * The record of brief `b` staged with the desk shots `desk` (by host shot id), the cast's kinds and
 * the names the desk gave their actors (`actorName`: what an actor renamed in the desk is told from),
 * the held elements' holders and the set as planned. `notes`: the digest to keep for shots whose notes
 * were edited in the desk (the staged notes' digest, so that a later update still keeps them).
 * `removed`: the recorded shots that were removed in the desk and stay removed (an update keeps them
 * in the record, with the brief's values, so that only a later change of the brief stages them
 * again). A shot's frames are the brief's (its duration at the brief's frame rate), whatever length
 * the desk gave it.
 */
export function recordOf(
  b: SceneBrief,
  desk: ReadonlyMap<string, ShotData>,
  kinds: ReadonlyMap<string, { kind: ActorKind; actorName?: string }>,
  holders: ReadonlyMap<string, string>,
  plannedSet: unknown,
  notes: ReadonlyMap<string, string> = new Map(),
  removed: ReadonlyMap<string, BriefRecordShot> = new Map(),
  pins: RecordPins = {},
): BriefRecord {
  return {
    version: 1,
    sceneId: b.id,
    hash: briefHash(b),
    fps: b.fps,
    width: b.width,
    height: b.height,
    set: setDigest(plannedSet),
    ...(pins.set ? { setUnit: pins.set } : {}),
    shots: b.shots
      .filter((s) => desk.has(s.id) || removed.has(s.id))
      .map((s) => {
        const d = desk.get(s.id);
        const was = removed.get(s.id);
        return {
          id: s.id,
          desk: d?.id ?? was!.desk,
          index: s.index,
          durationSec: s.durationSec,
          frames: briefFrames(s.durationSec, b.fps),
          castIds: shotCast(s),
          elementIds: [...s.elementIds],
          text: shotTextDigest(s),
          notes: notes.get(s.id) ?? (d ? digest(d.notes) : was!.notes),
          camera: shotCameraDigest(s),
          lensMm: s.lensMm,
          move: s.move,
        };
      }),
    cast: b.cast.map((c) => {
      const actorName = kinds.get(c.id)?.actorName;
      return {
        id: c.id,
        name: c.name,
        kind: kinds.get(c.id)?.kind ?? null,
        heightM: c.heightM,
        ...(actorName === undefined ? {} : { actorName }),
        digest: castDigest(c),
        ...(pins.cast?.get(c.id) ? { unit: pins.cast.get(c.id) } : {}),
      };
    }),
    elements: b.elements.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      holder: holders.get(e.id) ?? null,
      digest: elementDigest(e),
      ...(pins.elements?.get(e.id) ? { unit: pins.elements.get(e.id) } : {}),
    })),
  };
}

/** The pins a record keeps per slot (record.ts RecordPin). */
export interface RecordPins {
  set?: RecordPin;
  cast?: ReadonlyMap<string, RecordPin>;
  elements?: ReadonlyMap<string, RecordPin>;
}

/** The record pins of resolved slots (`done`: the slots whose place, update or replace was carried out). */
export function recordPinsOf(resolved: ResolvedUnits, done: ReadonlySet<string>): RecordPins {
  const pin = (s: SlotUnit | undefined) => (s ? recordPinOf(s, done.has(s.key)) : undefined);
  const cast = new Map<string, RecordPin>();
  for (const [cid, s] of resolved.cast) {
    const p = pin(s);
    if (p) cast.set(cid, p);
  }
  const elements = new Map<string, RecordPin>();
  for (const [eid, s] of resolved.elements) {
    const p = pin(s);
    if (p) elements.set(eid, p);
  }
  return { set: pin(resolved.set ?? undefined), cast, elements };
}

/** The members a brief stages (cast in a shot, or in a shot's planned layout), in brief order of first shot. */
export function stagedCast(brief: SceneBrief): Set<string> {
  const ids = new Set(brief.cast.map((c) => c.id));
  return new Set(brief.shots.flatMap((s) => shotCast(s)).filter((id) => ids.has(id)));
}

/**
 * Puts the set unit of slot `s` (placing, its unit decoded) in as the scene's set: the instance with
 * key 'set', its root an EMPTY at the origin stamped with desk_role 'set', the scene (desk_rideo_clip),
 * the ground's name and its planning facts. Returns its root.
 */
export function insertSetUnit(doc: SceneDoc, sceneId: string, s: SlotUnit): string {
  const info = s.held!.info as SetPlanInfo;
  return insertUnit(doc, s.payload!, {
    ...s.pin!,
    key: s.key,
    name: info.name,
    rootProps: {
      [DESK_PROPS.role]: 'set',
      [RIDEO_PROPS.clip]: sceneId,
      [RIDEO_PROPS.ground]: info.ground,
      [UNIT_FACTS_PROP]: JSON.stringify(info),
    },
  }).root;
}

/** The import's figure for slot `s` when it places one (its unit decoded), else undefined. */
export function figureHook(s: SlotUnit | undefined): StagedFigure | undefined {
  if (
    !s ||
    !s.payload ||
    !s.held ||
    (s.action !== 'place' && s.action !== 'replace' && s.action !== 'update')
  )
    return undefined;
  const f = (s.held.info as FigurePlanInfo).figure;
  return {
    key: s.key,
    pin: s.pin!,
    unit: s.payload,
    kind: f.kind as StagedFigure['kind'],
    heightM: f.heightM,
    color: f.color,
  };
}

/**
 * The import's prop unit for slot `s`: the unit to place, update or replace (decoded), or the slot's
 * instance kept as it is (only placed again: a version not held, or one made local); undefined for
 * the words' prop.
 */
export function propHook(
  doc: SceneDoc,
  s: SlotUnit | undefined,
  root: string | null,
): StagedProp | undefined {
  if (!s) return undefined;
  if (s.payload && s.held && (s.action === 'place' || s.action === 'update' || s.action === 'replace')) {
    const info = s.held.info as PropPlanInfo;
    return { key: s.key, pin: s.pin!, unit: s.payload, base: info.base, facts: JSON.stringify(info) };
  }
  const a = afterOf(s);
  if (!a || a.from === 'held' || !root) return undefined;
  const facts = heldPropFacts(doc, root);
  const z = doc.getObject(root)?.location[2] ?? 0;
  return { key: s.key, pin: a.pin, unit: null, base: facts ? facts.base : -z, facts: null };
}

/** The longest pre-roll a staging puts before a cut: the SceneBlocking import's limit (rideo/schema.ts preRollFrames). */
export const MAX_BRIEF_PRE_ROLL = 1000;

/**
 * Stages brief `raw` in `ctx.doc` inside the caller's transaction (desk.stage_brief's execute; see
 * stageBrief). INVALID_PARAMS for a brief that does not validate, or a document already staged
 * from a brief or holding shots.
 */
export function stageBriefIn(
  ctx: OperatorContext,
  raw: unknown,
  opts: StageBriefOptions = {},
): StageBriefReport {
  const brief = parseBrief(raw);
  const pre = opts.preRollFrames;
  if (pre !== undefined && !(Number.isInteger(pre) && pre >= 0 && pre <= MAX_BRIEF_PRE_ROLL))
    throw new OperatorError(
      `the pre-roll must be a whole number of frames from 0 to ${MAX_BRIEF_PRE_ROLL} (got ${pre})`,
      'INVALID_PARAMS',
    );
  const doc = ctx.doc;
  const staged = readBriefRecord(doc);
  if (staged)
    throw new OperatorError(
      staged.sceneId === brief.id
        ? `the project is already staged from scene '${brief.id}': update it (updateFromBrief, desk.update_from_brief)`
        : `the project is staged from scene '${staged.sceneId}', not '${brief.id}': stage this brief in another project`,
      'INVALID_PARAMS',
    );
  if (getShots(doc).length)
    throw new OperatorError(
      'the project already has shots: a brief is staged in an empty project (one without shots)',
      'INVALID_PARAMS',
    );
  // the library units: what is held of each pin, decoded for the slots that place them
  const source = opts.units ?? null;
  const castStaged = stagedCast(brief);
  const resolved = resolveUnits(doc, brief, null, source, {
    stageable: {
      cast: (cid) => castStaged.has(cid),
      element: (eid) => brief.elements.some((e) => e.id === eid && e.kind !== 'location'),
    },
  });
  decodeHeld(resolved, source);
  // a library set is the scene's set before the import, so that the cameras it solves see it; one
  // that does not go in is not used (the words' set is staged, the slot says why), the rest goes on
  const done = new Set<string>();
  if (resolved.set?.action === 'place' && resolved.set.payload) {
    try {
      insertSetUnit(doc, brief.id, resolved.set);
      done.add(resolved.set.key);
    } catch (err) {
      failSlot(resolved.set, err);
    }
  }
  const plan = planBrief(brief, { preRollFrames: opts.preRollFrames, units: planUnitsOf(doc, resolved) });
  const warnings = [...plan.warnings, ...unitWarnings(resolved)];
  const r = importRideoBlocking(briefContext(ctx, warnings), plan.input, solveShotCameras, {
    ...(plan.units.set ? { marks: plan.marks } : {}),
    figure: (cid) => {
      const f = figureHook(resolved.cast.get(cid));
      if (f) done.add(f.key);
      return f;
    },
    prop: (p) => {
      const u = p.elementId ? propHook(doc, resolved.elements.get(p.elementId), null) : undefined;
      if (u) done.add(u.key);
      return u;
    },
  });
  warnings.push(...r.warnings);
  for (const s of plan.skipped) {
    const e = brief.elements.find((x) => x.id === s.id)!;
    warnings.push(`${e.name} ${s.why}`);
  }
  const desk = hostShots(doc, brief.id);
  // the names the import gave the actors ("Guard.001" beside another "Guard"): a later update renames
  // an actor that still has it, and keeps a name given in the desk
  const actors = stagedActors(doc, brief.id);
  const kinds = new Map(
    [...plan.cast].map(([cid, k]) => [cid, { kind: k.kind, actorName: actors.get(cid)?.name }]),
  );
  writeBriefRecord(
    doc,
    recordOf(brief, desk, kinds, plan.holders, plan.set, new Map(), new Map(), recordPinsOf(resolved, done)),
  );
  const propObjects = new Map(r.props.filter((p) => p.element_id).map((p) => [p.element_id!, p.id]));
  const objectOf = (s: SlotUnit): string | null =>
    'set' in s.slot
      ? setUnitRoot(doc)
      : 'castId' in s.slot
        ? (actors.get(s.slot.castId)?.id ?? null)
        : (propObjects.get(s.slot.elementId) ?? null);
  const units = resolved.all
    .filter((s) => s.stageable || s.pin)
    .map((s) => reportRowOf(s, objectOf(s), done.has(s.key)))
    .filter((x): x is StageUnitRow => x !== null);
  const hostOf = new Map([...desk].map(([host, s]) => [s.id, host]));
  return {
    sceneId: brief.id,
    hash: briefHash(brief),
    shots: brief.shots
      .filter((s) => desk.has(s.id))
      .map((s) => {
        const d = desk.get(s.id)!;
        return { shotId: s.id, deskShotId: d.id, frames: d.frame_end - d.frame_start + 1, camera: d.camera };
      }),
    cast: r.actors.map((a) => ({
      castId: a.character_id,
      object: a.id,
      name: a.name,
      kind: a.kind,
      reason: plan.cast.get(a.character_id)?.reason ?? a.reason,
    })),
    props: r.props
      .filter((p) => p.element_id)
      .map((p) => ({
        elementId: p.element_id!,
        object: p.id,
        heldBy: plan.holders.get(p.element_id!) ?? null,
      })),
    changes: null,
    solved: r.shots.filter((s) => s.camera_from === 'solved').map((s) => s.rideo_shot),
    units,
    warnings,
    issues: briefIssues(r.issues, hostOf),
  };
}

/**
 * Stages a host's SceneBrief in an empty project, in one transaction (one undo step): see the module
 * comment. `preRollFrames` (0 to MAX_BRIEF_PRE_ROLL, default 12): the gap the SceneBlocking import
 * puts before a cut where marks jump: in a brief, where a rider gets on or off a mount between two
 * shots (its shots' words say who rides whom). `units`: the library units the desk holds for the
 * brief's pins (see the module comment; without it pins are staged from the words). Throws an
 * OperatorError (INVALID_PARAMS) for a brief that does not validate, a pre-roll out of range, or a
 * project that has shots or is staged from a brief already (updateFromBrief updates that). Runs in a
 * web worker: no DOM, no Node API.
 */
export function stageBrief(doc: SceneDoc, brief: SceneBrief, opts: StageBriefOptions = {}): StageBriefReport {
  return doc.transact(() => stageBriefIn(docContext(doc), brief, opts));
}
