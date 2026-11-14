import type { Mat4, Vec3 } from '../../math/types';
import { multiply4 } from '../../math/mat4';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import type { FrameState } from '../../eval/frame-state';
import { DESK_PROPS } from '../props';

/*
 * The boxes rideo's blocking describes landmarks and props by: the footprint an object and the parts
 * below it fill (centre, width × depth in the frame of its heading, height above the floor, heading),
 * and a prop's largest extent at rest. The import centres a built-in model's footprint on rideo's
 * mark with the same measure the export reads it back with, so that a round trip does not drift.
 */

/** A footprint in rideo's terms (x, z on the floor; rotation in degrees about the up axis). */
export interface Footprint {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  rotationDeg: number;
}

/** How a footprint finds an object's parts: the object, and the ids parented to one. */
export interface PartsOf {
  object(id: string): ObjectData | undefined;
  children(id: string): readonly string[];
}

/** Children that are not parts of what they hang from: actors, strings and cameras. */
const NOT_PARTS = new Set(['actor', 'string', 'camera']);

const isPart = (o: ObjectData | undefined): boolean => {
  const role = o?.custom_props?.[DESK_PROPS.role];
  return !!o && !(typeof role === 'string' && NOT_PARTS.has(role));
};

/** The parts lookup of a doc as it is now. */
export function docParts(doc: SceneDoc): PartsOf {
  const index = doc.childrenIndex();
  return { object: (id) => doc.getObject(id) ?? undefined, children: (id) => index.get(id) ?? [] };
}

/**
 * The footprint of an object and its parts in frame state `fs`: their geometry in the frame of the
 * root's heading, its centre, width (along the heading's X), depth and height above the ground; null
 * when they hold no geometry.
 */
export function footprint(doc: SceneDoc, fs: FrameState, parts: PartsOf, root: string): Footprint | null {
  const m = fs.world(root);
  if (!m) return null;
  const yaw = Math.atan2(m[1], m[0]);
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const visit = (id: string) => {
    const o = parts.object(id);
    if (!o) return;
    const w = o.type === 'MESH' && o.data ? fs.world(id) : null;
    const mesh = w && o.data ? doc.getMesh(o.data) : null;
    if (w && mesh) {
      const p = mesh.positions;
      for (let i = 0; i + 2 < p.length; i += 3) {
        const x = w[0] * p[i] + w[4] * p[i + 1] + w[8] * p[i + 2] + w[12];
        const y = w[1] * p[i] + w[5] * p[i + 1] + w[9] * p[i + 2] + w[13];
        const v: Vec3 = [
          c * x - s * y,
          s * x + c * y,
          w[2] * p[i] + w[6] * p[i + 1] + w[10] * p[i + 2] + w[14],
        ];
        for (let k = 0; k < 3; k++) {
          if (v[k] < min[k]) min[k] = v[k];
          if (v[k] > max[k]) max[k] = v[k];
        }
      }
    }
    for (const child of parts.children(id)) if (isPart(parts.object(child))) visit(child);
  };
  visit(root);
  if (!(min[0] <= max[0])) return null;
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  // the centre back in the world: turned by the heading
  const wx = Math.cos(yaw) * cx - Math.sin(yaw) * cy;
  const wy = Math.sin(yaw) * cx + Math.cos(yaw) * cy;
  return {
    x: wx,
    z: -wy,
    width: max[0] - min[0],
    depth: max[1] - min[1],
    height: max[2] - Math.min(0, min[2]),
    rotationDeg: (yaw * 180) / Math.PI,
  };
}

/** The largest extent of an object's geometry and its parts' at rest (stored transforms, its own scale). */
export function restSize(doc: SceneDoc, parts: PartsOf, root: string): number {
  const o = parts.object(root);
  if (!o) return 0;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const visit = (id: string, local: Mat4) => {
    const x = parts.object(id);
    const mesh = x?.type === 'MESH' && x.data ? doc.getMesh(x.data) : null;
    if (mesh) {
      const p = mesh.positions;
      for (let i = 0; i + 2 < p.length; i += 3) {
        const v: Vec3 = [
          local[0] * p[i] + local[4] * p[i + 1] + local[8] * p[i + 2] + local[12],
          local[1] * p[i] + local[5] * p[i + 1] + local[9] * p[i + 2] + local[13],
          local[2] * p[i] + local[6] * p[i + 1] + local[10] * p[i + 2] + local[14],
        ];
        for (let k = 0; k < 3; k++) {
          if (v[k] < min[k]) min[k] = v[k];
          if (v[k] > max[k]) max[k] = v[k];
        }
      }
    }
    for (const child of parts.children(id)) {
      const co = parts.object(child);
      if (co && isPart(co)) visit(child, multiply4(local, doc.localMatrix(co)));
    }
  };
  // the root's own scale, not its place or heading
  visit(root, [o.scale[0], 0, 0, 0, 0, o.scale[1], 0, 0, 0, 0, o.scale[2], 0, 0, 0, 0, 1]);
  if (!(min[0] <= max[0])) return 0;
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}
