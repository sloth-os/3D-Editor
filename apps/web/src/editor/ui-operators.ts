import { z } from 'zod';
import * as THREE from 'three';
import {
  FrameState,
  defineOperator,
  keyChannelChanges,
  parseEdgeKey,
  type OperatorRegistry,
} from '@3d-editor/core';
import { session, openDialog, toast, workspace, type Workspace } from '../app/store';
import { registry, viewport, popupMenu, paletteOpen } from './editor';
import { axisViewAngles, clonePose, type AxisView } from '../viewport/navigation';
import { createProject } from '../project/manager';
import { importFromFilePicker } from '../io/import-export';
import { shareLink } from '../project/manager';
import { nearestEdge, projectEditVerts } from '../viewport/picking';
import { takePendingStroke } from '../viewport/interaction';
import { viewportCamera } from '../render/view';
import { telemetry } from '../telemetry/telemetry';
import { lastRepeat, repeatLast, runOperator } from './runner';

function engine() {
  const e = viewport.engine;
  if (!e) throw new Error('No viewport');
  return e;
}

const ui = { uiOnly: true as const, undo: false as const };

export function registerUiOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'ed.undo',
      label: 'Undo',
      description: 'Undo your last change (changes from other users are not undone).',
      category: 'Edit',
      ...ui,
      schema: z.object({}),
      execute() {
        const s = session.value!;
        if (!s.undo.canUndo()) throw new Error('Nothing to undo');
        const item = s.undo.undoStack[s.undo.undoStack.length - 1];
        const undone = String(item?.meta.get('operator') ?? 'unknown');
        s.undo.undo();
        // Which operators get undone right away is a strong signal of UX friction.
        telemetry.count('editor.undo', 1, { 'undo.operator': undone });
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'ed.redo',
      label: 'Redo',
      description: 'Redo the last undone change.',
      category: 'Edit',
      ...ui,
      schema: z.object({}),
      execute() {
        const s = session.value!;
        if (!s.undo.canRedo()) throw new Error('Nothing to redo');
        const item = s.undo.redoStack[s.undo.redoStack.length - 1];
        s.undo.redo();
        telemetry.count('editor.redo', 1, {
          'undo.operator': String(item?.meta.get('operator') ?? 'unknown'),
        });
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'screen.repeat_last',
      label: 'Repeat Last',
      description:
        'Run the last operation again as a new step with the same settings, on the current selection ' +
        '(Shift+R): after Duplicate and Move it duplicates and moves once more, after Add Cube it adds another.',
      category: 'Edit',
      ...ui,
      schema: z.object({}),
      poll: () => (lastRepeat.value ? true : 'Nothing to repeat'),
      execute(ctx) {
        const action = lastRepeat.value!;
        const res = repeatLast(session.value!, reg, ctx.source);
        // a failing step reported why itself
        return { repeated: action.label, ok: !!res?.ok, ...(res?.ok ? {} : { error: res?.error }) };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.view_axis',
      label: 'Align View',
      description: 'Align the viewport to an axis (Numpad 1/3/7, Ctrl for the opposite side).',
      category: 'View',
      ...ui,
      schema: z.object({ type: z.enum(['FRONT', 'BACK', 'RIGHT', 'LEFT', 'TOP', 'BOTTOM']) }),
      execute(_ctx, p) {
        const e = engine();
        const pose = clonePose(e.pose);
        const a = axisViewAngles(p.type as AxisView);
        pose.yaw = a.yaw;
        pose.pitch = a.pitch;
        pose.ortho = true;
        session.value!.view.cameraView.value = false;
        if (viewport.interaction) viewport.interaction.autoOrtho = true;
        e.setPose(pose, true);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.view_persportho',
      label: 'Perspective/Orthographic',
      description: 'Toggle between perspective and orthographic projection (Numpad 5).',
      category: 'View',
      ...ui,
      schema: z.object({}),
      execute() {
        const e = engine();
        const pose = clonePose(e.pose);
        pose.ortho = !pose.ortho;
        if (viewport.interaction) viewport.interaction.autoOrtho = false;
        e.setPose(pose, false);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.view_camera',
      label: 'Camera View',
      description: 'Look through the active scene camera (Numpad 0).',
      category: 'View',
      ...ui,
      schema: z.object({}),
      execute(ctx) {
        const v = session.value!.view;
        if (!ctx.doc.getScene().camera) throw new Error('No active camera in scene');
        v.cameraView.value = !v.cameraView.value;
        engine().requestRender();
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.object_as_camera',
      label: 'Set Active Object as Camera',
      description: 'Make the active camera object the scene camera and look through it (Ctrl+Numpad 0).',
      category: 'View',
      uiOnly: true,
      schema: z.object({}),
      poll: (ctx) =>
        ctx.state.activeId && ctx.doc.getObject(ctx.state.activeId)?.type === 'CAMERA'
          ? true
          : 'Active object is not a camera',
      execute(ctx) {
        ctx.doc.updateScene({ camera: ctx.state.activeId });
        session.value!.view.cameraView.value = true;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.camera_to_view',
      label: 'Align Active Camera to View',
      description:
        'Move the scene camera to the current viewpoint and switch to the camera view (Ctrl+Alt+Numpad 0). ' +
        "Under a parent the camera is set in the parent's space as the scene shows it at the current frame " +
        '(a bone, an animated or constrained parent); an animated channel it changes is keyed at the frame ' +
        'with its new value.',
      category: 'View',
      uiOnly: true,
      schema: z.object({}),
      poll: (ctx) => (ctx.doc.getScene().camera ? true : 'No active camera'),
      execute(ctx) {
        const e = engine();
        const camId = ctx.doc.getScene().camera!;
        // the view, also while an animated view change is still on its way there
        const cam = viewportCamera(e.pose, e.width / Math.max(1, e.height));
        // in the space of the parent as the scene shows it at the current frame (a bone's posed
        // matrix, an animated or constrained parent), as Blender's ED_view3d_to_object reads the
        // evaluated parent, and from the values the camera's channels hold there: an animated
        // channel it changes is keyed at the frame, as the editor keeps edits of animated channels
        const fs = new FrameState(ctx.doc, ctx.state.frame);
        const o = fs.byId.get(camId);
        const parented = !!o?.parent && o.parent !== camId && fs.byId.has(o.parent);
        const held = o && { location: o.location, rotation_euler: o.rotation_euler, scale: o.scale };
        const patch = ctx.doc.setWorldMatrix(
          camId,
          cam.matrixWorld.toArray(),
          parented ? fs.parent(camId) : null,
          held,
        );
        if (held && patch)
          keyChannelChanges(
            ctx,
            new Map([[camId, { before: held, after: { ...held, ...patch } }]]),
            undefined,
            false,
          );
        session.value!.view.cameraView.value = true;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.view_all',
      label: 'Frame All',
      description: 'Frame all visible objects (Home).',
      category: 'View',
      ...ui,
      schema: z.object({}),
      execute() {
        const e = engine();
        e.frameSphere(e.boundsOf() ?? new THREE.Sphere(new THREE.Vector3(), 5));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.view_selected',
      label: 'Frame Selected',
      description: 'Frame the selection (Numpad .).',
      category: 'View',
      ...ui,
      schema: z.object({}),
      execute(ctx) {
        const e = engine();
        if (ctx.state.mode === 'EDIT' && ctx.state.activeId) {
          const ev = e.ev?.byId.get(ctx.state.activeId);
          const mesh = ev?.baseMesh;
          if (ev && mesh) {
            const box = new THREE.Box3();
            const m = new THREE.Matrix4().fromArray(ev.worldMatrix);
            const sel = ctx.state.meshSelection.verts;
            const verts = sel.size
              ? [...sel]
              : mesh.positions
                  .map((_, i) => i)
                  .filter((i) => i % 3 === 0)
                  .map((i) => i / 3);
            for (const v of verts)
              box.expandByPoint(
                new THREE.Vector3(
                  mesh.positions[v * 3],
                  mesh.positions[v * 3 + 1],
                  mesh.positions[v * 3 + 2],
                ).applyMatrix4(m),
              );
            if (!box.isEmpty()) return e.frameSphere(box.getBoundingSphere(new THREE.Sphere()));
          }
        }
        e.frameSphere(e.boundsOf(ctx.state.selectedIds.length ? ctx.state.selectedIds : undefined));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.view_orbit',
      label: 'Orbit View',
      description: 'Orbit the view in 15° steps (Numpad 4/6/8/2).',
      category: 'View',
      ...ui,
      schema: z.object({
        type: z.enum(['ORBITLEFT', 'ORBITRIGHT', 'ORBITUP', 'ORBITDOWN']),
        angle: z.number().default(Math.PI / 12),
      }),
      execute(_ctx, p) {
        const e = engine();
        const pose = clonePose(e.pose);
        if (p.type === 'ORBITLEFT') pose.yaw += p.angle;
        if (p.type === 'ORBITRIGHT') pose.yaw -= p.angle;
        if (p.type === 'ORBITUP') pose.pitch = Math.min(Math.PI / 2, pose.pitch + p.angle);
        if (p.type === 'ORBITDOWN') pose.pitch = Math.max(-Math.PI / 2, pose.pitch - p.angle);
        e.setPose(pose, true);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.zoom',
      label: 'Zoom',
      description: 'Zoom the view in or out.',
      category: 'View',
      ...ui,
      schema: z.object({ delta: z.number().default(1) }),
      execute(_ctx, p) {
        viewport.interaction?.zoomBy(Math.pow(1.25, -p.delta));
      },
    }),
  );
  const toggle = (
    id: string,
    label: string,
    key: 'xray' | 'overlays' | 'sidebar' | 'toolbar' | 'showWireframe' | 'snapping',
    description: string,
  ) =>
    reg.register(
      defineOperator({
        id,
        label,
        description,
        category: 'View',
        ...ui,
        schema: z.object({}),
        execute() {
          const v = session.value!.view;
          v[key].value = !v[key].value;
        },
      }),
    );
  toggle(
    'view3d.toggle_xray',
    'Toggle X-Ray',
    'xray',
    'See through objects in Solid shading (Wireframe always does; Material Preview and Rendered draw them ' +
      'as they are); in Edit Mode the cage shows through and box selections and clicks on vertices or ' +
      'edges also select hidden elements (a click on a face picks the front one). Selecting objects ' +
      'works the same with it on or off (Alt+Z).',
  );
  toggle(
    'view3d.toggle_overlays',
    'Toggle Overlays',
    'overlays',
    'Show or hide all viewport overlays, like Blender: grid, 3D cursor, camera, light and empty ' +
      'helpers, bones, curves without a surface, wireframe overlays, selection outlines and origins, ' +
      'the edit-mode cage, the camera frame, the text info and the statistics (Wireframe shading stays).',
  );
  toggle('view3d.toggle_sidebar', 'Sidebar', 'sidebar', 'Toggle the viewport sidebar (N).');
  toggle('view3d.toggle_toolbar', 'Toolbar', 'toolbar', 'Toggle the tool bar (T).');
  toggle(
    'view3d.toggle_wireframe_overlay',
    'Wireframe Overlay',
    'showWireframe',
    'Show wireframe on top of shaded objects.',
  );
  toggle('view3d.toggle_snapping', 'Snapping', 'snapping', 'Snap transforms to increments (Shift+Tab).');
  reg.register(
    defineOperator({
      id: 'view3d.toggle_shading',
      label: 'Viewport Shading',
      description:
        'Switch viewport shading: WIREFRAME, SOLID, MATERIAL preview or RENDERED. Without GPU ' +
        'acceleration (software WebGL, e.g. a headless browser) MATERIAL and RENDERED frames of a heavy ' +
        'scene are slow: the first one compiles the shaders (can take tens of seconds), later ones take ' +
        'seconds each and are drawn without anti-aliasing; the viewport info then shows "Slow viewport: ' +
        'N s". SOLID is fast; render_image gives the final image.',
      category: 'View',
      ...ui,
      schema: z.object({ type: z.enum(['WIREFRAME', 'SOLID', 'MATERIAL', 'RENDERED']) }),
      execute(_ctx, p) {
        const v = session.value!.view;
        v.shading.value = p.type === 'WIREFRAME' && v.shading.value === 'WIREFRAME' ? 'SOLID' : p.type;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.tool_set',
      label: 'Set Tool',
      description: 'Activate a toolbar tool.',
      category: 'Tools',
      ...ui,
      schema: z.object({
        tool: z.enum([
          'select',
          'cursor',
          'move',
          'rotate',
          'scale',
          'sculpt_draw',
          'sculpt_smooth',
          'sculpt_grab',
          'sculpt_inflate',
          'sculpt_flatten',
          'paint',
        ]),
      }),
      execute(_ctx, p) {
        session.value!.view.tool.value = p.tool;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'view3d.transform_modal',
      label: 'Interactive Transform',
      description: 'Start an interactive move/rotate/scale (G/R/S).',
      category: 'Transform',
      ...ui,
      schema: z.object({
        mode: z.enum(['translate', 'rotate', 'resize']),
        continue_last: z
          .boolean()
          .default(false)
          .describe(
            'The transform completes the operation that ran just before it (Extrude and Move, Duplicate ' +
              'and Move): Repeat Last (Shift+R) repeats that operation and this transform together',
          ),
      }),
      execute(_ctx, p) {
        viewport.interaction?.startModal(p.mode, p.continue_last ? lastRepeat.value : null);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'object.duplicate_move',
      label: 'Duplicate Objects',
      description:
        'Duplicate the selection and move the copies interactively (Shift+D / Alt+D linked). Repeat Last ' +
        '(Shift+R) duplicates the copies and moves them by the same offset.',
      category: 'Object',
      ...ui,
      schema: z.object({ linked: z.boolean().default(false) }),
      poll: (ctx) => reg.poll(ctx, 'object.duplicate'),
      execute(ctx, p) {
        // a step of its own (undo, Adjust Last Operation, Repeat Last), which the move continues
        const r = runOperator(session.value!, reg, 'object.duplicate', { linked: p.linked }, ctx.source);
        // a failure was reported by the run
        if (!r.ok) return { ok: false, error: r.error };
        const action = lastRepeat.value;
        setTimeout(() => viewport.interaction?.startModal('translate', action), 0);
        return r.result;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'screen.animation_play',
      label: 'Play Animation',
      description: 'Start or stop animation playback (Space).',
      category: 'Animation',
      ...ui,
      schema: z.object({}),
      execute() {
        const v = session.value!.view;
        v.playing.value = !v.playing.value;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'screen.frame_offset',
      label: 'Frame Offset',
      description: 'Move the current frame by delta (Left/Right arrows).',
      category: 'Animation',
      ...ui,
      schema: z.object({ delta: z.number().int().default(1) }),
      execute(ctx, p) {
        ctx.state.frame = Math.round(ctx.state.frame) + p.delta;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'screen.keyframe_jump',
      label: 'Jump to Keyframe',
      description: 'Jump to the previous/next keyframe of the selected objects (Up/Down arrows).',
      category: 'Animation',
      ...ui,
      schema: z.object({ next: z.boolean().default(true) }),
      execute(ctx, p) {
        const ids = ctx.state.selectedIds.length ? ctx.state.selectedIds : ctx.doc.objectIds();
        const frames = new Set<number>();
        for (const id of ids)
          for (const fc of ctx.doc.listFCurves(id)) for (const k of fc.keyframes) frames.add(k.frame);
        const sorted = [...frames].sort((a, b) => a - b);
        const cur = ctx.state.frame;
        const target = p.next
          ? sorted.find((f) => f > cur + 1e-6)
          : [...sorted].reverse().find((f) => f < cur - 1e-6);
        if (target === undefined) throw new Error('No more keyframes');
        ctx.state.frame = target;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.search_menu',
      label: 'Search',
      description: 'Search all operators (F3).',
      category: 'Window',
      ...ui,
      schema: z.object({}),
      execute() {
        paletteOpen.value = true;
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.call_menu',
      label: 'Call Menu',
      description: 'Open a popup menu at the mouse position.',
      category: 'Window',
      ...ui,
      schema: z.object({ name: z.string(), x: z.number().optional(), y: z.number().optional() }),
      execute(_ctx, p) {
        popupMenu.value = { name: p.name, x: p.x ?? lastMouse.x, y: p.y ?? lastMouse.y };
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.save_mainfile',
      label: 'Save',
      description: 'Projects save continuously; this forces an immediate sync to storage (Ctrl+S).',
      category: 'File',
      ...ui,
      schema: z.object({}),
      execute() {
        const s = session.value!;
        // what the save did: saved, stored again after a deletion, offline, or failed and why
        void s.flush().then((r) => toast(r.message, r.level, r.level === 'info' ? undefined : 10_000));
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.read_homefile',
      label: 'New Project',
      description: 'Create a new project with the default scene (Ctrl+N).',
      category: 'File',
      ...ui,
      schema: z.object({ empty: z.boolean().default(false), name: z.string().default('Untitled') }),
      execute(_ctx, p) {
        void createProject(p.name, { empty: p.empty });
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.open_mainfile',
      label: 'Open Project…',
      description: 'Open the project browser (Ctrl+O).',
      category: 'File',
      ...ui,
      schema: z.object({}),
      execute() {
        openDialog('projects');
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.preferences',
      label: 'Preferences…',
      description: 'Open preferences (storage, sync, telemetry, input).',
      category: 'Edit',
      ...ui,
      schema: z.object({}),
      execute() {
        openDialog('preferences');
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.import',
      label: 'Import…',
      description: 'Import glTF/GLB, OBJ, STL or PLY files.',
      category: 'File',
      ...ui,
      schema: z.object({}),
      execute() {
        void importFromFilePicker();
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.export',
      label: 'Export…',
      description: 'Export the scene to glTF/GLB, OBJ, STL or PLY.',
      category: 'File',
      ...ui,
      schema: z.object({ format: z.enum(['glb', 'gltf', 'obj', 'stl', 'ply']).optional() }),
      execute(_ctx, p) {
        openDialog('export', { format: p.format });
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'render.render',
      label: 'Render Image',
      description:
        'Open the Render window and render the scene there at once (F12): at the output resolution, from the ' +
        "scene camera (else the viewport's view); with the PATHTRACER engine the image refines progressively " +
        "on the render workers, as many as the tab's memory allows, and a path traced render that would not " +
        'fit into it is not started: the window says why. animation=true opens the Render Animation window ' +
        'instead (Ctrl+F12), which renders nothing until its Render button is pressed (there the frame range ' +
        'is rendered into an animated PNG or GIF).',
      category: 'Render',
      ...ui,
      schema: z.object({
        animation: z
          .boolean()
          .default(false)
          .describe(
            'Open the Render Animation window (Ctrl+F12) instead of rendering a still image; it renders ' +
              'nothing until its Render button is pressed',
          ),
      }),
      execute(_ctx, p) {
        openDialog('render', p.animation ? { animation: true } : {});
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'wm.share',
      label: 'Copy Share Link',
      description: 'Copy a link that opens this project on another device (changes sync live).',
      category: 'File',
      ...ui,
      schema: z.object({}),
      execute() {
        const s = session.value!;
        const link = shareLink(s.id);
        void navigator.clipboard?.writeText(link).then(
          () => toast('Share link copied to clipboard'),
          () => toast(link),
        );
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'screen.workspace_set',
      label: 'Set Workspace',
      description: 'Switch the workspace layout.',
      category: 'Window',
      ...ui,
      schema: z.object({ name: z.enum(['Layout', 'Modeling', 'Shading', 'Animation', 'Scripting']) }),
      execute(_ctx, p) {
        workspace.value = p.name as Workspace;
        const v = session.value?.view;
        if (v && p.name === 'Shading') v.shading.value = 'MATERIAL';
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'sculpt.commit_stroke',
      label: 'Brush Stroke',
      description: 'Commits the interactive sculpt / paint stroke (one undo step).',
      category: 'Sculpt',
      uiOnly: true,
      schema: z.object({}),
      execute(ctx) {
        const s = takePendingStroke();
        if (!s) throw new Error('No stroke to commit');
        ctx.doc.setMesh(s.meshId, s.mesh);
      },
    }),
  );
  reg.register(
    defineOperator({
      id: 'mesh.loopcut_pick',
      label: 'Loop Cut',
      description: 'Insert an edge loop across the edge ring under the mouse (Ctrl+R).',
      category: 'Mesh',
      uiOnly: true,
      redoable: false,
      schema: z.object({ number_cuts: z.number().int().min(1).max(64).default(1) }),
      poll: (ctx) => (ctx.state.mode === 'EDIT' ? true : 'Requires Edit Mode'),
      execute(ctx, p) {
        const it = viewport.interaction;
        const e = viewport.engine;
        if (!it || !e) throw new Error('No viewport');
        const edge = pickEdgeUnderMouse();
        if (!edge) throw new Error('Hover an edge to place the loop cut');
        const r = registry.run(ctx, 'mesh.loopcut', { edge, number_cuts: p.number_cuts });
        if (!r.ok) throw new Error(r.error);
      },
    }),
  );
}

/** Last known mouse position (client coordinates) for popup menus. */
export const lastMouse = { x: 200, y: 200 };
if (typeof window !== 'undefined')
  window.addEventListener('pointermove', (e) => {
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
  });

function pickEdgeUnderMouse(): [number, number] | null {
  const e = viewport.engine;
  const it = viewport.interaction;
  const s = session.value;
  if (!e || !it || !s?.state.activeId) return null;
  const o = e.ev?.byId.get(s.state.activeId);
  if (!o?.baseMesh) return null;
  const proj = projectEditVerts(e, o.baseMesh, o.worldMatrix, s.view.xray.value);
  const k = nearestEdge(proj, e.edit.edges, it.mouse.x, it.mouse.y, 30);
  return k ? parseEdgeKey(k) : null;
}
