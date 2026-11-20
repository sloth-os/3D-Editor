import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import { figureFits, figureProblem } from '../characters/figure';
import { isActorKind } from '../characters/kinds';
import type { ActorKind } from '../characters/types';
import { DESK_PROPS } from '../props';
import { getDeskSettings } from '../shots';
import { UnitError } from '../units/errors';
import { decodeUnit, readUnitHeader, type UnitHeader, type UnitPayload } from '../units/format';
import { UNIT_ROOT, deriveUnitId, slotKey, type UnitSlot } from '../units/ids';
import type { UnitPin } from '../units/insert';
import type { UnitKind } from '../units/kinds';
import { listUnits, readInstance, type UnitInstanceInfo } from '../units/list';
import type { PlanUnits } from './plan';
import { readBriefRecord, type BriefRecord, type RecordPin, type RecordPinStaged } from './record';
import type { BriefUnitPin, SceneBrief } from './schema';

/*
 * Library pins in staging (docs/embedding.md "Library units"; docs/director-desk.md "Library units"):
 * which slots of a brief pin a unit, the units the desk holds (UnitSource), what a unit's header says
 * for planning (planInfoOf), whether a unit can be used, the units one staging may take (unitBudget),
 * and per slot what staging or an update does (resolveUnits).
 *
 * A slot is the set ('set'), a cast member ('cast:<castId>': a 'figure' unit) or an element
 * ('el:<elementId>': a 'prop' unit; an element of kind 'location' takes none: its pin is ignored, as
 * the place's set goes in set.unit). Its pin, the record's pin of it (record.ts: what was staged for
 * it, `staged` 'unit' | 'pending' | 'refused') and the instance with its key in the document decide:
 *
 * - no pin: an instance the record staged is removed (the slot goes back to the words); anything
 *   else stays (a slot made local stays local, an instance the record never staged is left alone);
 * - the slot's instance is the pinned version: nothing to do;
 * - the record staged the slot and its instance is gone (the person made it local): it stays local;
 * - the record refused this very pin: it is not tried again (only another pin is);
 * - the unit is held (the source has its file, it reads, its kind fits the slot, a set's ground is
 *   at 0, a figure is of a kind the desk builds with its rig and fits the actor staged, and it fits
 *   the staging's budget): placed in the slot ('place'), or the slot's instance is updated to it (the
 *   same item: 'update') or replaced by it (another item: 'replace');
 * - otherwise nothing is placed: the slot keeps what it has (an earlier version stays placed), else
 *   it is staged from the words, and the record says why: 'pending' (missing: not sent; mismatch:
 *   bytes that are not the pin's; unavailable: the staging's budget was spent by earlier slots, the
 *   unit could not be read this time, or the scene was in its way as it went in), tried again at the
 *   next open or update, or 'refused' (unreadable,
 *   too_new, too_large, wrong_kind, figure_kind, figure_rig, over_budget, set_ground), tried again
 *   only when the brief pins another version.
 *
 * Pure core: no DOM, no Node API (the staging worker and the page both run it).
 */

/** Pending reasons (decision 5): tried again at the next open. */
export const UNIT_PENDING_REASONS = ['missing', 'mismatch', 'unavailable'] as const;
/** Refused reasons (decision 5): tried again only when the brief pins another version. */
export const UNIT_REFUSED_REASONS = [
  'unreadable',
  'too_new',
  'too_large',
  'wrong_kind',
  'figure_kind',
  'figure_rig',
  'over_budget',
  'set_ground',
] as const;
export type UnitPendingReason = (typeof UNIT_PENDING_REASONS)[number];
export type UnitRefusal = (typeof UNIT_REFUSED_REASONS)[number];

/** Why a slot's pinned unit is not used. */
export type UnitProblem =
  | { staged: 'pending'; why: UnitPendingReason; message: string }
  | { staged: 'refused'; why: UnitRefusal; message: string };

/** `ref@version`, the key of a library version. */
export const pinKey = (p: { ref: string; version: number }): string => `${p.ref}@${p.version}`;

/** Whether two pins name the same file. */
export const samePin = (a: UnitPin, b: UnitPin): boolean =>
  a.ref === b.ref && a.version === b.version && a.sha256 === b.sha256;

const pinOf = (p: UnitPin): BriefUnitPin => ({ ref: p.ref, version: p.version, sha256: p.sha256 });

// ---------------------------------------------------------------- the brief's pins

/** The unit kind each slot takes. */
const SLOT_KIND = { set: 'set', cast: 'figure', element: 'prop' } as const;

/** A slot of a brief with its pin. */
export interface BriefSlotPin {
  slot: UnitSlot;
  /** The instance key of the slot (slotKey): 'set', 'cast:<castId>' or 'el:<elementId>'. */
  key: string;
  /** The kind of unit the slot takes. */
  kind: UnitKind;
  pin: BriefUnitPin;
  /** The slot in words: 'the set', a cast member's or an element's name. */
  name: string;
}

/**
 * The pins of a brief, in slot order: the set, the cast (brief order), the elements of kind 'prop'
 * and 'other' (brief order). A location element's pin is not one (it is ignored, with a warning).
 */
