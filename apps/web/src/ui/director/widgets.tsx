import { useRef, useState } from 'preact/hooks';
import { NumberField, composing, useEditedText, type NumberFieldProps } from '../fields/fields';
import { Icon, type IconName } from '../icons';

/** An icon button with an accessible name (the title). */
export function IconButton(p: {
  icon: IconName;
  title: string;
  testId?: string;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      class={`btn ${p.label ? '' : 'icon'}`}
      title={p.title}
      aria-label={p.title}
      data-testid={p.testId}
      disabled={p.disabled}
      onClick={p.onClick}
    >
      <Icon name={p.icon} size={12} />
      {p.label && <span style={{ marginLeft: '4px' }}>{p.label}</span>}
    </button>
  );
}

/**
 * A number field that commits once, when a drag ends or a typed value is confirmed (one operator
 * run, one undo step), and shows the dragged value meanwhile.
 */
export function CommitNumber(
  p: Omit<NumberFieldProps, 'onChange'> & { onCommit: (v: number) => void; value: number },
) {
  const [live, setLive] = useState<number | null>(null);
  const { onCommit, ...rest } = p;
  return (
    <NumberField
      {...rest}
      value={live ?? p.value}
      onChange={(v, final) => {
        if (!final) return setLive(v);
        setLive(null);
        if (v !== p.value) onCommit(v);
      }}
    />
  );
}

/**
 * A multi-line text field (a shot's notes) that commits when it loses the focus or on Ctrl+Enter;
 * Escape puts back the stored text. Keys typed in it never reach the editor's shortcuts.
 */
export function NotesField(p: {
  value: string;
  onChange: (v: string) => void;
  testId?: string;
  placeholder?: string;
  maxLength?: number;
  ariaLabel?: string;
}) {
  const [text, setText] = useEditedText(p.value);
  const committed = useRef<string | null>(null);
  const commit = (v: string) => {
    if (v === p.value || v === committed.current) return;
    committed.current = v;
    p.onChange(v);
  };
  return (
    <textarea
      class="notes-field"
      value={text}
      placeholder={p.placeholder}
      maxLength={p.maxLength}
      aria-label={p.ariaLabel}
      data-testid={p.testId}
      onInput={(e) => {
        committed.current = null;
        setText((e.target as HTMLTextAreaElement).value);
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (composing(e)) return;
        const el = e.currentTarget as HTMLTextAreaElement;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          commit(el.value);
        }
        if (e.key === 'Escape') {
          el.value = p.value;
          setText(p.value);
        }
      }}
      onBlur={(e) => commit((e.currentTarget as HTMLTextAreaElement).value)}
    />
  );
}

/**
 * A dropdown that runs an action (its first option is a prompt such as "Pose…"): choosing an
 * option runs it and the dropdown shows the prompt again.
 */
export function ActionSelect(p: {
  prompt: string;
  options: { value: string; label: string }[];
  onPick: (value: string) => void;
  testId?: string;
  title?: string;
}) {
  return (
    <select
      class="select"
      value=""
      data-testid={p.testId}
      title={p.title}
      aria-label={p.title ?? p.prompt}
      onChange={(e) => {
        const el = e.currentTarget as HTMLSelectElement;
        const v = el.value;
        el.value = '';
        if (v) p.onPick(v);
      }}
    >
      <option value="">{p.prompt}</option>
      {p.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** "three_quarter_left" → "Three quarter left". */
export function humanize(v: string): string {
  const s = v.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}
