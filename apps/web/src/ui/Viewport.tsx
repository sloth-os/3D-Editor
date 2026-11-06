import { useEffect, useRef, useState } from 'preact/hooks';
import { transformPoint3 } from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { ViewportEngine } from '../viewport/engine';
import { ViewportInteraction } from '../viewport/interaction';
import { canRun, hoveredArea, popupMenu, run, viewport } from '../editor/editor';
import { MenuButton } from './Menu';
import {
  ADD_MENU,
  MESH_MENU,
  OBJECT_MENU,
  SELECT_MENU_EDIT,
  SELECT_MENU_OBJECT,
  UV_MENU,
  VIEW_MENU,
} from '../editor/menus';
import { Icon, type IconName } from './icons';
import { RedoPanel } from './RedoPanel';
import { Panel, Row, SelectField, NumberField, ColorField, Checkbox } from './fields/fields';
import { TransformFields } from './properties/ObjectTab';
import { NavGizmo } from './NavGizmo';
import { importFiles } from '../io/import-export';
import { fps } from '../telemetry/perf';
import type { ToolId } from '../editor/state';

function BrushSettings({ s }: { s: ProjectSession }) {
  const b = s.view.brush.value;
  const set = (patch: Partial<typeof b>) => (s.view.brush.value = { ...b, ...patch });
  const paint = s.state.$mode.value === 'VERTEX_PAINT';
  return (
    <span style={{ display: 'flex', gap: '6px', alignItems: 'center' }} data-testid="brush-settings">
      <span class="hint">Radius</span>
      <div style={{ width: '70px' }}>
        <NumberField
          value={b.radius}
          integer
          min={2}
          max={500}
          unit=" px"
          step={1}
          onChange={(v) => set({ radius: v })}
        />
      </div>
      <span class="hint">Strength</span>
      <div style={{ width: '70px' }}>
        <NumberField value={b.strength} min={0} max={1} slider onChange={(v) => set({ strength: v })} />
      </div>
      {paint && (
        <div style={{ width: '40px' }}>
          <ColorField value={b.color} onChange={(v) => set({ color: [v[0], v[1], v[2], 1] })} />
        </div>
      )}
      <Checkbox value={b.symmetryX} label="X Sym" onChange={(v) => set({ symmetryX: v })} />
    </span>
  );
}

const TOOLS: { id: ToolId; icon: IconName; title: string; modes: string[] }[] = [
  { id: 'select', icon: 'select', title: 'Select Box (W)', modes: ['OBJECT', 'EDIT'] },
  { id: 'cursor', icon: 'cursor', title: '3D Cursor', modes: ['OBJECT', 'EDIT'] },
  { id: 'move', icon: 'move', title: 'Move', modes: ['OBJECT', 'EDIT'] },
  { id: 'rotate', icon: 'rotate', title: 'Rotate', modes: ['OBJECT', 'EDIT'] },
  { id: 'scale', icon: 'scale', title: 'Scale', modes: ['OBJECT', 'EDIT'] },
  { id: 'sculpt_draw', icon: 'brush', title: 'Draw (Ctrl: subtract)', modes: ['SCULPT'] },
  { id: 'sculpt_inflate', icon: 'solid', title: 'Inflate', modes: ['SCULPT'] },
  { id: 'sculpt_smooth', icon: 'wire', title: 'Smooth', modes: ['SCULPT'] },
  { id: 'sculpt_flatten', icon: 'face', title: 'Flatten', modes: ['SCULPT'] },
  { id: 'sculpt_grab', icon: 'hand', title: 'Grab', modes: ['SCULPT'] },
  { id: 'paint', icon: 'brush', title: 'Paint vertex colors', modes: ['VERTEX_PAINT'] },
];

