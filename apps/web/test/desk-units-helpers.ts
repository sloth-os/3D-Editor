import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SceneDoc,
  extractUnit,
  sha256Hex,
  stageBrief,
  type BriefUnitPin,
  type SceneBrief,
  type UnitSpec,
} from '@3d-editor/core';
import { UNIT_DATA_FORMAT, UNIT_DATA_VERSION, type OpenUnit } from '../src/embed/protocol';

/*
 * Real library unit files for the desk's tests (desk-units.test.ts, the worker-safety test): units
 * made by core's extractUnit from the contract's example brief staged (open.json: the meadow with its
 * pond, Mira holding the red kite, Pip), their pins, and open.units entries carrying them.
 */

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, 'fixtures/desk-protocol', name), 'utf8'));

/** The contract's example brief (open.json). */
export const exampleBrief = (): SceneBrief => structuredClone(fixture('open.json').scene);

export const MIRA = 'chr_0123456789mira';
export const PIP = 'chr_0123456789pipd';
export const KITE = 'ele_0123456789kite';
export const MEADOW = 'ele_0123456789mead';

const role = (o: { custom_props?: Record<string, unknown> }) => String(o.custom_props?.desk_role ?? '');

/** A document with `brief` staged (no units). */
export function stagedDoc(brief: SceneBrief = exampleBrief()): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  stageBrief(doc, brief);
  return doc;
}

/** A library version: its pin and its file. */
export interface Lib {
  pin: BriefUnitPin;
  data: Uint8Array;
}

/** A version `version` of item `ref` holding the file `data`. */
export const lib = (ref: string, version: number, data: Uint8Array): Lib => ({
  pin: { ref, version, sha256: sha256Hex(data) },
  data,
});

/** The open.units entry of a library version (its file in an ArrayBuffer of its own). */
export const openUnit = (l: Lib, over: Partial<OpenUnit['unit']> = {}): OpenUnit => ({
  ref: l.pin.ref,
  version: l.pin.version,
  sha256: l.pin.sha256,
  unit: { format: UNIT_DATA_FORMAT, version: UNIT_DATA_VERSION, data: l.data.slice().buffer, ...over },
});

export interface Library {
  /** The meadow (the brief's set) as a set unit. */
  set: Lib;
  /** The red kite as a prop unit. */
  kite: Lib;
  /** Mira (a child) as a figure unit. */
  mira: Lib;
  /** Pip (a dog) as a figure unit. */
  pip: Lib;
}

let made: Library | null = null;

/** The units made from the example brief staged (once per test file). */
export function library(): Library {
  if (made) return made;
  const doc = stagedDoc();
  const objects = doc.listObjects();
  const actor = (castId: string) =>
    objects.find((o) => role(o) === 'actor' && o.custom_props?.desk_character_id === castId)!.id;
  const prop = objects.find((o) => role(o) === 'prop' && o.custom_props?.desk_element_id === KITE)!.id;
  const file = (spec: UnitSpec) => {
    const ex = extractUnit(doc, spec, { deskVersion: 'test' });
    ex.probe.destroy();
    return ex.data;
  };
  made = {
    set: lib('lib_0123456789mead', 1, file({ kind: 'set', name: 'Meadow' })),
    kite: lib('lib_0123456789kite', 1, file({ kind: 'prop', root: prop, name: 'Red kite' })),
    mira: lib('lib_0123456789mira', 1, file({ kind: 'figure', actor: actor(MIRA), name: 'Mira' })),
    pip: lib('lib_0123456789pipd', 1, file({ kind: 'figure', actor: actor(PIP), name: 'Pip' })),
  };
  doc.destroy();
  return made;
}

/** `brief` with pins: the set's, and cast members' and elements' by id (null removes one). */
export function withPins(
  brief: SceneBrief,
  pins: { set?: Lib | null; cast?: Record<string, Lib | null>; elements?: Record<string, Lib | null> },
): SceneBrief {
  const b = structuredClone(brief);
  const put = <T extends { unit?: BriefUnitPin }>(x: T, l: Lib | null | undefined) => {
    if (l === undefined) return;
    if (l === null) delete x.unit;
    else x.unit = { ...l.pin };
  };
  put(b.set, pins.set);
  for (const c of b.cast) put(c, pins.cast?.[c.id]);
  for (const e of b.elements) put(e, pins.elements?.[e.id]);
  return b;
}
