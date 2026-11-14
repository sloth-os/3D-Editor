import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getShots, type BriefChanges } from '@3d-editor/core';
import { session } from '../app/store';
import { hoveredArea, type AreaKind } from '../editor/editor';
import { PopupMenuHost } from '../ui/Menu';
import { Viewport } from '../ui/Viewport';
import { DirectorPanel } from '../ui/director/DirectorPanel';
import { Area, BottomPane, Splitter, Toasts, usePersistentSize, type BottomEditor } from '../ui/App';
import { Icon } from '../ui/icons';
import type { ProjectSession } from '../project/session';
import type { DeskController } from './controller';
import { exportSizeProblem, type LengthCheck } from './export';
import type { Mode } from './protocol';
import type { WorkProgress } from './workspace';
import './desk.css';

/*
 * The desk's page (docs/embedding.md, "Starting"): the Director workspace of the editor, focused —
 * the viewport through the shot cameras, the shot list and inspector with each shot's issues, the
 * sequence strip, the timeline and playback, the staging tools and the Asset Browser — under a
 * compact header: the scene's name, where it came from and whether the host has its latest state,
 * the brief's changes with Update shots, Send to <host>, Done and Close, and an export's progress
 * with Cancel. No menus, workspaces, project list, presence, share, update button, Console,
 * Diagnostics, UV, Dope Sheet or Properties.
 *
 * The viewport's keys (X and Delete, G/R/S, …) act only while the pointer or the focus is in the
 * viewport: the header, the banners and the Director column say so on pointer and focus as the
 * editor's areas do, so a key pressed over the shot list never deletes the selected objects.
 *
 * Opened on its own (no host), it explains itself and offers a sample scene.
 */

/** The bottom area's tabs in the desk ("Shots" is the phone layout's Director panel). */
export const DESK_BOTTOM_TABS: readonly BottomEditor[] = ['sequence', 'timeline', 'shots', 'assets', 'info'];

const MODE_LABEL: Record<Mode, string> = { camera: 'Camera', motion: 'Motion', pose: 'Pose' };

/** Handlers that tell the keymap which area the pointer or the focus is in (keymap.ts hoveredArea). */
function areaHandlers(kind: AreaKind) {
  const set = () => (hoveredArea.value = kind);
  return { onPointerEnter: set, onFocusIn: set };
}
/** The desk's own chrome (header, banners, overlays): no viewport keys act there. */
const CHROME = areaHandlers('other');

const SOURCE_LABEL = {
  state: (host: string) => `Opened from ${host}'s copy`,
  local: () => 'Opened from this browser',
  brief: () => 'Staged from the brief',
} as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The brief's changes in words ("1 shot added, 1 retimed"). */
export function changesText(c: BriefChanges): string {
  const parts: string[] = [];
  if (c.added.length) parts.push(`${plural(c.added.length, 'shot')} added`);
  if (c.removed.length) parts.push(`${plural(c.removed.length, 'shot')} removed`);
  if (c.retimed.length) parts.push(`${plural(c.retimed.length, 'shot')} retimed`);
  if (c.recast.length) parts.push(`${plural(c.recast.length, 'shot')} recast`);
  if (c.cast.added.length) parts.push(`${plural(c.cast.added.length, 'cast member')} added`);
  if (c.cast.removed.length) parts.push(`${plural(c.cast.removed.length, 'cast member')} removed`);
  // what else an update acts on, in words ("the frame rate (24 to 30 fps)", "the set")
  for (const o of c.other ?? []) parts.push(o);
  return parts.join(', ');
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  return `${Math.round(s / 60)} min ago`;
}

/** Re-renders every `ms` while `active`. */
function useTick(active: boolean, ms = 1000): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