function ViewportHeader({ s }: { s: ProjectSession }) {
  const mode = s.state.$mode.value;
  const shading = s.view.shading.value;
  const selectMode = s.state.$selectMode.value;
  const shadingBtn = (
    type: 'WIREFRAME' | 'SOLID' | 'MATERIAL' | 'RENDERED',
    icon: IconName,
    title: string,
  ) => (
    <button
      class={`btn icon ${shading === type ? 'active' : ''}`}
      title={title}
      data-testid={`shading-${type.toLowerCase()}`}
      onClick={() => run('view3d.toggle_shading', { type }, 'ui')}
    >
      <Icon name={icon} />
    </button>
  );
  return (
    <div class="area-header" onPointerDown={(e) => e.stopPropagation()}>
      <SelectField
        value={mode}
        testId="mode-select"
        options={[
          { value: 'OBJECT', label: 'Object Mode' },
          { value: 'EDIT', label: 'Edit Mode' },
          { value: 'SCULPT', label: 'Sculpt Mode' },
          { value: 'VERTEX_PAINT', label: 'Vertex Paint' },
        ]}
        onChange={(v) => run('object.mode_set', { mode: v }, 'ui')}
      />
      {mode === 'EDIT' && (
        <div class="btn-group" data-testid="select-mode">
          {(['VERT', 'EDGE', 'FACE'] as const).map((m) => (
            <button
              key={m}
              class={`btn icon ${selectMode === m ? 'active' : ''}`}
              title={`${m === 'VERT' ? 'Vertex' : m === 'EDGE' ? 'Edge' : 'Face'} select (${m === 'VERT' ? 1 : m === 'EDGE' ? 2 : 3})`}
              onClick={() => run('mesh.select_mode', { type: m }, 'ui')}
            >
              <Icon name={m === 'VERT' ? 'vert' : m === 'EDGE' ? 'edge' : 'face'} />
            </button>
          ))}
        </div>
      )}
      <MenuButton label="View" items={VIEW_MENU} />
      {(mode === 'SCULPT' || mode === 'VERTEX_PAINT') && <BrushSettings s={s} />}
      {(mode === 'OBJECT' || mode === 'EDIT') && (
        <MenuButton label="Select" items={mode === 'EDIT' ? SELECT_MENU_EDIT : SELECT_MENU_OBJECT} />
      )}
      {(mode === 'OBJECT' || mode === 'EDIT') && <MenuButton label="Add" items={() => ADD_MENU} />}
      {mode !== 'OBJECT' && mode !== 'EDIT' ? null : mode === 'EDIT' ? (
        <>
          <MenuButton label="Mesh" items={MESH_MENU} />
          <MenuButton label="UV" items={UV_MENU} />
        </>
      ) : (
        <MenuButton label="Object" items={OBJECT_MENU} />
      )}
      <div style={{ flex: 1 }} />
      <span class="hide-mobile" style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
        <SelectField
          value={s.state.$pivotPoint.value}
          options={[
            { value: 'MEDIAN_POINT', label: 'Median Point' },
            { value: 'BOUNDING_BOX_CENTER', label: 'Bounding Box' },
            { value: 'CURSOR', label: '3D Cursor' },
            { value: 'INDIVIDUAL_ORIGINS', label: 'Individual Origins' },
            { value: 'ACTIVE_ELEMENT', label: 'Active Element' },
          ]}
          onChange={(v) => (s.state.pivotPoint = v)}
        />
        <button
          class={`btn icon ${s.view.snapping.value ? 'active' : ''}`}
          title="Snap increments (Shift+Tab)"
          onClick={() => run('view3d.toggle_snapping', {}, 'ui')}
        >
          <Icon name="grid" />
        </button>
        {mode === 'EDIT' && (
          <button
            class={`btn icon ${s.state.$proportionalEditing.value ? 'active' : ''}`}
            title="Proportional editing (O)"
            onClick={() => (s.state.proportionalEditing = !s.state.proportionalEditing)}
          >
            ◎
          </button>
        )}
      </span>
      <button
        class={`btn icon ${s.view.overlays.value ? 'active' : ''}`}
        title="Overlays"
        onClick={() => run('view3d.toggle_overlays', {}, 'ui')}
      >
        <Icon name="overlay" />
      </button>
      <button
        class={`btn icon ${s.view.xray.value ? 'active' : ''}`}
        title="X-Ray (Alt+Z)"
        data-testid="xray"
        onClick={() => run('view3d.toggle_xray', {}, 'ui')}
      >
        <Icon name="xray" />
      </button>
      <div class="btn-group">
        {shadingBtn('WIREFRAME', 'wire', 'Wireframe')}
        {shadingBtn('SOLID', 'solid', 'Solid')}
        {shadingBtn('MATERIAL', 'matPreview', 'Material Preview')}
        {shadingBtn('RENDERED', 'rendered', 'Rendered')}
      </div>
    </div>
  );
}

