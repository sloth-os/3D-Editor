import * as THREE from 'three';
import {
  ObjectTransform,
  axisAngle4,
  cross3,
  identity4,
  invert4,
  normalize3,
  orientAxes,
  scaling4,
  selectedVertexSet,
  selectionPivot,
  shownWorld,
  transformDirection3,
  transformFrameState,
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
/** The axes a constraint is in: the world's, or the active object's (Blender's LOCAL orientation). */
export type ConstraintOrientation = 'GLOBAL' | 'LOCAL';

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

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
 * (X/Y/Z, Shift+X/Y/Z; for a move or rotation pressed again in the active object's axes, see
 * {@link setAxis}), typed numeric input, Ctrl snapping and Shift precision.
 * The preview is local only; confirming runs the equivalent core operator so the result is one
 * undo step that syncs to every device. The preview shows what confirming stores: every object the
 * transform can move is drawn with the world matrix the scene evaluates once the operator stored
 * (and keyed, where they are animated) the channels it computes (Blender's Move, Rotate and Scale,
 * from where the scene shows the objects at the current frame, rigid bodies where the simulation
 * has them): the objects it transforms, their children, and every object that reads them through
 * constraints, drivers or other datablocks (see ObjectTransform.worlds). Cancelling draws every
 * object as before and changes nothing.
 */
export class ModalTransform {
  readonly pivot: THREE.Vector3;
  private pivotScreen: { x: number; y: number };
  private start: { x: number; y: number };
  private last: { x: number; y: number };
  axis: Axis | null = null;
  planeExclude = false;
  /**
   * Blender's orientation slots of a transform (t->orient, set in initTransInfo,
   * transform_generics.cc): the default and the scene's orientation (the editor's transform
   * orientation), then the other one (LOCAL when the scene's is GLOBAL, else GLOBAL). The
   * constraint is in the slot `orientSlot` (t->orient_curr), 0 while there is none (see setAxis).
   * A scale has the world's axes only (see the constructor).
   */
  private readonly orientSlots: readonly ConstraintOrientation[];
  private orientSlot = 0;
  /** The LOCAL axes, as the operator confirming the transform reads them (read when first needed). */
  private localAxesRead: Mat4 | null = null;
  /** A move's value in the axes of its constraint's orientation (what transform.translate stores). */
  private moveValue: Vec3 = [0, 0, 0];
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
    // the editor's orientations other than GLOBAL and LOCAL cannot be set (the operators take only
    // those two): they count as GLOBAL
    const scene: ConstraintOrientation = state.transformOrientation === 'LOCAL' ? 'LOCAL' : 'GLOBAL';
    // a scale is confirmed by transform.resize, which scales along the world's axes only (it takes
    // no orient_type, unlike Blender's Scale): its axis keys constrain along those, and a second
    // press removes the constraint
    this.orientSlots =
      kind === 'resize' ? ['GLOBAL', 'GLOBAL'] : [scene, scene, scene === 'GLOBAL' ? 'LOCAL' : 'GLOBAL'];
    // what the operator reads when the transform is confirmed: the scene at the current frame, as
    // the viewport shows it (rigid bodies where the simulation has them)
    const fs = transformFrameState(doc, state.frame);
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
          // where the scene shows the object (also where it reads a dependency cycle), as the
          // operator confirming the transform reads it
          world: shownWorld(fs, o.id),
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

  /** The orientation of the constraint's axes (that of the slot it is in; see {@link setAxis}). */
  get orientation(): ConstraintOrientation {
    return this.orientSlots[this.orientSlot];
  }

  /**
   * An axis key (X, Y, Z; with Shift the plane without that axis), as Blender's
   * transform_event_modal_constraint (transform.cc) takes it: the first press constrains in the
   * scene's orientation (the editor's transform orientation, GLOBAL by default), the same key again
   * in the next slot's (LOCAL after GLOBAL: the active object's axes, as transform.translate and
   * transform.rotate take them with orient_type LOCAL), a third press removes the constraint;
   * another axis or plane constrains in the scene's orientation again. A scale has no LOCAL slot
   * (see orientSlots): its second press removes the constraint.
   */
  setAxis(axis: Axis, exclude: boolean): void {
    const same = this.axis === axis && this.planeExclude === exclude;
    const slots = this.orientSlots.length;
    this.orientSlot = this.orientSlot === 0 || this.axis === null || same ? (this.orientSlot + 1) % slots : 1;
    if (this.orientSlot === 0) this.axis = null;
    else {
      this.axis = axis;
      this.planeExclude = exclude;
    }
    this.update(this.last, { ctrl: false, shift: false });
  }

  /** Whether the constraint is in the active object's axes (LOCAL). */
  private get local(): boolean {
    return this.axis !== null && this.orientation === 'LOCAL';
  }

  /**
   * The axes of the LOCAL orientation (columns X, Y, Z) as transform.translate and transform.rotate
   * read them for orient_type LOCAL when the transform is confirmed (orientationOf in core's
   * transform.ts): the active object's (see orientAxes), the world's without an active object.
   */
  private get localAxes(): Mat4 {
    if (!this.localAxesRead) {
      const { doc, state } = this.session;
      const active = state.activeId ? doc.getObject(state.activeId) : null;
      this.localAxesRead = active
        ? orientAxes(transformFrameState(doc, state.frame), active.id)
        : identity4();
    }
    return this.localAxesRead;
  }

  /** The axes of the constraint's orientation, or null for the world's. */
  private constraintAxes(): Mat4 | null {
    return this.local ? this.localAxes : null;
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

  /** The constraint's axis in world space (unit length; for a plane, the axis it leaves out). */
  private axisVec(): THREE.Vector3 | null {
    if (!this.axis) return null;
    const o = this.constraintAxes();
    if (!o) return AXES[this.axis].clone();
    const k = AXIS_INDEX[this.axis] * 4;
    return new THREE.Vector3(o[k], o[k + 1], o[k + 2]);
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

  /**
   * A move: its value in the axes of the constraint's orientation (the world's without a LOCAL
   * constraint), which is what the header shows and what confirming stores, and the world offset
   * the operator computes from it (transform.translate turns a LOCAL value into the world with the
   * same axes).
   */
  private computeTranslate(m: { x: number; y: number }, num: number | null, snap: boolean): Mat4 {
    const e = this.engine;
    const o = this.constraintAxes();
    const axis = this.axisVec();
    const k = this.axis ? AXIS_INDEX[this.axis] : 0;
    let value: Vec3 = [0, 0, 0];
    if (num !== null) {
      // a typed value moves along the constraint's axis or the first axis its plane keeps (Blender's
      // constraintNumInput), along X without a constraint
      value[this.axis && this.planeExclude ? (k === 0 ? 1 : 0) : k] = num;
    } else if (axis && !this.planeExclude) {
      const a = this.closestOnAxis(this.start, axis);
      const b = this.closestOnAxis(m, axis);
      if (a !== null && b !== null) value[k] = b - a;
    } else if (axis && this.planeExclude) {
      // the plane through the pivot that holds the two other axes of the orientation
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.planeNormal(), this.pivot);
      const p0 = e.rayAt(this.start.x, this.start.y).ray.intersectPlane(plane, new THREE.Vector3());
      const p1 = e.rayAt(m.x, m.y).ray.intersectPlane(plane, new THREE.Vector3());
      if (p0 && p1) {
        const d = p1.sub(p0);
        value = o ? transformDirection3(invert4(o), [d.x, d.y, d.z]) : [d.x, d.y, d.z];
        value[k] = 0;
      }
    } else {
      const p0 = e.viewPlanePoint(this.start.x, this.start.y, this.pivot);
      const p1 = e.viewPlanePoint(m.x, m.y, this.pivot);
      if (p0 && p1) value = p1.sub(p0).toArray();
    }
    if (snap && num === null) {
      // the grid's step in the view drawn (also during an animated view change)
      const inc = this.engine.shownPose.distance > 4 ? 1 : 0.1;
      value = value.map((v) => Math.round(v / inc) * inc) as Vec3;
    }
    this.moveValue = value;
    const len = Math.hypot(...value);
    this.summary = `D: ${value[0].toFixed(4)} m  ${value[1].toFixed(4)} m  ${value[2].toFixed(4)} m (${len.toFixed(4)} m)`;
    return translation4(o ? transformDirection3(o, value) : value);
  }

  /** The normal of a plane constraint's plane: across the two axes of the orientation it keeps. */
  private planeNormal(): THREE.Vector3 {
    const k = AXIS_INDEX[this.axis ?? 'X'];
    const o = this.constraintAxes();
    if (!o) return AXES[this.axis ?? 'X'].clone();
    const col = (i: number): Vec3 => [o[i * 4], o[i * 4 + 1], o[i * 4 + 2]];
    return new THREE.Vector3(...normalize3(cross3(col((k + 1) % 3), col((k + 2) % 3))));
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
    this.rotAngle = angle;
    this.summary = `Rot: ${THREE.MathUtils.radToDeg(angle).toFixed(2)}°`;
    if (this.local) {
      // the axis transform.rotate takes for orient_type LOCAL and orient_axis: the column of the
      // LOCAL axes as it is, so the preview shows exactly what confirming stores
      this.rotAxis = [axis.x, axis.y, axis.z];
      return axisAngle4(this.rotAxis, angle);
    }
    axis = axis.normalize();
    this.rotAxis = [axis.x, axis.y, axis.z];
    // the matrix transform.rotate builds from the parameters confirming passes (it normalizes the
    // axis again, which can change its last bits), so the preview shows exactly what it stores
    return axisAngle4(normalize3(this.rotAxis), angle);
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
      const i = AXIS_INDEX[this.axis];
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
    // Blender's header: "along global X", "along local X", "locking local X" (a plane constraint)
    const constraint = this.axis
      ? `${this.planeExclude ? 'locking' : 'along'} ${this.orientation.toLowerCase()} ${this.axis}`
      : '';
    this.session.view.hud.value = `${this.summary}${constraint ? `  ${constraint}` : ''}${this.numeric ? `  [${this.numeric}]` : ''}`;
  }

  /**
   * The world matrices the preview draws (Object Mode): those the scene evaluates after the
   * operator stores the channels of the transform shown and keys them as confirming keys them,
   * with the editor's auto keying (see ObjectTransform.worlds), for every object the transform can
   * move.
   */
  previewMatrices(): Map<string, Mat4> {
    if (!this.objects) return new Map();
    const pivot: Vec3 = [this.pivot.x, this.pivot.y, this.pivot.z];
    return this.objects.worlds(this.objects.channels(this.current, pivot), {
      autoKeying: this.session.state.autoKeying,
    });
  }

  /** Ends the modal; returns the operator call that reproduces the transform (or null if cancelled). */
  finish(confirm: boolean): ModalResult | null {
    this.engine.setMatrixOverrides(null);
    if (this.editBase) this.engine.setMeshOverride(this.editBase.id, null);
    this.session.view.hud.value = null;
    if (!confirm) return null;
    const pivot: Vec3 = [this.pivot.x, this.pivot.y, this.pivot.z];
    // a constraint in the active object's axes is stored as one: orient_type LOCAL, with the value
    // (and the rotation's axis) in those axes, as Blender's operators store it
    const local = this.local ? { orient_type: 'LOCAL' } : {};
    if (this.kind === 'translate') {
      const c = this.current;
      const value = this.local ? [...this.moveValue] : [c[12], c[13], c[14]];
      return { operator: 'transform.translate', params: { value, ...local } };
    }
    if (this.kind === 'rotate')
      return {
        operator: 'transform.rotate',
        params: this.local
          ? { value: this.rotAngle, orient_axis: this.axis, ...local, center: pivot }
          : { value: this.rotAngle, axis: this.rotAxis, center: pivot },
      };
    return { operator: 'transform.resize', params: { value: this.scaleValue, center: pivot } };
  }
}
