import type { Mat4, Vec3 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { ObjectData } from '../doc/types';
import { docChangeToken } from '../doc/change-token';
import { FrameState } from '../eval/frame-state';
import { DESK_PROPS } from './props';
import { DESK_SHAPE_PROP, deskProp, isWater, isWaterLabel, type DeskScene } from './layout';

/*
 * The water of the desk's scenes: where actors cannot stand and props float (desk.check's
 * walks_on_water and body_in_water, the water warnings of desk.actor_move, desk.actor_add and the
 * release presets, desk.physics_bake's water: 'float').
 *
 * A water piece is a mesh layout.ts isWater names water: a model's water part (store_part 'water':
 * the lake's, a fountain's, a trough's), a mesh whose desk_shape is 'water' (the rideo import's
 * water landmarks), or each mesh of a desk piece (desk_role landmark, prop or set) whose label names
 * water ("the pond") when it has no water part of its own, also when its desk_shape is rideo's box
 * or cylinder (rideo's blue 'river' box: cameras may not stand in it, but its top is water). The rest
 * of a model with a water part is not water: the lake's sandy shore, the fountain's stone. Meshes
 * renders do not draw (their own hide_render: a render does not inherit it from a parent) are left
 * out.
 *
 * The footprint of a piece at a frame is its polygons that face up (all of them for a piece with
 * none, a sheet modelled facing down) placed in the world and projected on the floor (XY), exactly:
 * a point is over the water when one of those polygons contains it, never a bounding box. The water's
 * surface is what faces up: a box of water's top, not its bottom. Its surface height at a point is
 * that polygon's height there (the top of the part for flat water); where surfaces stack (a
 * fountain's upper bowl over its basin) the water at a point is the surface nearest the point's own
 * height. Geometry is the stored mesh, as the desk's other readers read it (layout.ts
 * DeskScene.bounds): modifiers are not applied.
 *
 * Footprints are cached per state of the document (doc/change-token.ts): pieces nothing moves (no
 * keys, drivers, constraints or rigid body on them, their mesh or their parents, no bone parent) are
 * placed once, moving ones per frame.
 *
 * Actors that belong in the water (swimmers, waders; the cast rideo marks inside its water) carry
 * the frames they do in desk_in_water (inWaterSpans): desk.actor_add's and desk.actor_move's
 * in_water, and the rideo import, write them.
 */

/** A water piece: the water mesh, what it belongs to and what messages call it. */
export interface WaterPiece {
  /** The water mesh object. */
  id: string;
  /** The object it belongs to: its landmark or model root (what to move), else the mesh itself. */
  owner: string;
  /** What messages call it: the owner's desk_label, else the owner's name. */
  label: string;
}

/** The water at a point. */
export interface WaterHit extends WaterPiece {
  /** Height of the water's surface over (or under) the point (m). */
  surface_z: number;
}

/** A stretch of a polyline over one water piece. */
export interface WaterSpan extends WaterPiece {
  /** Where the stretch starts and ends, in metres along the polyline from its first point. */
  from_m: number;
  to_m: number;
}

/** The footprint of a water piece at a frame. */
export interface WaterSurface extends WaterPiece {
  /** Floor (XY) bounds of the footprint. */
  min: [number, number];
  max: [number, number];
  /** The highest point of the piece (m). */
  top: number;
}

/**
 * Height difference (m) up to which a water surface is at the level of a point: the lake's water
 * lies 2–4 cm above the ground an actor walks on, while a footbridge's deck is 20 cm or more over a
 * stream and an actor standing in a fountain's basin is 40 cm below its water.
 */
export const WATER_LEVEL_M = 0.15;

/** How far above a water's surface (m) the bottom of a body still touches it. */
export const WATER_TOUCH_M = 0.02;

/**
 * How far under a water's surface (m) the top of a body may be for it to be in that water: a body
 * deeper under it is under a raised basin, not in it.
 */
export const WATER_UNDER_M = 1;

/** Anything over water any source can read it from: a desk scene (its frame states) or a document. */
export type WaterSource = DeskScene | SceneDoc;

/** One polygon of a footprint: its floor outline, bounds and plane (z = a·x + b·y + c). */
interface Polygon {
  xs: Float64Array;
  ys: Float64Array;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  a: number;
  b: number;
  c: number;
}

/** A footprint with its polygons and a uniform grid of them over its bounds. */
interface Footprint extends WaterSurface {
  polys: Polygon[];
  /** Grid: `nx` × `ny` cells of `cw` × `ch` from min; each lists the polygons overlapping it. */
  nx: number;
  ny: number;
  cw: number;
  ch: number;
  cells: Int32Array[];
}

/** A water piece of the document and whether anything can move it. */
interface PieceInfo extends WaterPiece {
  mesh: string;
  moves: boolean;
}

interface WaterCache {
  token: string;
  pieces: PieceInfo[];
  /** Footprints of the pieces nothing moves (null: no area), by piece id. */
  fixed: Map<string, Footprint | null>;
  /** Footprints of the moving pieces, by frame. */
  frames: Map<number, Footprint[]>;
}

/** Frames of moving water kept per document. */
const MOVING_FRAMES = 128;

const caches = new WeakMap<SceneDoc, WaterCache>();
/** The cache each desk scene reads (a scene is one reading of its document: its state is fixed). */
const sceneCaches = new WeakMap<DeskScene, WaterCache>();

const docOf = (source: WaterSource): SceneDoc => ('doc' in source ? source.doc : source);

/** The cache of `doc` for its current state (a fresh, unkept one when the state is unknown). */
function docCache(doc: SceneDoc): WaterCache {
  const token = docChangeToken(doc);
  const hit = caches.get(doc);
  if (hit && token !== null && hit.token === token) return hit;
  const fresh: WaterCache = {
    token: token ?? '',
    pieces: findPieces(doc),
    fixed: new Map(),
    frames: new Map(),
  };
  if (token !== null) caches.set(doc, fresh);
  return fresh;
}

/** The cache `source` reads: a desk scene's, taken from its document once; a document's, by its state. */
function cacheOf(source: WaterSource): WaterCache {
  if (!('doc' in source)) return docCache(source);
  let c = sceneCaches.get(source);
  if (!c) sceneCaches.set(source, (c = docCache(source.doc)));
  return c;
}

const ROLES: ReadonlySet<string> = new Set(['landmark', 'prop', 'set']);

/** Whether an object is a desk piece (a landmark, prop or set piece). */
const isDeskPiece = (o: ObjectData | undefined): boolean => !!o && ROLES.has(deskProp(o, DESK_PROPS.role));

/** Whether an object is a store model's root (store.add and store.insert_files give it a store_id). */
const isModelRoot = (o: ObjectData | undefined): boolean =>
  !!o && typeof o.custom_props?.[DESK_PROPS.storeId] === 'string';

/** rideo's solid landmark shapes: one its label names water holds water (rideo draws a 'river' box blue). */
const SOLID_SHAPES: ReadonlySet<string> = new Set(['box', 'cylinder']);

/**
 * Whether desk piece `o` is water by what it says of itself: layout.ts isWater (its desk_shape
 * 'water', else its label), or a box or a cylinder (rideo's shapes) whose label names water.
 */
function holdsWater(o: ObjectData): boolean {
  if (isWater(o)) return true;
  const shape = deskProp(o, DESK_SHAPE_PROP).trim().toLowerCase();
  return SOLID_SHAPES.has(shape) && isWaterLabel(deskProp(o, DESK_PROPS.label) || o.name);
}

/** The water pieces of a document (see the module comment). */
function findPieces(doc: SceneDoc): PieceInfo[] {
  const objects = doc.listObjects();
  const byId = new Map(objects.map((o) => [o.id, o]));
  const children = doc.childrenIndex();
  /** The ancestors of `id`, nearest first. */
  const ancestors = (id: string): ObjectData[] => {
    const out: ObjectData[] = [];
    const seen = new Set<string>([id]);
    for (let p = byId.get(id)?.parent; p && !seen.has(p); p = byId.get(p)?.parent) {
      seen.add(p);
      const o = byId.get(p);
      if (!o) break;
      out.push(o);
    }
    return out;
  };
  /** Whether any mesh under `id` is a water part of its own. */
  const ownWaterPart = new Map<string, boolean>();
  const hasWaterPart = (id: string): boolean => {
    let v = ownWaterPart.get(id);
    if (v !== undefined) return v;
    v = false;
    const queue = [...(children.get(id) ?? [])];
    const seen = new Set<string>();
    while (queue.length && !v) {
      const c = queue.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      const o = byId.get(c);
      if (!o) continue;
      if (o.type === 'MESH' && isWater(o, true)) v = true;
      queue.push(...(children.get(c) ?? []));
    }
    ownWaterPart.set(id, v);
    return v;
  };
  // what anything animates, drives, constrains or simulates (object and datablock ids)
  const animated = new Set<string>();
  for (const fc of doc.listFCurves()) if (!fc.mute && fc.keyframes.length) animated.add(fc.target_id);
  for (const d of doc.listDrivers()) if (!d.mute) animated.add(d.target_id);
  const movable = (o: ObjectData): boolean =>
    animated.has(o.id) ||
    o.constraints.some((c) => !c.mute) ||
    !!o.rigid_body?.enabled ||
    (!!o.parent && o.parent_type !== 'OBJECT');
  const out: PieceInfo[] = [];
  for (const o of objects) {
    // a mesh renders draw (its own hide_render: renders do not inherit an owner's, eval/evaluate.ts)
    if (o.type !== 'MESH' || !o.data || o.hide_render) continue;
    const up = ancestors(o.id);
    const owner =
      [o, ...up].find((x) => isDeskPiece(x) || isModelRoot(x)) ?? (isWater(o, true) ? o : undefined);
    let water = isWater(o, true);
    if (!water) {
      // every mesh of a desk piece its label names water, unless the piece has water parts
      const piece = [o, ...up].find(isDeskPiece);
      water = !!piece && holdsWater(piece) && !hasWaterPart(piece.id);
    }
    if (!water || !owner) continue;
    out.push({
      id: o.id,
      owner: owner.id,
      label: deskProp(owner, DESK_PROPS.label) || owner.name,
      mesh: o.data,
      moves: animated.has(o.data) || [o, ...up].some(movable),
    });
  }
  return out;
}

/** The world matrix of object `id` at `frame` from `source` (its frame states, or one of the document's). */
function worldReader(source: WaterSource, frame: number): (id: string) => Mat4 | null {
  if ('doc' in source) return (id) => source.world(id, frame);
  let fs: FrameState | null = null;
  return (id) => (fs ??= new FrameState(source, frame)).world(id);
}

/** Polygons projected this little (m², relative to the piece's size squared) have no footprint. */
const MIN_AREA = 1e-9;

/** The footprint of `piece` under world matrix `m` (null: no area: a vertical sheet, a hidden piece). */
function buildFootprint(doc: SceneDoc, piece: PieceInfo, m: Readonly<Mat4>): Footprint | null {
  const mesh = doc.getMesh(piece.mesh);
  if (!mesh || mesh.positions.length < 9) return null;
  const P = mesh.positions;
  const n = Math.floor(P.length / 3);
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  const wz = new Float64Array(n);
  let top = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3];
    const y = P[i * 3 + 1];
    const z = P[i * 3 + 2];
    wx[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    wy[i] = m[1] * x + m[5] * y + m[9] * z + m[13];
    wz[i] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  // the polygons that face up (the water's surface), and those that face down (a box of water's
  // bottom: left out unless nothing faces up), each with its top
  const ups: { p: Polygon; top: number }[] = [];
  const downs: { p: Polygon; top: number }[] = [];
  for (const f of mesh.faces) {
    if (!Array.isArray(f) || f.length < 3 || !f.every((v) => Number.isInteger(v) && v >= 0 && v < n))
      continue;
    const k = f.length;
    const xs = new Float64Array(k);
    const ys = new Float64Array(k);
    // Newell's normal and the centroid give the polygon's plane
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < k; i++) {
      const a = f[i];
      const b = f[(i + 1) % k];
      xs[i] = wx[a];
      ys[i] = wy[a];
      nx += (wy[a] - wy[b]) * (wz[a] + wz[b]);
      ny += (wz[a] - wz[b]) * (wx[a] + wx[b]);
      nz += (wx[a] - wx[b]) * (wy[a] + wy[b]);
      cx += wx[a] / k;
      cy += wy[a] / k;
      cz += wz[a] / k;
    }
    let px0 = Infinity;
    let py0 = Infinity;
    let px1 = -Infinity;
    let py1 = -Infinity;
    for (let i = 0; i < k; i++) {
      px0 = Math.min(px0, xs[i]);
      py0 = Math.min(py0, ys[i]);
      px1 = Math.max(px1, xs[i]);
      py1 = Math.max(py1, ys[i]);
    }
    // nz is twice the projected area: a polygon seen edge-on from above covers no floor
    const size = Math.max(px1 - px0, py1 - py0);
    if (!(Math.abs(nz) / 2 > MIN_AREA * Math.max(1, size * size)) || !Number.isFinite(nz)) continue;
    let ptop = -Infinity;
    for (const v of f) ptop = Math.max(ptop, wz[v]);
    (nz > 0 ? ups : downs).push({
      p: {
        xs,
        ys,
        x0: px0,
        y0: py0,
        x1: px1,
        y1: py1,
        a: -nx / nz,
        b: -ny / nz,
        c: cz + (nx * cx + ny * cy) / nz,
      },
      top: ptop,
    });
  }
  const kept = ups.length ? ups : downs;
  if (!kept.length) return null;
  const polys: Polygon[] = [];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { p, top: ptop } of kept) {
    polys.push(p);
    top = Math.max(top, ptop);
    x0 = Math.min(x0, p.x0);
    y0 = Math.min(y0, p.y0);
    x1 = Math.max(x1, p.x1);
    y1 = Math.max(y1, p.y1);
  }
  // about one polygon per cell, at most 64 × 64 cells
  const side = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(polys.length))));
  const w = Math.max(x1 - x0, 1e-9);
  const h = Math.max(y1 - y0, 1e-9);
  const nxc = Math.max(1, Math.min(64, Math.round(side * Math.sqrt(w / h) || 1)));
  const nyc = Math.max(1, Math.min(64, Math.round(side * Math.sqrt(h / w) || 1)));
  const cw = w / nxc;
  const ch = h / nyc;
  const lists: number[][] = Array.from({ length: nxc * nyc }, () => []);
  polys.forEach((p, i) => {
    const i0 = clampCell(Math.floor((p.x0 - x0) / cw), nxc);
    const i1 = clampCell(Math.floor((p.x1 - x0) / cw), nxc);
    const j0 = clampCell(Math.floor((p.y0 - y0) / ch), nyc);
    const j1 = clampCell(Math.floor((p.y1 - y0) / ch), nyc);
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) lists[j * nxc + ii].push(i);
  });
  return {
    id: piece.id,
    owner: piece.owner,
    label: piece.label,
    min: [x0, y0],
    max: [x1, y1],
    top,
    polys,
    nx: nxc,
    ny: nyc,
    cw,
    ch,
    cells: lists.map((l) => Int32Array.from(l)),
  };
}

