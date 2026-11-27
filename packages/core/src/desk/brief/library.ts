import type { SceneDoc } from '../../doc/scene-doc';
import { newId } from '../../util/id';
import { cloneJson } from '../../util/json';
import { DESK_PROPS } from '../props';
import { RIDEO_PROPS } from '../rideo/import';
import { adoptUnit } from '../units/adopt';
import { UnitError } from '../units/errors';
import type { UnitLinkPlan } from '../units/extract';
import type { UnitHeader } from '../units/format';
import { UNIT_ROOT, parseSlotKey, slotKey, type UnitSlot } from '../units/ids';
import type { UnitPin } from '../units/insert';
import { resolveBriefUnits } from './changes';
import { plannedSun } from './plan';
import { readBriefRecord, setDigest, writeBriefRecord, type RecordPin } from './record';
import type { BriefUnitPin, SceneBrief } from './schema';
import { parseBrief } from './stage';
import {
  UNIT_FACTS_PROP,
  pinKey,
  planInfoOf,
  refusesPin,
  samePin,
  wouldTry,
  type SlotUnit,
  type UnitRefusal,
  type UnitSource,
} from './units';

/*
 * The desk's side of a host's library beyond staging (docs/embedding.md "Library units"):
 *
 * - pinsWanted: the pins of a brief whose unit an Update shots would place, update or replace if it
 *   were held (the desk keeps only those units after an open, for a later update);
 * - pinsRefused: the pins whose unit the desk holds but staging cannot use, not recorded refused yet
 *   (an Update shots records them; until then briefChanges counts them as changes);
 * - adoptPublished: once the host has confirmed a publish (unit-ack), the scene's published objects
 *   become an instance of the new version (adoptUnit: no id changes); when the host linked it to the
 *   brief's slot (`linked`, it pins the version in its next brief), the record says the slot holds it,
 *   so that the next brief, which pins it, changes nothing;
 * - pending publishes: each unit sent to the host from a slot is kept in the document, one record per
 *   save (recordPublish), until the host refuses that save (forgetPublish) or the scene takes a unit
 *   of the slot in, so that a brief pinning one of those very files later (the host linked it after
 *   the desk stopped waiting for its answer) has an update adopt the scene's own objects
 *   (adoptLinkedPublishes) rather than put a copy of them in beside them.
 *
 * Pure core: no DOM, no Node API.
 */

/**
 * The pins of `brief` (validated: INVALID_PARAMS otherwise) whose slot an update of `doc` would
 * place, update or replace if the unit were held: not the ones the scene holds already (the instance
 * is that version), made local, refused at that version, or whose slot is not staged (a cast member
 * in no shot, a location's pin). Each version once, in slot order (the set, the cast, the elements).
 */
export function pinsWanted(doc: SceneDoc, brief: SceneBrief): BriefUnitPin[] {
  const b = parseBrief(brief);
  const units = resolveBriefUnits(doc, b, readBriefRecord(doc), null);
  const out = new Map<string, BriefUnitPin>();
  for (const s of units.all)
    if (s.pin && wouldTry(s) && !out.has(pinKey(s.pin)))
      out.set(pinKey(s.pin), { ref: s.pin.ref, version: s.pin.version, sha256: s.pin.sha256 });
  return [...out.values()];
}

/** A pin whose unit the desk holds but staging cannot use (pinsRefused). */
export interface RefusedPin {
  /** The slot's key: 'set', 'cast:<castId>' or 'el:<elementId>'. */
  slot: string;
  pin: BriefUnitPin;
  why: UnitRefusal;
  message: string;
}

/**
 * The pins of `brief` (validated: INVALID_PARAMS otherwise) whose unit `units` holds (or says why it
 * was left out) but an update of `doc` cannot use, with why: those an Update shots records 'refused'
 * (briefChanges counts them as changes until it has; the record's pin then refuses them, and they are
 * listed no more). In slot order; headers are enough (nothing is decoded).
 */
