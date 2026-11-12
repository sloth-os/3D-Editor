import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { session, workspace, toasts, serverConfig, online, openDialog, type Workspace } from '../app/store';
import { prefs } from '../app/prefs';
import { MenuButton, PopupMenuHost, CommandPalette } from './Menu';
import { EDIT_MENU, FILE_MENU, HELP_MENU, RENDER_MENU } from '../editor/menus';
import { Outliner } from './Outliner';
import { Properties } from './properties/Properties';
import { Timeline } from './Timeline';
import { InfoLog, Console, Diagnostics } from './InfoLog';
import { Viewport } from './Viewport';
import { DopeSheet } from './DopeSheet';
import { UVEditor } from './UVEditor';
import { DialogHost, ProjectList } from './dialogs/Dialogs';
import { hoveredArea, run } from '../editor/editor';
import { createProject } from '../project/manager';
import { Icon } from './icons';
import {
  LOAD_REFUSED_NOTE,
  deletedOnServerNote,
  refusedOnServerNote,
  type ProjectSession,
} from '../project/session';
import { pwaUpdate, applyPwaUpdate } from '../pwa/register';

function Splitter({ dir, onDrag }: { dir: 'v' | 'h'; onDrag: (delta: number) => void }) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);
  return (
    <div
      class={`splitter ${dir} ${dragging ? 'dragging' : ''}`}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        last.current = dir === 'v' ? e.clientX : e.clientY;
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const cur = dir === 'v' ? e.clientX : e.clientY;
        onDrag(cur - last.current);
        last.current = cur;
      }}
      onPointerUp={() => setDragging(false)}
    />
  );
}

function usePersistentSize(key: string, initial: number): [number, (v: number) => void] {
  const [v, setV] = useState(() => Number(localStorage.getItem(`3d-editor:size:${key}`)) || initial);
  return [
    v,
    (n: number) => {
      setV(n);
      localStorage.setItem(`3d-editor:size:${key}`, String(Math.round(n)));
    },
  ];
}

function Presence({ s }: { s: ProjectSession }) {
  const peers = s.peers.value;
  const following = s.view.following.value;
  const me = prefs.value;
  return (
    <div class="presence" data-testid="presence">
      <div class="avatar" title={`${me.userName} (you)`} style={{ background: me.userColor }}>
        {me.userName.slice(0, 1)}
      </div>
      {peers.map((p) => (
        <div
          key={p.clientId}
          class={`avatar ${following === p.clientId ? 'following' : ''}`}
          title={`${p.state.user.name}${p.state.user.kind === 'agent' ? ' (AI agent)' : ''} — click to ${following === p.clientId ? 'stop following' : 'follow their view'}`}
          style={{ background: p.state.user.color }}
          data-testid="peer-avatar"
          onClick={() => (s.view.following.value = following === p.clientId ? null : p.clientId)}
        >
          {p.state.user.kind === 'agent' ? <Icon name="bot" size={12} /> : p.state.user.name.slice(0, 1)}
        </div>
      ))}
    </div>
  );
}

/**
 * The status bar's sync and storage status. Sync status `deleted`: the server closed the connection
 * because it deleted the project; `refused`: because it did not take this browser's changes (or
 * cannot load the project: SyncRefusal.load) for memory. The browser then no longer connects to it
 * by itself; the tooltip says what the toast said then (ProjectSession.tellWhenDeletedOnServer).
 */
export function SyncStatus({ s }: { s: ProjectSession }) {
  const st = s.provider?.status.value ?? 'disabled';
  const wd = s.webdav;
  const wdStatus = wd?.status.value;
  const dot =
    st === 'connected'
      ? 'ok'
      : st === 'connecting'
        ? 'warn'
        : st === 'deleted' || st === 'refused'
          ? 'err'
          : 'off';
  const label =
    st === 'connected'
      ? `Live · ${s.peers.value.length + 1} device(s)`
      : st === 'connecting'
        ? 'Connecting…'
        : st === 'offline'
          ? 'Offline'
          : st === 'deleted'
            ? 'Deleted on server'
            : st === 'refused'
              ? 'Too large for server'
              : 'Local only';
  const refusal = st === 'refused' ? s.provider?.refusal.value : null;
  const title =
    st === 'refused'
      ? refusal?.load
        ? `The server did not open this project: ${refusal.message}. ${LOAD_REFUSED_NOTE}`
        : `The server did not take this project${refusal ? `: ${refusal.message}.` : '.'} ${refusedOnServerNote(!!wd?.target.viaServer)}`
      : st !== 'deleted'
        ? 'Real-time sync'
        : wd?.target.viaServer
          ? `The server deleted this project. ${deletedOnServerNote(true)}`
          : `The server deleted this project. ${deletedOnServerNote(false)} Save (Ctrl+S) or a reload tries the server again.`;
  return (
    <>
      <span title={title} data-testid="sync-status" data-status={st}>
        <span class={`dot ${dot}`} />
        {label}
        {s.provider?.latencyMs.value != null && st === 'connected'
          ? ` · ${s.provider.latencyMs.value} ms`
          : ''}
      </span>
      <span
        title={wd?.error.value ?? 'Storage'}
        data-testid="storage-status"
        data-status={wdStatus ?? 'browser'}
      >
        <span
          class={`dot ${!wd ? 'ok' : wdStatus === 'synced' ? 'ok' : wdStatus === 'error' ? 'err' : 'warn'}`}
        />
        {wd ? `WebDAV ${wdStatus}` : 'Saved in browser'}
      </span>
    </>
  );
}

