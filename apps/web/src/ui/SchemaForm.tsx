import {
  Checkbox,
  EnumButtons,
  NumberField,
  Row,
  SelectField,
  TextField,
  ToggleGroup,
  VectorField,
  RAD,
} from './fields/fields';
import type { ObjectData, SceneDoc } from '@3d-editor/core';
import { session } from '../app/store';

/** Minimal JSON-schema shape produced by zod's toJSONSchema for operator/modifier params. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  /** Parameters without a default that must be given. */
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  description?: string;
  items?: JsonSchema | JsonSchema[] | false;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

/** String parameters that hold an object id or name (rendered as object pickers). */
const OBJECT_REF_KEYS = new Set([
  'object',
  'mirror_object',
  'offset_object',
  'target',
  'operand_object',
  'camera',
  'bevel_object',
  'instance_object',
  'surface',
]);
/** Object types an object-reference parameter accepts, by name (others accept any object). */
const OBJECT_REF_TYPES: Record<string, readonly string[]> = {
  camera: ['CAMERA'],
  surface: ['MESH', 'CURVE', 'FONT'],
  bevel_object: ['CURVE'],
};
const ANGLE_KEYS = /angle|rotation|spot_size/;

/**
 * Whether a numeric parameter is an angle (stored in radians, shown in degrees): parameters whose
 * description gives radians as their unit, otherwise angle-like names, except plain 0..1 factors.
 * Descriptions listing several units ("in the units of the property (metres, radians, …)") are
 * not angles.
 */
function isAngleParam(key: string, s: JsonSchema, extra?: readonly string[]): boolean {
  if (extra?.includes(key)) return true;
  const d = s.description ?? '';
  if (/radian/i.test(d) && !/metre|meter/i.test(d)) return true;
  if (/degree/i.test(d)) return false;
  if (s.minimum !== undefined && s.maximum !== undefined && s.minimum >= 0 && s.maximum <= 1) return false;
  return ANGLE_KEYS.test(key);
}

function typeOf(s: JsonSchema): string | undefined {
  return Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
}

function isNullable(raw: JsonSchema): boolean {
  if (Array.isArray(raw.type) && raw.type.includes('null')) return true;
  return !!(raw.anyOf ?? raw.oneOf)?.some((a) => a.type === 'null');
}

function humanize(k: string): string {
  return k
    .replace(/^use_/, '')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}

function unwrap(s: JsonSchema): JsonSchema {
  const alt = s.anyOf ?? s.oneOf;
  if (alt) {
    const nonNull = alt.find((a) => a.type !== 'null');
    if (nonNull)
      return {
        ...nonNull,
        default: s.default ?? nonNull.default,
        description: s.description ?? nonNull.description,
      };
  }
  return s;
}

/**
 * The value an operator uses for an optional vector parameter that was left unset, when it is
 * known: a literal default in the description ("default [1, 1, 1]"), the 3D cursor ("default:
 * the 3D cursor"), otherwise the identity `scale` and `rotation` of the add operators (Blender's
 * location / rotation / scale convention). Null when the operator computes it or keeps a current
 * value (e.g. an orbit centre fitted to the scene, `rotation_euler` of a "set" operator).
 */
function implicitVector(key: string, s: JsonSchema, length: number): number[] | null {
  const d = s.description ?? '';
  const literal = /default:?\s*\[([^\]]*)\]/i.exec(d);
  if (literal) {
    const nums = literal[1].split(',').map((x) => Number(x.trim()));
    if (nums.length === length && nums.every(Number.isFinite)) return nums;
  }
  if (/3D cursor/i.test(d)) {
    const cursor = session.value?.state.cursorLocation;
    if (cursor?.length === length) return [...cursor];
  }
  if (key === 'scale') return Array.from({ length }, () => 1);
  if (key === 'rotation') return Array.from({ length }, () => 0);
  return null;
}

/** A fixed choice of a {@link SchemaForm} dropdown ('' stands for none / null). */
export interface SchemaChoice {
  value: string;
  label: string;
}

/**
 * Renders editable fields for a JSON schema (numbers, integers, booleans, enums, enum sets,
 * fixed-length number tuples and object references). Used by the modifier stack, the redo panel
 * and the object property tabs.
 */
