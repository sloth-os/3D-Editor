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
import { DirectorPanel } from './director/DirectorPanel';
import { SequenceStrip } from './director/SequenceStrip';
import { AssetBrowser } from './assets/AssetBrowser';
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

export type BottomEditor =
  'timeline' | 'sequence' | 'shots' | 'assets' | 'dopesheet' | 'uv' | 'info' | 'console' | 'diagnostics';

/**
 * Narrow screens (phones, tablets held upright): the right column is hidden (styles.css
 * .hide-mobile) and the Director panel is the bottom area's "Shots" tab (director.css).
 */
export const NARROW_SCREEN = '(max-width: 760px)';

/** Whether the window is narrow ({@link NARROW_SCREEN}), followed as it is resized or turned. */
export function useNarrowScreen(): boolean {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_SCREEN) : null);
  const [narrow, setNarrow] = useState(() => !!query()?.matches);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return narrow;
}

/**
 * The share of the window's height the bottom area takes on a narrow screen while it shows the
 * Shots or Assets tab (the Director panel with its shot inspector, the Asset Browser): the 150 px it
 * opens with hold the shot list's header and two rows.
 */
export const NARROW_PANEL_SHARE = 0.55;

/** Tabs that open the bottom area to {@link NARROW_PANEL_SHARE} of the window on narrow screens. */
const PANEL_TABS: ReadonlySet<BottomEditor> = new Set(['shots', 'assets']);

/**
 * Tabs of the bottom area. "Shots" (the Director panel) is shown on narrow screens only, where the
 * right column is hidden; the header scrolls sideways when the tabs do not fit.
 */
const BOTTOM_TABS: { id: BottomEditor; label: string; mobileOnly?: boolean }[] = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'sequence', label: 'Sequence' },
  { id: 'shots', label: 'Shots', mobileOnly: true },
  { id: 'assets', label: 'Assets' },
  { id: 'dopesheet', label: 'Dope Sheet' },
  { id: 'uv', label: 'UV Editor' },
  { id: 'info', label: 'Info' },
  { id: 'console', label: 'Console' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

function BottomArea({
  s,
  tab,
  onTab,
}: {
  s: ProjectSession;
  tab: BottomEditor;
  onTab: (tab: BottomEditor) => void;
}) {
  return (
    <div class="column" style={{ height: '100%' }}>
      <div class="area-header" style={{ height: '24px', overflowX: 'auto', scrollbarWidth: 'none' }}>
        {BOTTOM_TABS.map((t) => (
          <button
            key={t.id}
            class={`menu-button ${tab === t.id ? 'open' : ''} ${t.mobileOnly ? 'director-mobile-only' : ''}`}
            style={{ flex: 'none' }}
            data-testid={`bottom-tab-${t.id}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === 'timeline' && <Timeline session={s} />}
        {tab === 'sequence' && <SequenceStrip s={s} />}
        {tab === 'shots' && <DirectorPanel s={s} />}
        {tab === 'assets' && <AssetBrowser session={s} />}
        {tab === 'dopesheet' && <DopeSheet session={s} />}
        {tab === 'uv' && <UVEditor session={s} />}
        {tab === 'info' && <InfoLog />}
        {tab === 'console' && <Console />}
        {tab === 'diagnostics' && <Diagnostics />}
      </div>
    </div>
  );
}

/** The window's inner height; while `active`, the caller renders again when it changes. */
function useWindowHeight(active: boolean): number {
  const [, setHeight] = useState(0);
  useEffect(() => {
    if (!active) return;
    const update = () => setHeight(window.innerHeight);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [active]);
  return window.innerHeight;
}

/**
 * The area under the viewport: its splitter and its tabs (BottomArea), opening on the workspace's
 * tab (`initial`), `size` pixels tall (the height dragged to, at least `minHeight`).
 *
 * On a narrow screen ({@link NARROW_SCREEN}) the Shots and Assets tabs open it to
 * {@link NARROW_PANEL_SHARE} of the window (a height of their own once dragged), so that the shot
 * inspector shows under the shot list; and the phone-only Shots tab gives way to the workspace's tab
 * once the window is wide (a tablet turned, a window widened): its tab button is hidden then, and
 * the Director panel belongs in the right column.
 */
export function BottomPane(p: {
  s: ProjectSession;
  initial: BottomEditor;
  size: number;
  setSize: (height: number) => void;
  minHeight?: number;
}) {
  const { initial } = p;
  const narrow = useNarrowScreen();
  const [tab, setTab] = useState<BottomEditor>(initial);
  useEffect(() => setTab(initial), [initial]);
  useEffect(() => {
    if (!narrow && tab === 'shots') setTab(initial);
  }, [narrow, tab, initial]);
  const panel = narrow && PANEL_TABS.has(tab);
  // 0: NARROW_PANEL_SHARE of the window
  const [panelSize, setPanelSize] = usePersistentSize('bottom-narrow-panel', 0);
  const windowH = useWindowHeight(panel && !panelSize);
  const height = panel
    ? panelSize || Math.round(windowH * NARROW_PANEL_SHARE)
    : Math.max(p.size, p.minHeight ?? 0);
  return (
    <>
      <Splitter
        dir="h"
        onDrag={(d) => {
          if (panel) setPanelSize(Math.max(60, Math.min(window.innerHeight - 120, height - d)));
          else p.setSize(Math.max(60, Math.min(window.innerHeight - 200, p.size - d)));
        }}
      />
      <Area
        kind={initial === 'console' ? 'console' : 'timeline'}
        style={{ height: `${height}px`, flex: 'none' }}
      >
        <BottomArea s={p.s} tab={tab} onTab={setTab} />
      </Area>
    </>
  );
}

// Director: the director's desk (shots, actors, assets in the right column, the sequence below)
const WORKSPACES: Workspace[] = ['Layout', 'Modeling', 'Shading', 'Animation', 'Scripting', 'Director'];

function Editor({ s }: { s: ProjectSession }) {
  const ws = workspace.value;
  const [rightW, setRightW] = usePersistentSize('right', 330);
  const [outlinerH, setOutlinerH] = usePersistentSize('outliner', 230);
  const [bottomH, setBottomH] = usePersistentSize('bottom', 150);
  const bottomEditor: BottomEditor =
    ws === 'Scripting'
      ? 'console'
      : ws === 'Animation'
        ? 'dopesheet'
        : ws === 'Shading'
          ? 'uv'
          : ws === 'Director'
            ? 'sequence'
            : 'timeline';
  return (
    <div class="main">
      <div class="column" style={{ flex: 1 }}>
        <Viewport session={s} />
        <BottomPane
          s={s}
          initial={bottomEditor}
          size={bottomH}
          setSize={setBottomH}
          minHeight={ws === 'Animation' || ws === 'Scripting' ? 260 : 0}
        />
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
          {ws === 'Director' ? <DirectorPanel s={s} /> : <Properties session={s} />}
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
                aria-pressed={ws === w}
                data-testid={`workspace-${w.toLowerCase()}`}
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
