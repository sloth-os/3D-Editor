import * as THREE from 'three';
import { edgeKey, vertexCount, type MeshData, type Vec3 } from '@3d-editor/core';
import type { ViewportEngine } from './engine';
import { DepthCapture, linearDepth } from './depth';

const depth = new DepthCapture();

/** Object id under the mouse (null for empty space). */
export function pickObject(engine: ViewportEngine, x: number, y: number): string | null {
  const rc = engine.rayAt(x, y);
  const hits = rc.intersectObjects(engine.objects.pickables(), false);
  for (const h of hits) {
    let o: THREE.Object3D | null = h.object;
    while (o && !o.userData.objectId) o = o.parent;
    const id = o?.userData.objectId as string | undefined;
    if (!id) continue;
    const data = engine.ev?.byId.get(id)?.data;
    if (data?.hide_select) continue;
    return id;
  }
  return null;
}

/** Objects whose geometry (or origin) projects inside a screen rectangle. */
export function objectsInRect(
  engine: ViewportEngine,
  r: { x0: number; y0: number; x1: number; y1: number },
): string[] {
  const out: string[] = [];
  const ev = engine.ev;
  if (!ev) return out;
  const inside = (p: { x: number; y: number; z: number }) =>
    p.z > -1 && p.z < 1 && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  for (const o of ev.objects) {
    if (!o.visible || o.data.hide_select) continue;
    let hit = false;
    if (o.mesh && vertexCount(o.mesh) > 0) {
      const n = vertexCount(o.mesh);
      const step = Math.max(1, Math.floor(n / 4000));
      const m = o.worldMatrix;
      const P = o.mesh.positions;
      for (let i = 0; i < n && !hit; i += step) {
        const w: Vec3 = [
          m[0] * P[i * 3] + m[4] * P[i * 3 + 1] + m[8] * P[i * 3 + 2] + m[12],
          m[1] * P[i * 3] + m[5] * P[i * 3 + 1] + m[9] * P[i * 3 + 2] + m[13],
          m[2] * P[i * 3] + m[6] * P[i * 3 + 1] + m[10] * P[i * 3 + 2] + m[14],
        ];
        hit = inside(engine.project(w));
      }
    } else hit = inside(engine.project([o.worldMatrix[12], o.worldMatrix[13], o.worldMatrix[14]]));
    if (hit) out.push(o.id);
  }
  return out;
}

interface Projected {
  x: number;
  y: number;
  visible: boolean;
}

/** Projects all vertices of the edit mesh, testing occlusion against the cage (unless x-ray). */
export function projectEditVerts(
  engine: ViewportEngine,
  mesh: MeshData,
  world: number[],
  xray: boolean,
): Projected[] {
  const n = vertexCount(mesh);
  const out: Projected[] = new Array(n);
  const cam = engine.camera;
  if (!xray) depth.capture(engine.renderer, cam, [engine.edit.cage], engine.width, engine.height);
  const v = new THREE.Vector3();
  const mw = new THREE.Matrix4().fromArray(world);
  const camPos = new THREE.Vector3();
  cam.getWorldPosition(camPos);
  const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera;
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  for (let i = 0; i < n; i++) {
    v.set(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]).applyMatrix4(mw);
    const eyeDist = ortho ? v.clone().sub(camPos).dot(dir) : v.distanceTo(camPos);
    const p = v.clone().project(cam);
    const x = (p.x * 0.5 + 0.5) * engine.width;
    const y = (-p.y * 0.5 + 0.5) * engine.height;
    let visible = p.z > -1 && p.z < 1;
    if (visible && !xray) {
      const d = depth.depthAt(x, y);
      if (d < 1) {
        const surf = linearDepth(d, cam as THREE.PerspectiveCamera);
        // eye distance along view ray vs depth (perspective depth is along the view axis)
        const along = ortho ? eyeDist : v.clone().sub(camPos).dot(dir);
        visible = along <= surf + Math.max(0.002, surf * 0.004);
      }
    }
    out[i] = { x, y, visible };
  }
  return out;
}

export function nearestVertex(proj: Projected[], x: number, y: number, maxDist = 14): number {
  let best = -1;
  let bestD = maxDist * maxDist;
  for (let i = 0; i < proj.length; i++) {
    const p = proj[i];
    if (!p.visible) continue;
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return qx * qx + qy * qy;
}

export function nearestEdge(
  proj: Projected[],
  edges: [number, number][],
  x: number,
  y: number,
  maxDist = 12,
): string | null {
  let best: string | null = null;
  let bestD = maxDist * maxDist;
  for (const [a, b] of edges) {
    const pa = proj[a];
    const pb = proj[b];
    if (!pa || !pb || (!pa.visible && !pb.visible)) continue;
    const d = segDist2(x, y, pa.x, pa.y, pb.x, pb.y);
    if (d < bestD) {
      bestD = d;
      best = edgeKey(a, b);
    }
  }
  return best;
}

/** Face under the mouse via the cage mesh. */
export function pickFace(engine: ViewportEngine, x: number, y: number): number {
  const rc = engine.rayAt(x, y);
  const hits = rc.intersectObject(engine.edit.cage, false);
  if (!hits.length || hits[0].faceIndex === undefined || hits[0].faceIndex === null) return -1;
  return engine.edit.triFace[hits[0].faceIndex] ?? -1;
}
