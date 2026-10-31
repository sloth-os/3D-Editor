import { Checkbox, NumberField, Row, SelectField, TextField, VectorField, RAD } from './fields/fields';
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
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

const OBJECT_REF_KEYS = new Set(['object', 'mirror_object', 'offset_object', 'target', 'operand_object']);
const ANGLE_KEYS = /angle|rotation|spot_size/;

function humanize(k: string): string {
  return k.replace(/^use_/, '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function unwrap(s: JsonSchema): JsonSchema {
  const alt = s.anyOf ?? s.oneOf;
  if (alt) {
    const nonNull = alt.find((a) => a.type !== 'null');
    if (nonNull) return { ...nonNull, default: s.default ?? nonNull.default, description: s.description ?? nonNull.description };
  }
  return s;
}

/**
 * Renders editable fields for a JSON schema (numbers, integers, booleans, enums, fixed-length
 * number tuples and object references). Used by the modifier stack and the redo panel.
 */
export function SchemaForm(p: {
  schema: unknown;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown, final: boolean) => void;
  doc?: SceneDoc;
  exclude?: string[];
  testIdPrefix?: string;
}) {
  const schema = p.schema as JsonSchema;
  const props = schema?.properties ?? {};
  const rows = Object.entries(props).filter(([k]) => !p.exclude?.includes(k));
  return (
    <>
      {rows.map(([key, raw]) => {
        const s = unwrap(raw);
        const value = p.values[key] ?? s.default;
        const label = humanize(key);
        const tid = p.testIdPrefix ? `${p.testIdPrefix}-${key}` : undefined;
        if (OBJECT_REF_KEYS.has(key) && p.doc) {
          const objs = p.doc.listObjects();
          return (
            <Row key={key} label={label}>
              <SelectField
                value={(value as string) ?? ''}
                testId={tid}
                options={[{ value: '', label: '— none —' }, ...objs.map((o) => ({ value: o.id, label: o.name }))]}
                onChange={(v) => p.onChange(key, v || null, true)}
              />
            </Row>
          );
        }
        if (s.enum) {
          return (
            <Row key={key} label={label}>
              <SelectField
                value={String(value ?? s.enum[0])}
                testId={tid}
                options={s.enum.map((e) => ({ value: String(e), label: humanize(String(e).toLowerCase()) }))}
                onChange={(v) => p.onChange(key, v, true)}
              />
            </Row>
          );
        }
        const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
        if (type === 'boolean') {
          return (
            <Row key={key} label="">
              <Checkbox value={!!value} label={label} testId={tid} onChange={(v) => p.onChange(key, v, true)} />
            </Row>
          );
        }
        if (type === 'number' || type === 'integer') {
          const isAngle = ANGLE_KEYS.test(key);
          return (
            <Row key={key} label={label}>
              <NumberField
                value={Number(value ?? 0)}
                integer={type === 'integer'}
                min={s.minimum ?? s.exclusiveMinimum}
                max={s.maximum}
                slider={s.minimum !== undefined && s.maximum !== undefined && s.maximum - s.minimum <= 10}
                step={type === 'integer' ? 1 : isAngle ? 1 : 0.01}
                unit={isAngle ? '°' : undefined}
                {...(isAngle ? RAD : {})}
                testId={tid}
                title={s.description}
                onChange={(v, final) => p.onChange(key, v, final)}
              />
            </Row>
          );
        }
        if (type === 'array') {
          const items = s.prefixItems ?? (Array.isArray(s.items) ? s.items : null);
          const arr = Array.isArray(value) ? (value as unknown[]) : [];
          if (items && items.every((i) => unwrap(i).type === 'boolean')) {
            return (
              <Row key={key} label={label}>
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
            const isAngle = ANGLE_KEYS.test(key);
            return (
              <Row key={key} label={label}>
                <VectorField
                  value={items.map((_, i) => Number(arr[i] ?? 0))}
                  step={isAngle ? 1 : 0.01}
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
            <Row key={key} label={label}>
              <TextField value={String(value ?? '')} testId={tid} onChange={(v) => p.onChange(key, v, true)} />
            </Row>
          );
        }
        return null;
      })}
    </>
  );
}