function Sidebar({ s }: { s: ProjectSession }) {
  void s.revision.value;
  const id = s.state.$activeId.value;
  const o = id ? s.doc.getObject(id) : null;
  const st = s.state;
  return (
    <div
      class="sidebar-n"
      onPointerDown={(e) => e.stopPropagation()}
      // scroll the sidebar, not the view
      onWheel={(e) => e.stopPropagation()}
      data-testid="sidebar"
    >
      <Panel title="Transform" id="n-transform">
        {o && st.mode === 'OBJECT' ? (
          <TransformFields s={s} o={o} />
        ) : (
          <div class="hint">
            {st.mode === 'EDIT' ? 'Edit-mode transforms: use G/R/S' : 'Nothing selected'}
          </div>
        )}
      </Panel>
      <Panel title="3D Cursor" id="n-cursor" defaultOpen={false}>
        <Row label="Location">
          <div class="vector">
            {st.$cursorLocation.value.map((v, i) => (
              <NumberField
                key={i}
                label={'XYZ'[i]}
                value={v}
                step={0.01}
                unit=" m"
                onChange={(x) => {
                  const next = [...st.cursorLocation] as [number, number, number];
                  next[i] = x;
                  st.cursorLocation = next;
                }}
              />
            ))}
          </div>
        </Row>
      </Panel>
      <Panel title="View" id="n-view" defaultOpen={false}>
        <Row label="Focal Length">
          <NumberField
            value={viewport.engine ? 18 / Math.tan(viewport.engine.pose.fovY / 2) : 50}
            min={1}
            max={500}
            unit=" mm"
            onChange={(v) => {
              const e = viewport.engine;
              if (!e) return;
              e.pose.fovY = 2 * Math.atan(18 / v);
              e.requestRender();
            }}
          />
        </Row>
      </Panel>
    </div>
  );
}

/** Statistics/info overlay in the top-left corner (Blender style); hidden with the overlays. */
export function InfoOverlay({ s }: { s: ProjectSession }) {
  void s.revision.value;
  if (!s.view.overlays.value) return null;
  const frame = s.state.$frame.value;
  const active = s.state.$activeId.value ? s.doc.getObject(s.state.$activeId.value) : null;
  const label = s.view.viewLabel.value;
  const showStats = s.view.showStats.value;
  const stats = showStats ? s.sceneStats() : null;
  const mode = s.state.$mode.value;
  const sel = s.state.$meshSelection.value;
  return (
    <>
      <div class="viewport-overlay viewport-info" data-testid="viewport-info">
        <div>{label}</div>
        <div>
          ({Math.round(frame)}) Scene Collection{active ? ` | ${active.name}` : ''}
        </div>
      </div>
      {stats && (
        <div class="viewport-overlay viewport-stats" data-testid="viewport-stats">
          <div>
            Objects {s.state.$selectedIds.value.length}/{stats.objects}
          </div>
          {mode === 'EDIT' ? (
            <div>
              Verts {sel.verts.size} · Edges {sel.edges.size} · Faces {sel.faces.size} selected
            </div>
          ) : null}
          <div data-testid="stats-vertices">Vertices {stats.vertices.toLocaleString()}</div>
          <div>Faces {stats.faces.toLocaleString()}</div>
          <div data-testid="stats-triangles">Triangles {stats.triangles.toLocaleString()}</div>
          <div>{fps.value ? `${fps.value} fps` : ''}</div>
        </div>
      )}
    </>
  );
}

/** The camera frame and passepartout of the camera view (an overlay, hidden with the overlays). */
export function CameraFrame({ engine }: { engine: ViewportEngine }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    engine.onAfterRender.add(cb);
    return () => engine.onAfterRender.delete(cb);
  }, [engine]);
  if (!engine.session.view.overlays.value) return null;
  const r = engine.cameraFrameRect();
  if (!r) return null;
  return (
    <div class="viewport-overlay" style={{ inset: 0 }} data-testid="camera-frame">
      <div
        style={{
          position: 'absolute',
          left: `${r.x}px`,
          top: `${r.y}px`,
          width: `${r.w}px`,
          height: `${r.h}px`,
          border: '1px dashed #ddd',
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.45)',
        }}
      />
    </div>
  );
}

/** Other people's 3D cursors (an overlay, hidden with the overlays). */
export function PeerCursors({ s, engine }: { s: ProjectSession; engine: ViewportEngine }) {
  const peers = s.peers.value;
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    engine.onAfterRender.add(cb);
    return () => engine.onAfterRender.delete(cb);
  }, [engine]);
  if (!s.view.overlays.value) return null;
  return (
    <>
      {peers
        .filter((p) => p.state.cursor3d)
        .map((p) => {
          const pt = engine.project(
            transformPoint3([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], p.state.cursor3d!),
          );
          if (pt.z < -1 || pt.z > 1) return null;
          return (
            <div
              key={p.clientId}
              class="viewport-overlay"
              style={{
                left: `${pt.x + 8}px`,
                top: `${pt.y - 8}px`,
                fontSize: '11px',
                color: p.state.user.color,
              }}
            >
              ◆ {p.state.user.name}
            </div>
          );
        })}
    </>
  );
}

