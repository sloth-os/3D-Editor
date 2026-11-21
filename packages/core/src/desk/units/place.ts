import type { SceneDoc } from '../../doc/scene-doc';
import { decompose4, invert4, multiply4 } from '../../math/mat4';
import type { Mat4, Vec3 } from '../../math/types';

/*
 * Hanging an object from a unit's root with its world matrix kept (stored transforms, as
 * SceneDoc.worldMatrix computes them). extractUnit writes these channels into the unit for every
 * object whose parent is outside it, and adoptUnit writes the same channels into the scene when it
 * hangs those objects from the instance's root, so the parts' stamps match to the bit.
 */

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const isIdentity = (m: Readonly<Mat4>) => m.every((v, i) => v === IDENTITY[i]);

/** The local channels of object `id` under a root whose world matrix is `rootWorld`. */
export interface HungChannels {
  location: Vec3;
  rotation_euler: Vec3;
  scale: Vec3;
}

/**
 * The channels object `id` takes when it hangs from a root with world matrix `rootWorld` (null: a
 * root at the origin, as a set root that is made). An object without a parent under a root at
 * identity keeps its channels as they are (its local matrix is its world matrix); otherwise they are
 * read from root⁻¹ · world. Null when there is no such object.
 */
export function channelsUnder(
  doc: SceneDoc,
  id: string,
  rootWorld: Readonly<Mat4> | null,
): HungChannels | null {
  const o = doc.getObject(id);
  if (!o) return null;
  const root = rootWorld ?? IDENTITY;
  if (o.parent === null && isIdentity(root))
    return { location: [...o.location], rotation_euler: [...o.rotation_euler], scale: [...o.scale] };
  const local = decompose4(multiply4(invert4(root as Mat4), doc.worldMatrix(id)));
  return { location: local.location, rotation_euler: local.rotation, scale: local.scale };
}
