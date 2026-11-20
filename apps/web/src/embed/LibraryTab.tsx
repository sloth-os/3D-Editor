import { useEffect, useState } from 'preact/hooks';
import type { SceneBrief } from '@3d-editor/core';
import { hoveredArea } from '../editor/editor';
import { Icon, type IconName } from '../ui/icons';
import type { DeskController, PublishOutcome, PublishProgress } from './controller';
import type { UnitKind } from './protocol';
import { slotName, type LibraryRow } from './units';

/*
 * The desk's Library tab (docs/director-desk.md "The Library tab"), a bottom tab shown only after an
 * open whose host turned library units on (controller.units): "From the library" lists each library
 * unit the scene uses or the brief pins (name, kind, the version, its status in words, and Make local
 * on an instance), and "Save to library…" opens the Save dialog (SaveToLibraryDialog.tsx), off with
 * the reason when the host takes no units from this open or nothing can be saved. It also says how
 * the last Save to library went (and how far one in progress is, when its dialog was closed).
 * Its controls are the desk's chrome: no viewport key acts over them.
 */

/** The desk's chrome: no viewport keys act there (as DeskApp.tsx's header). */
export const CHROME = {
  onPointerEnter: () => (hoveredArea.value = 'other'),
  onFocusIn: () => (hoveredArea.value = 'other'),
};

/** Re-renders every `ms` while `active`. */
export function useTick(active: boolean, ms = 1000): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

/** A unit's kind in words. */
export const KIND_WORDS: Record<UnitKind, string> = { set: 'set', prop: 'prop', figure: 'figure' };
const KIND_ICON: Record<UnitKind, IconName> = { set: 'world', prop: 'cube', figure: 'user' };

/** Why Save to library is off now (null: it is on). */
export function saveBlocker(c: DeskController): string | null {
  const host = c.options.value.hostName;
  const units = c.units.value;
  if (!units) return `${host} did not turn on library units for this scene.`;
  if (!units.publish) return `${host} takes no units saved to its library from this scene.`;
  if (c.status.value !== 'open') return 'No scene is open.';
  if (c.publishing.value) return 'A unit is being saved to the library.';
  if (c.updating.value) return 'The shots are being updated.';
  if (!c.saveTargets().length) return 'Nothing in this scene can be saved to the library.';
  return null;
}

/** A Save to library in progress, in words. */
export function publishingText(p: PublishProgress, host: string, now: number): string {
  const what = `'${p.name}'`;
  if (p.phase === 'extracting') return `Making ${what} and its thumbnail…`;
  if (p.phase === 'linking') return `Linking the scene to ${what}…`;
  const secs = Math.max(0, Math.round((now - p.startedAt) / 1000));
  return `Waiting for ${host} to save ${what}… ${secs} s`;
}

/**
 * Where a unit saved from slot `slot` (the brief's 'set', 'cast:<id>', 'el:<id>') is linked, in
 * words: the scene's place for the set, else the cast member's or the element's name.
 */
export function linkedWords(brief: SceneBrief | null, slot: string | null, kind: UnitKind | null): string {
  if (slot === 'set' || (!slot && kind === 'set')) return "the scene's place";
  if (brief && slot) {
    const name = slotName(brief, slot);
    if (name !== slot) return name;
  }
  return kind === 'figure' ? 'its actor' : 'its prop';
}

/** The slot of the brief that pins `ref@version` (a linked publish moved it there), else null. */
export function pinnedSlot(brief: SceneBrief | null, ref: string, version: number): string | null {
  if (!brief) return null;
  const is = (u: { ref: string; version: number } | undefined) => u?.ref === ref && u.version === version;
  if (is(brief.set?.unit)) return 'set';
  const cast = brief.cast.find((x) => is(x.unit));
  if (cast) return `cast:${cast.id}`;
  const el = brief.elements.find((x) => is(x.unit));
  return el ? `el:${el.id}` : null;
}

/**
 * The desk's own codes of a save whose end it does not know (controller.ts publish), each with why:
 * the host did not answer in time, the desk closed first, or the host's answer was not valid. The
 * host may have saved the unit, and linked it, all the same (a later answer is not applied; its next
 * brief brings the link), so the person looks in its library before saving it again.
 */
const UNKNOWN_END: Record<string, string> = {
  timeout: 'it did not answer in time',
  closed: 'the desk closed before it answered',
  bad_reply: 'its answer was not valid',
};

/**
 * How a Save to library ended: 'linked' (the scene is the version now), 'unlinked' (saved only),
 * 'failed' (not saved), or 'unknown' (the host may have saved it: UNKNOWN_END).
 */
export function publishOutcome(o: PublishOutcome): 'linked' | 'unlinked' | 'failed' | 'unknown' {
  if (!o.result.ok) return Object.hasOwn(UNKNOWN_END, o.result.code) ? 'unknown' : 'failed';
  return o.result.linked && o.result.adopted ? 'linked' : 'unlinked';
}

/**
 * How a Save to library ended, in words: "Saved 'Harbor' v3 to rideo; linked to the scene's place",
 * "Saved 'Harbor' v1 to rideo; not linked: <reason>" (also "not linked here" when the host linked it
 * but the scene stays as it is), "Not saved: <reason>", or "Not known whether rideo saved 'Harbor':
 * it did not answer in time. Look in its library before saving again." `linkedTo`: where it was
 * linked (linkedWords).
 */
