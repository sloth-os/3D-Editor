import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { WebDAVClient, type ExportFormat } from '@3d-editor/core';
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
}) {
  return (
    <div class="modal-backdrop" onPointerDown={closeDialog}>
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

function RenderDialog() {
  const [img, setImg] = useState<{ dataUrl: string; width: number; height: number; ms: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const e = viewport.engine;
    if (!e) return setError('No viewport available');
    const t0 = performance.now();
    // let the dialog paint first
    const h = setTimeout(() => {
      e.renderImage()
        .then((r) => setImg({ ...r, ms: performance.now() - t0 }))
        .catch((err) => setError(String(err)));
    }, 30);
    return () => clearTimeout(h);
  }, []);
  return (
    <Modal
      title="Render"
      width="min(1100px, 96vw)"
      testId="render-dialog"
      footer={
        img && (
          <button
            class="btn primary"
            data-testid="render-save"
            onClick={() => {
              const bin = atob(img.dataUrl.split(',')[1]);
              const bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              downloadBytes(bytes, `${session.value?.doc.name ?? 'render'}.png`, 'image/png');
              telemetry.count('editor.render.saved');
            }}
          >
            Save Image
          </button>
        )
      }
    >
      <div class="render-view">
        {error && <div class="error-text">{error}</div>}
        {!img && !error && <div class="hint">Rendering…</div>}
        {img && (
          <>
            <img src={img.dataUrl} alt="Render result" data-testid="render-image" />
            <div class="hint" style={{ textAlign: 'center', marginTop: '6px' }}>
              {img.width}×{img.height} · {img.ms.toFixed(0)} ms
            </div>
          </>
        )}
      </div>
    </Modal>
  );
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