function StatusBar() {
  const s = session.value;
  const mode = s?.state.$mode.value;
  return (
    <div class="statusbar" data-testid="statusbar">
      {s ? (
        <>
          <span>
            <kbd>LMB</kbd> Select <kbd>MMB</kbd> Rotate View <kbd>RMB</kbd> Context Menu
          </span>
          {mode === 'EDIT' && (
            <span class="hide-mobile">
              <kbd>E</kbd> Extrude <kbd>I</kbd> Inset <kbd>Tab</kbd> Object Mode
            </span>
          )}
          <span class="right">
            {!online.value && <span style={{ color: 'var(--warn)' }}>● Offline</span>}
            <SyncStatus s={s} />
            <span>v{__APP_VERSION__}</span>
          </span>
        </>
      ) : (
        <span class="right">
          <span>
            {serverConfig.value ? `Server v${serverConfig.value.version}` : 'Standalone (no server)'}
          </span>
          <span>v{__APP_VERSION__}</span>
        </span>
      )}
    </div>
  );
}

function Toasts() {
  return (
    <div class="toasts">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.level}`} data-testid="toast">
          {t.message}
        </div>
      ))}
    </div>
  );
}

function Area(p: {
  kind: 'outliner' | 'properties' | 'timeline' | 'console' | 'other';
  style?: Record<string, string>;
  children: ComponentChildren;
  title?: ComponentChildren;
}) {
  return (
    <div class="area" style={p.style} onPointerEnter={() => (hoveredArea.value = p.kind)}>
      {p.title && <div class="area-header">{p.title}</div>}
      {p.children}
    </div>
  );
}

type BottomEditor = 'timeline' | 'dopesheet' | 'uv' | 'info' | 'console' | 'diagnostics';

function BottomArea({ s, initial }: { s: ProjectSession; initial: BottomEditor }) {
  const [ed, setEd] = useState<BottomEditor>(initial);
  useEffect(() => setEd(initial), [initial]);
  const tabs: { id: BottomEditor; label: string }[] = [
    { id: 'timeline', label: 'Timeline' },
    { id: 'dopesheet', label: 'Dope Sheet' },
    { id: 'uv', label: 'UV Editor' },
    { id: 'info', label: 'Info' },
    { id: 'console', label: 'Console' },
    { id: 'diagnostics', label: 'Diagnostics' },
  ];
  return (
    <div class="column" style={{ height: '100%' }}>
      <div class="area-header" style={{ height: '24px' }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            class={`menu-button ${ed === t.id ? 'open' : ''}`}
            data-testid={`bottom-tab-${t.id}`}
            onClick={() => setEd(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {ed === 'timeline' && <Timeline session={s} />}
        {ed === 'dopesheet' && <DopeSheet session={s} />}
        {ed === 'uv' && <UVEditor session={s} />}
        {ed === 'info' && <InfoLog />}
        {ed === 'console' && <Console />}
        {ed === 'diagnostics' && <Diagnostics />}
      </div>
    </div>
  );
}

const WORKSPACES: Workspace[] = ['Layout', 'Modeling', 'Shading', 'Animation', 'Scripting'];

function Editor({ s }: { s: ProjectSession }) {
  const ws = workspace.value;
  const [rightW, setRightW] = usePersistentSize('right', 330);
  const [outlinerH, setOutlinerH] = usePersistentSize('outliner', 230);
  const [bottomH, setBottomH] = usePersistentSize('bottom', 150);
  const bottomEditor: BottomEditor =
    ws === 'Scripting' ? 'console' : ws === 'Animation' ? 'dopesheet' : ws === 'Shading' ? 'uv' : 'timeline';
  const showBottom = true;
  const bottom = ws === 'Animation' || ws === 'Scripting' ? Math.max(bottomH, 260) : bottomH;
  return (
    <div class="main">
      <div class="column" style={{ flex: 1 }}>
        <Viewport session={s} />
        {showBottom && (
          <>
            <Splitter
              dir="h"
              onDrag={(d) => setBottomH(Math.max(60, Math.min(window.innerHeight - 200, bottomH - d)))}
            />
            <Area
              kind={bottomEditor === 'console' ? 'console' : 'timeline'}
              style={{ height: `${bottom}px`, flex: 'none' }}
            >
              <BottomArea s={s} initial={bottomEditor} />
            </Area>
          </>
        )}
      </div>
      <Splitter
        dir="v"
        onDrag={(d) => setRightW(Math.max(220, Math.min(window.innerWidth - 300, rightW - d)))}
      />
      <div class="column hide-mobile" style={{ width: `${rightW}px`, flex: 'none' }}>
        <Area
          kind="outliner"
          style={{ height: `${outlinerH}px`, flex: 'none' }}
          title={
            <>
              <span>Outliner</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '2px' }}>
                <button
                  class="btn flat icon"
                  title="New collection"
                  data-testid="new-collection"
                  onClick={() => run('collection.create', { name: 'Collection' }, 'ui')}
                >
                  <Icon name="collection" size={13} />
                </button>
                <button
                  class="btn flat icon"
                  title="Move selection to a new collection (M)"
                  onClick={() =>
                    run('object.move_to_collection', { new_collection_name: 'Collection' }, 'ui')
                  }
                >
                  <Icon name="plus" size={13} />
                </button>
              </span>
            </>
          }
        >
          <Outliner session={s} />
        </Area>
        <Splitter
          dir="h"
          onDrag={(d) => setOutlinerH(Math.max(80, Math.min(window.innerHeight - 200, outlinerH + d)))}
        />
        <Area kind="properties" style={{ flex: '1' }}>
          <Properties session={s} />
        </Area>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <div class="welcome" data-testid="welcome">
      <div class="welcome-inner">
        <h1>
          <img src="/icons/icon.svg" width={32} height={32} alt="" /> 3D Editor
        </h1>
        <div class="tagline">
          Model, animate and render in the browser — works offline, saves to your browser or WebDAV, and syncs
          live across devices.
        </div>
        <div class="actions">
          <button
            class="btn primary"
            data-testid="new-project"
            onClick={() => void createProject('Untitled')}
          >
            <Icon name="plus" size={12} /> New Project
          </button>
          <button
            class="btn"
            data-testid="new-empty-project"
            onClick={() => void createProject('Untitled', { empty: true })}
          >
            New Empty Project
          </button>
          <button class="btn" onClick={() => openDialog('preferences')} data-testid="open-preferences">
            Preferences (storage & sync)
          </button>
        </div>
        <h3>Recent projects</h3>
        <ProjectList />
      </div>
    </div>
  );
}

export function App() {
  const s = session.value;
  const ws = workspace.value;
  const update = pwaUpdate.value;
  return (
    <div class="app">
      <div class="topbar" onPointerEnter={() => (hoveredArea.value = 'other')}>
        <img class="logo" src="/icons/icon.svg" alt="3D Editor" />
        <MenuButton label="File" items={FILE_MENU} />
        <MenuButton label="Edit" items={EDIT_MENU} />
        <MenuButton label="Render" items={RENDER_MENU} />
        <MenuButton label="Help" items={() => HELP_MENU((k) => openDialog(k))} />
        {s && (
          <div class="workspace-tabs">
            {WORKSPACES.map((w) => (
              <button
                key={w}
                class={ws === w ? 'active' : ''}
                onClick={() => run('screen.workspace_set', { name: w }, 'ui')}
              >
                {w}
              </button>
            ))}
          </div>
        )}
        <div class="spacer" />
        {update && (
          <button class="btn primary" onClick={applyPwaUpdate} title="A new version is available">
            Update available — reload
          </button>
        )}
        {s && (
          <>
            <span style={{ color: 'var(--text-dim)', marginRight: '8px' }} data-testid="project-title">
              {s.title.value}
            </span>
            <Presence s={s} />
            <button class="btn flat icon" title="Copy share link" onClick={() => run('wm.share', {}, 'ui')}>
              <Icon name="share" />
            </button>
            <button
              class="btn flat icon"
              title="Projects"
              data-testid="open-projects"
              onClick={() => openDialog('projects')}
            >
              <Icon name="menu" />
            </button>
          </>
        )}
      </div>
      {s ? <Editor s={s} /> : <Welcome />}
      <StatusBar />
      <PopupMenuHost />
      <CommandPalette />
      <DialogHost />
      <Toasts />
    </div>
  );
}