export function pinsRefused(doc: SceneDoc, brief: SceneBrief, units: UnitSource): RefusedPin[] {
  const b = parseBrief(brief);
  const out: RefusedPin[] = [];
  for (const s of resolveBriefUnits(doc, b, readBriefRecord(doc), units).all)
    if (refusesPin(s) && s.problem?.staged === 'refused')
      out.push({
        slot: s.key,
        pin: { ref: s.pin!.ref, version: s.pin!.version, sha256: s.pin!.sha256 },
        why: s.problem.why,
        message: s.problem.message,
      });
  return out;
}

/** What adoptPublished links. */
export interface AdoptPublishedOptions {
  /** The brief slot the unit was made from (extractUnit's `from`; null: none). */
  slot: UnitSlot | null;
  /** extractUnit's link plan. */
  link: UnitLinkPlan;
  /** The version the host published: its item id, version number and the SHA-256 of the file. */
  pin: UnitPin;
  /** Whether the host linked the version to the slot (the unit-ack's `linked`: it pins the version next). */
  linked: boolean;
  /** The unit's header (extractUnit's): a set's and a prop's planning facts are stamped on its root. */
  header?: UnitHeader;
}

/**
 * Makes the scene's objects published as `o.pin` an instance of it (adoptUnit; see the module
 * comment), in one transaction: inside the caller's own `doc.transact(…, origin)` when it chooses the
 * origin (the desk applies it with its storage origin: not undoable). A set's root is stamped as the
 * scene's set (desk_role 'set', the scene, its ground's name and planning facts from `o.header`), a
 * prop's root with its planning facts. The saves kept for its slot (recordPublish) are let go: the
 * slot holds an instance now (of this file). Only when `o.linked`, `o.slot` names a slot and the document is
 * staged from `brief`'s scene: the record's pin of the slot becomes `o.pin` staged 'unit' (a set's
 * record digest that of a set planned from it), so that the next brief pinning it is no change.
 * Returns the root, adoptUnit's warnings and whether the record was written. Throws adoptUnit's
 * UnitErrors, or INVALID_PARAMS for a brief that does not validate.
 */
export function adoptPublished(
  doc: SceneDoc,
  brief: SceneBrief,
  o: AdoptPublishedOptions,
): { root: string; warnings: string[]; recorded: boolean } {
  const b = parseBrief(brief);
  return doc.transact(() => {
    const r = adoptUnit(doc, o.link, o.pin);
    if (o.slot) forgetSlot(doc, slotKey(o.slot));
    const info = o.header ? planInfoOf(o.header) : null;
    const root = doc.getObject(r.root)!;
    if (o.link.kind === 'set')
      doc.updateObject(r.root, {
        custom_props: {
          ...root.custom_props,
          [DESK_PROPS.role]: 'set',
          [RIDEO_PROPS.clip]: b.id,
          ...(info?.kind === 'set'
            ? { [RIDEO_PROPS.ground]: info.ground, [UNIT_FACTS_PROP]: JSON.stringify(info) }
            : {}),
        },
      });
    else if (o.link.kind === 'prop' && info?.kind === 'prop')
      doc.updateObject(r.root, {
        custom_props: { ...root.custom_props, [UNIT_FACTS_PROP]: JSON.stringify(info) },
      });
    const record = readBriefRecord(doc);
    if (!o.linked || !o.slot || !record || record.sceneId !== b.id) return { ...r, recorded: false };
    const pin: RecordPin = { ref: o.pin.ref, version: o.pin.version, sha256: o.pin.sha256, staged: 'unit' };
    const slot = o.slot;
    let recorded = false;
    if ('set' in slot) {
      record.setUnit = pin;
      record.set = setDigest({ unit: pin, sun: plannedSun(b) });
      recorded = true;
    } else if ('castId' in slot) {
      const c = record.cast.find((x) => x.id === slot.castId);
      if (c) {
        c.unit = pin;
        recorded = true;
      }
    } else {
      const e = record.elements.find((x) => x.id === slot.elementId);
      if (e) {
        e.unit = pin;
        recorded = true;
      }
    }
    if (recorded) writeBriefRecord(doc, record);
    return { ...r, recorded };
  });
}

// ---------------------------------------------------------------- publishes not taken in yet

/**
 * The scene settings keys of the units sent to the host's library and not taken in yet
 * (recordPublish): `unit_publish:<id>`, one per save (its id recordPublish's), each
 * `{slot, sha256, link, seq}`.
 */
