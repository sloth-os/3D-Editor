import * as THREE from 'three';
import {
  FrameState,
  ObjectTransform,
  axisAngle4,
  evaluatedWorld,
  scaling4,
  selectedVertexSet,
  selectionPivot,
  transformVertices,
  translation4,
  type Mat4,
  type TransformMode,
  type Vec3,
} from '@3d-editor/core';
import type { ViewportEngine } from './engine';
import type { ProjectSession } from '../project/session';

export type ModalKind = 'translate' | 'rotate' | 'resize';
type Axis = 'X' | 'Y' | 'Z';

const AXES: Record<Axis, THREE.Vector3> = {
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
};

export interface ModalResult {
  operator: string;
  params: Record<string, unknown>;
}

/** The core transform mode of a modal kind. */
const MODES: Record<ModalKind, TransformMode> = {
  translate: 'TRANSLATE',
  rotate: 'ROTATE',
  resize: 'RESIZE',
};

/**
 * Interactive G / R / S transform (Blender style): mouse-driven with axis/plane constraints
 * (X/Y/Z, Shift+X/Y/Z), typed numeric input, Ctrl snapping and Shift precision.
 * The preview is local only; confirming runs the equivalent core operator so the result is one
 * undo step that syncs to every device. The preview shows what confirming stores: every object the
 * transform can move is drawn with the world matrix the scene evaluates once the operator stored
 * (and keyed, where they are animated) the channels it computes (Blender's Move, Rotate and Scale,
 * from where the scene shows the objects at the current frame): the objects it transforms, their
 * children, and the objects whose constraints or drivers read them (see ObjectTransform.worlds).
 */
export class ModalTransform {
  readonly pivot: THREE.Vector3;
  private pivotScreen: { x: number; y: number };
  private start: { x: number; y: number };
  private last: { x: number; y: number };
  axis: Axis | null = null;
  planeExclude = false;
  numeric = '';
  private angleAcc = 0;
  private lastAngle: number;
  private precisionOrigin: { x: number; y: number } | null = null;
  /** The objects the operator changes and what it reads from each (Object Mode). */
  private readonly objects: ObjectTransform | null = null;
  private editBase: {
    id: string;
    mesh: import('@3d-editor/core').MeshData;
    verts: Set<number>;
    world: Mat4;
  } | null = null;
  current: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  private summary = '';

  constructor(
    readonly engine: ViewportEngine,
    readonly session: ProjectSession,
    readonly kind: ModalKind,
    mouse: { x: number; y: number },
  ) {
    const { doc, state } = session;
    // what the operator reads when the transform is confirmed: the scene at the current frame
    const fs = new FrameState(doc, state.frame);
    const mode = MODES[kind];
    if (state.mode === 'EDIT') {
      this.pivot = new THREE.Vector3(...selectionPivot(doc, state, state.pivotPoint, { mode, fs }));
      const o = state.activeId ? doc.getObject(state.activeId) : null;
      const mesh = o?.data ? doc.getMesh(o.data) : null;
      if (o && mesh)
        this.editBase = {
          id: o.id,
          mesh,
          verts: selectedVertexSet(mesh, state.meshSelection),
          world: evaluatedWorld(fs, o.id),
        };
    } else {
      this.objects = new ObjectTransform(fs, state.selectedIds, state.pivotPoint, mode);
      this.pivot = new THREE.Vector3(...this.objects.pivot(state));
    }
    this.pivotScreen = engine.project(this.pivot);
    this.start = { ...mouse };
    this.last = { ...mouse };
    this.lastAngle = Math.atan2(mouse.y - this.pivotScreen.y, mouse.x - this.pivotScreen.x);
    this.update(mouse, { ctrl: false, shift: false });
  }

  get isEmpty(): boolean {
    return this.editBase ? this.editBase.verts.size === 0 : !this.objects?.targets.length;
  }

  setAxis(axis: Axis, exclude: boolean): void {
    if (this.axis === axis && this.planeExclude === exclude) this.axis = null;
    else {
      this.axis = axis;
      this.planeExclude = exclude;
    }
    this.update(this.last, { ctrl: false, shift: false });
  }

  typeKey(key: string): boolean {
    if (/^[0-9]$/.test(key) || key === '.') this.numeric += key;
    else if (key === '-')
      this.numeric = this.numeric.startsWith('-') ? this.numeric.slice(1) : `-${this.numeric}`;
    else if (key === 'Backspace') this.numeric = this.numeric.slice(0, -1);
    else return false;
    this.update(this.last, { ctrl: false, shift: false });
    return true;
  }

