import { render } from 'preact';
import { signal } from '@preact/signals';
import { getShots } from '@3d-editor/core';
import '../ui/styles.css';
import { session, workspace as workspaceSignal } from '../app/store';
import { registerUiOperators } from '../editor/ui-operators';
import { hoveredArea, registry, runResult } from '../editor/editor';
import { installKeymap } from '../editor/keymap';
import { browserExportSupport } from '../export';
import { selectedShot } from '../ui/director/state';
import { showShot } from '../ui/director/playback';
import { DeskBridge } from './bridge';
import { DeskController } from './controller';
import { DeskApp, SampleBar, StandalonePage } from './DeskApp';
import { lengthChecks, wakeLockAllowed } from './export';
import { DESK_IGNORED_KEYS, guardRegistry } from './guards';
import type { DeskMessage } from './protocol';
import { registerDeskServiceWorker } from './pwa';
import { SAMPLE_BRIEF } from './sample';
import { StagingClient } from './staging';
import { DeskWorkspace, type WorkProgress } from './workspace';

/*
 * The embeddable director's desk (desk.html; docs/embedding.md). Unlike the editor's entry
 * (main.tsx) it never asks a server for its configuration and starts no telemetry, RPC, live sync,
 * server WebDAV, server probe, launch queue or file handlers: everything stays in this browser
 * (IndexedDB), and after the page has loaded it makes no network requests (its workers' scripts come
 * from the service worker's cache). Inside a frame it talks to its host through the desk embed
 * protocol (bridge.ts, controller.ts); opened on its own it explains itself and offers a sample.
 */

const bootStart = performance.now();
registerUiOperators(registry);
workspaceSignal.value = 'Director';
let readOnly = false;
guardRegistry(registry, () => readOnly);
installKeymap({ ignore: DESK_IGNORED_KEYS });
// the viewport's keys act once the pointer or the focus is in the viewport (DeskApp.tsx), not before
hoveredArea.value = 'other';
void registerDeskServiceWorker();
// an export keeps the screen on only where the permissions policy lets this frame do so (the host's
// iframe `allow` names screen-wake-lock): elsewhere it never asks, so the host sees no policy violation
if (!wakeLockAllowed()) {
  try {
    Object.defineProperty(navigator, 'wakeLock', { value: undefined, configurable: true });
  } catch {
    // a navigator that keeps its wakeLock: the export's request is refused, as before
  }
}

const work = signal<WorkProgress | null>(null);
const staging = new StagingClient();
// the worker's script loads with the page (no request goes out when the first brief comes)
staging.warm();
const scene = new DeskWorkspace(staging, (w) => (work.value = w));

/** When the scene opens: look through the first shot's camera, the shot selected. */
function showFirstShot(): void {
  const s = session.peek();
  if (!s) return;
  const first = getShots(s.doc).find((x) => x.enabled);
  if (!first) return;
  selectedShot.value = first.id;
  showShot(s, first.id);
}

function makeController(send: (m: DeskMessage, transfer?: Transferable[]) => boolean): DeskController {
  const c = new DeskController({
    send,
    workspace: scene,
    exportSupport: (o) => browserExportSupport(o),
    deskVersion: __APP_VERSION__,
  });
  c.options.subscribe((o) => (readOnly = o.readOnly));
  c.status.subscribe((st) => {
    if (st === 'open') showFirstShot();
  });
  return c;
}

const root = document.getElementById('app')!;
const timings = { bootMs: 0, helloAt: 0, readyAt: 0 };
/** When each progress message went to the host (the tests check the pacing by the desk's own clock). */
const progressSent: { id: string; phase: string; done: number; at: number }[] = [];

/** The scene's objects, as the tests read them (a key that deletes objects changes the count). */
function objectsNow(): number {
  const s = session.peek();
  return s ? s.doc.objectIds().length : 0;
}

/** The scene's shots as the tests and measurements read them: desk id, host shot id, name, frames. */
function shotsNow() {
  const s = session.peek();
  if (!s) return [];
  return getShots(s.doc).map((x) => ({
    id: x.id,
    host: x.external?.source === 'host' ? (x.external.shot ?? null) : null,
    name: x.name,
    frames: x.frame_end - x.frame_start + 1,
  }));
}

/** A small scripting hook for the end-to-end tests and measurements (window.__desk). */
function exposeHook(c: DeskController): void {
  Object.assign(window, {
    __desk: {
      controller: c,
      workspace: scene,
      run: runResult,
      timings,
      progressSent: () => progressSent.slice(),
      shots: shotsNow,
      objects: objectsNow,
    },
  });
}

/** The brief's shots whose clips would have another length than the brief's (the Send check). */
function briefLengthChecks(c: DeskController) {
  const s = session.peek();
  const brief = c.brief.peek();
  return s && brief ? lengthChecks(s.doc, brief) : [];
}

function Embedded({ c }: { c: DeskController }) {
  return <DeskApp c={c} work={work.value} lengthChecks={() => briefLengthChecks(c)} />;
}

const sampleFiles = signal<{ name: string; url: string; size: number }[]>([]);

function Sample({ c }: { c: DeskController }) {
  return (
    <DeskApp
      c={c}
      work={work.value}
      lengthChecks={() => briefLengthChecks(c)}
      sampleBar={<SampleBar files={sampleFiles.value} onLeave={() => location.reload()} />}
    />
  );
}

/** Runs the desk on the contract's example brief, with this page as its host (manual and offline checks). */
async function startSample(): Promise<void> {
  const c = makeController((m) => {
    if (m.type === 'result') {
      for (const f of sampleFiles.peek()) URL.revokeObjectURL(f.url);
      sampleFiles.value = m.files.map((f) => ({
        name: f.name,
        url: URL.createObjectURL(new Blob([f.data], { type: f.mime })),
        size: f.data.byteLength,
      }));
    }
    if (m.type === 'close') location.reload();
    console.info('[desk sample] the desk sends', m.type, m);
    return true;
  });
  exposeHook(c);
  render(<Sample c={c} />, root);
  await c.connected(`${location.origin}#sample`);
  c.message({
    type: 'open',
    scene: SAMPLE_BRIEF,
    state: null,
    options: { hostName: 'the sample', modes: ['camera', 'motion', 'pose'], defaultMode: 'camera' },
  });
}

if (window.parent !== window) {
  let bridge: DeskBridge | null = null;
  const c = makeController((m, transfer) => {
    if (m.type === 'ready') timings.readyAt = performance.now();
    if (m.type === 'progress')
      progressSent.push({ id: m.id, phase: m.phase, done: m.done, at: performance.now() });
    return bridge?.send(m, transfer) ?? false;
  });
  bridge = new DeskBridge(window, {
    connected: (origin) => void c.connected(origin),
    message: (m) => c.message(m),
  });
  exposeHook(c);
  render(<Embedded c={c} />, root);
  const hello = () => {
    timings.helloAt = performance.now();
    bridge!.start();
  };
  if (document.readyState === 'complete') hello();
  else window.addEventListener('load', hello, { once: true });
} else {
  render(<StandalonePage onTry={() => void startSample()} />, root);
}
timings.bootMs = performance.now() - bootStart;