export function briefPins(brief: SceneBrief): BriefSlotPin[] {
  const out: BriefSlotPin[] = [];
  if (brief.set.unit)
    out.push({ slot: { set: true }, key: 'set', kind: 'set', pin: pinOf(brief.set.unit), name: 'the set' });
  for (const c of brief.cast)
    if (c.unit) {
      const slot = { castId: c.id };
      out.push({ slot, key: slotKey(slot), kind: 'figure', pin: pinOf(c.unit), name: c.name });
    }
  for (const e of brief.elements)
    if (e.unit && e.kind !== 'location') {
      const slot = { elementId: e.id };
      out.push({ slot, key: slotKey(slot), kind: 'prop', pin: pinOf(e.unit), name: e.name });
    }
  return out;
}

/** The brief without its pins (an open with units off stages it as though the host never sent them). */
export function briefWithoutPins(brief: SceneBrief): SceneBrief {
  const strip = <T extends { unit?: unknown }>(x: T): T => {
    const { unit: _unit, ...rest } = x;
    return rest as T;
  };
  return {
    ...brief,
    set: strip(brief.set),
    cast: brief.cast.map(strip),
    elements: brief.elements.map(strip),
  };
}

// ---------------------------------------------------------------- the units held

/**
 * The units the desk holds for a staging, by pin (synchronous). `header` is cheap (the file's prefix
 * and header) and null when the unit is not held; `unit` decodes it (throws a UnitError when it does
 * not decode). Optional: `bytes`, the file's size (for the budget; else its unpacked body's), and
 * `problem`, why a pin's unit is not held or cannot be used (else 'missing').
 */
export interface UnitSource {
  header(pin: BriefUnitPin): UnitHeader | null;
  unit(pin: BriefUnitPin): UnitPayload;
  bytes?(pin: BriefUnitPin): number | null;
  problem?(pin: BriefUnitPin): UnitProblem | null;
}

/** A unit file the host sent for a pin, its SHA-256 checked by the caller. */
export interface GivenUnit {
  ref: string;
  version: number;
  sha256: string;
  data: Uint8Array;
}

/** Why the caller could not use a unit the host sent (it hashed to another SHA-256, it was too large …). */
export interface GivenProblem {
  ref: string;
  version: number;
  staged: 'pending' | 'refused';
  why: UnitPendingReason | UnitRefusal;
  message?: string;
}

/**
 * Why a unit that failed to read or to go in is not used: refused for the file's own faults
 * (unreadable, too_new, too_large), else pending 'unavailable', tried again at the next open or
 * update: an error that is not the unit's (out of memory, a worker restart), or the scene in the
 * unit's way as it goes in (an id it takes that something of the scene holds, an instance or object
 * it needs, an instance or object of another kind or type where it goes: UNIT_ID_TAKEN,
 * UNIT_INSTANCE_EXISTS, UNIT_NOT_FOUND, UNIT_KIND_MISMATCH; a file that decodes always roots a unit
 * of its kind in an object of the type its kind takes, so a mismatch is the scene's), which the
 * message names.
 */
export function unitReadProblem(err: unknown): UnitProblem {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof UnitError)) return { staged: 'pending', why: 'unavailable', message };
  switch (err.code) {
    case 'UNIT_VERSION':
    case 'UNIT_SCHEMA_NEWER':
      return { staged: 'refused', why: 'too_new', message };
    case 'UNIT_TOO_LARGE':
      return { staged: 'refused', why: 'too_large', message };
    case 'UNIT_ID_TAKEN':
    case 'UNIT_INSTANCE_EXISTS':
    case 'UNIT_KIND_MISMATCH':
      return { staged: 'pending', why: 'unavailable', message: `the scene is in its way: ${message}` };
    case 'UNIT_NOT_FOUND':
      return { staged: 'pending', why: 'unavailable', message };
    default:
      return { staged: 'refused', why: 'unreadable', message };
  }
}

/** The words of a caller's problem without a message of its own. */
const GIVEN_WORDS: Partial<Record<UnitPendingReason | UnitRefusal, string>> = {
  missing: 'it was not sent',
  mismatch: 'the file sent is not the pinned one (its SHA-256 differs)',
  unavailable: 'it could not be read this time',
  too_large: 'the file sent is over 32 MiB',
};

const problemOf = (p: GivenProblem): UnitProblem =>
  ({
    staged: p.staged,
    why: p.why,
    message: p.message ?? `${pinKey(p)}: ${GIVEN_WORDS[p.why] ?? p.why}`,
  }) as UnitProblem;

/**
 * A UnitSource of the units the host sent (open.units, their SHA-256 checked by the caller): each
 * file's header is read at once (a file that does not read is refused: unreadable, too_new or
 * too_large), its body decoded only when staging needs it (once). The first file of a `ref@version`
 * counts, later ones are ignored. A file whose SHA-256 is not the pin's is 'mismatch' for that pin.
 * `problems`: why the caller left a pin's file out (bytes that do not hash to their SHA-256:
 * 'mismatch'; over 32 MiB: 'too_large'). Without bodies decoded it is the page's header-only source
 * for briefChanges.
 */