export function SchemaForm(p: {
  schema: unknown;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown, final: boolean) => void;
  doc?: SceneDoc;
  exclude?: string[];
  testIdPrefix?: string;
  /** Parameter names holding object references (rendered as object pickers). */
  objectKeys?: string[];
  /** Only these parameters, in this order (default: every parameter of the schema). */
  only?: string[];
  /** Display labels overriding the humanized parameter names. */
  labels?: Record<string, string>;
  /** Unit suffixes of numeric parameters, e.g. `{ mass: ' kg' }`. */
  units?: Record<string, string>;
  /** Extra numeric parameters stored in radians and shown in degrees. */
  angleKeys?: string[];
  /** Fixed choices per parameter (pickers for collections, vertex groups, bones, filtered objects). */
  choices?: Record<string, SchemaChoice[]>;
  /** Enum parameters shown as a row of buttons instead of a dropdown. */
  expandEnums?: string[];
  /** Display label of an enum value (default: the humanized identifier). */
  enumLabel?: (key: string, value: string) => string | undefined;
  /**
   * Whether an object picker lists `object` for the parameter `key` (default: every object of a
   * fitting type), e.g. to leave out objects the operator would reject for it.
   */
  objectFilter?: (key: string, object: ObjectData) => boolean;
  /**
   * Label of the empty choice of an optional object picker (default "— none —"): what the operator
   * uses when the parameter is left unset, e.g. "This armature" for a bone target.
   */
  emptyLabels?: Record<string, string>;
}) {
  const schema = p.schema as JsonSchema;
  const objectKeys = new Set([...OBJECT_REF_KEYS, ...(p.objectKeys ?? [])]);
  const required = new Set(schema?.required ?? []);
  const props = schema?.properties ?? {};
  const keys = p.only ? p.only.filter((k) => k in props) : Object.keys(props);
  const rows = keys.filter((k) => !p.exclude?.includes(k)).map((k) => [k, props[k]] as const);
  const enumText = (key: string, e: unknown) =>
    p.enumLabel?.(key, String(e)) ?? humanize(String(e).toLowerCase());
  return (
    <>
      {rows.map(([key, raw]) => {
        const s = unwrap(raw);
        const value = p.values[key] ?? s.default;
        const label = p.labels?.[key] ?? humanize(key);
        const tid = p.testIdPrefix ? `${p.testIdPrefix}-${key}` : undefined;
        const type = typeOf(s);
        const choices = p.choices?.[key];
        if (choices) {
          const current = value === null || value === undefined ? '' : String(value);
          const known = choices.some((c) => c.value === current);
          return (
            <Row key={key} label={label} title={s.description}>
              <SelectField
                value={current}
                testId={tid}
                title={s.description}
                options={known ? choices : [...choices, { value: current, label: `${current} (missing)` }]}
                onChange={(v) => p.onChange(key, v === '' && isNullable(raw) ? null : v, true)}
              />
            </Row>
          );
        }
        if (s.enum) {
          const options = s.enum.map((e) => ({ value: String(e), label: enumText(key, e) }));
          return (
            <Row key={key} label={label} title={s.description}>
              {p.expandEnums?.includes(key) ? (
                <EnumButtons
                  value={String(value ?? s.enum[0])}
                  testId={tid}
                  title={s.description}
                  compact
                  options={options}
                  onChange={(v) => p.onChange(key, v, true)}
                />
              ) : (
                <SelectField
                  value={String(value ?? s.enum[0])}
                  testId={tid}
                  title={s.description}
                  options={options}
                  onChange={(v) => p.onChange(key, v, true)}
                />
              )}
            </Row>
          );
        }
        if (objectKeys.has(key) && p.doc && type === 'string') {
          const types = OBJECT_REF_TYPES[key];
          const objs = p.doc
            .listObjects()
            .filter((o) => (!types || types.includes(o.type)) && (p.objectFilter?.(key, o) ?? true));
          const stored = typeof value === 'string' ? value : '';
          // operators accept object ids or names: a name shows as its object
          const match = objs.find((o) => o.id === stored) ?? objs.find((o) => o.name === stored);
          const other = stored && !match ? p.doc.resolveObject(stored) : null;
          const nullable = isNullable(raw);
          const optional = nullable || !required.has(key);
          const selected = match?.id ?? stored;
          return (
            <Row key={key} label={label} title={s.description}>
              <SelectField
                value={selected}
                testId={tid}
                title={s.description}
                options={[
                  ...(optional || !selected
                    ? [{ value: '', label: optional ? (p.emptyLabels?.[key] ?? '— none —') : '— choose —' }]
                    : []),
                  ...objs.map((o) => ({ value: o.id, label: o.name })),
                  ...(stored && !match
                    ? [{ value: stored, label: other ? `${other.name} (invalid)` : `${stored} (missing)` }]
                    : []),
                ]}
                onChange={(v) => {
                  if (v) p.onChange(key, v, true);
                  // cleared: null where the schema allows it, otherwise left out (the operator's default)
                  else if (optional) p.onChange(key, nullable ? null : undefined, true);
                }}
              />
            </Row>
          );
        }
        if (type === 'boolean') {
          return (
            <Row key={key} label="" title={s.description}>
              <Checkbox
                value={!!value}
                label={label}
                testId={tid}
                onChange={(v) => p.onChange(key, v, true)}
              />
            </Row>
          );
        }
        if (type === 'number' || type === 'integer') {
          const isAngle = isAngleParam(key, s, p.angleKeys);
          // an optional parameter without default that was left out is computed by the operator
          const unset = value === undefined || value === null;
          return (
            <Row key={key} label={label} title={s.description}>
              <NumberField
                value={unset ? NaN : Number(value)}
                placeholder={unset ? 'Auto' : undefined}
                integer={type === 'integer'}
                min={s.minimum ?? s.exclusiveMinimum}
                max={s.maximum}
                slider={s.minimum !== undefined && s.maximum !== undefined && s.maximum - s.minimum <= 10}
                step={type === 'integer' ? 1 : isAngle ? 1 : 0.01}
                unit={p.units?.[key] ?? (isAngle ? '°' : undefined)}
                {...(isAngle ? RAD : {})}
                testId={tid}
                title={s.description}
                onChange={(v, final) => p.onChange(key, v, final)}
              />
            </Row>
          );
        }
        if (type === 'array') {
          const arr = Array.isArray(value) ? (value as unknown[]) : [];
          const single = s.items && !Array.isArray(s.items) ? unwrap(s.items) : null;
          if (single?.enum) {
            // a set of enum values (e.g. axes ['X', 'Z']): one toggle per value
            const all = single.enum.map(String);
            const min = s.minItems ?? 0;
            const atMin = arr.length <= min;
            return (
              <Row key={key} label={label} title={s.description}>
                <ToggleGroup
                  testId={tid}
                  options={all.map((e) => {
                    const on = arr.map(String).includes(e);
                    return {
                      label: enumText(key, e),
                      value: on,
                      title:
                        on && atMin ? `At least ${min} value${min === 1 ? '' : 's'} required` : undefined,
                    };
                  })}
                  onChange={(i, on) => {
                    const set = new Set(arr.map(String));
                    if (on) set.add(all[i]);
                    else set.delete(all[i]);
                    // the operator rejects fewer values than the schema's minimum
                    if (set.size < min) return;
                    p.onChange(
                      key,
                      all.filter((e) => set.has(e)),
                      true,
                    );
                  }}
                />
              </Row>
            );
          }
          const fixed =
            single && s.minItems !== undefined && s.minItems === s.maxItems && s.minItems <= 4
              ? Array.from({ length: s.minItems }, () => single)
              : null;
          const items = s.prefixItems ?? (Array.isArray(s.items) ? s.items : fixed);
          if (items && items.every((i) => unwrap(i).type === 'boolean')) {
            return (
              <Row key={key} label={label} title={s.description}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {items.map((_, i) => (
                    <Checkbox
                      key={i}
                      value={!!arr[i]}
                      label={'XYZW'[i]}
                      onChange={(v) => {
                        const next = items.map((__, j) => !!arr[j]);
                        next[i] = v;
                        p.onChange(key, next, true);
                      }}
                    />
                  ))}
                </div>
              </Row>
            );
          }
          if (items && items.every((i) => ['number', 'integer'].includes(String(unwrap(i).type)))) {
            const isAngle = isAngleParam(key, s, p.angleKeys);
            // an optional vector left unset shows what the operator uses instead ('Auto' when the
            // operator computes it); editing one component keeps the shown values of the others
            const shown = Array.isArray(value)
              ? items.map((_, i) => Number(arr[i] ?? 0))
              : (implicitVector(key, s, items.length) ?? items.map(() => NaN));
            return (
              <Row key={key} label={label} title={s.description}>
                <VectorField
                  value={shown}
                  placeholder="Auto"
                  step={isAngle ? 1 : 0.01}
                  unit={p.units?.[key] ?? (isAngle ? '°' : undefined)}
                  {...(isAngle ? RAD : {})}
                  testId={tid}
                  onChange={(v, final) =>
                    p.onChange(
                      key,
                      v.map((x) => (Number.isFinite(x) ? x : 0)),
                      final,
                    )
                  }
                />
              </Row>
            );
          }
          return null;
        }
        if (type === 'string') {
          return (
            <Row key={key} label={label} title={s.description}>
              <TextField
                value={String(value ?? '')}
                testId={tid}
                onChange={(v) => p.onChange(key, v, true)}
              />
            </Row>
          );
        }
        return null;
      })}
    </>
  );
}