const clampCell = (i: number, n: number): number => (i < 0 ? 0 : i >= n ? n - 1 : i);

/** The footprints of the document's water at `frame` (cached; see the module comment). */
function footprintsAt(source: WaterSource, frame: number): Footprint[] {
  const doc = docOf(source);
  const cache = cacheOf(source);
  if (!cache.pieces.length) return [];
  const at = Number.isFinite(frame) ? frame : doc.getScene().frame_start;
  // pieces nothing moves are where the document puts them (no simulation can move them either);
  // moving ones as the source evaluates them (a desk scene's frame states, simulated)
  let still: ((id: string) => Mat4 | null) | null = null;
  let moved: ((id: string) => Mat4 | null) | null = null;
  const place = (p: PieceInfo): Footprint | null => {
    const world = p.moves ? (moved ??= worldReader(source, at)) : (still ??= worldReader(doc, at));
    const m = world(p.id);
    return m ? buildFootprint(doc, p, m) : null;
  };
  const out: Footprint[] = [];
  for (const p of cache.pieces) {
    if (p.moves) continue;
    let f = cache.fixed.get(p.id);
    if (f === undefined) cache.fixed.set(p.id, (f = place(p)));
    if (f) out.push(f);
  }
  if (cache.pieces.some((p) => p.moves)) {
    let moving = cache.frames.get(at);
    if (!moving) {
      moving = cache.pieces
        .filter((p) => p.moves)
        .map(place)
        .filter((f): f is Footprint => !!f);
      if (cache.frames.size >= MOVING_FRAMES) cache.frames.delete(cache.frames.keys().next().value as number);
      cache.frames.set(at, moving);
    }
    out.push(...moving);
  }
  return out;
}