export function unitSourceOf(
  units: readonly GivenUnit[],
  problems: readonly GivenProblem[] = [],
): UnitSource {
  interface Entry {
    sha256: string;
    data: Uint8Array;
    header: UnitHeader | null;
    problem: UnitProblem | null;
    payload: UnitPayload | null;
  }
  const entries = new Map<string, Entry>();
  for (const u of units) {
    const key = pinKey(u);
    if (entries.has(key)) continue;
    let header: UnitHeader | null = null;
    let problem: UnitProblem | null = null;
    try {
      header = readUnitHeader(u.data);
    } catch (err) {
      problem = unitReadProblem(err);
    }
    entries.set(key, { sha256: u.sha256, data: u.data, header, problem, payload: null });
  }
  const given = new Map<string, UnitProblem>();
  for (const p of problems) if (!given.has(pinKey(p))) given.set(pinKey(p), problemOf(p));
  const usable = (pin: BriefUnitPin): Entry | null => {
    const e = entries.get(pinKey(pin));
    return e && e.sha256 === pin.sha256 && e.header ? e : null;
  };
  return {
    header: (pin) => usable(pin)?.header ?? null,
    unit(pin) {
      const e = usable(pin);
      if (!e) throw new UnitError('UNIT_NOT_FOUND', `the unit ${pinKey(pin)} is not here`);
      return (e.payload ??= decodeUnit(e.data));
    },
    bytes: (pin) => usable(pin)?.data.byteLength ?? null,
    problem(pin) {
      if (usable(pin)) return null;
      const e = entries.get(pinKey(pin));
      if (e && e.sha256 === pin.sha256 && e.problem) return e.problem;
      const g = given.get(pinKey(pin));
      if (g) return g;
      if (e)
        return {
          staged: 'pending',
          why: 'mismatch',
          message: `the file sent for ${pinKey(pin)} is not the pinned one (SHA-256 ${e.sha256.slice(0, 12)}…, the pin's ${pin.sha256.slice(0, 12)}…)`,
        };
      return null;
    },
  };
}

// ---------------------------------------------------------------- planning facts

/** A piece of a set unit: a box in editor axes (x right, y away from the front, z up), the set at the origin. */
export interface SetPiece {
  label: string;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
  rotationDeg: number;
  water: boolean;
}

/** What staging plans from a unit (planInfoOf: from its header). */
export type PlanUnitInfo =
  | {
      kind: 'set';
      name: string;
      interior: boolean;
      /** The ground's name (its colour and the SceneBlocking export's ground). */
      ground: string;
      /** The walkable stage, centred on the origin. */
      stage: { width: number; depth: number };
      groundZ: number;
      pieces: SetPiece[];
    }
  | {
      kind: 'prop';
      name: string;
      label: string;
      /** Its size at its own scale (x, y, z, m). */
      dimensions: [number, number, number];
      /** The lowest z of its meshes: its root stands at z = −base. */
      base: number;
    }
  | {
      kind: 'figure';
      name: string;
      figure: { kind: string; heightM: number; color: string; rig: string };
    };
export type SetPlanInfo = Extract<PlanUnitInfo, { kind: 'set' }>;
export type PropPlanInfo = Extract<PlanUnitInfo, { kind: 'prop' }>;
export type FigurePlanInfo = Extract<PlanUnitInfo, { kind: 'figure' }>;

/** A set unit's stage is clamped to these (m). */
export const MIN_UNIT_STAGE_M = 2;
export const MAX_UNIT_STAGE_M = 200;
/** Most pieces of a set unit staging avoids. */
export const MAX_SET_PIECES = 128;
/** A set's ground further than this from height 0 (m) is refused ('set_ground'). */
export const SET_GROUND_TOLERANCE_M = 0.01;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));

/**
 * The facts staging plans from, read from a unit's header: a set's stage (its width and depth,
 * clamped to 2–200 m), interior, ground (the landmark of role 'ground') and pieces (its landmarks but
 * the ground and lights, at most 128); a prop's size and base; a figure's kind, height, colour and rig.
 */
export function planInfoOf(header: UnitHeader): PlanUnitInfo {
  if (header.kind === 'set') {
    const s = header.set!;
    return {
      kind: 'set',
      name: header.name,
      interior: s.interior,
      ground: s.landmarks.find((l) => l.role === 'ground')?.label || 'ground',
      stage: {
        width: clamp(s.width, MIN_UNIT_STAGE_M, MAX_UNIT_STAGE_M),
        depth: clamp(s.depth, MIN_UNIT_STAGE_M, MAX_UNIT_STAGE_M),
      },
      groundZ: s.groundZ,
      pieces: s.landmarks
        .filter((l) => l.role !== 'ground' && l.role !== 'light')
        .slice(0, MAX_SET_PIECES)
        .map((l) => ({
          label: l.label,
          x: l.x,
          y: l.y,
          width: l.width,
          depth: l.depth,
          height: l.height,
          rotationDeg: l.rotationDeg,
          water: l.water,
        })),
    };
  }
  if (header.kind === 'prop') {
    const p = header.prop!;
    return {
      kind: 'prop',
      name: header.name,
      label: p.label,
      dimensions: [p.dimensions[0], p.dimensions[1], p.dimensions[2]],
      base: p.base,
    };
  }
  const f = header.figure!;
  return {
    kind: 'figure',
    name: header.name,
    figure: { kind: f.kind, heightM: f.heightM, color: f.color, rig: f.rig },
  };
}

/** The scene prop on a set or prop instance's root holding its planning facts (PlanUnitInfo as JSON). */
export const UNIT_FACTS_PROP = 'desk_unit_facts';

/** The planning facts stamped on root `id` (null: none, or none that read). */
export function rootFacts(doc: SceneDoc, id: string): PlanUnitInfo | null {
  const v = doc.getObject(id)?.custom_props?.[UNIT_FACTS_PROP];
  if (typeof v !== 'string') return null;
  try {
    const f = JSON.parse(v) as PlanUnitInfo;
    return f && typeof f === 'object' && (f.kind === 'set' || f.kind === 'prop' || f.kind === 'figure')
      ? f
      : null;
  } catch {
    return null;
  }
}

