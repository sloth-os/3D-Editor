import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Icon } from '../icons';

function fmt(v: number, precision: number, unit?: string): string {
  if (!Number.isFinite(v)) return String(v);
  let s = v.toFixed(precision);
  if (precision > 0) s = s.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  return unit ? `${s}${unit}` : s;
}

/** Evaluates simple arithmetic typed into fields (e.g. "2*pi", "1/3+0.5"). */
export function evalExpression(s: string): number | null {
  const clean = s
    .trim()
    .toLowerCase()
    .replace(/pi/g, String(Math.PI))
    .replace(/[^0-9+\-*/().e\s]/g, '');
  if (!clean) return null;
  try {
    const v = Function(`"use strict"; return (${clean});`)() as unknown;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Animation state of a field, coloured like Blender: on a keyframe (yellow), animated between
 * keyframes (green), set by a driver (purple).
 */
export type FieldState = 'keyed' | 'animated' | 'driven';

export interface NumberFieldProps {
  value: number;
  onChange: (v: number, final: boolean) => void;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  /** Show a slider fill between min and max. */
  slider?: boolean;
  integer?: boolean;
  /** Display transform (e.g. radians → degrees). */
  toDisplay?: (v: number) => number;
  fromDisplay?: (v: number) => number;
  state?: FieldState | null;
  testId?: string;
  title?: string;
  /**
   * Text shown instead of the value while it is not a finite number, e.g. 'Auto' for an optional
   * parameter left unset (dragging then starts from 0, typing replaces it).
   */
  placeholder?: string;
}

/**
 * Blender-style number field: drag horizontally to change (Shift = fine, Ctrl = snap),
 * click to type a value or expression, Enter to confirm, Esc to cancel.
 */
export function NumberField(p: NumberFieldProps) {
  const toD = p.toDisplay ?? ((v: number) => v);
  const fromD = p.fromDisplay ?? ((v: number) => v);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  // whether the text entry is still open: Enter and Escape close it, so the blur that browsers fire
  // when they remove the focused input does not commit (or cancel into a commit) a second time
  const entryOpen = useRef(false);
  const drag = useRef<{ x: number; start: number; moved: boolean; id: number } | null>(null);
  const precision = p.precision ?? (p.integer ? 0 : 3);
  const step = p.step ?? (p.integer ? 1 : 0.01);
  const clamp = (v: number) => {
    let x = v;
    if (p.min !== undefined) x = Math.max(p.min, x);
    if (p.max !== undefined) x = Math.min(p.max, x);
    if (p.integer) x = Math.round(x);
    return x;
  };
  const display = toD(p.value);
  const unset = p.placeholder !== undefined && !Number.isFinite(display);
  const onDown = (e: PointerEvent) => {
    if (editing || e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: unset ? 0 : display, moved: false, id: e.pointerId };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const speed = e.shiftKey ? step * 0.1 : step;
    let v = d.start + dx * speed;
    if (e.ctrlKey) v = Math.round(v / (step * 10)) * (step * 10);
    p.onChange(clamp(fromD(v)), false);
  };
  const onUp = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) {
      const dx = e.clientX - d.x;
      const speed = e.shiftKey ? step * 0.1 : step;
      let v = d.start + dx * speed;
      if (e.ctrlKey) v = Math.round(v / (step * 10)) * (step * 10);
      p.onChange(clamp(fromD(v)), true);
    } else {
      setText(unset ? '' : fmt(display, Math.max(precision, 4)));
      setEditing(true);
      entryOpen.current = true;
    }
  };
  const commit = () => {
    if (!entryOpen.current) return;
    entryOpen.current = false;
    const v = evalExpression(text);
    setEditing(false);
    if (v !== null) p.onChange(clamp(fromD(v)), true);
  };
  const fill =
    p.slider && p.min !== undefined && p.max !== undefined && !unset
      ? Math.max(0, Math.min(1, (display - toD(p.min)) / (toD(p.max) - toD(p.min) || 1)))
      : null;
  return (
    <div
      class={`numfield ${p.state ?? ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      data-testid={p.testId}
      title={p.title}
    >
      {fill !== null && !editing && <div class="fill" style={{ width: `${fill * 100}%` }} />}
      {editing ? (
        <input
          autoFocus
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              entryOpen.current = false;
              setEditing(false);
            }
            e.stopPropagation();
          }}
          onBlur={commit}
          ref={(el) => el?.select()}
        />
      ) : (
        <>
          {p.label && <span class="nf-label">{p.label}</span>}
          <span class="nf-value">{unset ? p.placeholder : fmt(display, precision, p.unit)}</span>
        </>
      )}
    </div>
  );
}

export function VectorField(p: {
  value: number[];
  labels?: string[];
  onChange: (v: number[], final: boolean) => void;
  step?: number;
  precision?: number;
  unit?: string;
  toDisplay?: (v: number) => number;
  fromDisplay?: (v: number) => number;
  min?: number;
  max?: number;
  states?: (FieldState | null)[];
  testId?: string;
  /** Text shown for components that are not finite numbers (see {@link NumberFieldProps}). */
  placeholder?: string;
}) {
  const labels = p.labels ?? ['X', 'Y', 'Z', 'W'];
  return (
    <div class="vector">
      {p.value.map((v, i) => (
        <NumberField
          key={i}
          label={labels[i]}
          value={v}
          step={p.step}
          precision={p.precision}
          unit={p.unit}
          min={p.min}
          max={p.max}
          toDisplay={p.toDisplay}
          fromDisplay={p.fromDisplay}
          state={p.states?.[i] ?? null}
          testId={p.testId ? `${p.testId}-${i}` : undefined}
          placeholder={p.placeholder}
          onChange={(x, final) => {
            const next = p.value.slice();
            next[i] = x;
            p.onChange(next, final);
          }}
        />
      ))}
    </div>
  );
}

const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** Color swatch editing linear RGB values through the browser color picker (sRGB). */
export function ColorField(p: {
  value: number[];
  onChange: (v: number[], final: boolean) => void;
  testId?: string;
}) {
  const [r, g, b] = p.value;
  const hex =
    '#' +
    [r, g, b]
      .map((c) =>
        Math.round(Math.max(0, Math.min(1, linearToSrgb(c))) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  return (
    <div class="colorfield" style={{ background: hex }} title={hex} data-testid={p.testId}>
      <input
        type="color"
        value={hex}
        onInput={(e) => {
          const h = (e.target as HTMLInputElement).value;
          const c = [1, 3, 5].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
          p.onChange(p.value.length === 4 ? [...c, p.value[3]] : c, false);
        }}
        onChange={(e) => {
          const h = (e.target as HTMLInputElement).value;
          const c = [1, 3, 5].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
          p.onChange(p.value.length === 4 ? [...c, p.value[3]] : c, true);
        }}
      />
    </div>
  );
}

export function Checkbox(p: {
  value: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  testId?: string;
}) {
  return (
    <label
      class={`checkbox ${p.value ? 'on' : ''}`}
      data-testid={p.testId}
      onClick={() => p.onChange(!p.value)}
    >
      <span class="box">{p.value ? <Icon name="check" size={11} /> : null}</span>
      {p.label}
    </label>
  );
}

export function SelectField<T extends string>(p: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  testId?: string;
  /** Tooltip (e.g. the parameter description). */
  title?: string;
  disabled?: boolean;
}) {
  return (
    <select
      class="select"
      value={p.value}
      data-testid={p.testId}
      title={p.title}
      disabled={p.disabled}
      onChange={(e) => p.onChange((e.target as HTMLSelectElement).value as T)}
    >
      {p.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function EnumButtons<T extends string>(p: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** Test id of the row; each button gets `${testId}-${value}`. */
  testId?: string;
  title?: string;
  /** Buttons share the row width without wrapping (narrow paddings), e.g. six axis buttons. */
  compact?: boolean;
}) {
  return (
    <div class="enum-row" data-testid={p.testId} title={p.title} style={p.compact ? COMPACT_ROW : undefined}>
      {p.options.map((o) => (
        <button
          key={o.value}
          class={`btn ${p.value === o.value ? 'active' : ''}`}
          style={p.compact ? COMPACT_BUTTON : undefined}
          aria-pressed={p.value === o.value}
          data-testid={p.testId ? `${p.testId}-${o.value}` : undefined}
          onClick={() => p.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const COMPACT_ROW = { flexWrap: 'nowrap' } as const;
const COMPACT_BUTTON = {
  // content-sized, sharing the spare width: long labels keep their room
  flex: '1 1 auto',
  padding: '0 3px',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as const;

/**
 * Row of independent toggle buttons (Blender's X / Y / Z axis toggles): each option is a boolean
 * shown as a pressed (active) or released button.
 */
export function ToggleGroup(p: {
  options: { label: string; value: boolean; title?: string }[];
  onChange: (index: number, value: boolean) => void;
  /** Test id of the row; each button gets `${testId}-${index}`. */
  testId?: string;
}) {
  return (
    <div class="enum-row" data-testid={p.testId} style={COMPACT_ROW}>
      {p.options.map((o, i) => (
        <button
          key={i}
          class={`btn ${o.value ? 'active' : ''}`}
          style={COMPACT_BUTTON}
          title={o.title}
          aria-pressed={o.value}
          data-testid={p.testId ? `${p.testId}-${i}` : undefined}
          onClick={() => p.onChange(i, !o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The text a field edits: it starts as `value` and is set to it again whenever `value` changes (an
 * undo, an agent, an edit that failed). It is set in the commit that brings the new value: an effect
 * would run after the next frame, or sooner when the field renders again, and on a new field it
 * replaced what was typed in it before then (a name typed as soon as the Projects window appeared, so
 * the Escape meant to cancel the typing closed the window).
 */
export function useEditedText(value: string): [string, (text: string) => void] {
  const [text, setText] = useState(value);
  useLayoutEffect(() => setText(value), [value]);
  return [text, setText];
}

export function TextField(p: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testId?: string;
  type?: string;
  commitOnBlur?: boolean;
  /** Id of a `<datalist>` with suggestions. */
  list?: string;
  title?: string;
  /** Accessible name when there is no visible label. */
  ariaLabel?: string;
}) {
  const [v, setV] = useEditedText(p.value);
  /**
   * The text committed last: a blur right after Enter (e.g. when the commit renamed what the field
   * shows and the field is removed while focused) must not commit it again with stale props.
   */
  const committed = useRef<string | null>(null);
  const commit = () => {
    if (v === p.value || v === committed.current) return;
    committed.current = v;
    p.onChange(v);
  };
  return (
    <input
      class="textfield"
      type={p.type ?? 'text'}
      value={v}
      placeholder={p.placeholder}
      list={p.list}
      title={p.title}
      aria-label={p.ariaLabel}
      data-testid={p.testId}
      onInput={(e) => {
        committed.current = null;
        setV((e.target as HTMLInputElement).value);
        if (p.commitOnBlur === false) p.onChange((e.target as HTMLInputElement).value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          // with no typing to cancel, Escape goes on to what holds the field (it closes a dialog)
          if (v === p.value) return;
          setV(p.value);
        }
        e.stopPropagation();
      }}
      onBlur={commit}
    />
  );
}

export function Row(p: {
  label?: string;
  children: ComponentChildren;
  full?: boolean;
  /**
   * The label column is as wide as the label instead of 40% of the row, for short labels in nested
   * list entries (a driver variable's Target and Path) whose values need the width.
   */
  compact?: boolean;
  /** Tooltip of the label (e.g. the property description). */
  title?: string;
}) {
  return (
    <div class={`prop-row ${p.full ? 'full' : ''} ${p.compact ? 'compact' : ''}`}>
      {!p.full && <label title={p.title}>{p.label}</label>}
      <div>{p.children}</div>
    </div>
  );
}

export function Panel(p: {
  title: string;
  children: ComponentChildren;
  defaultOpen?: boolean;
  actions?: ComponentChildren;
  id?: string;
}) {
  const key = `3d-editor:panel:${p.id ?? p.title}`;
  const [open, setOpen] = useState(() => {
    const s = localStorage.getItem(key);
    return s === null ? p.defaultOpen !== false : s === '1';
  });
  return (
    <div class="panel">
      <div
        class="panel-header"
        onClick={() => {
          setOpen(!open);
          localStorage.setItem(key, open ? '0' : '1');
        }}
      >
        <span class="chev">{open ? '▾' : '▸'}</span>
        <span>{p.title}</span>
        {p.actions && (
          <span class="actions" onClick={(e) => e.stopPropagation()}>
            {p.actions}
          </span>
        )}
      </div>
      {open && <div class="panel-body">{p.children}</div>}
    </div>
  );
}

export const RAD = {
  toDisplay: (v: number) => (v * 180) / Math.PI,
  fromDisplay: (v: number) => (v * Math.PI) / 180,
};