/** Whether polygon `p` contains the floor point (x, y) (crossing number, half-open edges). */
function contains(p: Polygon, x: number, y: number): boolean {
  if (x < p.x0 || x > p.x1 || y < p.y0 || y > p.y1) return false;
  const { xs, ys } = p;
  let inside = false;
  for (let i = 0, j = xs.length - 1; i < xs.length; j = i++) {
    const yi = ys[i];
    const yj = ys[j];
    if (yi > y !== yj > y && x < ((xs[j] - xs[i]) * (y - yi)) / (yj - yi) + xs[i]) inside = !inside;
  }
  return inside;
}

/** The polygons of `f` whose grid cell holds (x, y) (none outside its bounds). */
function cellOf(f: Footprint, x: number, y: number): Int32Array | null {
  if (x < f.min[0] || x > f.max[0] || y < f.min[1] || y > f.max[1]) return null;
  const i = clampCell(Math.floor((x - f.min[0]) / f.cw), f.nx);
  const j = clampCell(Math.floor((y - f.min[1]) / f.ch), f.ny);
  return f.cells[j * f.nx + i];
}

/** The surface of `f` over (x, y) nearest height z, or null when the point is not over it. */
function surfaceOver(f: Footprint, x: number, y: number, z: number): number | null {
  const cell = cellOf(f, x, y);
  if (!cell) return null;
  let best: number | null = null;
  for (let k = 0; k < cell.length; k++) {
    const p = f.polys[cell[k]];
    if (!contains(p, x, y)) continue;
    const s = p.a * x + p.b * y + p.c;
    if (best === null || Math.abs(s - z) < Math.abs(best - z)) best = s;
  }
  return best;
}

