import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { WebDAVClient, type ExportFormat } from '@3d-editor/core';
import {
  animationFrameCount,
  animationFrames,
  animationProblem,
  pixelsToCanvas,
  pixelsToDataUrl,
  renderOutputSize,
  renderPool,
  scaledOutputNote,
  startAnimationRender,
  type AnimationJob,
  type AnimationResult,
  type EncodeFormat,
  type FrameRender,
  type PathTraceJob,
  type PathTraceStatus,
  type PixelImage,
} from '../../render';
import { closeDialog, dialog, dialogProps, serverConfig, session, toast } from '../../app/store';
import { prefs, updatePrefs, type StorageMode } from '../../app/prefs';
import {
  createProject,
  deleteProject,
  listProjects,
  openProject,
  type ProjectListEntry,
} from '../../project/manager';
import { exportAndDownload, downloadBytes } from '../../io/import-export';
import { viewport } from '../../editor/editor';
import { SHORTCUT_HELP } from '../../editor/keymap';
import { Checkbox, NumberField, Row, SelectField, TextField } from '../fields/fields';
import { Icon } from '../icons';
import { telemetry } from '../../telemetry/telemetry';
import { resolveWebDAV } from '../../storage/webdav';

export function Modal(p: {
  title: string;
  children: ComponentChildren;
  footer?: ComponentChildren;
  width?: string;
  testId?: string;
  /** Close when the backdrop is clicked or Escape is pressed (default true; e.g. false while a render runs). */
  dismissible?: boolean;
}) {
  const dismissible = p.dismissible !== false;
  // Escape closes the dialog wherever the focus is in it: on the window, after the fields in the dialog
  // (a text or number entry being typed in uses an Escape to cancel the typing and stops it) and after
  // the render windows' own handler (an Escape that stops a running render keeps the window open)
  useEffect(() => {
    if (!dismissible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      closeDialog();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissible]);
  return (
    <div class="modal-backdrop" onPointerDown={dismissible ? closeDialog : undefined}>
      <div
        class="modal"
        style={{ width: p.width }}
        onPointerDown={(e) => e.stopPropagation()}
        data-testid={p.testId}
      >
        <div class="modal-header">
          {p.title}
          <button class="btn flat icon close" onClick={closeDialog} title="Close">
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">{p.children}</div>
        {p.footer && <div class="modal-footer">{p.footer}</div>}
      </div>
    </div>
  );
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '';
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Project list across browser storage, WebDAV and the sync server. */
export function ProjectList({ onOpened }: { onOpened?: () => void }) {
  const [list, setList] = useState<ProjectListEntry[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    void listProjects().then((r) => {
      setList(r.projects);
      setErrors(r.errors);
    });
  };
  // Re-list when the server becomes known (the welcome page renders before /api/config answers).
  const cfg = serverConfig.value;
  useEffect(refresh, [cfg]);
  const open = async (id: string) => {
    setBusy(id);
    try {
      await openProject(id);
      onOpened?.();
    } catch (err) {
      toast(`Could not open project: ${err instanceof Error ? err.message : err}`, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (!list) return <div class="hint">Loading projects…</div>;
  return (
    <>
      {errors.map((e) => (
        <div key={e} class="error-text">
          {e}
        </div>
      ))}
      {list.length === 0 && <div class="empty-note">No projects yet.</div>}
      <div class="project-grid" data-testid="project-list">
        {list.map((p) => (
          <div
            key={p.id}
            class="project-card"
            data-testid={`project-card-${p.name}`}
            onClick={() => void open(p.id)}
          >
            <div class="thumb" style={p.thumbnail ? { backgroundImage: `url(${p.thumbnail})` } : undefined}>
              {!p.thumbnail && <Icon name="cube" size={36} />}
            </div>
            <div class="meta">
              <div class="name">{busy === p.id ? 'Opening…' : p.name}</div>
              <div class="sub">
                {p.sources.map((s) => (
                  <span key={s} class={`badge ${s}`}>
                    {s === 'local' ? 'browser' : s}
                  </span>
                ))}
                {p.peers ? <span class="badge live">{p.peers} live</span> : null}
                <span>{timeAgo(p.updated_at)}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <button
                    class="btn flat icon"
                    title="Delete project"
                    data-testid={`delete-project-${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (
                        !confirm(
                          `Delete "${p.name}" everywhere (browser${p.sources.includes('webdav') ? ', WebDAV' : ''}${p.sources.includes('server') ? ', server' : ''})?`,
                        )
                      )
                        return;
                      void deleteProject(p).then(refresh);
                    }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </span>
              </div>
              {p.stats && (
                <div class="sub">
                  {p.stats.objects} objects · {p.stats.vertices.toLocaleString()} verts
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ProjectsDialog() {
  const [name, setName] = useState('Untitled');
  return (
    <Modal
      title="Projects"
      width="min(900px, 96vw)"
      testId="projects-dialog"
      footer={
        <>
          <TextField value={name} onChange={setName} placeholder="Project name" />
          <button
            class="btn primary"
            data-testid="create-project"
            onClick={() => {
              closeDialog();
              void createProject(name || 'Untitled');
            }}
          >
            <Icon name="plus" size={12} /> New Project
          </button>
        </>
      }
    >
      <ProjectList onOpened={closeDialog} />
    </Modal>
  );
}

function PreferencesDialog() {
  const p = prefs.value;
  const cfg = serverConfig.value;
  const [test, setTest] = useState<string | null>(null);
  const set = (fn: (x: typeof p) => void) => updatePrefs((x) => (fn(x), x));
  const target = resolveWebDAV();
  return (
    <Modal
      title="Preferences"
      width="560px"
      testId="preferences-dialog"
      footer={
        <button class="btn primary" onClick={closeDialog}>
          Done
        </button>
      }
    >
      <h4 style={{ margin: '4px 0 8px' }}>Storage</h4>
      <Row label="Save projects to">
        <SelectField
          value={p.storage.mode}
          testId="storage-mode"
          options={[
            {
              value: 'auto',
              label: cfg?.webdav ? 'Auto (server WebDAV)' : 'Auto (browser unless WebDAV set)',
            },
            { value: 'browser', label: 'This browser only (IndexedDB)' },
            { value: 'webdav', label: 'WebDAV server' },
          ]}
          onChange={(v) => set((x) => (x.storage.mode = v as StorageMode))}
        />
      </Row>
      <Row label="WebDAV URL">
        <TextField
          value={p.storage.webdav.url}
          placeholder="https://dav.example.com/remote.php/dav/files/me"
          testId="webdav-url"
          onChange={(v) => set((x) => (x.storage.webdav.url = v.trim()))}
        />
      </Row>
      <Row label="Username">
        <TextField
          value={p.storage.webdav.username}
          testId="webdav-username"
          onChange={(v) => set((x) => (x.storage.webdav.username = v))}
        />
      </Row>
      <Row label="Password">
        <TextField
          type="password"
          value={p.storage.webdav.password}
          testId="webdav-password"
          onChange={(v) => set((x) => (x.storage.webdav.password = v))}
        />
      </Row>
      <Row label="Folder">
        <TextField
          value={p.storage.webdav.basePath}
          testId="webdav-base"
          onChange={(v) => set((x) => (x.storage.webdav.basePath = v || '/'))}
        />
      </Row>
      <Row label="">
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            class="btn"
            data-testid="webdav-test"
            onClick={async () => {
              const url = p.storage.webdav.url;
              if (!url) return setTest('Enter a WebDAV URL first');
              setTest('Testing…');
              const r = await new WebDAVClient({
                url,
                username: p.storage.webdav.username,
                password: p.storage.webdav.password,
              }).check();
              setTest(r.ok ? 'Connected ✓' : `Failed: ${r.message ?? r.status}`);
            }}
          >
            Test Connection
          </button>
          <span class="hint" data-testid="webdav-test-result">
            {test}
          </span>
        </div>
      </Row>
      <div class="hint">
        Currently saving to:{' '}
        <b data-testid="storage-target">{target ? target.label : 'this browser (IndexedDB)'}</b>. Projects are
        always cached in the browser so they work offline; with WebDAV they are merged and saved to the server
        whenever you are online. A WebDAV server used directly from the browser must allow CORS. Changes apply
        to projects opened from now on.
      </div>
      <h4 style={{ margin: '14px 0 8px' }}>Collaboration</h4>
      <Row label="">
        <Checkbox
          value={p.sync.enabled}
          label="Real-time sync with the editor server"
          onChange={(v) => set((x) => (x.sync.enabled = v))}
        />
      </Row>
      <Row label="Server URL">
        <TextField
          value={p.sync.serverUrl}
          placeholder="(same origin)"
          onChange={(v) => set((x) => (x.sync.serverUrl = v.trim()))}
        />
      </Row>
      <Row label="Access token">
        <TextField
          type="password"
          value={p.sync.token}
          placeholder="(only if the server requires one)"
          onChange={(v) => set((x) => (x.sync.token = v.trim()))}
        />
      </Row>
      <Row label="Your name">
        <TextField
          value={p.userName}
          testId="user-name"
          onChange={(v) => set((x) => (x.userName = v || x.userName))}
        />
      </Row>
      <Row label="Color">
        <input
          type="color"
          value={p.userColor.startsWith('#') ? p.userColor : '#e87d0d'}
          onInput={(e) => set((x) => (x.userColor = (e.target as HTMLInputElement).value))}
        />
      </Row>
      <div class="hint">
        Server:{' '}
        {cfg
          ? `connected (v${cfg.version}, persistence: ${cfg.persistence})`
          : 'not reachable — working offline/local only'}
      </div>
      <h4 style={{ margin: '14px 0 8px' }}>Input</h4>
      <Row label="">
        <Checkbox
          value={p.ui.emulate3Button}
          label="Emulate 3-button mouse (Alt+LMB navigates)"
          onChange={(v) => set((x) => (x.ui.emulate3Button = v))}
        />
      </Row>
      <Row label="">
        <Checkbox
          value={p.ui.invertZoom}
          label="Invert zoom direction"
          onChange={(v) => set((x) => (x.ui.invertZoom = v))}
        />
      </Row>
      <Row label="Orbit speed">
        <NumberField
          value={p.ui.orbitSensitivity}
          min={0.1}
          max={4}
          step={0.01}
          slider
          onChange={(v) => set((x) => (x.ui.orbitSensitivity = v))}
        />
      </Row>
      <h4 style={{ margin: '14px 0 8px' }}>Privacy</h4>
      <Row label="">
        <Checkbox
          value={p.telemetry}
          label="Send anonymous usage & performance telemetry"
          testId="telemetry-toggle"
          onChange={(v) => set((x) => (x.telemetry = v))}
        />
      </Row>
      <div class="hint">
        Telemetry contains operator names, timings, counts and errors — never geometry, names or file
        contents. It helps improve the editor and is only sent to this app's server
        {cfg?.features.telemetry ? '' : ' (currently disabled by the server)'}.
      </div>
    </Modal>
  );
}

function ExportDialog() {
  const [format, setFormat] = useState<ExportFormat>((dialogProps.value.format as ExportFormat) ?? 'glb');
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [applyModifiers, setApplyModifiers] = useState(true);
  return (
    <Modal
      title="Export"
      width="420px"
      testId="export-dialog"
      footer={
        <button
          class="btn primary"
          data-testid="export-confirm"
          onClick={() => {
            closeDialog();
            exportAndDownload(format, { selectedOnly, applyModifiers });
          }}
        >
          Export
        </button>
      }
    >
      <Row label="Format">
        <SelectField
          value={format}
          testId="export-format"
          options={[
            { value: 'glb', label: 'glTF 2.0 Binary (.glb)' },
            { value: 'gltf', label: 'glTF 2.0 Embedded (.gltf)' },
            { value: 'obj', label: 'Wavefront (.obj)' },
            { value: 'stl', label: 'STL (.stl)' },
            { value: 'ply', label: 'Stanford (.ply)' },
          ]}
          onChange={(v) => setFormat(v as ExportFormat)}
        />
      </Row>
      <Row label="">
        <Checkbox value={selectedOnly} label="Selected objects only" onChange={setSelectedOnly} />
      </Row>
      <Row label="">
        <Checkbox value={applyModifiers} label="Apply modifiers" onChange={setApplyModifiers} />
      </Row>
    </Modal>
  );
}

// ------------------------------------------------------------------ render window (F12, Ctrl+F12)

/** Elapsed time like Blender's render info: "00:12.34" (minutes:seconds). */
export function formatRenderTime(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Bytes of a base64 data URL. */
function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.split(',')[1] ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** File name of a render: the project name (made safe) and an extension. */
function renderFileName(ext: string, suffix = ''): string {
  const base = (session.value?.doc.name ?? 'render').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'render';
  return `${base}${suffix}.${ext}`;
}

const RENDER_CANVAS_STYLE = {
  maxWidth: '100%',
  maxHeight: '70vh',
  display: 'block',
  margin: '0 auto',
  background: 'repeating-conic-gradient(#3a3a3a 0% 25%, #2e2e2e 0% 50%) 50% / 20px 20px',
} as const;

/** Re-renders the calling component (at most once per animation frame) while `source` reports changes. */
function useLiveUpdates(source: { subscribe(fn: () => void): () => void } | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!source) return;
    let raf = 0;
    const off = source.subscribe(() => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setTick((t) => t + 1);
        });
    });
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [source]);
}

/** Re-renders the calling component every `ms` milliseconds while `active` (a running clock). */
function useTicker(active: boolean, ms = 250): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(h);
  }, [active, ms]);
}

/** Calls `onEscape` for the Escape key while mounted (before the dialog and editor keymaps). */
function useEscape(onEscape: () => boolean): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onEscape]);
}

/** A path traced render shown progressively: changed rows are drawn on animation frames. */
function PathTraceCanvas({ job, testId }: { job: PathTraceJob; testId?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = job.width;
    canvas.height = job.height;
    const image = new ImageData(job.width, job.height);
    let raf = 0;
    const draw = () => {
      raf = 0;
      const rows = job.takeDirtyRows();
      if (!rows) return;
      const [y0, y1] = rows;
      const W = job.width;
      image.data.set(job.pixels.subarray(y0 * W * 4, y1 * W * 4), y0 * W * 4);
      ctx.putImageData(image, 0, 0, 0, y0, W, y1 - y0);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const off = job.subscribe(schedule);
    schedule();
    return () => {
      off();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [job]);
  return (
    <canvas ref={ref} data-testid={testId} aria-label="Render in progress" style={RENDER_CANVAS_STYLE} />
  );
}

/** A finished frame (RGBA8 pixels) on a canvas. */
function PixelsCanvas({ img, testId }: { img: PixelImage; testId?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) pixelsToCanvas(img, ref.current);
  }, [img]);
  return <canvas ref={ref} data-testid={testId} style={RENDER_CANVAS_STYLE} />;
}

function ProgressBar({ fraction, label, testId }: { fraction: number; label: string; testId?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      data-testid={testId}
      style={{
        height: '6px',
        background: 'var(--bg-input-dark)',
        borderRadius: '3px',
        overflow: 'hidden',
        margin: '6px 0 2px',
      }}
    >
      <div
        style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', transition: 'width 120ms' }}
      />
    </div>
  );
}

const PHASE_TEXT: Record<PathTraceStatus['phase'], string> = {
  preparing: 'Preparing scene',
  rendering: 'Path Tracing',
  finishing: 'Denoising',
  done: 'Finished',
  cancelled: 'Cancelled',
  failed: 'Failed',
};

/** Blender-style render info line of a path traced render. */
export function pathTraceInfo(
  job: Pick<PathTraceJob, 'status' | 'elapsedMs' | 'width' | 'height'>,
  frame: number,
): string {
  const st = job.status;
  const parts = [`Frame ${frame}`, `Time ${formatRenderTime(job.elapsedMs)}`];
  if (st.phase === 'rendering' || st.phase === 'cancelled' || st.phase === 'done')
    parts.push(st.total ? `Sample ${st.samples}/${st.total}` : `Sample ${st.samples}`);
  if (st.phase === 'finishing') parts.push(job.status.total ? 'Denoising' : 'Finishing');
  if (st.threads)
    parts.push(`${st.threads} thread${st.threads === 1 ? '' : 's'}${st.limitedByMemory ? ' (memory)' : ''}`);
  parts.push(`${job.width}×${job.height}`);
  return parts.join(' | ');
}

/** Progress of the path traced frame of an animation render: its phase or its samples. */
function frameRenderInfo(job: PathTraceJob): string {
  const st = job.status;
  if (st.phase === 'preparing') return 'Preparing scene';
  if (st.phase === 'finishing') return 'Denoising';
  return `Sample ${st.samples}/${st.total || '…'}`;
}

type StillRender = (
  | { kind: 'raster'; img: { dataUrl: string; width: number; height: number; ms: number } }
  | { kind: 'path'; job: PathTraceJob; frame: number }
) & {
  /** Says that the output was scaled down to the browser's size limit (null when it was not). */
  sizeNote: string | null;
};

/** The note of the render windows when the output settings ask for more than the browser renders. */
function outputSizeNote(): string | null {
  const r = session.value?.doc.getRender();
  return r
    ? scaledOutputNote(renderOutputSize(r.resolution_x, r.resolution_y, r.resolution_percentage))
    : null;
}

/** F12: renders the scene camera at the output resolution (WebGL, or path traced on the workers). */
function RenderImageDialog() {
  const [render, setRender] = useState<StillRender | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  /** Bumped by Render Again (the effect below starts a new render). */
  const [pass, setPass] = useState(0);
  useEffect(() => {
    setRender(null);
    setError(null);
    setFinalUrl(null);
    const e = viewport.engine;
    if (!e) {
      setError('No viewport available');
      return;
    }
    const t0 = performance.now();
    let job: PathTraceJob | null = null;
    // let the dialog paint first
    const h = setTimeout(() => {
      const sizeNote = outputSizeNote();
      try {
        if (e.pathTraces()) {
          job = e.startPathTrace();
          const frame = session.value?.state.frame ?? 1;
          setRender({ kind: 'path', job, frame, sizeNote });
          telemetry.count('editor.render.pathtrace');
          job.result.then(
            (r) => {
              setFinalUrl(pixelsToDataUrl(r));
              telemetry.histogram('editor.render.pathtrace_ms', r.elapsedMs);
            },
            (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
          );
        } else
          e.renderImage()
            .then((r) => setRender({ kind: 'raster', img: { ...r, ms: performance.now() - t0 }, sizeNote }))
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 30);
    return () => {
      clearTimeout(h);
      job?.cancel();
    };
  }, [pass]);
  const job = render?.kind === 'path' ? render.job : null;
  useLiveUpdates(job);
  // the clock keeps running between status changes (e.g. while the workers prepare the scene)
  useTicker(!!job?.running);
  const onEscape = useCallback(() => {
    if (!job?.running) return false;
    job.cancel();
    return true;
  }, [job]);
  useEscape(onEscape);
  const url = render?.kind === 'raster' ? render.img.dataUrl : finalUrl;
  const st = job?.status;
  return (
    <Modal
      title={job ? 'Render (Path Tracer)' : 'Render'}
      width="min(1100px, 96vw)"
      testId="render-dialog"
      dismissible={!job?.running}
      footer={
        <>
          {job?.running && (
            <button
              class="btn"
              data-testid="render-cancel"
              title="Stop sampling and keep the image as it is (Esc)"
              onClick={() => job.cancel()}
            >
              Cancel
            </button>
          )}
          {(render || error) && !job?.running && (
            <button
              class="btn"
              data-testid="render-again"
              title="Render the scene again as it is now"
              onClick={() => setPass((n) => n + 1)}
            >
              Render Again
            </button>
          )}
          {url && (
            <button
              class="btn primary"
              data-testid="render-save"
              onClick={() => {
                downloadBytes(dataUrlBytes(url), renderFileName('png'), 'image/png');
                telemetry.count('editor.render.saved');
              }}
            >
              Save Image
            </button>
          )}
        </>
      }
    >
      <div class="render-view">
        {error && <div class="error-text">{error}</div>}
        {!render && !error && <div class="hint">Rendering…</div>}
        {job && !url && <PathTraceCanvas job={job} testId="render-canvas" />}
        {url && <img src={url} alt="Render result" data-testid="render-image" />}
        {render?.kind === 'raster' && (
          <div class="hint" style={{ textAlign: 'center', marginTop: '6px' }}>
            {render.img.width}×{render.img.height} · {render.img.ms.toFixed(0)} ms
          </div>
        )}
        {job && st && (
          <div style={{ marginTop: '6px' }}>
            {job.running && (
              <ProgressBar
                fraction={st.phase === 'finishing' ? 1 : st.fraction}
                label="Render progress"
                testId="render-progress"
              />
            )}
            <div class="hint" style={{ textAlign: 'center' }} data-testid="render-status">
              <b>{PHASE_TEXT[st.phase]}</b> | {pathTraceInfo(job, render?.kind === 'path' ? render.frame : 1)}
              {st.phase === 'done' &&
                job.status.total > 0 &&
                (job.status.samples < job.status.total ? ' | time limit' : '')}
            </div>
            {job.warnings.map((w) => (
              <div key={w} class="hint" style={{ color: 'var(--warn)', textAlign: 'center' }}>
                {w}
              </div>
            ))}
          </div>
        )}
        {render?.sizeNote && (
          <div
            class="hint"
            style={{ color: 'var(--warn)', textAlign: 'center' }}
            data-testid="render-size-note"
          >
            {render.sizeNote}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Ctrl+F12: renders the frame range into an animated PNG or GIF. */
function RenderAnimationDialog() {
  const s = session.value;
  // Redraw on document changes: an MCP agent or a collaborator can change the engine, the
  // resolution or the frame range while the window is open, and Render uses them as they are then.
  void s?.revision.value;
  const sc = s?.doc.getScene();
  const rs = s?.doc.getRender();
  const pathTrace = rs?.engine === 'PATHTRACER';
  const [format, setFormat] = useState<EncodeFormat>('APNG');
  // frame range, resolution % and samples follow the scene's settings until changed in this window
  const [startEdit, setStart] = useState<number | null>(null);
  const [endEdit, setEnd] = useState<number | null>(null);
  const [step, setStep] = useState(1);
  const [percentEdit, setPercent] = useState<number | null>(null);
  const [samplesEdit, setSamples] = useState<number | null>(null);
  const [timeLimit, setTimeLimit] = useState(0);
  const start = startEdit ?? sc?.frame_start ?? 1;
  const end = endEdit ?? sc?.frame_end ?? 1;
  const percent = percentEdit ?? rs?.resolution_percentage ?? 100;
  const samples = samplesEdit ?? rs?.samples ?? 64;
  const [job, setJob] = useState<AnimationJob | null>(null);
  const [result, setResult] = useState<AnimationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resultUrl = useMemo(
    () => (result ? URL.createObjectURL(new Blob([result.data as BlobPart], { type: result.mime })) : null),
    [result],
  );
  useEffect(() => () => void (resultUrl && URL.revokeObjectURL(resultUrl)), [resultUrl]);
  useEffect(() => () => job?.cancel(), [job]);
  useLiveUpdates(job);
  /** The path traced render of the frame being rendered (its samples and phase change within the frame). */
  const current = job?.current?.job ?? null;
  useLiveUpdates(current);
  useTicker(!!job?.running);
  const onEscape = useCallback(() => {
    if (!job?.running) return false;
    job.cancel();
    return true;
  }, [job]);
  useEscape(onEscape);
  if (!s || !sc || !rs) return null;
  // the output size, scaled down uniformly (same framing) when larger than the browser renders
  const size = renderOutputSize(rs.resolution_x, rs.resolution_y, percent);
  const { width, height } = size;
  const sizeNote = scaledOutputNote(size);
  const frameCount = animationFrameCount(start, end, step);
  const fps = sc.fps / Math.max(1, step);
  const problem = animationProblem(format, width, height, frameCount);
  const running = !!job?.running;
  const begin = () => {
    if (problem) return setError(problem);
    const frames = animationFrames(start, end, step);
    const e = viewport.engine;
    if (!e) return setError('No viewport available');
    setError(null);
    setResult(null);
    const nextPaint = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const renderFrame = (frame: number): FrameRender => {
      if (!pathTrace)
        return {
          // one frame per animation frame, so the window keeps updating; multisampled, so that
          // every frame gets the same anti-aliasing (ViewportEngine.finalSampling)
          done: nextPaint().then(() => e.renderPixels({ frame, width, height, animation: true })),
          cancel: () => undefined,
        };
      const pt = e.startPathTrace({
        frame,
        width,
        height,
        samples,
        time_limit: timeLimit > 0 ? timeLimit : undefined,
      });
      return { done: pt.result, cancel: () => pt.cancel(), job: pt };
    };
    const j = startAnimationRender(renderPool(), {
      format,
      frames,
      width,
      height,
      fps,
      renderFrame,
    });
    setJob(j);
    telemetry.count('editor.render.animation', 1, { 'render.format': format, 'render.engine': rs.engine });
    j.result.then(setResult, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };
  const st = job?.status;
  return (
    <Modal
      title="Render Animation"
      width="min(1100px, 96vw)"
      testId="render-animation-dialog"
      dismissible={!running}
      footer={
        <>
          {running ? (
            <button
              class="btn"
              data-testid="render-animation-cancel"
              disabled={!job?.cancellable}
              title={
                job?.cancellable
                  ? 'Stop and keep the frames rendered so far (Esc)'
                  : 'Every frame is rendered: the file is being finished'
              }
              onClick={() => job?.cancel()}
            >
              Cancel
            </button>
          ) : (
            <button
              class={`btn ${result ? '' : 'primary'}`}
              data-testid="render-animation-start"
              disabled={!!problem}
              title={problem ?? `Render ${frameCount} frames`}
              onClick={begin}
            >
              {result ? 'Render Again' : 'Render'}
            </button>
          )}
          {result && resultUrl && (
            <button
              class="btn primary"
              data-testid="render-animation-save"
              onClick={() => {
                downloadBytes(result.data, renderFileName(result.extension), result.mime);
                telemetry.count('editor.render.animation_saved');
              }}
            >
              Save Animation
            </button>
          )}
        </>
      }
    >
      {!running && !result && (
        <div data-testid="render-animation-settings" style={{ maxWidth: '480px', margin: '0 auto' }}>
          <Row label="Format">
            <SelectField
              value={format}
              testId="render-animation-format"
              options={[
                { value: 'APNG', label: 'Animated PNG (lossless)' },
                { value: 'GIF', label: 'GIF (256 colours)' },
              ]}
              onChange={(v) => setFormat(v)}
            />
          </Row>
          <Row label="Frame Start">
            <NumberField
              value={start}
              integer
              step={1}
              testId="render-animation-start-frame"
              onChange={setStart}
            />
          </Row>
          <Row label="End">
            <NumberField value={end} integer step={1} testId="render-animation-end-frame" onChange={setEnd} />
          </Row>
          <Row label="Step">
            <NumberField value={step} integer min={1} max={1000} step={1} onChange={setStep} />
          </Row>
          <Row label="Resolution %">
            <NumberField
              value={percent}
              integer
              min={1}
              max={100}
              slider
              unit="%"
              testId="render-animation-percent"
              onChange={setPercent}
            />
          </Row>
          {pathTrace && (
            <>
              <Row label="Samples" title="Samples per pixel of every frame">
                <NumberField
                  value={samples}
                  integer
                  min={1}
                  max={4096}
                  step={1}
                  testId="render-animation-samples"
                  onChange={setSamples}
                />
              </Row>
              <Row
                label="Time Limit"
                title="Seconds per frame (0 = none); frames stop sampling when it runs out"
              >
                <NumberField
                  value={timeLimit}
                  min={0}
                  max={3600}
                  step={0.5}
                  unit=" s"
                  onChange={setTimeLimit}
                />
              </Row>
            </>
          )}
          <div class="hint" style={{ marginTop: '6px' }}>
            {frameCount} frame{frameCount === 1 ? '' : 's'} · {width}×{height} px ·{' '}
            {Math.round(fps * 100) / 100} fps ·{' '}
            {pathTrace ? 'Path Tracer (render workers)' : 'Rasterized (WebGL)'}
          </div>
          {sizeNote && (
            <div class="hint" style={{ color: 'var(--warn)' }} data-testid="render-animation-size-note">
              {sizeNote}
            </div>
          )}
          {problem && <div class="error-text">{problem}</div>}
        </div>
      )}
      {error && <div class="error-text">{error}</div>}
      {!running && !result && st?.phase === 'cancelled' && (
        <div class="hint" style={{ textAlign: 'center' }} data-testid="render-animation-cancelled">
          Cancelled before the first frame was finished: nothing to save.
        </div>
      )}
      {running && st && (
        <div class="render-view">
          {current ? (
            <PathTraceCanvas key={current.id} job={current} testId="render-animation-canvas" />
          ) : job?.lastFrame ? (
            <PixelsCanvas img={job.lastFrame} testId="render-animation-canvas" />
          ) : (
            <div class="hint" style={{ textAlign: 'center' }}>
              Rendering frame {st.frame}…
            </div>
          )}
          <ProgressBar
            fraction={(st.index + (current ? current.status.fraction : 0)) / Math.max(1, st.total)}
            label="Animation progress"
            testId="render-animation-progress"
          />
          <div class="hint" style={{ textAlign: 'center' }} data-testid="render-animation-status">
            <b>{st.phase === 'encoding' ? 'Encoding' : 'Rendering'}</b> | Frame {st.frame} (
            {Math.min(st.index + 1, st.total)}/{st.total}) | Time {formatRenderTime(job!.elapsedMs)}
            {current && st.phase === 'rendering' ? ` | ${frameRenderInfo(current)}` : ''}
          </div>
        </div>
      )}
      {result && resultUrl && (
        <div class="render-view">
          <img src={resultUrl} alt="Rendered animation" data-testid="render-animation-result" />
          <div
            class="hint"
            style={{ textAlign: 'center', marginTop: '6px' }}
            data-testid="render-animation-info"
          >
            {result.cancelled ? 'Cancelled: ' : ''}
            {result.frames.length} frame{result.frames.length === 1 ? '' : 's'} ({result.frames[0]}–
            {result.frames[result.frames.length - 1]}) · {result.width}×{result.height} ·{' '}
            {Math.round(result.fps * 100) / 100} fps · {(result.data.length / 1024).toFixed(0)} KB ·{' '}
            {formatRenderTime(result.elapsedMs)}
          </div>
        </div>
      )}
    </Modal>
  );
}

function RenderDialog() {
  return dialogProps.value.animation ? <RenderAnimationDialog /> : <RenderImageDialog />;
}

function AboutDialog() {
  const cfg = serverConfig.value;
  return (
    <Modal title="About 3D Editor" width="460px">
      <p>
        <b>3D Editor</b> v{__APP_VERSION__} — a collaborative, offline-capable 3D modeling, animation and
        rendering tool for the browser, inspired by Blender's workflow.
      </p>
      <p class="hint">
        Server:{' '}
        {cfg
          ? `v${cfg.version} · MCP ${cfg.features.mcp ? 'enabled at /mcp' : 'disabled'} · persistence ${cfg.persistence}`
          : 'offline'}
      </p>
      <p class="hint">Licensed under the GNU GPL v3.</p>
    </Modal>
  );
}

function ShortcutsDialog() {
  return (
    <Modal title="Keyboard & Mouse" width="760px">
      {SHORTCUT_HELP.map(([k, v]) => (
        <div
          key={k}
          style={{
            display: 'grid',
            gridTemplateColumns: '110px 1fr',
            gap: '8px',
            padding: '4px 0',
            borderBottom: '1px solid #333',
          }}
        >
          <b>{k}</b>
          <span>{v}</span>
        </div>
      ))}
    </Modal>
  );
}

export function DialogHost() {
  switch (dialog.value) {
    case 'projects':
      return <ProjectsDialog />;
    case 'preferences':
      return <PreferencesDialog />;
    case 'export':
      return <ExportDialog />;
    case 'render':
      return <RenderDialog />;
    case 'about':
      return <AboutDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    default:
      return null;
  }
}
