import { readFileSync } from 'node:fs';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ObjectData } from '../src/doc/types';
import { stageBrief, type SceneBrief } from '../src/desk/brief';
import { BUILTIN_CATALOG } from '../src/store/catalog';
import {
  decodeUnit,
  encodeUnit,
  extractUnit,
  type UnitBody,
  type UnitExtraction,
  type UnitHeader,
  type UnitHeaderInput,
  type UnitPayload,
  type UnitSpec,
} from '../src/desk/units';

/*
 * Shared by the library unit tests (desk-units-*.test.ts): staged scenes, dressing, extraction and
 * new versions of a unit made by editing its body.
 */

const FIXTURES = new URL('./fixtures/desk-embed/', import.meta.url);

/** The open.json fixture's brief (Mira, a child, holding the red kite; Pip, a dog; the meadow with a pond). */
export const openBrief = (): SceneBrief =>
  structuredClone(JSON.parse(readFileSync(new URL('open.json', FIXTURES), 'utf8')).scene);

export const MIRA = 'chr_0123456789mira';
export const PIP = 'chr_0123456789pipd';
export const KITE = 'ele_0123456789kite';

/** A document with the open.json brief staged. */
export function stagedDoc(brief: SceneBrief = openBrief()): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  stageBrief(doc, brief);
  return doc;
}

export const prop = (o: ObjectData | null | undefined, key: string) => o?.custom_props?.[key];

/** The actor staged for a cast member. */
export function actorOf(doc: SceneDoc, castId: string): ObjectData {
  const a = doc
    .listObjects()
    .find((o) => prop(o, 'desk_role') === 'actor' && prop(o, 'desk_character_id') === castId);
  if (!a) throw new Error(`no actor for ${castId}`);
  return a;
}

/** The prop staged for an element. */
export function propOf(doc: SceneDoc, elementId: string): ObjectData {
  const p = doc
    .listObjects()
    .find((o) => prop(o, 'desk_role') === 'prop' && prop(o, 'desk_element_id') === elementId);
  if (!p) throw new Error(`no prop for ${elementId}`);
  return p;
}

/** Built-in models placed as set dressing (no desk role): the root ids. */
export function dress(
  doc: SceneDoc,
  picks: [string, number, number][] = [
    ['oak_tree', -14, 9],
    ['park_bench', 4, 6],
    ['house', 0, 22],
  ],
): string[] {
  return picks.map(([id, x, y]) => {
    const entry = BUILTIN_CATALOG.find((e) => e.id === id);
    if (!entry) throw new Error(`no built-in model ${id}`);
    return entry.build(doc, { location: [x, y, 0] }).root;
  });
}

/** A unit made from the scene, and the decoded payload of its file. */
export function unitFrom(doc: SceneDoc, spec: UnitSpec): { ex: UnitExtraction; unit: UnitPayload } {
  const ex = extractUnit(doc, spec, { deskVersion: 'test' });
  return { ex, unit: decodeUnit(ex.data) };
}

/** The header encodeUnit takes, from a header it wrote. */
export function headerInput(h: UnitHeader): UnitHeaderInput {
  const { format: _f, version: _v, digest: _d, bodyBytes: _b, ...rest } = h;
  return structuredClone(rest);
}

/** A new version of a unit: its body cloned and changed by `edit`, encoded and decoded again. */
export function editedUnit(unit: UnitPayload, edit: (body: UnitBody) => void): UnitPayload {
  const body = structuredClone(unit.body);
  edit(body);
  return decodeUnit(encodeUnit(body, headerInput(unit.header)));
}

/** A pin for tests. */
export const pin = (version = 1, sha = 'a'.repeat(64), ref = 'lib_0123456789test') => ({
  ref,
  version,
  sha256: sha,
});
