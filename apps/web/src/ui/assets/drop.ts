import * as THREE from 'three';
import type { StoreResult, Vec3 } from '@3d-editor/core';
import { session } from '../../app/store';
import { viewport } from '../../editor/editor';
import { insertStoreModel } from './insert';

/*
 * Dragging a store model from the Asset Browser into the viewport (SPEC §13). The card puts the
 * model on the drag as ASSET_DRAG_TYPE (JSON: the store id, name, provider and the search result an
 * insert needs); the viewport's drop handler calls dropAsset, which inserts the model where it was
 * dropped: on the surface under the pointer (a viewport raycast), else on the ground plane z = 0,
 * else at the 3D cursor.
 *
 * Viewport.tsx (UI-DESK) wires it as:
 *   onDragOver={(e) => { e.preventDefault(); assetDragOver(e); }}
 *   onDrop={(e) => { e.preventDefault(); if (dropAsset(e)) return; …files… }}
 */

/** The drag data type of a store model. */
export const ASSET_DRAG_TYPE = 'application/x-3d-editor-asset';

/** What a dragged card carries. */
export interface AssetDragData {
  /** Format version. */
  v: 1;
  /** Store id ('<provider>:<id>'). */
  model: string;
  name: string;
  provider: string;
  /** The search result (licence, download flags: what an insert needs). */
  result: StoreResult;
}

/** Puts a model on a drag (a card's dragstart). */
export function setAssetDragData(dt: DataTransfer, result: StoreResult): void {
  const data: AssetDragData = {
    v: 1,
    model: result.id,
    name: result.name,
    provider: result.provider,
    result,
  };
  dt.setData(ASSET_DRAG_TYPE, JSON.stringify(data));
  dt.effectAllowed = 'copy';
}

/** Whether a drag carries a store model (its types are readable while dragging, its data only on drop). */
export function hasAssetDrag(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes(ASSET_DRAG_TYPE);
}

/** The model a drop carries, or null (another drag, or data that is not a model). */
export function getAssetDragData(dt: DataTransfer | null | undefined): AssetDragData | null {
  if (!dt) return null;
  let raw: string;
  try {
    raw = dt.getData(ASSET_DRAG_TYPE);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<AssetDragData>;
    const r = d?.result as Partial<StoreResult> | undefined;
    if (
      d?.v !== 1 ||
      typeof d.model !== 'string' ||
      !d.model ||
      !r ||
      r.id !== d.model ||
      typeof r.name !== 'string' ||
      typeof r.provider !== 'string' ||
      !r.license ||
      typeof r.license.spdx !== 'string'
    )
      return null;
    return d as AssetDragData;
  } catch {
    return null;
  }
}

/** What the drop needs of the viewport (ViewportEngine). */
export interface DropTarget {
  readonly camera: THREE.Camera & { far?: number };
  rayAt(x: number, y: number): THREE.Raycaster;
  readonly objects: { pickables(): THREE.Object3D[] };
}

/** Where a drop lands: on a surface under the pointer, on the ground plane, or at the 3D cursor. */
export type DropSource = 'hit' | 'ground' | 'cursor';

/** Farthest ground point a drop takes (a ray grazing the horizon lands on the cursor instead). */
const MAX_GROUND_DISTANCE = 10_000;

const GROUND = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/**
 * The drop point under viewport pixel (x, y) (CSS pixels from the viewport's top left): the first
 * surface the ray hits (helpers' pick proxies skipped), else where it meets the ground plane z = 0
 * in front of the camera (within its far clip and 10 km), else the 3D cursor.
 */
export function dropLocation(
  target: DropTarget,
  x: number,
  y: number,
  cursor: Vec3,
): { location: Vec3; source: DropSource } {
  const rc = target.rayAt(x, y);
  const hit = rc
    .intersectObjects(target.objects.pickables(), false)
    .find((h) => !h.object.userData.pickProxy && Number.isFinite(h.point.x));
  if (hit) return { location: [hit.point.x, hit.point.y, hit.point.z], source: 'hit' };
  const ground = rc.ray.intersectPlane(GROUND, new THREE.Vector3());
  const far = Math.min(MAX_GROUND_DISTANCE, target.camera.far ?? MAX_GROUND_DISTANCE);
  if (ground && rc.ray.origin.distanceTo(ground) <= far)
    return { location: [ground.x, ground.y, 0], source: 'ground' };
  return { location: [cursor[0], cursor[1], cursor[2]], source: 'cursor' };
}

/**
 * The viewport's dragover: marks a store model drag as a copy (the caller still calls
 * preventDefault so the drop happens). Returns whether it is one.
 */
export function assetDragOver(e: DragEvent): boolean {
  if (!hasAssetDrag(e.dataTransfer)) return false;
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  return true;
}

/**
 * The viewport's drop: when it carries a store model, inserts the model where it was dropped
 * (dropLocation) and returns true; returns false for any other drop (files, outliner rows).
 */
export function dropAsset(e: DragEvent): boolean {
  const data = getAssetDragData(e.dataTransfer);
  if (!data) return false;
  e.preventDefault();
  const s = session.value;
  const cursor = (s?.state.cursorLocation ?? [0, 0, 0]) as Vec3;
  const engine = viewport.engine;
  let location: Vec3 = [cursor[0], cursor[1], cursor[2]];
  if (engine) {
    const r = engine.canvas.getBoundingClientRect();
    location = dropLocation(engine, e.clientX - r.left, e.clientY - r.top, cursor).location;
  }
  void insertStoreModel(data.result, { location });
  return true;
}