const piece = (f: Footprint): WaterPiece => ({ id: f.id, owner: f.owner, label: f.label });

/** The water footprints at `frame`: each piece's floor bounds and top. */
export function waterSurfaces(source: WaterSource, frame: number): WaterSurface[] {
  return footprintsAt(source, frame).map((f) => ({
    ...piece(f),
    min: [f.min[0], f.min[1]],
    max: [f.max[0], f.max[1]],
    top: f.top,
  }));
}

/** Whether the scene has water (pieces that may cover floor at some frame or other). */
export function hasWater(source: WaterSource): boolean {
  return cacheOf(source).pieces.length > 0;
}

/**
 * The water footprints when nothing moves any piece (the same at every frame), for readers that rule
 * water out once for a whole film; null when a piece moves.
 */
export function stillWater(source: WaterSource): WaterSurface[] | null {
  if (cacheOf(source).pieces.some((p) => p.moves)) return null;
  return waterSurfaces(source, docOf(source).getScene().frame_start);
}

/**
 * The water at `point` at `frame`: the water piece whose footprint contains the point's floor
 * position (exactly: one of its polygons does) with the surface nearest the point's height, and that
 * surface's height there; null when the point is over no water. With `level`, only a surface within
 * `level` metres above or below the point counts (WATER_LEVEL_M: the water an actor standing there
 * would stand in, not a stream under a bridge).
 */