  private axisVec(): THREE.Vector3 | null {
    return this.axis ? AXES[this.axis].clone() : null;
  }

  update(mouse: { x: number; y: number }, mods: { ctrl: boolean; shift: boolean }): void {
    // Shift = precision: movement relative to where Shift was pressed counts 10x less
    let m = mouse;
    if (mods.shift) {
      if (!this.precisionOrigin) this.precisionOrigin = { ...this.last };
      m = {
        x: this.precisionOrigin.x + (mouse.x - this.precisionOrigin.x) * 0.1,
        y: this.precisionOrigin.y + (mouse.y - this.precisionOrigin.y) * 0.1,
      };
    } else this.precisionOrigin = null;
    this.last = { ...mouse };
    const num = this.numeric && this.numeric !== '-' && this.numeric !== '.' ? Number(this.numeric) : null;
    if (this.kind === 'translate') this.current = this.computeTranslate(m, num, mods.ctrl);
    else if (this.kind === 'rotate') this.current = this.computeRotate(m, num, mods.ctrl);
    else this.current = this.computeScale(m, num, mods.ctrl);
    this.preview();
  }

  private computeTranslate(m: { x: number; y: number }, num: number | null, snap: boolean): Mat4 {
    const e = this.engine;
    let delta = new THREE.Vector3();
    const axis = this.axisVec();
    if (num !== null) {
      delta = (axis && !this.planeExclude ? axis : AXES.X.clone()).multiplyScalar(num);
    } else if (axis && !this.planeExclude) {
      const a = this.closestOnAxis(this.start, axis);
      const b = this.closestOnAxis(m, axis);
      if (a && b) delta = axis.clone().multiplyScalar(b - a);
    } else if (axis && this.planeExclude) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, this.pivot);
      const p0 = e.rayAt(this.start.x, this.start.y).ray.intersectPlane(plane, new THREE.Vector3());
      const p1 = e.rayAt(m.x, m.y).ray.intersectPlane(plane, new THREE.Vector3());
      if (p0 && p1) delta = p1.sub(p0);
    } else {
      const p0 = e.viewPlanePoint(this.start.x, this.start.y, this.pivot);
      const p1 = e.viewPlanePoint(m.x, m.y, this.pivot);
      if (p0 && p1) delta = p1.sub(p0);
    }
    if (snap && num === null) {
      // the grid's step in the view drawn (also during an animated view change)
      const inc = this.engine.shownPose.distance > 4 ? 1 : 0.1;
      delta.set(
        Math.round(delta.x / inc) * inc,
        Math.round(delta.y / inc) * inc,
        Math.round(delta.z / inc) * inc,
      );
    }
    this.summary = `D: ${delta.x.toFixed(4)} m  ${delta.y.toFixed(4)} m  ${delta.z.toFixed(4)} m (${delta.length().toFixed(4)} m)`;
    return translation4([delta.x, delta.y, delta.z]);
  }

  /** Parameter along an axis line through the pivot closest to the mouse ray. */
  private closestOnAxis(m: { x: number; y: number }, axis: THREE.Vector3): number | null {
    const ray = this.engine.rayAt(m.x, m.y).ray;
    const w0 = this.pivot.clone().sub(ray.origin);
    const b = axis.dot(ray.direction);
    const d = axis.dot(w0);
    const e = ray.direction.dot(w0);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-6) {
      // axis is parallel to the view direction: fall back to screen projection
      const s0 = this.engine.project(this.pivot);
      const s1 = this.engine.project(this.pivot.clone().add(axis));
      const sx = s1.x - s0.x;
      const sy = s1.y - s0.y;
      const l2 = sx * sx + sy * sy || 1;
      return ((m.x - s0.x) * sx + (m.y - s0.y) * sy) / l2;
    }
    return (b * e - d) / denom;
  }

  private computeRotate(m: { x: number; y: number }, num: number | null, snap: boolean): Mat4 {
    const a = Math.atan2(m.y - this.pivotScreen.y, m.x - this.pivotScreen.x);
    let d = a - this.lastAngle;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.angleAcc += d;
    this.lastAngle = a;
    const toViewer = new THREE.Vector3();
    this.engine.camera.getWorldDirection(toViewer);
    toViewer.negate();
    let axis = this.axisVec() ?? toViewer.clone();
    let angle = -this.angleAcc;
    if (this.axis && axis.dot(toViewer) < 0) angle = -angle;
    if (num !== null) angle = THREE.MathUtils.degToRad(num);
    else if (snap) angle = THREE.MathUtils.degToRad(Math.round(THREE.MathUtils.radToDeg(angle) / 5) * 5);
    axis = axis.normalize();
    this.rotAxis = [axis.x, axis.y, axis.z];
    this.rotAngle = angle;
    this.summary = `Rot: ${THREE.MathUtils.radToDeg(angle).toFixed(2)}°${this.axis ? ` along ${this.axis}` : ''}`;
    return axisAngle4([axis.x, axis.y, axis.z], angle);
  }
  rotAxis: Vec3 = [0, 0, 1];
  rotAngle = 0;

  private computeScale(m: { x: number; y: number }, num: number | null, snap: boolean): Mat4 {
    const d0 = Math.hypot(this.start.x - this.pivotScreen.x, this.start.y - this.pivotScreen.y) || 1;
    const d1 = Math.hypot(m.x - this.pivotScreen.x, m.y - this.pivotScreen.y);
    let f = num !== null ? num : d1 / d0;
    if (snap && num === null) f = Math.round(f * 10) / 10;
    let s: Vec3 = [f, f, f];
    if (this.axis) {
      const i = { X: 0, Y: 1, Z: 2 }[this.axis];
      s = this.planeExclude
        ? ([f, f, f].map((v, k) => (k === i ? 1 : v)) as Vec3)
        : ([1, 1, 1].map((v, k) => (k === i ? f : v)) as Vec3);
    }
    this.scaleValue = s;
    this.summary = `Scale X: ${s[0].toFixed(4)}  Y: ${s[1].toFixed(4)}  Z: ${s[2].toFixed(4)}`;
    return scaling4(s);
  }
  scaleValue: Vec3 = [1, 1, 1];

  private preview(): void {
    const { state } = this.session;
    const pivot: Vec3 = [this.pivot.x, this.pivot.y, this.pivot.z];
    if (this.editBase) {
      const mesh = transformVertices(
        this.editBase.mesh,
        this.editBase.verts,
        this.editBase.world,
        this.current,
        pivot,
        {
          proportional: state.proportionalEditing,
          proportionalSize: state.proportionalSize,
          falloff: state.proportionalFalloff,
        },
      );
      this.engine.setMeshOverride(this.editBase.id, mesh);
    } else if (this.objects) {
      // the channels confirming stores, and the world matrices the scene evaluates from them
      this.engine.setMatrixOverrides(this.previewMatrices());
    }
    const constraint = this.axis ? `${this.planeExclude ? 'plane ⟂ ' : 'along '}${this.axis}` : '';
    this.session.view.hud.value = `${this.summary}${constraint ? `  ${constraint}` : ''}${this.numeric ? `  [${this.numeric}]` : ''}`;
  }

  /**
   * The world matrices the preview draws (Object Mode): those the scene evaluates after the
   * operator stores the channels of the transform shown (see ObjectTransform.worlds), for every
   * object the transform can move.
   */
  previewMatrices(): Map<string, Mat4> {
    if (!this.objects) return new Map();
    const pivot: Vec3 = [this.pivot.x, this.pivot.y, this.pivot.z];
    return this.objects.worlds(this.objects.channels(this.current, pivot));
  }

  /** Ends the modal; returns the operator call that reproduces the transform (or null if cancelled). */
  finish(confirm: boolean): ModalResult | null {
    this.engine.setMatrixOverrides(null);
    if (this.editBase) this.engine.setMeshOverride(this.editBase.id, null);
    this.session.view.hud.value = null;
    if (!confirm) return null;
    const pivot: Vec3 = [this.pivot.x, this.pivot.y, this.pivot.z];
    if (this.kind === 'translate') {
      const c = this.current;
      return { operator: 'transform.translate', params: { value: [c[12], c[13], c[14]] } };
    }
    if (this.kind === 'rotate')
      return {
        operator: 'transform.rotate',
        params: { value: this.rotAngle, axis: this.rotAxis, center: pivot },
      };
    return { operator: 'transform.resize', params: { value: this.scaleValue, center: pivot } };
  }
}
