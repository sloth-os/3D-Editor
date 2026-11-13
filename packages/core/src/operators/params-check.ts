import type { z } from 'zod';

/*
 * Unknown-parameter detection for operator parameters.
 *
 * Operator schemas are zod objects in "strip" mode, so a misspelled or unsupported key used to be
 * dropped silently and the operator ran with the default value instead (`raduis: 3` gave a radius-1
 * cylinder). The registry now rejects such keys; this module finds them (at the top level and inside
 * nested parameter objects such as curve points or driver variables) and builds an error message
 * with did-you-mean suggestions and the list of valid names, which AI agents rely on.
 */

/** A key that the schema does not declare at `at` ('' = top level, else e.g. 'points[2]'). */
export interface UnknownParam {
  at: string;
  key: string;
  /** Keys accepted at that place. */
  valid: string[];
}

type Def = { type: string } & Record<string, unknown>;
type Schema = z.ZodType;

function defOf(s: unknown): Def | null {
  const def = (s as { _zod?: { def?: Def } } | null | undefined)?._zod?.def;
  return def && typeof def.type === 'string' ? def : null;
}

const WRAPPERS = new Set(['optional', 'default', 'nullable', 'readonly', 'catch', 'prefault', 'nonoptional']);

/**
 * Follows wrappers (optional, default, nullable, lazy …) and validation pipes to the schema that
 * receives the input value. Returns null when the input is pre-processed (z.preprocess), because
 * the accepted keys are then unknowable.
 */
function unwrap(schema: unknown): Schema | null {
  let s = schema;
  for (let guard = 0; guard < 64; guard++) {
    const def = defOf(s);
    if (!def) return null;
    if (WRAPPERS.has(def.type)) s = def.innerType;
    else if (def.type === 'lazy') s = (def.getter as () => unknown)();
    else if (def.type === 'pipe') {
      if (defOf(def.in)?.type === 'transform') return null;
      s = def.in;
    } else return s as Schema;
  }
  return null;
}

/** Declared keys of an object schema; null when it accepts any key (passthrough / catchall). */
function objectKeys(def: Def): string[] | null {
  const catchall = defOf(def.catchall);
  if (catchall && catchall.type !== 'never') return null;
  return Object.keys((def.shape as Record<string, unknown>) ?? {});
}

/**
 * Top-level parameter names an operator schema accepts, or null when it accepts any key (or the
 * schema is not an object, e.g. a pre-processed input).
 */
