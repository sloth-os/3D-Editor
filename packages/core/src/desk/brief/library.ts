import type { SceneDoc } from '../../doc/scene-doc';
import { DESK_PROPS } from '../props';
import { RIDEO_PROPS } from '../rideo/import';
import { adoptUnit } from '../units/adopt';
import type { UnitLinkPlan } from '../units/extract';
import type { UnitHeader } from '../units/format';
import type { UnitSlot } from '../units/ids';
import type { UnitPin } from '../units/insert';
import { resolveBriefUnits } from './changes';
import { plannedSun } from './plan';
import { readBriefRecord, setDigest, writeBriefRecord, type RecordPin } from './record';
import type { BriefUnitPin, SceneBrief } from './schema';
import { parseBrief } from './stage';
import { UNIT_FACTS_PROP, pinKey, planInfoOf, wouldTry } from './units';

/*
 * The desk's side of a host's library beyond staging (docs/embedding.md "Library units"):
 *
 * - pinsWanted: the pins of a brief whose unit an Update shots would place, update or replace if it
 *   were held (the desk keeps only those units after an open, for a later update);
 * - adoptPublished: once the host has confirmed a publish (unit-ack), the scene's published objects
 *   become an instance of the new version (adoptUnit: no id changes); when the host linked it to the
 *   brief's slot (`linked`, it pins the version in its next brief), the record says the slot holds it,
 *   so that the next brief, which pins it, changes nothing.
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
 * prop's root with its planning facts. Only when `o.linked`, `o.slot` names a slot and the document
 * is staged from `brief`'s scene: the record's pin of the slot becomes `o.pin` staged 'unit' (a set's
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