export function Viewport({ session: s }: { session: ProjectSession }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [engine, setEngine] = useState<ViewportEngine | null>(null);
  const [interaction, setInteraction] = useState<ViewportInteraction | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current!;
    const host = hostRef.current!;
    let e: ViewportEngine;
    try {
      e = new ViewportEngine(canvas, s);
    } catch (err) {
      console.error(err);
      return;
    }
    const it = new ViewportInteraction(e, s, host, {
      run: (id, params, source) => run(id, params, source ?? 'ui'),
      openContextMenu: (x, y) => {
        popupMenu.value = { name: 'context', x, y };
      },
    });
    viewport.engine = e;
    viewport.interaction = it;
    s.thumbnailProvider = () => e.thumbnail();
    setEngine(e);
    setInteraction(it);
    return () => {
      it.dispose();
      e.dispose();
      if (viewport.engine === e) viewport.engine = null;
      if (viewport.interaction === it) viewport.interaction = null;
      s.thumbnailProvider = null;
    };
  }, [s]);
  const tool = s.view.tool.value;
  const mode = s.state.$mode.value;
  useEffect(() => {
    // pick a tool that exists in the new mode
    const valid = TOOLS.filter((t) => t.modes.includes(mode)).map((t) => t.id);
    if (!valid.includes(s.view.tool.value)) s.view.tool.value = valid[0] ?? 'select';
  }, [mode, s]);
  const box = interaction?.boxRect.value;
  const hud = s.view.hud.value;
  return (
    <div class="area" style={{ flex: 1 }}>
      <ViewportHeader s={s} />
      <div
        class={`viewport ${s.view.sidebar.value ? 'with-sidebar' : ''}`}
        ref={hostRef}
        tabIndex={0}
        data-testid="viewport"
        onPointerEnter={() => (hoveredArea.value = 'viewport')}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const files = [...(e.dataTransfer?.files ?? [])];
          if (files.length) void importFiles(files);
        }}
        style={{ cursor: tool === 'cursor' ? 'crosshair' : 'default' }}
      >
        <canvas ref={canvasRef} />
        {s.view.toolbar.value && (
          <div class="toolbar" onPointerDown={(e) => e.stopPropagation()} data-testid="toolbar">
            {TOOLS.filter((t) => t.modes.includes(mode)).map((t) => (
              <button
                key={t.id}
                class={tool === t.id ? 'active' : ''}
                title={t.title}
                data-testid={`tool-${t.id}`}
                onClick={() => run('wm.tool_set', { tool: t.id }, 'toolbar')}
              >
                <Icon name={t.icon} />
              </button>
            ))}
            {(mode === 'OBJECT' || mode === 'EDIT') && (
              <>
                <div class="sep" />
                <button
                  title="Add (Shift+A)"
                  onClick={(e) => (popupMenu.value = { name: 'add', x: e.clientX + 20, y: e.clientY })}
                >
                  <Icon name="plus" />
                </button>
              </>
            )}
            {mode === 'EDIT' && canRun('mesh.extrude_region_shrink_fatten') && (
              <button
                title="Extrude (E)"
                onClick={() => run('mesh.extrude_region_shrink_fatten', { value: 0.5 }, 'toolbar')}
              >
                <Icon name="up" />
              </button>
            )}
          </div>
        )}
        {engine && <InfoOverlay s={s} />}
        {engine && <CameraFrame engine={engine} />}
        {engine && <PeerCursors s={s} engine={engine} />}
        {engine && <NavGizmo engine={engine} />}
        <div class="nav-buttons" onPointerDown={(e) => e.stopPropagation()}>
          <button title="Frame all (Home)" onClick={() => run('view3d.view_all', {}, 'ui')}>
            <Icon name="home" />
          </button>
          <button
            title="Toggle camera view (Numpad 0)"
            data-testid="camera-view"
            onClick={() => run('view3d.view_camera', {}, 'ui')}
          >
            <Icon name="camera" />
          </button>
          <button
            title="Perspective / Orthographic (Numpad 5)"
            onClick={() => run('view3d.view_persportho', {}, 'ui')}
          >
            <Icon name="grid" />
          </button>
        </div>
        {box && (
          <div
            class="selection-rect"
            style={{
              left: `${box.x0}px`,
              top: `${box.y0}px`,
              width: `${box.x1 - box.x0}px`,
              height: `${box.y1 - box.y0}px`,
            }}
          />
        )}
        {hud && (
          <div class="viewport-overlay viewport-hud" data-testid="hud">
            {hud}
          </div>
        )}
        {s.view.sidebar.value && <Sidebar s={s} />}
        <RedoPanel s={s} />
      </div>
    </div>
  );
}