/**
 * Why unit `header` cannot fill a slot taking `kind` (null: it can): another kind ('wrong_kind'), a
 * set whose ground is off height 0 ('set_ground'), a figure of a kind the desk does not build
 * ('figure_kind') or whose bones are not its kind's ('figure_rig').
 */
export function unitRefusal(kind: UnitKind, header: UnitHeader): UnitProblem | null {
  if (header.kind !== kind)
    return {
      staged: 'refused',
      why: 'wrong_kind',
      message: `'${header.name}' is a ${header.kind} unit, not a ${kind}`,
    };
  if (kind === 'set' && Math.abs(header.set?.groundZ ?? 0) > SET_GROUND_TOLERANCE_M)
    return {
      staged: 'refused',
      why: 'set_ground',
      message: `the set '${header.name}' has its ground at ${header.set!.groundZ} m, not at 0`,
    };
  if (kind === 'figure') {
    const why = figureProblem(header.figure);
    if (why === 'figure_kind')
      return {
        staged: 'refused',
        why,
        message: `the figure '${header.name}' is a ${header.figure?.kind ?? '?'}, a kind the desk does not build`,
      };
    if (why === 'figure_rig')
      return {
        staged: 'refused',
        why,
        message: `the figure '${header.name}' has bones the desk's ${header.figure!.kind} does not have`,
      };
  }
  return null;
}

// ---------------------------------------------------------------- the budget

/** The units one staging or update places at most: 48 MiB of files, 160 MiB unpacked. */
export const UNIT_BUDGET = { packedBytes: 48 * 2 ** 20, unpackedBytes: 160 * 2 ** 20 } as const;

/**
 * A unit's size for the budget: its file; its unpacked bound for one instance (the decoded body and
 * the scene's copy of it; from the header, twice the body: decodeHeld counts again once it is
 * decoded, with every blob reference written out); and the scene's copy alone (`copy`), which each
 * further slot placing the same version adds (absent: the whole unpacked bound again).
 */
export interface UnitSize {
  packed: number;
  unpacked: number;
  copy?: number;
}

/** A unit's size from its header and its file's length. */
export const unitSize = (header: UnitHeader, fileBytes: number): UnitSize => ({
  packed: fileBytes,
  unpacked: 2 * header.bodyBytes,
  copy: header.bodyBytes,
});

export type UnitBudgetVerdict = 'fits' | 'unavailable' | 'over_budget';

/**
 * The units one staging takes, counted in the order of `pins` (slot order: the set, the cast, the
 * elements; a version pinned in several slots once per slot): each version's file and decoded body
 * once, and the scene's copy of it in every slot (its first slot takes `unpacked`, each further one
 * `copy`). A slot whose unit fits what the slots before it left of UNIT_BUDGET 'fits'; one whose unit
 * does not, but would on its own, is 'unavailable' this time (a later open tries it again); one whose
 * unit's single instance is over the budget is 'over_budget' (never). Pins `sizeOf` gives no size are
 * left out (null). Returns the verdict of each slot (`slots`, in the order of `pins`) and of each
 * `ref@version` (its first slot's: whether its file is used), and the sizes taken.
 */
export function unitBudget<P extends { ref: string; version: number }>(
  pins: readonly P[],
  sizeOf: (pin: P) => UnitSize | null,
): {
  slots: (UnitBudgetVerdict | null)[];
  verdicts: Map<string, UnitBudgetVerdict>;
  packed: number;
  unpacked: number;
} {
  const slots: (UnitBudgetVerdict | null)[] = [];
  const verdicts = new Map<string, UnitBudgetVerdict>();
  let packed = 0;
  let unpacked = 0;
  for (const p of pins) {
    const key = pinKey(p);
    const size = sizeOf(p);
    let verdict: UnitBudgetVerdict | null;
    if (!size) verdict = null;
    else if (verdicts.get(key) === 'fits') {
      // the version's file and body are taken already: another copy of it in the scene
      const copy = size.copy ?? size.unpacked;
      verdict = unpacked + copy > UNIT_BUDGET.unpackedBytes ? 'unavailable' : 'fits';
      if (verdict === 'fits') unpacked += copy;
    } else if (size.packed > UNIT_BUDGET.packedBytes || size.unpacked > UNIT_BUDGET.unpackedBytes)
      verdict = 'over_budget';
    else if (
      packed + size.packed > UNIT_BUDGET.packedBytes ||
      unpacked + size.unpacked > UNIT_BUDGET.unpackedBytes
    )
      verdict = 'unavailable';
    else {
      verdict = 'fits';
      packed += size.packed;
      unpacked += size.unpacked;
    }
    slots.push(verdict);
    if (verdict && !verdicts.has(key)) verdicts.set(key, verdict);
  }
  return { slots, verdicts, packed, unpacked };
}

// ---------------------------------------------------------------- slots

/** What staging or an update does in a slot (see the module comment). */
export type UnitAction = 'place' | 'update' | 'replace' | 'remove' | 'none';

/** A slot of the brief or of the record, with what is known of its unit and what is done there. */
export interface SlotUnit {
  slot: UnitSlot;
  key: string;
  kind: UnitKind;
  /** The slot in words. */
  name: string;
  /** The brief's pin (null: the brief pins none; the record or the document has the slot). */
  pin: BriefUnitPin | null;
  /** The record's pin of the slot (null: none). */
  rec: RecordPin | null;
  /** The instance with the slot's key in the document (null: none). */
  inst: UnitInstanceInfo | null;
  /** The record staged the slot's unit and the document holds no instance of it: made local. */
  local: boolean;
  /** Whether the slot is staged (the set; a cast member with an actor; an element staged as a prop). */
  stageable: boolean;
  /** The pinned unit, when it is held, can be used and fits the budget. */
  held: { header: UnitHeader; info: PlanUnitInfo } | null;
  /** The decoded unit (decodeHeld), for place, update and replace. */
  payload: UnitPayload | null;
  /** Why the pinned unit is not used (null: it is, or the slot needs none). */
  problem: UnitProblem | null;
  action: UnitAction;
}