export function waterAt(
  source: WaterSource,
  point: Readonly<Vec3>,
  frame: number,
  o: { level?: number } = {},
): WaterHit | null {
  const [x, y, z] = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const zz = Number.isFinite(z) ? z : 0;
  let best: WaterHit | null = null;
  for (const f of footprintsAt(source, frame)) {
    const s = surfaceOver(f, x, y, zz);
    if (s === null) continue;
    const d = Math.abs(s - zz);
    if (o.level !== undefined && d > o.level) continue;
    if (!best || d < Math.abs(best.surface_z - zz)) best = { ...piece(f), surface_z: s };
  }
  return best;
}

/** Whether polygon `p` meets the floor box `min`–`max` (overlaps it at all). */
function meetsBox(p: Polygon, min: readonly [number, number], max: readonly [number, number]): boolean {
  if (p.x1 < min[0] || p.x0 > max[0] || p.y1 < min[1] || p.y0 > max[1]) return false;
  const { xs, ys } = p;
  const n = xs.length;
  // a corner of the polygon in the box, or a corner of the box in the polygon
  for (let i = 0; i < n; i++)
    if (xs[i] >= min[0] && xs[i] <= max[0] && ys[i] >= min[1] && ys[i] <= max[1]) return true;
  for (const [x, y] of [
    [min[0], min[1]],
    [max[0], min[1]],
    [max[0], max[1]],
    [min[0], max[1]],
  ])
    if (contains(p, x, y)) return true;
  // else they meet only where an edge of the polygon crosses an edge of the box
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = xs[j];
    const ay = ys[j];
    const bx = xs[i];
    const by = ys[i];
    if (
      crossing(ax, ay, bx, by, min[0], min[1], max[0], min[1]) !== null ||
      crossing(ax, ay, bx, by, max[0], min[1], max[0], max[1]) !== null ||
      crossing(ax, ay, bx, by, max[0], max[1], min[0], max[1]) !== null ||
      crossing(ax, ay, bx, by, min[0], max[1], min[0], min[1]) !== null
    )
      return true;
  }
  return false;
}

