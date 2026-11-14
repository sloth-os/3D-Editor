import { useEffect, useRef, useState } from 'preact/hooks';
import { transformPoint3 } from '@3d-editor/core';
import type { ProjectSession } from '../project/session';
import { ViewportEngine } from '../viewport/engine';
import { ViewportInteraction } from '../viewport/interaction';
import { clonePose } from '../viewport/navigation';
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
  xrayInactiveReason,
} from '../editor/menus';
import { Icon, type IconName } from './icons';
import { RedoPanel } from './RedoPanel';
import { Panel, Row, SelectField, NumberField, ColorField, Checkbox } from './fields/fields';
import { TransformFields } from './properties/ObjectTab';
import { useShownObject } from './properties/shown-object';
import { NavGizmo } from './NavGizmo';
import { importFiles } from '../io/import-export';
import { assetDragOver, dropAsset } from './assets/drop';
import { fps, slowFrameCompiled, slowFrameMs } from '../telemetry/perf';
import type { ToolId } from '../editor/state';
import { followedShot, shotPin } from '../viewport/follow-shots';
import { workspace } from '../app/store';

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

/**
 * The camera view's toggles in the viewport header (in the camera view and the Director workspace):
 * Follow Shots and the composition guides.
 */
function CameraViewButtons({ s }: { s: ProjectSession }) {
  const follow = s.view.followShots.value;
  const guides = s.view.cameraGuides.value;
  return (
    <div class="btn-group">
      <button
        class={`btn icon ${follow ? 'active' : ''}`}
        title="Follow Shots: look through the camera of the shot at the current frame (View menu)"
        aria-pressed={follow}
        data-testid="toggle-follow-shots"
        onClick={() => run('view3d.toggle_follow_shots', {}, 'ui')}
      >
        <Icon name="film" />
      </button>
      <button
        class={`btn icon ${guides ? 'active' : ''}`}
        title="Camera Guides: rule-of-thirds and action-safe guides in the camera frame (View menu)"
        aria-pressed={guides}
        data-testid="toggle-camera-guides"
        onClick={() => run('view3d.toggle_camera_guides', {}, 'ui')}
      >
        <Icon name="guides" />
      </button>
    </div>
  );
}