/** The slots of a staging: the set, the cast and the elements, and all of them in slot order. */
export interface ResolvedUnits {
  set: SlotUnit | null;
  cast: Map<string, SlotUnit>;
  elements: Map<string, SlotUnit>;
  all: SlotUnit[];
}

const instPin = (i: UnitInstanceInfo): BriefUnitPin => ({ ref: i.ref, version: i.version, sha256: i.sha256 });

/** What a cast member's slot may do in this staging: it has an actor (or staging makes one). */
export interface StageableSlots {
  cast(castId: string): boolean;
  element(elementId: string): boolean;
}

/**
 * The slots of `brief` (and of `record`, this scene's, for slots whose pin the brief dropped) with
 * the document's instances, what `source` holds of each pin (headers only: nothing is decoded) and
 * what staging or an update does there (see the module comment). `stageable` says which cast members
 * and elements are staged. Figures are checked against the actor a slot has (`actors`): one that does
 * not fit it is refused ('figure_kind' for another kind, 'figure_rig' for another height). The budget
 * is counted over the units to place, update or replace, in slot order.
 */
export function resolveUnits(
  doc: SceneDoc,
  brief: SceneBrief,
  record: BriefRecord | null,
  source: UnitSource | null,
  o: { stageable: StageableSlots; actors?: ReadonlyMap<string, ObjectData> },
): ResolvedUnits {
  const rec = record && record.sceneId === brief.id ? record : null;
  const instances = new Map<string, UnitInstanceInfo>();
  for (const i of listUnits(doc)) if (!instances.has(i.key)) instances.set(i.key, i);
  const pins = new Map(briefPins(brief).map((p) => [p.key, p]));
  const recPins = new Map<string, RecordPin>();
  if (rec?.setUnit) recPins.set('set', rec.setUnit);
  for (const c of rec?.cast ?? []) if (c.unit) recPins.set(slotKey({ castId: c.id }), c.unit);
  for (const e of rec?.elements ?? []) if (e.unit) recPins.set(slotKey({ elementId: e.id }), e.unit);

  const out: ResolvedUnits = { set: null, cast: new Map(), elements: new Map(), all: [] };
  const make = (slot: UnitSlot, name: string): SlotUnit | null => {
    const key = slotKey(slot);
    const p = pins.get(key) ?? null;
    const r = recPins.get(key) ?? null;
    const inst = instances.get(key) ?? null;
    if (!p && !r && !inst) return null;
    const kind = 'set' in slot ? SLOT_KIND.set : 'castId' in slot ? SLOT_KIND.cast : SLOT_KIND.element;
    const stageable =
      'set' in slot
        ? true
        : 'castId' in slot
          ? o.stageable.cast(slot.castId)
          : o.stageable.element(slot.elementId);
    return {
      slot,
      key,
      kind,
      name: p?.name ?? name,
      pin: p?.pin ?? null,
      rec: r,
      inst,
      local: r?.staged === 'unit' && !inst,
      stageable,
      held: null,
      payload: null,
      problem: null,
      action: 'none',
    };
  };
  const set = make({ set: true }, 'the set');
  if (set) out.set = set;
  for (const c of brief.cast) {
    const s = make({ castId: c.id }, c.name);
    if (s) out.cast.set(c.id, s);
  }
  for (const e of brief.elements) {
    if (e.kind === 'location') continue;
    const s = make({ elementId: e.id }, e.name);
    if (s) out.elements.set(e.id, s);
  }
  // slots only the record has (a member or element the brief dropped): nothing to place there
  out.all = [...(out.set ? [out.set] : []), ...out.cast.values(), ...out.elements.values()];

  // what is held, in slot order, and the budget over the units to place, update or replace
  const sizes = new Map<string, UnitSize>();
  for (const s of out.all) {
    if (!s.pin || !wouldTry(s)) continue;
    const header = source?.header(s.pin) ?? null;
    if (!header) {
      s.problem = source?.problem?.(s.pin) ?? {
        staged: 'pending',
        why: 'missing',
        message: `${s.name}'s library unit ${pinKey(s.pin)} is not here`,
      };
      continue;
    }
    const refused = unitRefusal(s.kind, header);
    if (refused) {
      s.problem = refused;
      continue;
    }
    const info = planInfoOf(header);
    if (info.kind === 'figure' && 'castId' in s.slot) {
      const actor = o.actors?.get(s.slot.castId);
      const f = info.figure;
      if (actor && isActorKind(f.kind) && !figureFits(doc, actor.id, { kind: f.kind, heightM: f.heightM })) {
        const k = String(actor.custom_props?.[DESK_PROPS.kind] ?? '');
        const h = Number(actor.custom_props?.[DESK_PROPS.heightM]);
        s.problem = {
          staged: 'refused',
          why: k !== f.kind ? 'figure_kind' : 'figure_rig',
          message: `${s.name} is staged as a ${k} of ${h} m and the library figure '${info.name}' is a ${f.kind} of ${f.heightM} m: the actor stays (stage the brief in a new project to use the figure)`,
        };
        continue;
      }
    }
    s.held = { header, info };
    sizes.set(pinKey(s.pin), unitSize(header, source?.bytes?.(s.pin) ?? header.bodyBytes));
  }
  // per slot: a version pinned in several slots is one file and one body, and a copy in each
  const held = out.all.filter((s) => s.held && s.pin);
  const budget = unitBudget(
    held.map((s) => s.pin!),
    (p) => sizes.get(pinKey(p)) ?? null,
  );
  held.forEach((s, i) => {
    const verdict = budget.slots[i];
    if (verdict === 'fits') return;
    s.held = null;
    s.problem = budgetProblem(s, verdict ?? 'unavailable');
  });
  for (const s of out.all) s.action = actionOf(s);
  return out;
}