/**
 * Whether water at `frame` may be within the floor box `min`–`max` at a height between `zlo` and
 * `zhi`: a polygon of a water footprint meets the box (the polygon itself, not its bounding box)
 * and its surface, somewhere over it, is in that range. False rules water out there: a cheap test of
 * a body's surroundings before its bounds are measured (checks.ts body_in_water).
 */
export function waterNear(
  source: WaterSource,
  min: readonly [number, number],
  max: readonly [number, number],
  zlo: number,
  zhi: number,
  frame: number,
): boolean {
  if (![...min, ...max].every(Number.isFinite)) return hasWater(source);
  for (const f of footprintsAt(source, frame)) {
    if (max[0] < f.min[0] || min[0] > f.max[0] || max[1] < f.min[1] || min[1] > f.max[1]) continue;
    const i0 = clampCell(Math.floor((min[0] - f.min[0]) / f.cw), f.nx);
    const i1 = clampCell(Math.floor((max[0] - f.min[0]) / f.cw), f.nx);
    const j0 = clampCell(Math.floor((min[1] - f.min[1]) / f.ch), f.ny);
    const j1 = clampCell(Math.floor((max[1] - f.min[1]) / f.ch), f.ny);
    const seen = new Set<number>();
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++)
        for (const k of f.cells[j * f.nx + i]) {
          if (seen.has(k)) continue;
          seen.add(k);
          const p = f.polys[k];
          let lo = Infinity;
          let hi = -Infinity;
          for (let v = 0; v < p.xs.length; v++) {
            const z = p.a * p.xs[v] + p.b * p.ys[v] + p.c;
            lo = Math.min(lo, z);
            hi = Math.max(hi, z);
          }
          if (hi >= zlo && lo <= zhi && meetsBox(p, min, max)) return true;
        }
  }
  return false;
}

/** Where segment (ax, ay)–(bx, by) crosses segment (cx, cy)–(dx, dy): its parameter on the first, or null. */
function crossing(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number | null {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-15) return null;
  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t > 0 && t < 1 && u >= 0 && u <= 1 ? t : null;
}

/**
 * The stretches of a polyline (points in world space) over water at `frame`, in metres along it from
 * its first point, each with its water piece: exact (where the polyline crosses the pieces' polygon
 * edges), consecutive stretches over the same piece joined. With `level`, only water within `level`
 * metres of the polyline's height there counts (as {@link waterAt}). A single point gives a stretch
 * of length 0 when it is over water.
 */