export const PUBLISH_KEY_PREFIX = 'unit_publish:';

/**
 * The saves of one slot the document keeps at most: a save past them lets go of the slot's oldest
 * (one whose end the desk does not know waits for a brief, which may never come).
 */
export const MAX_PUBLISHES_PER_SLOT = 8;

/** A unit sent to the host's library from a brief slot (unit-publish) that the scene has not taken in. */
export interface PendingPublish {
  /** The save (recordPublish's id): forgetPublish lets go of it alone. */
  id: string;
  /** The slot it was made from (slotKey). */
  slot: string;
  /** The SHA-256 of the file sent: what a brief pins once the host linked it. */
  sha256: string;
  /** extractUnit's link plan: the scene's objects it was made from. */
  link: UnitLinkPlan;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The saves kept in `doc` with their order (`seq`: later saves have higher ones). */
function readPublishes(doc: SceneDoc): (PendingPublish & { seq: number })[] {
  const out: (PendingPublish & { seq: number })[] = [];
  for (const [key, value] of doc.map('scene').entries()) {
    if (!key.startsWith(PUBLISH_KEY_PREFIX)) continue;
    const id = key.slice(PUBLISH_KEY_PREFIX.length);
    const v = value as { slot?: unknown; sha256?: unknown; link?: unknown; seq?: unknown } | null;
    if (!id || !v || typeof v !== 'object') continue;
    if (typeof v.slot !== 'string' || !parseSlotKey(v.slot)) continue;
    if (typeof v.sha256 !== 'string' || !SHA256.test(v.sha256) || !v.link || typeof v.link !== 'object')
      continue;
    const seq = typeof v.seq === 'number' && Number.isFinite(v.seq) ? v.seq : 0;
    out.push({ id, slot: v.slot, sha256: v.sha256, link: cloneJson(v.link) as UnitLinkPlan, seq });
  }
  return out.sort((a, b) =>
    a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : a.seq !== b.seq ? a.seq - b.seq : a.id < b.id ? -1 : 1,
  );
}

/**
 * The units sent to the host's library and not taken in yet (recordPublish): one per save, by slot
 * key, each slot's in the order they were sent.
 */
export function pendingPublishes(doc: SceneDoc): PendingPublish[] {
  return readPublishes(doc).map(({ id, slot, sha256, link }) => ({ id, slot, sha256, link }));
}

/**
 * Keeps in `doc` the unit sent to the host's library from `slot` (one save: the SHA-256 of its file
 * and extractUnit's link plan) beside those sent from the slot before, until the host refuses that
 * save (forgetPublish) or the scene takes a unit of the slot in (adoptPublished,
 * adoptLinkedPublishes); past MAX_PUBLISHES_PER_SLOT the slot's oldest goes. One transaction (the
 * caller's when inside one: the desk writes it with its storage origin, no undo step). Returns the
 * save's id (a new random one: two saves of the same file are two saves).
 */
export function recordPublish(doc: SceneDoc, slot: UnitSlot, sha256: string, link: UnitLinkPlan): string {
  const key = slotKey(slot);
  const all = readPublishes(doc);
  const seq = all.reduce((m, p) => Math.max(m, p.seq), 0) + 1;
  const mine = all.filter((p) => p.slot === key);
  const id = newId();
  doc.transact(() => {
    const scene = doc.map('scene');
    for (const p of mine.slice(0, Math.max(0, mine.length - MAX_PUBLISHES_PER_SLOT + 1)))
      scene.delete(PUBLISH_KEY_PREFIX + p.id);
    scene.set(PUBLISH_KEY_PREFIX + id, cloneJson({ slot: key, sha256, link, seq }));
  });
  return id;
}

/** Lets go of the save `id` alone (the host refused it, or it could not be sent); nothing when none. */
export function forgetPublish(doc: SceneDoc, id: string): void {
  const key = PUBLISH_KEY_PREFIX + id;
  if (!id || !doc.map('scene').has(key)) return;
  doc.transact(() => doc.map('scene').delete(key));
}

/** Lets go of every save of slot `slot` (slotKey): the scene took a unit of the slot in. */
function forgetSlot(doc: SceneDoc, slot: string): void {
  const gone = readPublishes(doc).filter((p) => p.slot === slot);
  if (!gone.length) return;
  doc.transact(() => {
    for (const p of gone) doc.map('scene').delete(PUBLISH_KEY_PREFIX + p.id);
  });
}

/**
 * Whether the scene still holds the objects of `link`, as slot `s` holds them now: for a set saved
 * from the scene's own pieces (its root to be made), none at the root's id and one piece at least;
 * else its root, which is the slot's instance when the slot holds one.
 */
function objectsLeft(doc: SceneDoc, link: UnitLinkPlan, s: SlotUnit): boolean {
  if (link.synthesizeSetRoot) {
    const root = link.parts[`objects:${UNIT_ROOT}`]?.sceneId;
    if (!root || s.inst || doc.has('objects', root)) return false;
    return Object.entries(link.parts).some(
      ([key, part]) =>
        key.startsWith('objects:') && key !== `objects:${UNIT_ROOT}` && doc.has('objects', part.sceneId),
    );
  }
  const root = link.rootSceneId;
  return !!root && doc.has('objects', root) && (!s.inst || s.inst.root === root);
}

/**
 * Before an update of `doc` (staged from `brief`'s scene) to `brief`: units saved to the host's
 * library from a slot (pendingPublishes), one of which the brief now pins there, that very file,
 * which the host linked after the desk stopped waiting for its answer. Every save of the slot is
 * matched against the pin. Where the update would place, update or replace the slot with that file
 * (it is held: `source`), the scene's objects a save of it was made from (the latest whose objects
 * are still there) become the instance instead, as the host's answer would have made them
 * (adoptPublished, linked: the record pins it), so that no copy of them goes in beside them. When
 * those objects are gone (a set's every piece; any other unit's root, or the slot holds another
 * instance), the update puts the unit in as usual. Either way the slot's saves are let go, and so
 * are those of a slot that holds the pinned version already; saves the brief pins none of yet, or
 * whose file is not here, stay (their end is not known: a later brief may pin one). Inside the
 * caller's transaction (an update's undo step). Staging needs none of it: it starts from an empty
 * document, which holds no publish. Returns the slots adopted and the warnings.
 */
export function adoptLinkedPublishes(
  doc: SceneDoc,
  brief: SceneBrief,
  source: UnitSource | null,
): { adopted: string[]; warnings: string[] } {
  const out = { adopted: [] as string[], warnings: [] as string[] };
  const pending = pendingPublishes(doc);
  if (!pending.length) return out;
  const slots = new Map(
    resolveBriefUnits(doc, brief, readBriefRecord(doc), source).all.map((s) => [s.key, s] as const),
  );
  const bySlot = new Map<string, PendingPublish[]>();
  for (const p of pending) bySlot.set(p.slot, [...(bySlot.get(p.slot) ?? []), p]);
  for (const [key, saves] of bySlot) {
    const s = slots.get(key);
    const pin = s?.pin;
    // the saves of the file the brief pins in the slot, the latest first
    const pinned = pin ? saves.filter((p) => p.sha256 === pin.sha256).reverse() : [];
    if (!s || !pin || !pinned.length) continue;
    if (s.inst && samePin(s.inst, pin)) {
      forgetSlot(doc, key);
      continue;
    }
    if (s.action !== 'place' && s.action !== 'update' && s.action !== 'replace') continue;
    let adopted = false;
    for (const p of pinned) {
      if (!objectsLeft(doc, p.link, s)) continue;
      try {
        const r = adoptPublished(doc, brief, {
          slot: s.slot,
          link: p.link,
          pin,
          linked: true,
          header: s.held!.header,
        });
        out.warnings.push(...r.warnings.map((w) => `${s.name}: ${w}`));
        adopted = true;
        break;
      } catch (err) {
        if (!(err instanceof UnitError)) throw err;
      }
    }
    forgetSlot(doc, key);
    if (adopted) out.adopted.push(s.key);
    else
      out.warnings.push(
        `${s.name}: the objects '${pinned[0].link.name}' was saved to the library from are no longer in the scene: its library unit ${pinKey(pin)} is put in instead`,
      );
  }
  return out;
}
