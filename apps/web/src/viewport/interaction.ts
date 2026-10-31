import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { signal } from '@preact/signals';
import {
  edgeKey,
  emptySelection,
  parseEdgeKey,
  selectionFromEdges,
  selectionFromFaces,
  selectionFromVerts,
  selectionPivot,
  type MeshSelection,
} from '@3d-editor/core';
import type { ViewportEngine } from './engine';
import type { ProjectSession } from '../project/session';
import { ModalTransform, type ModalKind } from './modal-transform';
import { clonePose, poseBasis } from './navigation';
import { nearestEdge, nearestVertex, objectsInRect, pickFace, pickObject, projectEditVerts } from './picking';
import { prefs } from '../app/prefs';
import { telemetry } from '../telemetry/telemetry';
import { BrushStroke } from './brush';

export interface InteractionHost {
  run(id: string, params?: unknown, source?: 'hotkey' | 'ui' | 'toolbar'): boolean;
  openContextMenu(x: number, y: number): void;
}

type DragMode = 'orbit' | 'pan' | 'zoom' | 'box' | 'none';

/**
 * Pointer/touch handling for the viewport: Blender-style navigation (MMB / Alt+LMB emulation /
 * touch), click & box selection in object and edit mode, 3D cursor placement, modal G/R/S
 * transforms and the move/rotate/scale gizmo.
 */