function StateStatus({ c }: { c: DeskController }) {
  const at = c.lastStateAt.value;
  const dirty = c.dirty.value;
  useTick(at !== null);
  const host = c.options.value.hostName;
  if (dirty) return <span class="desk-pill warn">Changes not sent to {host} yet</span>;
  if (at === null) return null;
  return (
    <span
      class="desk-pill"
      data-testid="desk-state-sent"
      title={`The scene's state went to ${host} ${ago(Date.now() - at)}`}
    >
      Sent to {host} {ago(Date.now() - at)}
    </span>
  );
}

function ExportBar({ c }: { c: DeskController }) {
  const run = c.exportRun.value;
  useTick(!!run, 500);
  if (!run) return null;
  const pct = run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;
  const what =
    run.phase === 'prepare'
      ? 'Preparing'
      : run.phase === 'render'
        ? `Rendering frame ${run.done} of ${run.total}`
        : run.phase === 'encode'
          ? 'Collecting the files'
          : 'Sending';
  const secs = Math.round((Date.now() - run.startedAt) / 1000);
  return (
    <div class="desk-export" data-testid="desk-export-progress" data-phase={run.phase} {...CHROME}>
      <div class="desk-export-text">
        <span>
          {run.by === 'desk' ? `Sending to ${c.options.value.hostName}` : 'Exporting for the host'} · {what}
          {run.shotId ? ` · ${run.shotId}` : ''} · {secs} s
        </span>
        <button class="btn flat" data-testid="desk-export-cancel" onClick={() => c.cancelExport()}>
          Cancel
        </button>
      </div>
      <div class="desk-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ChangesBanner({ c }: { c: DeskController }) {
  const changes = c.changes.value;
  const [hidden, setHidden] = useState<BriefChanges | null>(null);
  if (!changes || hidden === changes) return null;
  const readOnly = c.options.value.readOnly;
  const busy = c.updating.value || !!c.exportRun.value;
  return (
    <div class="desk-banner" data-testid="desk-changes" role="status" {...CHROME}>
      <Icon name="info" size={13} />
      <span>
        The brief changed since this scene was staged:{' '}
        <b data-testid="desk-changes-text">{changesText(changes)}</b>.
        {readOnly ? ' The scene is read-only here.' : ' Your staging stays until you update.'}
      </span>
      <span class="desk-banner-actions">
        {!readOnly && (
          <button
            class="btn primary"
            data-testid="desk-update-shots"
            disabled={busy}
            title="Bring the shots up to the brief (one undo step); hand edits of unchanged shots stay"
            onClick={() => void c.updateShots()}
          >
            Update shots
          </button>
        )}
        <button
          class="btn flat"
          onClick={() => setHidden(changes)}
          title="Hide this until the brief changes again"
        >
          Not now
        </button>
      </span>
    </div>
  );
}

function AckNotice({ c }: { c: DeskController }) {
  const ack = c.ack.value;
  if (!ack) return null;
  return (
    <div class={`desk-banner ${ack.ok ? 'ok' : 'warn'}`} data-testid="desk-ack" role="status" {...CHROME}>
      <Icon name={ack.ok ? 'check' : 'warning'} size={13} />
      <span>
        {c.options.value.hostName}: {ack.message}
        {ack.refused.length > 0 && (
          <ul class="desk-refused" data-testid="desk-ack-refused">
            {ack.refused.map((r) => (
              <li key={r.shotId}>
                <b>{r.shotId}</b>: {r.error}
              </li>
            ))}
          </ul>
        )}
      </span>
      <span class="desk-banner-actions">
        <button class="btn flat" onClick={() => (c.ack.value = null)}>
          OK
        </button>
      </span>
    </div>
  );
}

function NoticeLine({ c }: { c: DeskController }) {
  const n = c.notice.value;
  if (!n) return null;
  return (
    <div
      class={`desk-banner ${n.level === 'error' ? 'err' : n.level === 'warning' ? 'warn' : ''}`}
      data-testid="desk-notice"
      {...CHROME}
    >
      <Icon name={n.level === 'info' ? 'info' : 'warning'} size={13} />
      <span>{n.message}</span>
      <span class="desk-banner-actions">
        <button class="btn flat" onClick={() => (c.notice.value = null)}>
          OK
        </button>
      </span>
    </div>
  );
}

/**
 * Asks before a Send whose clips the host refuses (shots of another length than the brief's), never
 * with confirm(): the shots the brief retimed since they were staged (Update shots brings them to
 * the brief's length, offered here) apart from those made longer or shorter in the desk.
 */
function SendCheck(p: {
  checks: LengthCheck[];
  host: string;
  /** Update shots, when the brief retimed some and the open is not read-only. */
  onUpdate: (() => void) | null;
  onSend: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        p.onCancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [p.onCancel]);
  const byBrief = p.checks.filter((c) => c.byBrief);
  const byDesk = p.checks.filter((c) => !c.byBrief);
  const row = (c: LengthCheck) => (
    <li key={c.shotId}>
      <b>{c.name}</b> ({c.shotId}): {c.frames} frames here, {c.briefFrames} in the brief
    </li>
  );
  return (
    <div class="desk-modal-back" data-testid="desk-send-check" {...CHROME}>
      <div class="desk-modal" role="dialog" aria-modal="true" aria-label="Shots of another length">
        <h3>{plural(p.checks.length, 'shot')} differ from the brief</h3>
        <p>{p.host} takes a clip only when it has the shot&rsquo;s length in the brief.</p>
        {byBrief.length > 0 && (
          <div data-testid="desk-send-check-brief">
            <p>
              The brief changed the length of {byBrief.length === 1 ? 'this shot' : 'these shots'} since{' '}
              {byBrief.length === 1 ? 'it was' : 'they were'} staged.{' '}
              {p.onUpdate
                ? 'Update shots brings them to the brief; sent as they are, their clips are refused:'
                : 'The scene is read-only here, so they keep their staged length and their clips are refused:'}
            </p>
            <ul>{byBrief.map(row)}</ul>
          </div>
        )}
        {byDesk.length > 0 && (
          <div data-testid="desk-send-check-desk">
            <p>
              {byDesk.length === 1 ? 'This shot was' : 'These shots were'} made longer or shorter here, so{' '}
              {p.host} will refuse {byDesk.length === 1 ? 'its clip' : 'their clips'}:
            </p>
            <ul>{byDesk.map(row)}</ul>
          </div>
        )}
        <p>The other shots are taken as usual. Each refused shot says why in its issues.</p>
        <div class="desk-modal-actions">
          <button class="btn" data-testid="desk-send-check-cancel" onClick={p.onCancel}>
            Cancel
          </button>
          {p.onUpdate && (
            <button class="btn" data-testid="desk-send-check-update" onClick={p.onUpdate}>
              Update shots
            </button>
          )}
          <button class="btn primary" data-testid="desk-send-check-send" onClick={p.onSend}>
            Send anyway
          </button>
        </div>
      </div>
    </div>
  );
}

function DeskHeader(p: { c: DeskController; lengthChecks: () => LengthCheck[] }) {
  const { c } = p;
  const brief = c.brief.value;
  const options = c.options.value;
  const status = c.status.value;
  const open = status === 'open';
  const run = c.exportRun.value;
  const busy = !!run || c.updating.value;
  const source = c.source.value;
  const mode = c.mode.value;
  // a brief larger than the export renders: Send says why it is off
  const tooLarge = brief ? exportSizeProblem(brief.width, brief.height) : null;
  const [check, setCheck] = useState<LengthCheck[] | null>(null);
  const send = () => {
    const checks = p.lengthChecks();
    if (checks.length) setCheck(checks);
    else void c.sendToHost();
  };
  return (
    <div class="desk-header" data-testid="desk-header" {...CHROME}>
      <div class="desk-title">
        <img class="logo" src="/icons/icon.svg" alt="" width={18} height={18} />
        <span class="desk-scene" data-testid="desk-scene-name" title={brief?.name ?? ''}>
          {brief?.name ?? '3D director’s desk'}
        </span>
        {source && (
          <span class="desk-pill hide-narrow" data-testid="desk-source" data-source={source}>
            {SOURCE_LABEL[source](options.hostName)}
          </span>
        )}
        {status === 'opening' && <span class="desk-pill">Opening…</span>}
        {options.readOnly && open && (
          <span class="desk-pill lock" data-testid="desk-read-only" title="View, play and export only">
            Read-only
          </span>
        )}
        {open && <StateStatus c={c} />}
      </div>
      <div class="desk-actions">
        {open && options.modes.length > 1 && (
          <label
            class="desk-mode hide-narrow"
            title={`The reference clip Send renders for each shot (${options.hostName} takes ${options.modes
              .map((m) => MODE_LABEL[m])
              .join(', ')})`}
          >
            <span>Follow</span>
            <select
              value={mode}
              data-testid="desk-mode"
              onChange={(e) => (c.mode.value = (e.currentTarget as HTMLSelectElement).value as Mode)}
            >
              {options.modes.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          class="btn primary"
          data-testid="desk-send"
          disabled={!open || busy || !!tooLarge}
          title={
            tooLarge ??
            `Render the ${MODE_LABEL[mode]} reference clip and a still of every shot in this browser and send them to ${options.hostName}`
          }
          onClick={send}
        >
          <Icon name="film" size={12} /> Send to {options.hostName}
        </button>
        <button
          class="btn"
          data-testid="desk-done"
          disabled={!open || c.updating.value}
          title={`Send the scene to ${options.hostName} and close`}
          onClick={() => void c.done()}
        >
          Done
        </button>
        <button
          class="btn flat"
          data-testid="desk-close"
          disabled={status === 'closed'}
          title="Close the desk"
          onClick={() => void c.close()}
        >
          <Icon name="close" size={12} />
          <span class="hide-narrow">Close</span>
        </button>
      </div>
      {check && (
        <SendCheck
          checks={check}
          host={options.hostName}
          onCancel={() => setCheck(null)}
          onUpdate={
            !options.readOnly && check.some((x) => x.byBrief)
              ? () => {
                  setCheck(null);
                  void c.updateShots();
                }
              : null
          }
          onSend={() => {
            setCheck(null);
            void c.sendToHost();
          }}
        />
      )}
    </div>
  );
}

/**
 * The Director workspace, focused: viewport, bottom tabs, Director column. The column is the
 * editor's properties area (as in its Director workspace), so the viewport's keys do nothing over
 * it or while it has the focus; the viewport takes them back on pointer or focus.
 */
function DeskEditor({ s }: { s: ProjectSession }) {
  const [rightW, setRightW] = usePersistentSize('right', 340);
  const [bottomH, setBottomH] = usePersistentSize('bottom', 170);
  return (
    <div class="main desk-main">
      <div class="column" style={{ flex: 1, minWidth: 0 }}>
        <div class="desk-viewport" onFocusIn={() => (hoveredArea.value = 'viewport')}>
          <Viewport session={s} />
        </div>
        <BottomPane s={s} initial="sequence" size={bottomH} setSize={setBottomH} tabs={DESK_BOTTOM_TABS} />
      </div>
      <Splitter
        dir="v"
        onDrag={(d) => setRightW(Math.max(240, Math.min(window.innerWidth - 300, rightW - d)))}
      />
      <div
        class="column hide-mobile desk-side"
        data-testid="desk-side"
        style={{ width: `${rightW}px`, flex: 'none' }}
        onFocusIn={() => (hoveredArea.value = 'properties')}
      >
        <Area kind="properties" style={{ flex: '1', minHeight: '0' }}>
          <DirectorPanel s={s} />
        </Area>
      </div>
    </div>
  );
}

function WorkOverlay({ work }: { work: WorkProgress | null }) {
  useTick(!!work, 500);
  if (!work) return null;
  const secs = Math.round((Date.now() - work.startedAt) / 1000);
  return (
    <div class="desk-work" data-testid="desk-work" role="status" aria-live="polite" {...CHROME}>
      <div class="desk-work-box">
        <div>{work.label}</div>
        <div class="desk-bar indeterminate">
          <div />
        </div>
        <div class="desk-work-time">
          {secs} s · the page stays responsive: the work runs in the background
        </div>
      </div>
    </div>
  );
}

export interface DeskAppProps {
  c: DeskController;
  /** What the desk is busy with (staging, opening, updating). */
  work: WorkProgress | null;
  /** The brief's shots whose clips would have another length (export.ts lengthChecks). */
  lengthChecks: () => LengthCheck[];
  /** Shown above the desk in the sample (no host). */
  sampleBar?: ComponentChildren;
}

export function DeskApp(p: DeskAppProps) {
  const { c } = p;
  const s = session.value;
  const status = c.status.value;
  return (
    <div class="app desk-app" data-testid="desk-app" data-status={status}>
      {p.sampleBar}
      <DeskHeader c={c} lengthChecks={p.lengthChecks} />
      <ExportBar c={c} />
      <ChangesBanner c={c} />
      <AckNotice c={c} />
      <NoticeLine c={c} />
      {s && status !== 'waiting' && status !== 'connected' ? (
        <DeskEditor s={s} />
      ) : (
        <div class="desk-empty" data-testid="desk-waiting" {...CHROME}>
          {status === 'waiting' || status === 'connected'
            ? `Waiting for ${status === 'waiting' ? 'the host to connect' : 'the scene'}…`
            : status === 'opening'
              ? 'Opening the scene…'
              : ''}
        </div>
      )}
      {status === 'closed' && (
        <div class="desk-work" data-testid="desk-closed" {...CHROME}>
          <div class="desk-work-box">
            <div>The desk is closed. {c.options.value.hostName} closes this panel.</div>
            <button class="btn" onClick={() => c.reopen()}>
              Back to the desk
            </button>
          </div>
        </div>
      )}
      <WorkOverlay work={p.work} />
      <PopupMenuHost />
      <Toasts />
    </div>
  );
}

/** The page opened on its own, with no host. */
export function StandalonePage({ onTry }: { onTry: () => void }) {
  return (
    <div class="welcome desk-standalone" data-testid="desk-standalone">
      <div class="welcome-inner" style={{ maxWidth: '640px' }}>
        <h1>
          <img src="/icons/icon.svg" width={28} height={28} alt="" /> 3D director&rsquo;s desk
        </h1>
        <p class="tagline">
          This page is the 3D-Editor&rsquo;s director&rsquo;s desk for other applications. A host application,
          such as rideo, opens it in a frame and sends it a scene in words; the desk stages it in 3D, renders
          each shot&rsquo;s reference clips in this browser and sends them back. Opened on its own it has no
          scene to show.
        </p>
        <div class="actions">
          <button class="btn primary" data-testid="desk-try-sample" onClick={onTry}>
            Try a sample scene
          </button>
          <a class="btn" href="/" data-testid="desk-full-editor">
            Open the full editor
          </a>
        </div>
        <p class="tagline">
          The sample stages the protocol&rsquo;s example brief (a girl and her puppy with a kite in a meadow)
          in this browser, with no host and no server: it works offline once the page has loaded.
        </p>
      </div>
    </div>
  );
}

/** The bar above the sample: what it is, the last files it would have sent, and leaving it. */
export function SampleBar(p: { files: { name: string; url: string; size: number }[]; onLeave: () => void }) {
  return (
    <div class="desk-sample" data-testid="desk-sample-bar" {...CHROME}>
      <span>Sample scene (no host): Send keeps the clips here.</span>
      {p.files.map((f) => (
        <a key={f.name} href={f.url} download={f.name} data-testid={`desk-sample-file-${f.name}`}>
          {f.name}
        </a>
      ))}
      <button class="btn flat" onClick={p.onLeave}>
        Leave the sample
      </button>
    </div>
  );
}

/** The shots of the session's scene (for the header's first show). */
export function firstShotId(s: ProjectSession): string | null {
  return getShots(s.doc)[0]?.id ?? null;
}