export function schemaParamNames(schema: Schema): string[] | null {
  const s = unwrap(schema);
  const def = defOf(s);
  if (!def || def.type !== 'object') return null;
  return objectKeys(def);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Whether values of this schema can contain objects whose keys need checking (memoised). */
const checkable = new WeakMap<object, boolean>();
function needsCheck(schema: unknown, depth = 0): boolean {
  const s = unwrap(schema);
  if (!s || depth > 32) return false;
  const cached = checkable.get(s);
  if (cached !== undefined) return cached;
  checkable.set(s, false); // recursion guard for lazy schemas
  const def = defOf(s)!;
  const r = ((): boolean => {
    switch (def.type) {
      case 'object':
        return true;
      case 'array':
        return needsCheck(def.element, depth + 1);
      case 'tuple':
        return (
          (def.items as unknown[]).some((it) => needsCheck(it, depth + 1)) ||
          (!!def.rest && needsCheck(def.rest, depth + 1))
        );
      case 'record':
        return needsCheck(def.valueType, depth + 1);
      case 'union':
        return (def.options as unknown[]).some((o) => needsCheck(o, depth + 1));
      default:
        return false;
    }
  })();
  checkable.set(s, r);
  return r;
}

function walk(schema: unknown, value: unknown, at: string, out: UnknownParam[], depth: number): void {
  if (depth > 32 || value === undefined || value === null) return;
  const s = unwrap(schema);
  if (!s || !needsCheck(s)) return;
  const def = defOf(s)!;
  switch (def.type) {
    case 'object': {
      if (!isPlainObject(value)) return;
      const shape = (def.shape as Record<string, unknown>) ?? {};
      const keys = objectKeys(def);
      for (const [k, v] of Object.entries(value)) {
        // `undefined` means "not given" for JavaScript callers (JSON cannot carry it)
        if (v === undefined) continue;
        if (Object.prototype.hasOwnProperty.call(shape, k))
          walk(shape[k], v, at ? `${at}.${k}` : k, out, depth + 1);
        else if (keys) out.push({ at, key: k, valid: keys });
      }
      return;
    }
    case 'array':
      if (Array.isArray(value)) value.forEach((v, i) => walk(def.element, v, `${at}[${i}]`, out, depth + 1));
      return;
    case 'tuple': {
      if (!Array.isArray(value)) return;
      const items = def.items as unknown[];
      value.forEach((v, i) => walk(i < items.length ? items[i] : def.rest, v, `${at}[${i}]`, out, depth + 1));
      return;
    }
    case 'record':
      if (isPlainObject(value))
        for (const [k, v] of Object.entries(value))
          walk(def.valueType, v, at ? `${at}.${k}` : k, out, depth + 1);
      return;
    case 'union': {
      // zod uses the first option that accepts the value: check the keys against that one
      for (const option of def.options as Schema[]) {
        if (option.safeParse(value).success) {
          walk(option, value, at, out, depth + 1);
          return;
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Keys of `params` (recursively) that the schema does not declare. */
export function findUnknownParams(schema: Schema, params: unknown): UnknownParam[] {
  const out: UnknownParam[] = [];
  walk(schema, params ?? {}, '', out, 0);
  return out;
}

/** Optimal-string-alignment distance (Levenshtein plus adjacent transpositions). */
function osaDistance(a: string, b: string): number {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
    }
  return d[n][m];
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Names that mean the same thing in different operators (e.g. the material slot is `slot` in
 * object.material_assign but `index` in object.material_slot_assign), suggested when present.
 */
const SYNONYMS: Record<string, string[]> = {
  slot: ['index', 'material_index', 'slot_index'],
  index: ['slot', 'material_index'],
  material_index: ['slot', 'index'],
  object: ['target', 'objects'],
  objects: ['object', 'targets'],
  target: ['object', 'objects'],
  targets: ['objects'],
  count: ['number', 'number_cuts', 'vertices', 'segments'],
  number: ['count', 'number_cuts'],
  segments: ['vertices', 'resolution', 'resolution_u'],
  vertices: ['segments'],
  resolution: ['resolution_u', 'segments'],
  size: ['scale', 'dimensions', 'radius'],
  dimensions: ['size', 'scale'],
  radius: ['size', 'shadow_soft_size'],
  scale: ['size', 'factor'],
  rotation: ['rotation_euler'],
  rotation_euler: ['rotation'],
  location: ['offset', 'center'],
  color: ['base_color'],
  base_color: ['color'],
  strength: ['energy', 'factor', 'influence'],
  energy: ['strength', 'power'],
  power: ['energy'],
  amount: ['offset', 'width', 'thickness', 'factor'],
  thickness: ['width', 'offset'],
  angle: ['spot_size', 'rotation'],
  cone_angle: ['spot_size'],
  focal_length: ['lens'],
  fov: ['lens'],
  distance: ['dof_focus_distance', 'focus_distance'],
};

/** Up to `max` names from `candidates` that `key` was probably meant to be (best first). */
export function suggestNames(key: string, candidates: readonly string[], max = 3): string[] {
  const k = normalize(key);
  if (!k) return [];
  const synonyms = new Set(SYNONYMS[key.toLowerCase()] ?? []);
  const scored: { name: string; score: number }[] = [];
  for (const name of candidates) {
    const c = normalize(name);
    if (!c) continue;
    const d = osaDistance(k, c);
    let prefix = 0;
    while (prefix < k.length && prefix < c.length && k[prefix] === c[prefix]) prefix++;
    const shorter = Math.min(k.length, c.length);
    const limit = k.length <= 4 ? 1 : k.length <= 7 ? 2 : 3;
    let score = Infinity;
    if (d <= limit) score = d;
    else if (synonyms.has(name)) score = limit + 0.25;
    else if (shorter >= 3 && (c.includes(k) || k.includes(c))) score = limit + 0.5;
    else if (prefix >= 4 && d <= Math.ceil(Math.max(k.length, c.length) / 2)) score = limit + 1;
    if (score < Infinity) scored.push({ name, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((s) => s.name);
}

const quote = (s: string) => `'${s}'`;

/**
 * Human (and agent) readable description of unknown parameters, e.g.
 * "unknown parameter 'raduis' (did you mean 'radius'?). Valid parameters: vertices, radius, …".
 */
export function describeUnknownParams(unknown: readonly UnknownParam[]): string {
  // group by place, folding array indices so 100 points with the same typo give one entry
  const groups = new Map<string, { paths: string[]; keys: string[]; valid: string[] }>();
  for (const u of unknown) {
    const place = u.at.replace(/\[\d+\]/g, '[i]');
    let g = groups.get(place);
    if (!g) groups.set(place, (g = { paths: [], keys: [], valid: u.valid }));
    if (!g.paths.includes(u.at)) g.paths.push(u.at);
    if (!g.keys.includes(u.key)) g.keys.push(u.key);
  }
  const parts: string[] = [];
  for (const [place, g] of groups) {
    const items = g.keys.map((key) => {
      const s = suggestNames(key, g.valid);
      return s.length ? `${quote(key)} (did you mean ${s.map(quote).join(' or ')}?)` : quote(key);
    });
    const plural = g.keys.length > 1 ? 's' : '';
    const validText = g.valid.length ? g.valid.join(', ') : '(none)';
    if (!place) parts.push(`unknown parameter${plural} ${items.join(', ')}. Valid parameters: ${validText}`);
    else {
      const where =
        g.paths.length === 1 ? g.paths[0] : `${place} (${g.paths.length} entries, e.g. ${g.paths[0]})`;
      parts.push(`unknown key${plural} ${items.join(', ')} in ${where}. Valid keys there: ${validText}`);
    }
  }
  return parts.join('. ');
}

/**
 * Marks every object schema in a generated (input-mode) JSON schema with `additionalProperties:
 * false`, matching the registry, which rejects undeclared keys. Objects that accept any key
 * (records, passthrough objects) already carry an `additionalProperties` entry and are left alone.
 */
export function closeJsonSchemaObjects(json: unknown, depth = 0): unknown {
  if (depth > 64 || json === null || typeof json !== 'object') return json;
  if (Array.isArray(json)) {
    for (const item of json) closeJsonSchemaObjects(item, depth + 1);
    return json;
  }
  const node = json as Record<string, unknown>;
  if (
    node.type === 'object' &&
    node.properties &&
    typeof node.properties === 'object' &&
    !('additionalProperties' in node)
  )
    node.additionalProperties = false;
  for (const v of Object.values(node)) if (v && typeof v === 'object') closeJsonSchemaObjects(v, depth + 1);
  return json;
}

/**
 * Extra guidance for common mistakes: passing `objects`/`object` to an operator that acts on the
 * selection, or `frame` to one that uses the current frame.
 */
export function unknownParamHints(unknown: readonly UnknownParam[]): string[] {
  const top = new Set(unknown.filter((u) => !u.at).map((u) => u.key));
  const valid = new Set(unknown.find((u) => !u.at)?.valid ?? []);
  const hints: string[] = [];
  const objectKeys = ['objects', 'object', 'selected_objects', 'targets'];
  if (objectKeys.some((k) => top.has(k)) && !objectKeys.some((k) => valid.has(k)))
    hints.push(
      'This operator acts on the selected objects (and the active object): select them first with ' +
        'object.select {objects: [...]}, or pass `selection: {objects: [...]}` to the MCP run_operator tool',
    );
  if (top.has('frame') && !valid.has('frame'))
    hints.push('This operator works at the current frame: set it first with scene.frame_set {frame}');
  return hints;
}
