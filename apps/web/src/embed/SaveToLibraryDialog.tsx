import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { DeskController, PublishOutcome, UnitPreview } from './controller';
import type { SaveTarget } from './units';
import {
  CHROME,
  KIND_WORDS,
  linkedWords,
  publishOutcome,
  publishResultText,
  publishingText,
  useTick,
} from './LibraryTab';

/*
 * Save to library (docs/director-desk.md "Save to library"): saves the set, an actor's figure or a
 * prop of the scene to the host's library. What (the set, each actor by its cast member's name, each
 * prop; first the selected actor or prop, else the set), Name and Description, and, when the target
 * is an instance of a library unit, "Save as a new version of <item> vN" (else a new item): a new
 * version keeps its item's name (the host keeps its own), so Name shows it and cannot be changed,
 * and the Description is the new version's note. The dialog shows the unit as it would be saved
 * (its thumbnail, counts, size and warnings: made in the staging worker, nothing changes in the
 * scene), then the progress while the host saves it, then what came of it, under the name it was
 * saved with: "Saved 'Harbor' v3 to <host>; linked to the scene's place", "Saved … ; not linked:
 * <reason>" or "Not saved: <reason>". Closing it while the host saves lets the save go on: the
 * Library tab says how it ends. A read-only open may save too; the scene stays as it is.
 *
 * It is modal: it takes the keyboard focus when it opens (useModalFocus), Tab goes round its own
 * controls, and the focus goes back to Save to library… when it closes; no key of the editor acts
 * behind it meanwhile (DeskApp.tsx deskModals). What it offers to save is read again when a save
 * ends and when a target is chosen: a save the host linked makes its target an instance of what it
 * saved, offered next as a new version of it.
 */