export function waterAlong(
  source: WaterSource,
  polyline: readonly Readonly<Vec3>[],
  frame: number,
  o: { level?: number } = {},
): WaterSpan[] {
  const pts = polyline.filter((p) => p.length >= 3 && p.every(Number.isFinite));
  if (!pts.length) return [];
  const prints = footprintsAt(source, frame);
  if (!prints.length) return [];
  if (pts.length === 1) {
    const hit = waterAt(source, pts[0], frame, o);
    return hit ? [{ ...piece(hitPrint(prints, hit)), from_m: 0, to_m: 0 }] : [];
  }
  const out: WaterSpan[] = [];
  let walked = 0;
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = pts[s];
    const b = pts[s + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    // where the segment may change water: the polygon edges it crosses
    const ts = [0, 1];
    const sx0 = Math.min(a[0], b[0]);
    const sx1 = Math.max(a[0], b[0]);
    const sy0 = Math.min(a[1], b[1]);
    const sy1 = Math.max(a[1], b[1]);
    for (const f of prints) {
      if (sx1 < f.min[0] || sx0 > f.max[0] || sy1 < f.min[1] || sy0 > f.max[1]) continue;
      for (const p of f.polys) {
        if (sx1 < p.x0 || sx0 > p.x1 || sy1 < p.y0 || sy0 > p.y1) continue;
        for (let i = 0, j = p.xs.length - 1; i < p.xs.length; j = i++) {
          const t = crossing(a[0], a[1], b[0], b[1], p.xs[j], p.ys[j], p.xs[i], p.ys[i]);
          if (t !== null) ts.push(t);
        }
      }
    }
    ts.sort((u, v) => u - v);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k];
      const t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const tm = (t0 + t1) / 2;
      const mid: Vec3 = [a[0] + (b[0] - a[0]) * tm, a[1] + (b[1] - a[1]) * tm, a[2] + (b[2] - a[2]) * tm];
      const hit = waterAt(source, mid, frame, o);
      if (!hit) continue;
      const from = walked + t0 * len;
      const to = walked + t1 * len;
      const last = out[out.length - 1];
      if (last && last.id === hit.id && Math.abs(last.to_m - from) < 1e-9) last.to_m = to;
      else out.push({ ...piece(hitPrint(prints, hit)), from_m: from, to_m: to });
    }
    walked += len;
  }
  return out;
}

/** The footprint a hit came from. */
const hitPrint = (prints: readonly Footprint[], hit: WaterHit): Footprint =>
  prints.find((f) => f.id === hit.id)!;

// ---------------------------------------------------------------- actors in the water

/** Frame spans [from, to] (inclusive; ±Infinity for an open end). */
export type FrameSpan = [number, number];