/** Why slot `s`'s unit is not used when it does not fit the budget (see unitBudget). */
function budgetProblem(s: SlotUnit, verdict: 'unavailable' | 'over_budget'): UnitProblem {
  return verdict === 'over_budget'
    ? {
        staged: 'refused',
        why: 'over_budget',
        message: `${s.name}'s library unit ${pinKey(s.pin!)} is larger than one staging takes (${UNIT_BUDGET.packedBytes / 2 ** 20} MiB of files, ${UNIT_BUDGET.unpackedBytes / 2 ** 20} MiB unpacked)`,
      }
    : {
        staged: 'pending',
        why: 'unavailable',
        message: `${s.name}'s library unit ${pinKey(s.pin!)} does not fit what the units before it left of this staging's budget: it is tried again at the next open`,
      };
}

/** Whether a slot with a pin may place, update or replace (its unit is worth reading). */
export function wouldTry(s: SlotUnit): boolean {
  const pin = s.pin!;
  if (s.inst && samePin(s.inst, pin)) return false;
  if (s.local) return false;
  if (s.rec?.staged === 'refused' && samePin(s.rec, pin)) return false;
  return s.stageable;
}

/**
 * Whether an update records slot `s`'s pin refused: its file was sent (or the caller said why it left
 * it out) and staging cannot use it. resolveUnits looks only at pins it would try, so never at one the
 * record refuses already: once an update has recorded it, it is not tried again.
 */
export const refusesPin = (s: SlotUnit): boolean =>
  s.action === 'none' && s.pin !== null && s.problem?.staged === 'refused';

/** What staging or an update does in slot `s` (see the module comment). */
function actionOf(s: SlotUnit): UnitAction {
  if (!s.pin) return s.inst && s.rec?.staged === 'unit' ? 'remove' : 'none';
  if (!wouldTry(s) || !s.held) return 'none';
  if (!s.inst) return 'place';
  return s.inst.ref === s.pin.ref ? 'update' : 'replace';
}

/**
 * Decodes the units of the slots that place, update or replace, in slot order. A unit that does not
 * decode is not used: its slot keeps what it has, with the problem (refused, or 'unavailable' for an
 * error that is not the unit's). The unpacked budget is counted again from what each decoded version
 * holds (unitBudget, its files counted already): its body once, and in each slot the scene's copy of
 * it with every blob reference written out (a file can share one large byte array among many
 * references, which the header's estimate cannot see). A slot that no longer fits what the ones
 * before it left is 'unavailable', one whose unit's single instance never can is 'over_budget'.
 */
export function decodeHeld(resolved: ResolvedUnits, source: UnitSource | null): void {
  const decoded: SlotUnit[] = [];
  for (const s of resolved.all) {
    if (!s.held || !s.pin || (s.action !== 'place' && s.action !== 'update' && s.action !== 'replace'))
      continue;
    try {
      if (!source) throw new UnitError('UNIT_NOT_FOUND', 'no units are held');
      s.payload = source.unit(s.pin);
      decoded.push(s);
    } catch (err) {
      failSlot(s, err);
    }
  }
  const payloads = new Map(decoded.map((s) => [pinKey(s.pin!), s.payload!]));
  const budget = unitBudget(
    decoded.map((s) => s.pin!),
    (p) => {
      const u = payloads.get(pinKey(p))!;
      return { packed: 0, unpacked: u.header.bodyBytes + u.expandedBytes, copy: u.expandedBytes };
    },
  );
  decoded.forEach((s, i) => {
    const verdict = budget.slots[i]!;
    if (verdict === 'fits') return;
    s.payload = null;
    s.held = null;
    s.problem = budgetProblem(s, verdict);
    s.action = 'none';
  });
}

/**
 * Slot `s`'s unit is not used after all (it did not decode, or did not go in): the slot keeps what it
 * has, with the problem (refused, or pending 'unavailable' for an error that is not the unit's file's:
 * unitReadProblem).
 */
export function failSlot(s: SlotUnit, err: unknown): void {
  s.payload = null;
  s.held = null;
  s.problem = unitReadProblem(err);
  s.action = 'none';
}

// ---------------------------------------------------------------- the slots after staging

/** What a slot holds after the staging or update (null: it is staged from the words). */
export function afterOf(s: SlotUnit): { pin: BriefUnitPin; from: 'held' | 'instance' | 'local' } | null {
  if (s.action === 'place' || s.action === 'update' || s.action === 'replace')
    return { pin: s.pin!, from: 'held' };
  if (s.action === 'remove') return null;
  if (s.inst && s.pin) return { pin: instPin(s.inst), from: 'instance' };
  if (s.local && s.rec) return { pin: pinOf(s.rec), from: 'local' };
  return null;
}