/** What the keyboard reaches in a window: its enabled controls, links and other tab stops. */
const TAB_STOPS =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The keyboard focus of one of the desk's modal windows (`box`, focusable with tabIndex -1): the
 * window takes the focus when it opens; Tab and Shift+Tab go round its own controls, from the window
 * itself and from anywhere behind it too, never to the desk behind it; when it closes the focus goes
 * back to what had it (Save to library…, Send), if that is still there. While `active` says no
 * (another layer is over the window: the closed desk's panel) Tab is left alone.
 */
export function useModalFocus(box: RefObject<HTMLElement>, active: () => boolean = () => true): void {
  useLayoutEffect(() => {
    const had = document.activeElement;
    const opener = had instanceof HTMLElement && had !== document.body ? had : null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const el = box.current;
      if (e.key !== 'Tab' || e.altKey || e.ctrlKey || e.metaKey || !el || !active()) return;
      const stops = [...el.querySelectorAll<HTMLElement>(TAB_STOPS)];
      if (!stops.length) return;
      const at = document.activeElement;
      const [first, last] = [stops[0], stops[stops.length - 1]];
      const inside = at instanceof Node && at !== el && el.contains(at);
      if (!inside || at === (e.shiftKey ? first : last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
}

/** A target's key in the What list. */
export const targetKey = (t: SaveTarget): string => ('set' in t.what ? 'set' : `root:${t.what.root}`);

/** A target in the What list: "The set", "Mira (actor)", "Red kite (prop)". */
export const targetLabel = (t: SaveTarget): string =>
  t.kind === 'set' ? t.label : `${t.label} (${t.kind === 'figure' ? 'actor' : 'prop'})`;

/** The longest name and description a unit takes (the protocol's). */
export const MAX_NAME = 120;
export const MAX_DESCRIPTION = 2000;

/** Bytes in words ("3.2 KiB", "1.4 MiB"). */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** What the preview says of a unit: objects, triangles, size, dimensions, a figure's kind and height. */
export function previewWords(p: UnitPreview): string {
  const n = (v: number, one: string) => `${v.toLocaleString('en-US')} ${one}${v === 1 ? '' : 's'}`;
  const [w, d, h] = p.meta.dimensionsM.map((v) => v.toFixed(v < 10 ? 2 : 1));
  const parts = [
    n(p.counts.objects, 'object'),
    n(p.counts.triangles, 'triangle'),
    sizeWords(p.bytes),
    `${w} × ${d} × ${h} m`,
  ];
  if (p.meta.actor) parts.push(`${p.meta.actor.kind}, ${p.meta.actor.heightM.toFixed(2)} m tall`);
  return parts.join(' · ');
}

type PreviewState =
  | { key: string; status: 'busy' }
  | { key: string; status: 'ok'; preview: UnitPreview }
  | { key: string; status: 'failed'; error: string };

export function SaveToLibraryDialog(p: {
  c: DeskController;
  /** The editor's active object when the dialog opened (its target is the first offered). */
  selected: string | null;
  onClose: () => void;
}) {
  const { c } = p;
  const options = c.options.value;
  const host = options.hostName;
  // what can be saved: read when the dialog opens, again when a save ends (the host may have linked
  // it: the target is an instance of what was saved now) and when a target is chosen
  const [targets, setTargets] = useState(() => c.saveTargets());
  const first = useMemo(() => c.defaultSaveTarget(p.selected) ?? targets[0] ?? null, []);
  const [key, setKey] = useState(first ? targetKey(first) : '');
  const target = targets.find((t) => targetKey(t) === key) ?? first;
  const [name, setName] = useState(first?.name ?? '');
  const [named, setNamed] = useState(false);
  const [description, setDescription] = useState('');
  const [asNewVersion, setAsNewVersion] = useState(true);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const publishing = c.publishing.value;
  useTick(saving);
  const box = useRef<HTMLDivElement>(null);
  // the closed desk's panel is over the dialog (it stays under it): Tab is the panel's then
  useModalFocus(box, () => c.status.peek() !== 'closed');

  // Escape closes (a save under way goes on): not a held Escape's repeats, nor the Escape that ends
  // an IME composition in the Name or Description (Safari sends it after the composition, with key
  // code 229), which would lose what was typed; as in the editor's windows (Dialogs.tsx Modal)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      p.onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.onClose]);

  // the unit as it would be saved: made again when the target changes (read only)
  useEffect(() => {
    if (!target) return;
    const k = targetKey(target);
    const typed = name.trim();
    const asked =
      target.basedOn && asNewVersion
        ? target.basedOn.name
        : typed && typed.length <= MAX_NAME
          ? typed
          : target.name;
    setPreview({ key: k, status: 'busy' });
    c.previewUnit(target.what, asked).then(
      (preview) => alive.current && setPreview({ key: k, status: 'ok', preview }),
      (err: unknown) =>
        alive.current &&
        setPreview({ key: k, status: 'failed', error: err instanceof Error ? err.message : String(err) }),
    );
  }, [key]);

  const shown = preview && target && preview.key === targetKey(target) ? preview : null;
  const thumbnail = shown?.status === 'ok' ? shown.preview.thumbnail : null;
  const thumbUrl = useMemo(
    () =>
      thumbnail
        ? URL.createObjectURL(new Blob([thumbnail as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
        : null,
    [thumbnail],
  );
  useEffect(() => () => void (thumbUrl && URL.revokeObjectURL(thumbUrl)), [thumbUrl]);

  const choose = (k: string) => {
    const now = c.saveTargets();
    setTargets(now);
    const t = now.find((x) => targetKey(x) === k);
    if (!t) return;
    setKey(k);
    if (!named) setName(t.name);
    setAsNewVersion(true);
    setOutcome(null);
  };

  const based = target?.basedOn ?? null;
  // a new version is saved under its item's name, which the host keeps: Name shows it, read-only
  const itemName = based && asNewVersion ? based.name : null;
  const trimmed = itemName ?? name.trim();
  const nameProblem = !trimmed
    ? 'A unit needs a name.'
    : trimmed.length > MAX_NAME
      ? `A name of at most ${MAX_NAME} characters.`
      : null;
  const blocked = !target
    ? 'Nothing in this scene can be saved to the library.'
    : !c.units.value?.publish
      ? `${host} takes no units saved to its library from this scene.`
      : c.status.value !== 'open'
        ? 'No scene is open.'
        : publishing && !saving
          ? 'Another unit is being saved to the library.'
          : shown?.status === 'failed'
            ? `The unit cannot be made: ${shown.error}`
            : nameProblem;

  const save = async () => {
    if (!target || blocked || saving) return;
    setSaving(true);
    setOutcome(null);
    const result = await c.publish({
      what: target.what,
      name: trimmed,
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(itemName !== null ? { asNewVersion: true } : {}),
    });
    if (!alive.current) return;
    setSaving(false);
    setTargets(c.saveTargets());
    setOutcome(c.lastPublish.peek() ?? { result, kind: target.kind, name: trimmed, at: Date.now() });
  };

  const done = outcome !== null;
  return (
    <div class="desk-modal-back" data-testid="desk-save" {...CHROME}>
      <div
        class="desk-modal desk-save"
        role="dialog"
        aria-modal="true"
        aria-label="Save to library"
        tabIndex={-1}
        ref={box}
      >
        <h3>Save to library</h3>
        <p>
          {host} keeps it in its library, so that other scenes can use it. Nothing in this scene changes until{' '}
          {host} links it.
        </p>
        {options.readOnly && (
          <p class="desk-save-note" data-testid="desk-save-read-only">
            The scene is read-only here: {host} may save the unit, and the scene stays as it is.
          </p>
        )}
        <label class="desk-save-field">
          <span>What</span>
          <select
            class="select"
            data-testid="desk-save-what"
            value={key}
            disabled={saving || !targets.length}
            onChange={(e) => choose((e.currentTarget as HTMLSelectElement).value)}
          >
            {targets.map((t) => (
              <option key={targetKey(t)} value={targetKey(t)}>
                {targetLabel(t)}
              </option>
            ))}
          </select>
        </label>
        <label class="desk-save-field">
          <span>Name</span>
          <input
            class="textfield"
            data-testid="desk-save-name"
            value={itemName ?? name}
            maxLength={MAX_NAME}
            readOnly={itemName !== null}
            title={itemName !== null ? `A new version keeps the name of ${itemName}` : undefined}
            disabled={saving}
            onInput={(e) => {
              setName((e.currentTarget as HTMLInputElement).value);
              setNamed(true);
            }}
          />
        </label>
        <label class="desk-save-field">
          <span>Description</span>
          <textarea
            class="textfield desk-save-description"
            data-testid="desk-save-description"
            value={description}
            maxLength={MAX_DESCRIPTION}
            rows={2}
            disabled={saving}
            onInput={(e) => setDescription((e.currentTarget as HTMLTextAreaElement).value)}
          />
        </label>
        {based ? (
          <label class="desk-save-check">
            <input
              type="checkbox"
              data-testid="desk-save-new-version"
              checked={asNewVersion}
              disabled={saving}
              onChange={(e) => setAsNewVersion((e.currentTarget as HTMLInputElement).checked)}
            />
            <span>
              Save as a new version of {based.name} v{based.version}
              {!asNewVersion && (
                <span class="desk-save-dim" data-testid="desk-save-new-item-note">
                  {' '}
                  (unticked: a new item in {host}&rsquo;s library; this scene keeps {based.name} v
                  {based.version})
                </span>
              )}
            </span>
          </label>
        ) : (
          target && (
            <p class="desk-save-dim" data-testid="desk-save-new-item">
              A new item in {host}&rsquo;s library ({KIND_WORDS[target.kind]}).
            </p>
          )
        )}
        <div class="desk-save-preview" data-testid="desk-save-preview" data-status={shown?.status ?? 'busy'}>
          <div class="desk-save-thumb">
            {thumbUrl ? (
              <img
                data-testid="desk-save-thumbnail"
                src={thumbUrl}
                alt={`${trimmed || 'The unit'}, as saved`}
              />
            ) : (
              <span class="desk-save-dim">{shown?.status === 'ok' ? 'no thumbnail' : ''}</span>
            )}
          </div>
          <div class="desk-save-summary">
            {!shown || shown.status === 'busy' ? (
              <span class="desk-save-dim" data-testid="desk-save-preview-busy">
                Making the unit and its thumbnail…
              </span>
            ) : shown.status === 'failed' ? (
              <span class="desk-save-error" data-testid="desk-save-preview-error">
                The unit cannot be made: {shown.error}
              </span>
            ) : (
              <>
                <span data-testid="desk-save-counts">{previewWords(shown.preview)}</span>
                {shown.preview.warnings.length > 0 && (
                  <ul class="desk-save-warnings" data-testid="desk-save-warnings">
                    {shown.preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
        {saving && publishing && (
          <div class="desk-save-progress" data-testid="desk-save-progress" data-phase={publishing.phase}>
            <span>{publishingText(publishing, host, Date.now())}</span>
            <div class="desk-bar indeterminate">
              <div />
            </div>
          </div>
        )}
        {outcome && (
          <div
            class={`desk-save-result ${publishOutcome(outcome)}`}
            data-testid="desk-save-result"
            data-outcome={publishOutcome(outcome)}
            data-code={outcome.result.ok ? undefined : outcome.result.code}
            role="status"
          >
            {publishResultText(outcome, host, linkedWords(c.brief.value, target?.slot ?? null, outcome.kind))}
          </div>
        )}
        {!saving && !done && blocked && (
          <p class="desk-save-error" data-testid="desk-save-why">
            {blocked}
          </p>
        )}
        <div class="desk-modal-actions">
          <button
            class="btn"
            data-testid="desk-save-cancel"
            title={saving ? `The save goes on; the Library tab says how it ends` : undefined}
            onClick={p.onClose}
          >
            {done || saving ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button
              class="btn primary"
              data-testid="desk-save-submit"
              disabled={!!blocked || saving}
              title={blocked ?? `Save it to ${host}'s library`}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
