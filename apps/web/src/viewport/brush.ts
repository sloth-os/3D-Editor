import * as THREE from 'three';
import {
  applyPaintDab,
  applySculptDab,
  beginGrab,
  cloneMesh,
  createSculptCache,
  refreshSculptNormals,
  type MeshData,
  type SculptBrush,
  type SculptCache,
  type Vec3,
} from '@3d-editor/core';
import type { ViewportEngine } from './engine';
import type { ProjectSession } from '../project/session';
import { geometryFromMesh } from './scene-objects';
import { telemetry } from '../telemetry/telemetry';

export const TOOL_BRUSH: Record<string, SculptBrush> = {
  sculpt_draw: 'DRAW',
  sculpt_smooth: 'SMOOTH',
  sculpt_grab: 'GRAB',
  sculpt_inflate: 'INFLATE',
  sculpt_flatten: 'FLATTEN',
};

/**
 * Interactive sculpt / vertex-paint stroke. Dabs are applied to a private copy of the mesh and
 * previewed through the engine's mesh override; releasing the mouse commits the whole stroke as
 * one undoable change (which then syncs to every device).
 */
export class BrushStroke {
  private mesh: MeshData;
  private cache: SculptCache;
  private hitMesh: THREE.Mesh;
  private world: THREE.Matrix4;
  private inv: THREE.Matrix4;
  private last: THREE.Vector3 | null = null;
  private grabStartWorld: THREE.Vector3 | null = null;
  private dabs = 0;
  private span = telemetry.startSpan('sculpt.stroke');

  constructor(
    readonly engine: ViewportEngine,
    readonly session: ProjectSession,
    readonly objectId: string,
    readonly meshId: string,
    readonly paint: boolean,
    readonly invert: boolean,
  ) {
    const base = session.doc.getMesh(meshId)!;
    this.mesh = cloneMesh(base);
    this.cache = createSculptCache(this.mesh);
    const ev = engine.ev?.byId.get(objectId);
    this.world = new THREE.Matrix4().fromArray(ev?.worldMatrix ?? session.doc.worldMatrix(objectId));
    this.inv = this.world.clone().invert();
    this.hitMesh = new THREE.Mesh(geometryFromMesh(this.mesh).geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    this.hitMesh.matrixAutoUpdate = false;
    this.hitMesh.matrix.copy(this.world);
    this.hitMesh.updateMatrixWorld(true);
    this.span.setAttribute('brush.paint', paint).setAttribute('mesh.vertices', this.mesh.positions.length / 3);
  }

  /** World radius of the brush for a screen radius at a world point. */
  private worldRadius(p: THREE.Vector3): number {
    const cam = this.engine.camera;
    const px = this.session.view.brush.value.radius;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const oc = cam as THREE.OrthographicCamera;
      return (px * (oc.top - oc.bottom)) / this.engine.height;
    }
    const pc = cam as THREE.PerspectiveCamera;
    const d = p.distanceTo(pc.getWorldPosition(new THREE.Vector3()));
    return (px * 2 * d * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / this.engine.height;
  }

  private hit(x: number, y: number): THREE.Vector3 | null {
    const rc = this.engine.rayAt(x, y);
    const h = rc.intersectObject(this.hitMesh, false)[0];
    return h ? h.point : null;
  }

  /** Applies dabs along the mouse path. Returns false if the brush is off the mesh. */
  move(x: number, y: number): boolean {
    const b = this.session.view.brush.value;
    const brush = TOOL_BRUSH[this.session.view.tool.value] ?? 'DRAW';
    if (!this.paint && brush === 'GRAB') {
      if (!this.grabStartWorld) {
        const p = this.hit(x, y);
        if (!p) return false;
        this.grabStartWorld = p;
        const local = p.clone().applyMatrix4(this.inv);
        const r = this.worldRadius(p) / this.scale();
        beginGrab(this.mesh, this.cache, [local.x, local.y, local.z], r, b.symmetryX);
        return true;
      }
      const target = this.engine.viewPlanePoint(x, y, this.grabStartWorld);
      if (!target) return true;
      const prev = this.last ?? this.grabStartWorld;
      const deltaWorld = target.clone().sub(prev);
      this.last = target;
      const dl = deltaWorld.clone().transformDirection(this.inv).multiplyScalar(deltaWorld.length() / Math.max(1e-9, deltaWorld.clone().transformDirection(this.inv).length()) / this.scale());
      applySculptDab(this.mesh, this.cache, { brush: 'GRAB', center: [0, 0, 0], radius: 1, strength: 1, grabDelta: [dl.x, dl.y, dl.z], symmetryX: b.symmetryX });
      this.preview();
      return true;
    }
    const p = this.hit(x, y);
    if (!p) return false;
    const radiusWorld = this.worldRadius(p);
    // space dabs at ~25% of the radius along the stroke
    const points: THREE.Vector3[] = [];
    if (this.last) {
      const dist = this.last.distanceTo(p);
      const step = Math.max(radiusWorld * 0.25, 1e-6);
      const n = Math.min(20, Math.floor(dist / step));
      for (let i = 1; i <= n; i++) points.push(this.last.clone().lerp(p, i / n));
      if (n === 0) return true;
    } else points.push(p);
    this.last = p;
    const scale = this.scale();
    for (const q of points) {
      const l = q.clone().applyMatrix4(this.inv);
      const c: Vec3 = [l.x, l.y, l.z];
      if (this.paint) applyPaintDab(this.mesh, c, radiusWorld / scale, b.color, b.strength, b.symmetryX);
      else applySculptDab(this.mesh, this.cache, { brush, center: c, radius: radiusWorld / scale, strength: b.strength, invert: this.invert, symmetryX: b.symmetryX });
      this.dabs++;
    }
    if (!this.paint) refreshSculptNormals(this.mesh, this.cache);
    this.preview();
    return true;
  }

  private scale(): number {
    return Math.cbrt(Math.abs(this.world.determinant())) || 1;
  }

  private previewPending = false;
  private preview(): void {
    // Coalesce previews to one per animation frame. A fresh copy is needed because evaluated
    // meshes are cached by object identity.
    if (this.previewPending) return;
    this.previewPending = true;
    requestAnimationFrame(() => {
      this.previewPending = false;
      if (this.finished) return;
      this.engine.setMeshOverride(this.objectId, cloneMesh(this.mesh));
      this.hitMesh.geometry.dispose();
      this.hitMesh.geometry = geometryFromMesh(this.mesh).geometry;
    });
  }
  private finished = false;

  /** Ends the stroke; returns the final mesh to commit (or null if nothing changed). */
  finish(): MeshData | null {
    this.finished = true;
    this.engine.setMeshOverride(this.objectId, null);
    this.hitMesh.geometry.dispose();
    (this.hitMesh.material as THREE.Material).dispose();
    this.span.setAttribute('brush.dabs', this.dabs).setOk().end();
    return this.dabs > 0 || this.grabStartWorld ? this.mesh : null;
  }
}
