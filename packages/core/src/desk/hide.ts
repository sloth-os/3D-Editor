/*
 * Objects "hidden" by their scale. The desk has no per-frame visibility channel (hide_render cannot
 * be keyed), so a span of frames an object should not be seen in is keyed as its scale shrunk to a
 * point: HIDE_SCALE times the scale it is shown at, on every axis (hiddenScale), by desk.tether_fly
 * (after: 'hide', and a string or tail before and after its flight) and by the rideo import (held
 * props, actors in the shots they are not cast in). The keys are relative to the shown scale, so a
 * model shown at a tiny scale (store.insert_files fits a model in millimetres or in very large units
 * to its size by scaling its root) shrinks as much as any other.
 *
 * Telling such an object from one that is merely small: readers that have its geometry (desk.check
 * and the solver, through DeskScene; hiddenGeometry) ask whether a collapsed world matrix leaves its
 * geometry under HIDDEN_EXTENT_M across, which holds whatever scale it is shown at; readers of a
 * world matrix alone (hiddenByScale) compare its scale with HIDDEN_SCALE_EPS, which a store model in
 * very large units shown smaller than about 10 cm also falls under.
 */
import type { Mat4, Vec3 } from '../math/types';

/** Share of the scale it is shown at that a hidden object is keyed to, on every axis. */
export const HIDE_SCALE = 1e-8;

/**
 * The scale a hide key gives an axis shown at `shown`: shown × HIDE_SCALE, its sign kept (a
 * mirrored object stays mirrored); HIDE_SCALE when `shown` is 0 or not a number.
 */
export function hiddenScale(shown: number): number {
  return Number.isFinite(shown) && shown !== 0 ? shown * HIDE_SCALE : HIDE_SCALE;
}

/**
 * World scale of an axis below which a world matrix alone counts as collapsed by a hide key. Shown
 * objects are above it, store models fitted to their size included: one 1,000,000 units across made
 * 1 m is shown at 1e-6, a 1.5 m model in millimetres made a 2 cm toy at 1.3e-5. Hidden ones are below
 * it: HIDE_SCALE times a shown scale up to 10, and the absolute 1e-8 keys of earlier versions under
 * parents scaled up to 10.
 */
export const HIDDEN_SCALE_EPS = 1e-7;

/**
 * Size (m) under which geometry counts as shrunk to a point by a hide key: HIDE_SCALE times any size
 * up to 100 m is below it, while a model shown at a scale under HIDDEN_SCALE_EPS (one in very large
 * units made small) is still centimetres across.
 */
export const HIDDEN_EXTENT_M = 1e-6;

/**
 * World scale under which an axis may be collapsed by a hide key, for readers that then measure the
 * geometry (HIDDEN_EXTENT_M decides): every hidden object is below it, shown ones only when they are
 * smaller than a ten-thousandth of their model's units.
 */
export const COLLAPSED_SCALE_MAX = 1e-4;

/** How many of a world matrix's axis scales (the lengths of its x, y and z basis columns) are below `eps`. */
function axesBelow(world: Readonly<Mat4>, eps: number): number {
  let n = 0;
  for (let c = 0; c < 3; c++) if (!(Math.hypot(world[c * 4], world[c * 4 + 1], world[c * 4 + 2]) >= eps)) n++;
  return n;
}

/**
 * True when a world matrix is collapsed by a hide key: at least two of its axis scales are below
 * HIDDEN_SCALE_EPS. A hide key shrinks all three (a string, scaled along its length, keeps at most
 * that one above it); an object flattened along one axis is still drawn, and is not hidden. A
 * parent's hide key collapses its children's world matrices too, so a rider's mount or a flyer's
 * tail parts read as hidden with their root. Readers that have the object's geometry use
 * hiddenGeometry, which also tells a store model in very large units shown a few centimetres across.
 */
export function hiddenByScale(world: Readonly<Mat4>): boolean {
  return axesBelow(world, HIDDEN_SCALE_EPS) >= 2;
}

/** True when a world matrix may be collapsed by a hide key: two axis scales below COLLAPSED_SCALE_MAX. */
export function maybeCollapsed(world: Readonly<Mat4>): boolean {
  return axesBelow(world, COLLAPSED_SCALE_MAX) >= 2;
}

/**
 * True when geometry with local bounds `min`–`max` is shrunk to a point by `world`: its world matrix
 * may be collapsed (maybeCollapsed) and its world bounds are less than HIDDEN_EXTENT_M across.
 * Whatever scale a model is shown at, a hide key leaves it under a micrometre across and nothing
 * shown is that small.
 */
export function hiddenGeometry(world: Readonly<Mat4>, min: Readonly<Vec3>, max: Readonly<Vec3>): boolean {
  if (!maybeCollapsed(world)) return false;
  const e = [0, 1, 2].map((j) => Math.abs(max[j] - min[j]));
  // the world box of the local box along each world axis k: Σ_j |world[k][j]| · edge_j
  let across = 0;
  for (let k = 0; k < 3; k++)
    across = Math.max(
      across,
      Math.abs(world[k]) * e[0] + Math.abs(world[4 + k]) * e[1] + Math.abs(world[8 + k]) * e[2],
    );
  return !(across >= HIDDEN_EXTENT_M);
}

/** True when a world box (an object's geometry as evaluated) is less than HIDDEN_EXTENT_M across. */
export function collapsedBox(box: { min: Readonly<Vec3>; max: Readonly<Vec3> }): boolean {
  return !(
    Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) >= HIDDEN_EXTENT_M
  );
}