export class ViewportInteraction {
  readonly boxRect = signal<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  modal: ModalTransform | null = null;
  private stroke: BrushStroke | null = null;
  private drag: { mode: DragMode; x: number; y: number; startX: number; startY: number; button: number; moved: boolean; shift: boolean; ctrl: boolean } | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; cx: number; cy: number } | null = null;
  readonly mouse = { x: 0, y: 0, inside: false };
  private gizmo: TransformControls;
  private gizmoProxy = new THREE.Object3D();
  private gizmoStart: { matrix: THREE.Matrix4; modal: ModalTransform } | null = null;
  private disposers: (() => void)[] = [];

  constructor(
    readonly engine: ViewportEngine,
    readonly session: ProjectSession,
    readonly el: HTMLElement,
    readonly host: InteractionHost,
  ) {
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerleave', () => (this.mouse.inside = false));
    el.addEventListener('pointerenter', () => (this.mouse.inside = true));

    // transform gizmo
    this.gizmo = new TransformControls(engine.camera, engine.canvas);
    this.gizmo.setSize(0.9);
    engine.overlay.add(this.gizmoProxy);
    engine.overlay.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => this.onGizmoDragging(!!(e as unknown as { value: boolean }).value));
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());
    this.gizmo.addEventListener('change', () => engine.requestRender());
    engine.onAfterRender.add(this.updateGizmo);
    this.disposers.push(() => engine.onAfterRender.delete(this.updateGizmo));
  }

  // ------------------------------------------------------------------ gizmo

  private updateGizmo = () => {
    const tool = this.session.view.tool.value;
    const modeMap: Record<string, 'translate' | 'rotate' | 'scale'> = { move: 'translate', rotate: 'rotate', scale: 'scale' };
    const gmode = modeMap[tool];
    const st = this.session.state;
    const hasSel = st.mode === 'EDIT' ? st.meshSelection.verts.size > 0 : st.selectedIds.length > 0;
    if (!gmode || !hasSel || this.modal || st.mode === 'SCULPT' || st.mode === 'VERTEX_PAINT') {
      if (this.gizmo.object) this.gizmo.detach();
      return;
    }
    if (this.gizmoStart) return;
    this.gizmo.camera = this.engine.camera;
    if (this.gizmo.mode !== gmode) this.gizmo.setMode(gmode);
    const snap = this.session.view.snapping.value;
    this.gizmo.setTranslationSnap(snap ? (this.engine.pose.distance > 4 ? 1 : 0.1) : null);
    this.gizmo.setRotationSnap(snap ? THREE.MathUtils.degToRad(5) : null);
    this.gizmo.setScaleSnap(snap ? 0.1 : null);
    const p = selectionPivot(this.session.doc, st);
    this.gizmoProxy.position.set(p[0], p[1], p[2]);
    this.gizmoProxy.quaternion.identity();
    this.gizmoProxy.scale.set(1, 1, 1);
    this.gizmoProxy.updateMatrixWorld(true);
    if (this.gizmo.object !== this.gizmoProxy) this.gizmo.attach(this.gizmoProxy);
  };

  private onGizmoDragging(dragging: boolean): void {
    if (dragging) {
      const kind: ModalKind = this.gizmo.mode === 'translate' ? 'translate' : this.gizmo.mode === 'rotate' ? 'rotate' : 'resize';
      const modal = new ModalTransform(this.engine, this.session, kind, { x: this.mouse.x, y: this.mouse.y });
      this.gizmoStart = { matrix: this.gizmoProxy.matrixWorld.clone(), modal };
      return;
    }
    const g = this.gizmoStart;
    this.gizmoStart = null;
    if (!g) return;
    const res = g.modal.finish(true);
    if (res) {
      const p = res.params;
      if (this.gizmo.mode === 'translate') p.value = this.gizmoProxy.position.clone().sub(new THREE.Vector3().setFromMatrixPosition(g.matrix)).toArray();
      else if (this.gizmo.mode === 'rotate') {
        const q = this.gizmoProxy.quaternion.clone();
        const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
        const s = Math.sqrt(Math.max(0, 1 - q.w * q.w)) || 1;
        const axis = [q.x / s, q.y / s, q.z / s].map((v) => v * Math.sign(q.w || 1));
        p.value = angle;
        p.axis = axis;
      } else p.value = this.gizmoProxy.scale.toArray();
      if (Math.abs(Number(p.value) || 0) > 0 || Array.isArray(p.value)) this.host.run(res.operator, p, 'toolbar');
    }
    this.updateGizmo();
  }

  private onGizmoChange(): void {
    const g = this.gizmoStart;
    if (!g) return;
    // reuse the modal transform preview with the gizmo's delta
    const m = g.modal;
    const pos = this.gizmoProxy.position.clone().sub(new THREE.Vector3().setFromMatrixPosition(g.matrix));
    const mat = new THREE.Matrix4();
    if (this.gizmo.mode === 'translate') mat.makeTranslation(pos.x, pos.y, pos.z);
    else if (this.gizmo.mode === 'rotate') mat.makeRotationFromQuaternion(this.gizmoProxy.quaternion);
    else mat.makeScale(this.gizmoProxy.scale.x, this.gizmoProxy.scale.y, this.gizmoProxy.scale.z);
    m.current = mat.toArray();
    (m as unknown as { preview(): void }).preview();
  }

  /** True while the gizmo handles the pointer. */
  private gizmoActive(): boolean {
    return !!this.gizmo.object && (this.gizmo.dragging || this.gizmo.axis !== null);
  }

  // ------------------------------------------------------------------ modal transforms

  startModal(kind: ModalKind): void {
    if (this.modal) return;
    const st = this.session.state;
    if (st.mode !== 'OBJECT' && st.mode !== 'EDIT') return;
    const m = new ModalTransform(this.engine, this.session, kind, { x: this.mouse.x, y: this.mouse.y });
    if (m.isEmpty) {
      m.finish(false);
      return;
    }
    this.modal = m;
    this.el.focus();
    telemetry.count('editor.modal.started', 1, { kind });
  }

  finishModal(confirm: boolean): void {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    const res = m.finish(confirm);
    telemetry.count('editor.modal.finished', 1, { kind: m.kind, confirmed: confirm });
    if (res) this.host.run(res.operator, res.params, 'hotkey');
  }

  /** Keys while a modal transform runs. Returns true if handled. */
  modalKey(e: KeyboardEvent): boolean {
    const m = this.modal;
    if (!m) return false;
    const k = e.key;
    if (k === 'Escape') {
      this.finishModal(false);
      return true;
    }
    if (k === 'Enter' || k === ' ') {
      this.finishModal(true);
      return true;
    }
    const up = k.toUpperCase();
    if (up === 'X' || up === 'Y' || up === 'Z') {
      m.setAxis(up, e.shiftKey);
      return true;
    }
    if (up === 'G' || up === 'R' || up === 'S') {
      const kind: ModalKind = up === 'G' ? 'translate' : up === 'R' ? 'rotate' : 'resize';
      if (kind !== m.kind) {
        m.finish(false);
        this.modal = new ModalTransform(this.engine, this.session, kind, { x: this.mouse.x, y: this.mouse.y });
      }
      return true;
    }
    if (m.typeKey(k)) return true;
    return false;
  }

  // ------------------------------------------------------------------ pointer handling

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown = (e: PointerEvent) => {
    const p = this.local(e);
    this.mouse.x = p.x;
    this.mouse.y = p.y;
    this.el.focus({ preventScroll: true });
    if (this.modal) {
      this.finishModal(e.button === 0);
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'touch') {
      this.pointers.set(e.pointerId, p);
      this.el.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        this.drag = null;
        return;
      }
    }
    if (this.gizmoActive()) return;
    const emulate = prefs.value.ui.emulate3Button && e.altKey && e.button === 0;
    const st = this.session.state;
    const painting = st.mode === 'SCULPT' || st.mode === 'VERTEX_PAINT';
    const brushPointer = e.pointerType === 'touch' ? this.pointers.size === 1 : e.button === 0 && !emulate;
    if (painting && brushPointer) {
      const o = st.activeId ? this.session.doc.getObject(st.activeId) : null;
      if (o?.type === 'MESH' && o.data) {
        this.stroke = new BrushStroke(this.engine, this.session, o.id, o.data, st.mode === 'VERTEX_PAINT', e.ctrlKey);
        this.stroke.move(p.x, p.y);
        this.el.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    let mode: DragMode = 'none';
    if (e.button === 1 || emulate) mode = e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit';
    else if (e.button === 0) mode = e.pointerType === 'touch' ? 'orbit' : 'box';
    else if (e.button === 2) {
      if (e.shiftKey) this.placeCursor(p.x, p.y);
      else this.host.openContextMenu(e.clientX, e.clientY);
      return;
    }
    this.drag = { mode, x: p.x, y: p.y, startX: p.x, startY: p.y, button: e.button, moved: false, shift: e.shiftKey, ctrl: e.ctrlKey };
    this.el.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.local(e);
    this.mouse.x = p.x;
    this.mouse.y = p.y;
    if (this.modal) {
      this.modal.update(p, { ctrl: e.ctrlKey || this.session.view.snapping.value, shift: e.shiftKey });
      return;
    }
    if (this.stroke) {
      this.stroke.move(p.x, p.y);
      return;
    }
    if (e.pointerType === 'touch' && this.pointers.has(e.pointerId)) {
      this.pointers.set(e.pointerId, p);
      if (this.pinch && this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        this.pan(cx - this.pinch.cx, cy - this.pinch.cy);
        if (dist > 0 && this.pinch.dist > 0) this.zoomBy(this.pinch.dist / dist);
        this.pinch = { dist, cx, cy };
        return;
      }
    }
    const d = this.drag;
    if (!d) return;
    const dx = p.x - d.x;
    const dy = p.y - d.y;
    if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > 4) d.moved = true;
    d.x = p.x;
    d.y = p.y;
    if (d.mode === 'orbit' && d.moved) this.orbit(dx, dy);
    else if (d.mode === 'pan') this.pan(dx, dy);
    else if (d.mode === 'zoom') this.zoomBy(Math.pow(1.01, dy));
    else if (d.mode === 'box' && d.moved && this.session.view.tool.value !== 'cursor')
      this.boxRect.value = { x0: Math.min(d.startX, p.x), y0: Math.min(d.startY, p.y), x1: Math.max(d.startX, p.x), y1: Math.max(d.startY, p.y) };
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.stroke) {
      const stroke = this.stroke;
      this.stroke = null;
      if (e.pointerType === 'touch') this.pointers.delete(e.pointerId);
      const mesh = stroke.finish();
      if (mesh) {
        pendingStroke = { objectId: stroke.objectId, meshId: stroke.meshId, mesh };
        this.host.run('sculpt.commit_stroke', {}, 'ui');
      }
      return;
    }
    if (e.pointerType === 'touch') {
      const wasPinch = !!this.pinch;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (wasPinch) {
        this.drag = null;
        this.engine.persistPose();
        return;
      }
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const p = this.local(e);
    if (d.mode === 'orbit' || d.mode === 'pan' || d.mode === 'zoom') {
      if (d.mode === 'orbit' && !d.moved && e.pointerType === 'touch') this.clickSelect(p.x, p.y, false, false);
      this.engine.persistPose();
      return;
    }
    if (d.mode === 'box') {
      const rect = this.boxRect.value;
      this.boxRect.value = null;
      if (this.session.view.tool.value === 'cursor' && !d.moved) {
        this.placeCursor(p.x, p.y);
        return;
      }
      if (rect && d.moved) this.boxSelect(rect, d.shift, d.ctrl);
      else this.clickSelect(p.x, p.y, e.shiftKey, e.altKey, e.ctrlKey);
    }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.modal) {
      if (this.session.state.proportionalEditing) {
        const st = this.session.state;
        st.proportionalSize = Math.max(0.001, st.proportionalSize * (e.deltaY > 0 ? 1.1 : 1 / 1.1));
        this.modal.update(this.mouse, { ctrl: false, shift: false });
      }
      return;
    }
    if (e.ctrlKey && Math.abs(e.deltaY) < 50) {
      // trackpad pinch
      this.zoomBy(Math.pow(1.01, e.deltaY));
    } else if (e.shiftKey) this.pan(-e.deltaY * 0.5, 0);
    else {
      const dir = prefs.value.ui.invertZoom ? -1 : 1;
      this.zoomBy(Math.pow(1.15, Math.sign(e.deltaY) * dir * Math.min(3, Math.abs(e.deltaY) / 50 || 1)));
    }
    this.engine.persistPose();
  };

  // ------------------------------------------------------------------ navigation

  private leaveCameraView(): void {
    const v = this.session.view;
    if (v.cameraView.value) v.cameraView.value = false;
    v.following.value = null;
  }

  orbit(dx: number, dy: number): void {
    this.leaveCameraView();
    const p = this.engine.pose;
    const s = 0.008 * prefs.value.ui.orbitSensitivity;
    p.yaw -= dx * s;
    p.pitch = THREE.MathUtils.clamp(p.pitch + dy * s, -Math.PI / 2, Math.PI / 2);
    // Auto perspective: leaving an axis-aligned view returns to perspective
    if (p.ortho && this.autoOrtho) {
      p.ortho = false;
      this.autoOrtho = false;
    }
    this.engine.requestRender();
  }
  autoOrtho = false;

  pan(dx: number, dy: number): void {
    this.leaveCameraView();
    const p = this.engine.pose;
    const { right, up } = poseBasis(p);
    const scale = (2 * p.distance * Math.tan(p.fovY / 2)) / Math.max(1, this.engine.height);
    p.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
    this.engine.requestRender();
  }

  zoomBy(factor: number): void {
    this.leaveCameraView();
    const p = this.engine.pose;
    p.distance = THREE.MathUtils.clamp(p.distance * factor, 0.01, 100000);
    this.engine.requestRender();
  }

  // ------------------------------------------------------------------ selection

  private placeCursor(x: number, y: number): void {
    const rc = this.engine.rayAt(x, y);
    const hits = rc.intersectObjects(this.engine.objects.pickables(), false).filter((h) => !h.object.userData.pickProxy);
    let pt: THREE.Vector3 | null = hits[0]?.point ?? null;
    if (!pt) pt = this.engine.viewPlanePoint(x, y, new THREE.Vector3(...this.session.state.cursorLocation));
    if (pt) this.host.run('view3d.cursor_set', { location: [pt.x, pt.y, pt.z] }, 'ui');
  }

  clickSelect(x: number, y: number, extend: boolean, alt = false, ctrl = false): void {
    const st = this.session.state;
    if (st.mode === 'EDIT') return this.clickSelectEdit(x, y, extend, alt, ctrl);
    if (st.mode !== 'OBJECT') return;
    const id = pickObject(this.engine, x, y);
    telemetry.count('editor.select.click', 1, { mode: 'OBJECT', hit: !!id });
    if (!id) {
      if (!extend) {
        st.selectedIds = [];
      }
      return;
    }
    if (extend) {
      const sel = st.selectedIds;
      if (sel.includes(id) && st.activeId === id) st.selectedIds = sel.filter((s) => s !== id);
      else {
        st.selectedIds = sel.includes(id) ? sel : [...sel, id];
        st.activeId = id;
      }
    } else {
      st.selectedIds = [id];
      st.activeId = id;
    }
  }

  private editContext() {
    const st = this.session.state;
    const ev = this.engine.ev;
    const o = st.activeId ? ev?.byId.get(st.activeId) : null;
    const mesh = o?.baseMesh;
    if (!o || !mesh) return null;
    return { o, mesh };
  }

  private clickSelectEdit(x: number, y: number, extend: boolean, alt: boolean, ctrl: boolean): void {
    const st = this.session.state;
    const ctx = this.editContext();
    if (!ctx) return;
    const { o, mesh } = ctx;
    const xray = this.session.view.xray.value;
    const mode = st.selectMode;
    const cur = st.meshSelection;
    let next: MeshSelection | null = null;
    if (alt) {
      // edge loop / ring selection via the mesh operator when available
      const proj = projectEditVerts(this.engine, mesh, o.worldMatrix, xray);
      const k = nearestEdge(proj, this.engine.edit.edges, x, y, 20);
      if (k) {
        const [a, b] = parseEdgeKey(k);
        this.host.run('mesh.loop_select', { edge: [a, b], extend, ring: ctrl }, 'ui');
      }
      return;
    }
    if (mode === 'VERT') {
      const proj = projectEditVerts(this.engine, mesh, o.worldMatrix, xray);
      const v = nearestVertex(proj, x, y);
      if (v >= 0) {
        const verts = new Set(extend ? cur.verts : []);
        if (extend && cur.verts.has(v)) verts.delete(v);
        else verts.add(v);
        next = selectionFromVerts(mesh, verts);
      } else if (!extend) next = emptySelection();
    } else if (mode === 'EDGE') {
      const proj = projectEditVerts(this.engine, mesh, o.worldMatrix, xray);
      const k = nearestEdge(proj, this.engine.edit.edges, x, y);
      if (k) {
        const edges = new Set(extend ? cur.edges : []);
        if (extend && cur.edges.has(k)) edges.delete(k);
        else edges.add(k);
        next = selectionFromEdges(mesh, edges);
      } else if (!extend) next = emptySelection();
    } else {
      const f = pickFace(this.engine, x, y);
      if (f >= 0) {
        const faces = new Set(extend ? cur.faces : []);
        if (extend && cur.faces.has(f)) faces.delete(f);
        else faces.add(f);
        next = selectionFromFaces(mesh, faces);
      } else if (!extend) next = emptySelection();
    }
    if (next) st.meshSelection = next;
    telemetry.count('editor.select.click', 1, { mode: `EDIT_${mode}` });
  }

  boxSelect(r: { x0: number; y0: number; x1: number; y1: number }, extend: boolean, subtract: boolean): void {
    const st = this.session.state;
    telemetry.count('editor.select.box', 1, { mode: st.mode });
    if (st.mode === 'OBJECT') {
      const ids = objectsInRect(this.engine, r);
      if (subtract) st.selectedIds = st.selectedIds.filter((id) => !ids.includes(id));
      else {
        st.selectedIds = extend ? [...new Set([...st.selectedIds, ...ids])] : ids;
        if (ids.length && (!st.activeId || !st.selectedIds.includes(st.activeId))) st.activeId = ids[ids.length - 1];
      }
      return;
    }
    if (st.mode !== 'EDIT') return;
    const ctx = this.editContext();
    if (!ctx) return;
    const { o, mesh } = ctx;
    const proj = projectEditVerts(this.engine, mesh, o.worldMatrix, this.session.view.xray.value);
    const inside = new Set<number>();
    proj.forEach((p, i) => {
      if (p.visible && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1) inside.add(i);
    });
    const cur = st.meshSelection;
    const mode = st.selectMode;
    if (mode === 'VERT') {
      const verts = new Set(extend || subtract ? cur.verts : []);
      for (const v of inside) subtract ? verts.delete(v) : verts.add(v);
      st.meshSelection = selectionFromVerts(mesh, verts);
    } else if (mode === 'EDGE') {
      const edges = new Set(extend || subtract ? cur.edges : []);
      for (const [a, b] of this.engine.edit.edges)
        if (inside.has(a) && inside.has(b)) {
          const k = edgeKey(a, b);
          subtract ? edges.delete(k) : edges.add(k);
        }
      st.meshSelection = selectionFromEdges(mesh, edges);
    } else {
      const faces = new Set(extend || subtract ? cur.faces : []);
      mesh.faces.forEach((f, i) => {
        if (f.every((v) => inside.has(v))) subtract ? faces.delete(i) : faces.add(i);
      });
      st.meshSelection = selectionFromFaces(mesh, faces);
    }
  }

  setOrthoAuto(): void {
    const p = clonePose(this.engine.pose);
    p.ortho = true;
    this.autoOrtho = true;
    this.engine.setPose(p, true);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.gizmo.detach();
    this.gizmo.dispose();
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.el.removeEventListener('pointermove', this.onPointerMove);
    this.el.removeEventListener('pointerup', this.onPointerUp);
    this.el.removeEventListener('pointercancel', this.onPointerUp);
    this.el.removeEventListener('wheel', this.onWheel);
  }
}

/** Mesh produced by the last interactive brush stroke, consumed by `sculpt.commit_stroke`. */
export let pendingStroke: { objectId: string; meshId: string; mesh: import('@3d-editor/core').MeshData } | null = null;
export function takePendingStroke() {
  const s = pendingStroke;
  pendingStroke = null;
  return s;
}