/** The root id a set instance has (its key is always 'set'), placed or made local. */
export const SET_ROOT_ID = (): string => deriveUnitId('set', UNIT_ROOT);

/**
 * The set's planning facts for a set the scene holds (placed before, or made local): those stamped on
 * its root, else the desk settings' stage and interior with no pieces.
 */
export function heldSetFacts(doc: SceneDoc, root: string | null): Extract<PlanUnitInfo, { kind: 'set' }> {
  const stamped = root ? rootFacts(doc, root) : null;
  if (stamped?.kind === 'set') return stamped;
  const d = getDeskSettings(doc);
  const o = root ? doc.getObject(root) : null;
  const ground = o?.custom_props?.desk_ground;
  return {
    kind: 'set',
    name: o?.name ?? 'Set',
    interior: d.interior,
    ground: typeof ground === 'string' && ground ? ground : 'ground',
    stage: {
      width: clamp(d.set_width, MIN_UNIT_STAGE_M, MAX_UNIT_STAGE_M),
      depth: clamp(d.set_depth, MIN_UNIT_STAGE_M, MAX_UNIT_STAGE_M),
    },
    groundZ: 0,
    pieces: [],
  };
}

/** A figure's planning facts from an actor (its kind, height and colour). */
export function actorFigureFacts(actor: ObjectData): Extract<PlanUnitInfo, { kind: 'figure' }> {
  const p = actor.custom_props ?? {};
  return {
    kind: 'figure',
    name: actor.name,
    figure: {
      kind: String(p[DESK_PROPS.kind] ?? ''),
      heightM: Number(p[DESK_PROPS.heightM]) || 0,
      color: String(p[DESK_PROPS.color] ?? '#808080'),
      rig: '',
    },
  };
}

/** A prop's planning facts from its root (stamped, else its rest size unknown: none). */
export function heldPropFacts(doc: SceneDoc, root: string): Extract<PlanUnitInfo, { kind: 'prop' }> | null {
  const f = rootFacts(doc, root);
  return f?.kind === 'prop' ? f : null;
}

/** The figure a cast member is planned as: its kind (fixed), height and colour, and the unit's name. */
export interface PlannedFigure {
  pin: BriefUnitPin;
  kind: ActorKind;
  heightM: number;
  color: string;
  name: string;
}

/**
 * What the scene will hold of library units after staging, for the plan (planBrief's `units`): per
 * slot afterOf, with the facts of a unit to place (its header) or of one the scene holds (stamped on
 * its root; a figure's from its actor). `actors` and `props`: the actors and props staged now, by cast
 * and element id (a slot made local keeps its object, no longer an instance).
 */
export function planUnitsOf(
  doc: SceneDoc,
  resolved: ResolvedUnits,
  staged: { actors?: ReadonlyMap<string, ObjectData>; props?: ReadonlyMap<string, ObjectData> } = {},
): PlanUnits {
  let set: PlanUnits['set'] = null;
  if (resolved.set) {
    const a = afterOf(resolved.set);
    if (a)
      set = {
        pin: a.pin,
        info:
          a.from === 'held'
            ? (resolved.set.held!.info as SetPlanInfo)
            : heldSetFacts(
                doc,
                a.from === 'instance'
                  ? resolved.set.inst!.root
                  : doc.getObject(SET_ROOT_ID())
                    ? SET_ROOT_ID()
                    : null,
              ),
      };
  }
  const figures = new Map<string, PlannedFigure>();
  for (const [cid, s] of resolved.cast) {
    const a = afterOf(s);
    if (!a) continue;
    if (a.from === 'held') {
      const info = s.held!.info as FigurePlanInfo;
      if (isActorKind(info.figure.kind))
        figures.set(cid, {
          pin: a.pin,
          kind: info.figure.kind,
          heightM: info.figure.heightM,
          color: info.figure.color,
          name: info.name,
        });
      continue;
    }
    const actor = staged.actors?.get(cid) ?? (s.inst ? doc.getObject(s.inst.root) : null);
    if (!actor) continue;
    const f = actorFigureFacts(actor);
    if (isActorKind(f.figure.kind))
      figures.set(cid, {
        pin: a.pin,
        kind: f.figure.kind,
        heightM: f.figure.heightM,
        color: f.figure.color,
        name: s.inst?.name ?? actor.name,
      });
  }
  const props = new Map<string, { pin: BriefUnitPin; info: PropPlanInfo | null }>();
  for (const [eid, s] of resolved.elements) {
    const a = afterOf(s);
    if (!a) continue;
    if (a.from === 'held') {
      props.set(eid, { pin: a.pin, info: s.held!.info as PropPlanInfo });
      continue;
    }
    const root = s.inst?.root ?? staged.props?.get(eid)?.id ?? null;
    props.set(eid, { pin: a.pin, info: root ? heldPropFacts(doc, root) : null });
  }
  return { set, figures, props };
}

/** A unit kind in words. */
export const KIND_WORD = { set: 'set', figure: 'figure', prop: 'prop' } as const;
const STAND_IN = {
  set: 'the set from the words',
  figure: 'a mannequin from the words',
  prop: 'the prop from the words',
} as const;

/**
 * The warnings of the slots whose pinned unit staging or an update does not place: not here (pending
 * missing), not usable this time (pending), refused, made local, or an earlier version kept.
 */
