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
import type { SceneDoc } from '@3d-editor/core';

/** Minimal JSON-schema shape produced by zod's toJSONSchema for operator/modifier params. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
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
const ANGLE_KEYS = /angle|rotation|spot_size/;

/**
 * Whether a numeric parameter is an angle (stored in radians, shown in degrees): parameters whose
 * description says radians, otherwise angle-like names, except plain 0..1 factors.
 */
function isAngleParam(key: string, s: JsonSchema, extra?: readonly string[]): boolean {
  if (extra?.includes(key)) return true;
  const d = s.description ?? '';
  if (/radian/i.test(d)) return true;
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
}) {
  const schema = p.schema as JsonSchema;
  const objectKeys = new Set([...OBJECT_REF_KEYS, ...(p.objectKeys ?? [])]);
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
        if (objectKeys.has(key) && p.doc && type === 'string') {
          const objs = p.doc.listObjects();
          return (
            <Row key={key} label={label} title={s.description}>
              <SelectField
                value={(value as string) ?? ''}
                testId={tid}
                title={s.description}
                options={[
                  { value: '', label: '— none —' },
                  ...objs.map((o) => ({ value: o.id, label: o.name })),
                ]}
                onChange={(v) => p.onChange(key, v || null, true)}
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
          return (
            <Row key={key} label={label} title={s.description}>
              <NumberField
                value={Number(value ?? 0)}
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
            return (
              <Row key={key} label={label} title={s.description}>
                <ToggleGroup
                  testId={tid}
                  options={all.map((e) => ({ label: enumText(key, e), value: arr.includes(e) }))}
                  onChange={(i, on) => {
                    const set = new Set(arr.map(String));
                    if (on) set.add(all[i]);
                    else set.delete(all[i]);
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
            return (
              <Row key={key} label={label} title={s.description}>
                <VectorField
                  value={items.map((_, i) => Number(arr[i] ?? 0))}
                  step={isAngle ? 1 : 0.01}
                  unit={p.units?.[key] ?? (isAngle ? '°' : undefined)}
                  {...(isAngle ? RAD : {})}
                  testId={tid}
                  onChange={(v, final) => p.onChange(key, v, final)}
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