/** `spans` in order, overlapping and touching ones joined. */
function mergeSpans(spans: readonly FrameSpan[]): FrameSpan[] {
  const out: FrameSpan[] = [];
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * The frames at which actor `o` belongs in the water (DESK_PROPS.inWater: a swimmer, a wader, a
 * rider of rideo's water), as joined spans in order: every frame for `true`; the frames a string
 * names (spans 'a..b' and single frames, comma-separated; an end left out is open: '..9, 51..');
 * none without the property. desk.check's walks_on_water leaves the actor alone at those frames.
 */
export function inWaterSpans(o: Pick<ObjectData, 'custom_props'> | null | undefined): FrameSpan[] {
  const v = o?.custom_props?.[DESK_PROPS.inWater];
  if (v === true) return [[-Infinity, Infinity]];
  if (typeof v !== 'string') return [];
  const spans: FrameSpan[] = [];
  for (const part of v.split(',')) {
    const t = part.trim();
    const m = /^(-?\d+)?\s*\.\.\s*(-?\d+)?$/.exec(t);
    if (m) {
      const a = m[1] === undefined ? -Infinity : Number(m[1]);
      const b = m[2] === undefined ? Infinity : Number(m[2]);
      if (a <= b) spans.push([a, b]);
    } else if (/^-?\d+$/.test(t)) spans.push([Number(t), Number(t)]);
  }
  return mergeSpans(spans);
}

/** Whether `frame` is in one of `spans`. */
export const inSpans = (spans: readonly FrameSpan[], frame: number): boolean =>
  spans.some(([a, b]) => frame >= a && frame <= b);

/** desk_in_water for `spans`: true for every frame, else the spans written out; undefined for none. */
function spansValue(spans: readonly FrameSpan[]): string | true | undefined {
  if (!spans.length) return undefined;
  if (spans.length === 1 && spans[0][0] === -Infinity && spans[0][1] === Infinity) return true;
  const end = (v: number) => (Number.isFinite(v) ? String(v) : '');
  return spans.map(([a, b]) => (a === b ? end(a) : `${end(a)}..${end(b)}`)).join(', ');
}

/** Sets the frames at which actor `id` belongs in the water (none: the property is removed). */
export function setInWaterSpans(doc: SceneDoc, id: string, spans: readonly FrameSpan[]): void {
  const o = doc.getObject(id);
  if (!o) return;
  const value = spansValue(mergeSpans(spans));
  if (value === o.custom_props?.[DESK_PROPS.inWater]) return;
  const props = { ...o.custom_props };
  if (value === undefined) delete props[DESK_PROPS.inWater];
  else props[DESK_PROPS.inWater] = value;
  doc.updateObject(id, { custom_props: props });
}

/**
 * Marks frames `from`–`to` of actor `id` (the whole frames they touch) as frames it belongs in the
 * water (`on`: a swimmer or a wader there) or takes them out of those frames (on land again),
 * keeping its other frames as they were.
 */
export function markInWater(doc: SceneDoc, id: string, from: number, to: number, on: boolean): void {
  const lo = Math.floor(Math.min(from, to));
  const hi = Math.ceil(Math.max(from, to));
  const old = inWaterSpans(doc.getObject(id));
  const next: FrameSpan[] = [];
  if (on) next.push(...old, [lo, hi]);
  else
    for (const [a, b] of old) {
      if (a < lo) next.push([a, Math.min(b, lo - 1)]);
      if (b > hi) next.push([Math.max(a, hi + 1), b]);
    }
  setInWaterSpans(doc, id, next);
}

// ---------------------------------------------------------------- warnings

const metres = (v: number) => `${Math.round(v * 10) / 10} m`;

/**
 * The warning for actor `name` standing at `point` (where its feet are) at `frame` when that is on
 * water at its level (WATER_LEVEL_M), else null: an actor stands on water as on the ground.
 */
export function standsOnWaterWarning(
  source: WaterSource,
  name: string,
  point: Readonly<Vec3>,
  frame: number,
): string | null {
  const hit = waterAt(source, point, frame, { level: WATER_LEVEL_M });
  if (!hit) return null;
  const at = point.map((v) => Math.round(v * 100) / 100).join(', ');
  return (
    `'${name}' stands on the water of ${hit.label} at [${at}] as if it were solid ground (desk.check ` +
    'reports walks_on_water while it is filmed there): put it on dry ground, or, for a swimmer or a ' +
    'wader, add it with desk.actor_add {in_water: true}'
  );
}

/**
 * The warnings for the path actor `name` walks from `frame` (`path`: from where it stands, through
 * the points of the move) over water at its level, one per stretch: where along the path it is in
 * metres and, through `frameAt` (metres walked → frame), about when.
 */
export function pathWaterWarnings(
  source: WaterSource,
  name: string,
  path: readonly Readonly<Vec3>[],
  frame: number,
  frameAt: (metres: number) => number,
): string[] {
  return waterAlong(source, path, frame, { level: WATER_LEVEL_M }).map((s) => {
    const a = Math.round(frameAt(s.from_m));
    const b = Math.round(frameAt(s.to_m));
    return (
      `The path of '${name}' crosses the water of ${s.label} from ${metres(s.from_m)} to ${metres(s.to_m)} ` +
      `along it (about ${b > a ? `frames ${a}–${b}` : `frame ${a}`}): ${name} would walk on the water as if ` +
      'it were solid ground (desk.check reports walks_on_water). Route the move around it with more ' +
      "desk.actor_move points (or raise them onto a bridge's deck), or move the mark; for a swimmer or a " +
      'wader, move it with in_water: true'
    );
  });
}