export function unitWarnings(resolved: ResolvedUnits): string[] {
  const out: string[] = [];
  for (const s of resolved.all) {
    const pin = s.pin;
    if (!pin || s.action !== 'none' || !s.stageable) continue;
    if (s.inst && samePin(s.inst, pin)) continue;
    const what = `${s.name === 'the set' ? 'The set' : s.name}'s library ${KIND_WORD[s.kind]} ${pin.ref} v${pin.version}`;
    if (s.local) {
      out.push(`${what}: the ${KIND_WORD[s.kind]} was made local in the desk and stays as it is`);
      continue;
    }
    const refusedBefore = s.rec?.staged === 'refused' && samePin(s.rec, pin) ? s.rec : null;
    const stays = s.inst ? `v${s.inst.version} stays` : `${STAND_IN[s.kind]} stands in`;
    if (refusedBefore) {
      out.push(`${what} cannot be used (${refusedBefore.why ?? 'refused'}): ${stays}`);
      continue;
    }
    const p = s.problem;
    if (!p || p.why === 'missing')
      out.push(`${what} is not here: ${stays} until it arrives (Update shots then places it)`);
    else if (p.staged === 'pending')
      out.push(`${what} could not be used this time (${p.message}): ${stays}; the next open tries again`);
    else out.push(`${what} cannot be used (${p.message}): ${stays}`);
  }
  return out;
}

// ---------------------------------------------------------------- what the record and the report say

/** A row of StageBriefReport.units: a brief slot's pin and whether the scene holds it. */
export interface StageUnitRow {
  /** The slot's key: 'set', 'cast:<castId>' or 'el:<elementId>'. */
  slot: string;
  ref: string;
  version: number;
  /** The slot's object (the set's root, the actor, the prop), else null. */
  object: string | null;
  /** 'unit': the slot holds the pinned version; 'words': it does not (staged from the words, or another version kept). */
  staged: 'unit' | 'words';
  /** Why not: a pending or refused reason, or 'local' for a slot made local. */
  why?: string;
}

/**
 * The record pin of slot `s` after staging or an update that did what `s.action` says (`done`:
 * whether a place, update or replace was carried out; undefined: none for the slot).
 */
export function recordPinOf(s: SlotUnit, done: boolean): RecordPin | undefined {
  const pin = s.pin;
  if (s.action === 'remove') return s.local ? (s.rec ?? undefined) : undefined;
  if (done && pin && s.action !== 'none') return { ...pin, staged: 'unit' };
  if (s.local) return s.rec ?? undefined;
  if (!pin) return undefined;
  if (s.inst && samePin(s.inst, pin)) return { ...pin, staged: 'unit' };
  if (s.rec?.staged === 'refused' && samePin(s.rec, pin)) return s.rec;
  if (!s.stageable && !s.inst) return s.rec ?? undefined;
  if (s.problem?.staged === 'refused') return { ...pin, staged: 'refused', why: s.problem.why };
  if (s.inst) return s.rec?.staged === 'unit' ? s.rec : { ...instPin(s.inst), staged: 'unit' };
  return { ...pin, staged: s.problem?.staged ?? 'pending', why: s.problem?.why ?? 'missing' };
}

/** The report row of slot `s` (null: the brief pins none), given its object after the call. */
export function reportRowOf(s: SlotUnit, object: string | null, done: boolean): StageUnitRow | null {
  if (!s.pin) return null;
  const holds =
    (done && s.action !== 'none' && s.action !== 'remove') || (!!s.inst && samePin(s.inst, s.pin));
  const row: StageUnitRow = {
    slot: s.key,
    ref: s.pin.ref,
    version: s.pin.version,
    object,
    staged: holds ? 'unit' : 'words',
  };
  if (!holds) {
    const why = s.local
      ? 'local'
      : s.rec?.staged === 'refused' && samePin(s.rec, s.pin)
        ? s.rec.why
        : s.problem?.why;
    row.why = why ?? (s.stageable ? 'missing' : 'not_staged');
  }
  return row;
}

/** A row of the desk state's units (the protocol's StateUnit). */
export interface StateUnitRow {
  slot: string;
  ref: string;
  version: number;
  sha256: string;
  staged: RecordPinStaged;
  /** Staged 'unit', but the slot no longer holds an instance of it (made local). */
  local: boolean;
  why?: string;
}

/**
 * The desk state's `units` (docs/embedding.md "Library units"): one row per slot whose record has a
 * pin, in plain string order of the slot, with `local` for a slot staged 'unit' whose instance of that
 * version is gone. [] for a document not staged from a brief.
 */
export function stateUnitRows(doc: SceneDoc): StateUnitRow[] {
  const r = readBriefRecord(doc);
  if (!r) return [];
  const pins: [string, RecordPin][] = [];
  if (r.setUnit) pins.push(['set', r.setUnit]);
  for (const c of r.cast) if (c.unit) pins.push([slotKey({ castId: c.id }), c.unit]);
  for (const e of r.elements) if (e.unit) pins.push([slotKey({ elementId: e.id }), e.unit]);
  const held = new Set(listUnits(doc).map((i) => `${i.key}\u0000${i.ref}\u0000${i.version}`));
  return pins
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slot, p]) => ({
      slot,
      ref: p.ref,
      version: p.version,
      sha256: p.sha256,
      staged: p.staged,
      local: p.staged === 'unit' && !held.has(`${slot}\u0000${p.ref}\u0000${p.version}`),
      ...(p.staged !== 'unit' && p.why ? { why: p.why } : {}),
    }));
}

/** Whether a document object is the root of an instance (any key). */
export const isInstanceRoot = (doc: SceneDoc, id: string): boolean => readInstance(doc, id) !== null;