/** The viewport's header: mode, select mode, menus, pivot, snapping, overlays, X-ray, shading. */
export function ViewportHeader({ s }: { s: ProjectSession }) {
  const mode = s.state.$mode.value;
  const shading = s.view.shading.value;
  const selectMode = s.state.$selectMode.value;
  const xrayInactive = xrayInactiveReason(shading, mode);
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
      {(s.view.cameraView.value || workspace.value === 'Director') && <CameraViewButtons s={s} />}
      <button
        class={`btn icon ${s.view.overlays.value ? 'active' : ''}`}
        title="Overlays"
        onClick={() => run('view3d.toggle_overlays', {}, 'ui')}
      >
        <Icon name="overlay" />
      </button>
      <button
        class={`btn icon ${s.view.xray.value ? 'active' : ''}`}
        // greyed out where X-ray changes nothing (as Blender's is in Material Preview and Rendered
        // shading); it still toggles the setting
        title={xrayInactive ? `X-Ray (Alt+Z): ${xrayInactive}` : 'X-Ray (Alt+Z)'}
        style={xrayInactive ? { opacity: 0.45 } : undefined}
        data-testid="xray"
        data-inactive={xrayInactive ? 'true' : undefined}
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

/** The viewport's sidebar (N): Transform, 3D Cursor, View. */
export function Sidebar({ s }: { s: ProjectSession }) {
  void s.revision.value;
  const box = useRef<HTMLDivElement>(null);
  // the active object, or the one a field here is being typed into (see useShownObject)
  const o = useShownObject(s, box);
  const st = s.state;
  return (
    <div
      ref={box}
      class="sidebar-n"
      onPointerDown={(e) => e.stopPropagation()}
      // scroll the sidebar, not the view
      onWheel={(e) => e.stopPropagation()}
      data-testid="sidebar"
    >
      <Panel title="Transform" id="n-transform">
        {o && st.mode === 'OBJECT' ? (
          // built anew for another object: a field never writes what was typed for one into another
          <TransformFields key={o.id} s={s} o={o} />
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
            testId="focal-length"
            onChange={(v) => {
              const e = viewport.engine;
              if (!e) return;
              // a change of the view (the one an animated view change goes to): saved and sent to
              // the people following it, like the other ones
              const p = clonePose(e.pose);
              p.fovY = 2 * Math.atan(18 / v);
              e.setPose(p);
            }}
          />
        </Row>
      </Panel>
    </div>
  );
}

/**
 * The slow-frame notice of the info overlay: a component of its own, so that the time of each new
 * slow frame redraws only this line.
 */
function SlowFrameNotice() {
  const slow = slowFrameMs.value;
  if (!(slow > 0)) return null;
  return (
    <div
      class="viewport-slow"
      data-testid="viewport-slow-frame"
      title={
        'The last frame took this long to draw. Without GPU acceleration (software WebGL) heavy ' +
        'scenes are slow: the first frame in Material Preview or Rendered shading compiles the ' +
        'shaders of every material and light combination, and while frames stay slow the view is ' +
        'drawn without anti-aliasing. Solid shading is much faster; F12 or the path tracer renders ' +
        'the final image.'
      }
    >
      Slow viewport: {(slow / 1000).toFixed(slow < 10_000 ? 1 : 0)} s
      {slowFrameCompiled.value ? ' for the last frame (compiling shaders)' : ' per frame'}
    </div>
  );
}

/**
 * The frame rate line of the statistics overlay: a component of its own, so that a new frame rate
 * redraws only this line, not the statistics (whose counts it would otherwise read again each time
 * while the viewport keeps drawing).
 */
function FrameRate() {
  return <div data-testid="stats-fps">{fps.value ? `${fps.value} fps` : ''}</div>;
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
  // one column: the info grows (slow-frame notice) without running into the statistics
  return (
    <div class="viewport-overlay viewport-corner">
      <div class="viewport-info" data-testid="viewport-info">
        <div>{label}</div>
        <div>
          ({Math.round(frame)}) Scene Collection{active ? ` | ${active.name}` : ''}
        </div>
        <SlowFrameNotice />
      </div>
      {stats && (
        <div class="viewport-stats" data-testid="viewport-stats">
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
          <FrameRate />
        </div>
      )}
    </div>
  );
}

/**
 * Inset of the action-safe area on each side, as a share of the frame (EBU R 95 and Blender's
 * default safe areas: action safe is the central 93%).
 */
export const ACTION_SAFE_INSET = 0.035;

/** The shot name at the top of the camera frame, centred (the text info is at the top left). */
const SHOT_LABEL = {
  position: 'absolute',
  left: '50%',
  transform: 'translateX(-50%)',
  top: '4px',
  padding: '1px 6px',
  borderRadius: '3px',
  background: 'rgba(0,0,0,0.5)',
  color: '#fff',
  fontSize: '11px',
  maxWidth: 'calc(100% - 8px)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/**
 * Composition guides inside the camera frame (view3d.toggle_camera_guides): the rule-of-thirds lines
 * and the action-safe rectangle. Lines stay one pixel wide whatever the frame's size.
 */
export function CameraGuides() {
  const a = ACTION_SAFE_INSET * 100;
  // on each line: vector-effect is not inherited, and without it a 1-unit stroke of the stretched
  // 100 × 100 view box is a percent of the frame wide
  const line = { stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' };
  return (
    <svg
      data-testid="camera-guides"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}
      aria-hidden="true"
    >
      <g data-testid="camera-guide-thirds">
        {[100 / 3, 200 / 3].map((t) => (
          <g key={t}>
            <line x1={t} y1={0} x2={t} y2={100} {...line} />
            <line x1={0} y1={t} x2={100} y2={t} {...line} />
          </g>
        ))}
      </g>
      <rect
        data-testid="camera-guide-action-safe"
        x={a}
        y={a}
        width={100 - 2 * a}
        height={100 - 2 * a}
        fill="none"
        stroke="rgba(255,214,102,0.7)"
        stroke-width={1}
        stroke-dasharray="4 3"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The camera frame and passepartout of the camera view (an overlay, hidden with the overlays), with
 * the composition guides when they are on and, with Follow Shots, the name of the shot shown.
 */
export function CameraFrame({ engine }: { engine: ViewportEngine }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    engine.onAfterRender.add(cb);
    return () => engine.onAfterRender.delete(cb);
  }, [engine]);
  const v = engine.session.view;
  if (!v.overlays.value) return null;
  const guides = v.cameraGuides.value;
  const follow = v.followShots.value;
  const pin = shotPin(v).value;
  const r = engine.cameraFrameRect();
  if (!r) return null;
  const s = engine.session;
  const shot = follow ? followedShot(s.doc, s.state.$frame.value, pin) : null;
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
      >
        {guides && <CameraGuides />}
        {follow && (
          <div style={SHOT_LABEL} data-testid="camera-frame-shot">
            {shot ? shot.name : 'No shot at this frame'}
          </div>
        )}
      </div>
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
        onDragOver={(e) => {
          e.preventDefault();
          assetDragOver(e);
        }}
        onDrop={(e) => {
          e.preventDefault();
          // a model dragged from the Asset Browser lands where it was dropped; files are imported
          if (dropAsset(e)) return;
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
