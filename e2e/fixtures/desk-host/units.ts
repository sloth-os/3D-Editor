import { createHash } from 'node:crypto';
import { SceneDoc, extractUnit, stageBrief, type SceneBrief, type UnitSpec } from '@3d-editor/core';

/*
 * Real library unit files for the desk's end-to-end tests (e2e/tests/desk-library.spec.ts), made by
 * core in Node as a host's library would hold them: a brief staged, then its set, a prop and a cast
 * member's figure extracted (core extractUnit), each the version of an item of the host's library,
 * and the pins and `open.units` entries ({"$bytes"} data, as the fake host takes them) that carry
 * them.
 */

/** A version of a library item: its pin and its file. */
export interface LibraryUnit {
  ref: string;
  version: number;
  /** The SHA-256 of the file (64 lowercase hex digits). */
  sha256: string;
  data: Uint8Array;
  /** The unit's name (its header's). */
  name: string;
}

export interface Library {
  set: LibraryUnit;
  prop: LibraryUnit;
  figure: LibraryUnit;
}

const role = (o: { custom_props?: Record<string, unknown> }) => String(o.custom_props?.desk_role ?? '');

/**
 * The units of `brief` staged: its set (named `names.set`), the prop of element `ids.prop` and the
 * figure of cast member `ids.figure`, each version 1 of an item of its own.
 */
export function makeLibrary(
  brief: SceneBrief,
  ids: { figure: string; prop: string },
  names: { set: string; prop: string; figure: string },
): Library {
  const doc = SceneDoc.create({ empty: true });
  stageBrief(doc, brief);
  const objects = doc.listObjects();
  const actor = objects.find((o) => role(o) === 'actor' && o.custom_props?.desk_character_id === ids.figure);
  const prop = objects.find((o) => role(o) === 'prop' && o.custom_props?.desk_element_id === ids.prop);
  if (!actor || !prop) throw new Error('the brief stages no such actor or prop');
  const unit = (ref: string, spec: UnitSpec): LibraryUnit => {
    const ex = extractUnit(doc, spec, { deskVersion: 'e2e' });
    ex.probe.destroy();
    const sha256 = createHash('sha256').update(ex.data).digest('hex');
    if (sha256 !== ex.sha256) throw new Error('core and Node disagree on the SHA-256 of a unit');
    return { ref, version: 1, sha256, data: ex.data, name: ex.header.name };
  };
  const library = {
    set: unit('lib_e2e_set_meadow', { kind: 'set', name: names.set }),
    prop: unit('lib_e2e_prop_kite', { kind: 'prop', root: prop.id, name: names.prop }),
    figure: unit('lib_e2e_figure_mira', { kind: 'figure', actor: actor.id, name: names.figure }),
  };
  doc.destroy();
  return library;
}

/** A unit's pin, as a brief carries it. */
export const pinOf = (u: LibraryUnit) => ({ ref: u.ref, version: u.version, sha256: u.sha256 });

/** The `open.units` entry of a unit, its file as {"$bytes"} (the fake host revives and transfers it). */
export const openEntry = (u: LibraryUnit) => ({
  ref: u.ref,
  version: u.version,
  sha256: u.sha256,
  unit: {
    format: '3d-editor.desk-unit',
    version: 1,
    data: { $bytes: Buffer.from(u.data).toString('base64') },
  },
});

/** `brief` with the set's, cast members' and elements' pins (by id). */
export function withPins(
  brief: SceneBrief,
  pins: { set?: LibraryUnit; cast?: Record<string, LibraryUnit>; elements?: Record<string, LibraryUnit> },
): SceneBrief {
  const b = structuredClone(brief);
  if (pins.set) b.set = { ...b.set, unit: pinOf(pins.set) };
  for (const c of b.cast) if (pins.cast?.[c.id]) c.unit = pinOf(pins.cast[c.id]);
  for (const e of b.elements) if (pins.elements?.[e.id]) e.unit = pinOf(pins.elements[e.id]);
  return b;
}