export function publishResultText(o: PublishOutcome, host: string, linkedTo: string): string {
  const r = o.result;
  if (!r.ok)
    return Object.hasOwn(UNKNOWN_END, r.code)
      ? `Not known whether ${host} saved '${o.name}': ${UNKNOWN_END[r.code]}. Look in its library before saving again.`
      : `Not saved: ${r.message}`;
  const saved = `Saved '${o.name}' v${r.version} to ${host}`;
  if (r.linked && r.adopted) return `${saved}; linked to ${linkedTo}`;
  if (r.linked) return `${saved}; not linked here: ${r.message ?? `the scene stays as it is`}`;
  return `${saved}; not linked: ${r.message ?? `${host} keeps the scene's pin as it was`}`;
}

/** The kinds of rows Make local applies to: an instance not made local. */
const canMakeLocal = (r: LibraryRow) => r.root !== null && r.status !== 'local';

function Row(p: {
  row: LibraryRow;
  /** Why Make local is off (null: on). */
  off: string | null;
  busy: boolean;
  onMakeLocal: (row: LibraryRow) => void;
}) {
  const { row } = p;
  return (
    <li
      class={`desk-lib-row ${row.status}`}
      data-testid="desk-library-row"
      data-key={row.key}
      data-status={row.status}
      data-kind={row.kind}
      data-version={row.version}
      title={`${row.ref} v${row.version}`}
    >
      <Icon name={KIND_ICON[row.kind]} size={14} class="desk-lib-icon" />
      <div class="desk-lib-main">
        <div class="desk-lib-head">
          <span class="desk-lib-name" data-testid="desk-library-name">
            {row.name}
          </span>
          <span class="desk-lib-kind">{KIND_WORDS[row.kind]}</span>
          <span class="desk-lib-version" data-testid="desk-library-version">
            v{row.version}
          </span>
        </div>
        <div class={`desk-lib-status ${row.status}`} data-testid="desk-library-status">
          {row.text}
        </div>
      </div>
      {canMakeLocal(row) && (
        <button
          class="btn"
          data-testid="desk-library-make-local"
          disabled={!!p.off || p.busy}
          title={
            p.off ??
            'Keep its objects as plain ones of this scene, no longer linked to the library (one undo step)'
          }
          onClick={() => p.onMakeLocal(row)}
        >
          Make local
        </button>
      )}
    </li>
  );
}

export function LibraryTab({ c, onSave }: { c: DeskController; onSave: () => void }) {
  const rows = c.libraryRows.value;
  const options = c.options.value;
  const host = options.hostName;
  const publishing = c.publishing.value;
  const last = c.lastPublish.value;
  const status = c.status.value;
  const updating = c.updating.value;
  useTick(!!publishing);
  const [busy, setBusy] = useState<string | null>(null);
  // what came of the last Make local; `root`: the instance made local
  const [note, setNote] = useState<{ ok: boolean; text: string; root: string } | null>(null);
  // "X is local now" holds until the objects are an instance again (Ctrl+Z, or a save the host
  // linked): a row names their root then
  useEffect(() => {
    if (note?.ok && rows.some((r) => r.root === note.root)) setNote(null);
  }, [rows]);
  const saveOff = saveBlocker(c);
  const localOff = options.readOnly
    ? 'The scene is read-only here.'
    : status !== 'open'
      ? 'No scene is open.'
      : updating
        ? 'The shots are being updated.'
        : null;
  const makeLocal = async (row: LibraryRow) => {
    const root = row.root;
    if (!root) return;
    setBusy(root);
    setNote(null);
    const r = await c.makeLocal(root);
    setBusy(null);
    setNote(
      r.ok
        ? { ok: true, root, text: `${row.name} is local now: it stays as it is (Ctrl+Z undoes it).` }
        : { ok: false, root, text: `${row.name} could not be made local: ${r.message}` },
    );
  };
  const lastSlot = last?.result.ok ? pinnedSlot(c.brief.value, last.result.ref, last.result.version) : null;
  return (
    <div class="desk-library" data-testid="desk-library" {...CHROME}>
      <div class="desk-lib-toolbar">
        <span class="desk-lib-title">From the library</span>
        <span class="desk-lib-count" data-testid="desk-library-count">
          {rows.length}
        </span>
        <span class="desk-lib-grow" />
        <button
          class="btn primary"
          data-testid="desk-library-save"
          disabled={!!saveOff}
          title={saveOff ?? `Save the set, an actor or a prop of this scene to ${host}'s library`}
          onClick={onSave}
        >
          Save to library…
        </button>
      </div>
      {saveOff && !publishing && (
        <div class="desk-lib-line dim" data-testid="desk-library-save-why">
          {saveOff}
        </div>
      )}
      {publishing && (
        <div class="desk-lib-line" data-testid="desk-library-publishing" data-phase={publishing.phase}>
          {publishingText(publishing, host, Date.now())}
        </div>
      )}
      {last && !publishing && (
        <div
          class={`desk-lib-line ${publishOutcome(last)}`}
          data-testid="desk-library-last"
          data-outcome={publishOutcome(last)}
        >
          {publishResultText(last, host, linkedWords(c.brief.value, lastSlot, last.kind))}
        </div>
      )}
      {note && (
        <div class={`desk-lib-line ${note.ok ? 'linked' : 'failed'}`} data-testid="desk-library-note">
          {note.text}
        </div>
      )}
      {rows.length ? (
        <ul class="desk-lib-list" data-testid="desk-library-list">
          {rows.map((r) => (
            <Row
              key={r.key}
              row={r}
              off={localOff}
              busy={busy !== null && busy === r.root}
              onMakeLocal={(row) => void makeLocal(row)}
            />
          ))}
        </ul>
      ) : (
        <div class="desk-lib-empty" data-testid="desk-library-empty">
          No library units in this scene yet. The brief&rsquo;s pins and what you save to {host}&rsquo;s
          library show here.
        </div>
      )}
    </div>
  );
}
