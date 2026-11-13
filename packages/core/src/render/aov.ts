/*
 * Encoders of the per-pixel passes a RASTER render returns (`RenderedImage.aovs`) into the 8-bit
 * images video exports write (depth, normal, object mask, edges), and screen-space lines.
 *
 * Conventions:
 * - depth: 255 at `near` (and nearer), 0 at `far` (and beyond) and where nothing is drawn, linear in
 *   1/depth in between (disparity, like monocular depth estimators: near objects get the steps).
 *   Use one near/far pair for a whole shot, or the brightness of everything flickers.
 * - normal: view space (x right, y up, z towards the camera) as RGB = (n + 1) / 2 · 255 (the usual
 *   OpenGL-style normal map; a surface facing the camera is (128, 128, 255)); black where nothing is
 *   drawn.
 * - object masks: one byte per pixel (a palette index, 0 = background) or RGB colours per object id.
 * - edges: black (0) 1-pixel lines on white (255) where the object changes, the depth jumps or the
 *   surface creases.
 */

export { drawLines, type ScreenLine, type LineView, type DrawLinesOptions } from './lines';

/** Relative depth jump that makes an edge (for surfaces facing the camera; see `edgesToBytes`). */
export const EDGE_DEPTH_JUMP = 0.03;
/** Angle between neighbouring normals that makes an edge (35°). */
export const EDGE_NORMAL_ANGLE = (35 * Math.PI) / 180;

/**
 * Depth pass → 1 byte per pixel: 255 at `near`, 0 at `far`, linear in 1/depth between (see the module
 * comment); pixels without a surface (Infinity, 0 or NaN) are 0.
 */
export function depthToBytes(depth: Float32Array, near: number, far: number): Uint8Array {
  const out = new Uint8Array(depth.length);
  const n = Math.max(1e-6, Math.min(near, far));
  const f = Math.max(n * (1 + 1e-6), Math.max(near, far));
  const inf = 1 / f;
  const span = 1 / n - inf;
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (!(d > 0) || d === Infinity) continue;
    const v = (1 / Math.max(d, n) - inf) / span;
    out[i] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return out;
}

/** Normal pass (3 floats per pixel, view space) → RGB bytes (see the module comment). */
export function normalToRGB(normal: Float32Array): Uint8Array {
  const out = new Uint8Array(normal.length);
  for (let i = 0; i < normal.length; i += 3) {
    const x = normal[i];
    const y = normal[i + 1];
    const z = normal[i + 2];
    if (x === 0 && y === 0 && z === 0) continue;
    out[i] = byte(x * 0.5 + 0.5);
    out[i + 1] = byte(y * 0.5 + 0.5);
    out[i + 2] = byte(z * 0.5 + 0.5);
  }
  return out;
}

/**
 * Object pass → 1 byte per pixel: the index `palette` gives the pixel's object id. `palette` is a
 * list of ids (index = position + 1) or a record of ids to indices (1..255); background pixels and
 * objects not in the palette are 0. Keep one palette for a whole export so indices do not change.
 */
export function objectToIndex(
  object: Uint32Array,
  objectTable: readonly string[],
  palette: readonly string[] | Readonly<Record<string, number>>,
): Uint8Array {
  const lookup = new Map<string, number>();
  if (Array.isArray(palette))
    (palette as readonly string[]).forEach((id, i) => i < 255 && lookup.set(id, i + 1));
  else
    for (const [id, v] of Object.entries(palette as Readonly<Record<string, number>>))
      if (Number.isFinite(v)) lookup.set(id, Math.max(0, Math.min(255, Math.round(v))));
  const byIndex = Uint8Array.from(objectTable, (id, i) => (i === 0 ? 0 : (lookup.get(id) ?? 0)));
  const out = new Uint8Array(object.length);
  for (let i = 0; i < object.length; i++) {
    const k = object[i];
    out[i] = k < byIndex.length ? byIndex[k] : 0;
  }
  return out;
}

/**
 * Object pass → RGB bytes: each pixel takes its object's colour from `colors` (display values
 * 0..1 per channel, by object id); background pixels and objects without a colour take
 * `background` (default black).
 */
export function objectPaletteRGB(
  object: Uint32Array,
  objectTable: readonly string[],
  colors: Readonly<Record<string, readonly [number, number, number]>>,
  background: readonly [number, number, number] = [0, 0, 0],
): Uint8Array {
  const bg = [byte(background[0]), byte(background[1]), byte(background[2])];
  const table = new Uint8Array(objectTable.length * 3);
  objectTable.forEach((id, i) => {
    const c = i === 0 ? undefined : colors[id];
    for (let k = 0; k < 3; k++) table[i * 3 + k] = c ? byte(c[k]) : bg[k];
  });
  const out = new Uint8Array(object.length * 3);
  for (let i = 0; i < object.length; i++) {
    const k = object[i];
    const o = k < objectTable.length ? k * 3 : 0;
    const src = k < objectTable.length ? table : null;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = src ? src[o + c] : bg[c];
  }
  return out;
}

/**
 * Edge pass → 1 byte per pixel: black (0) where a pixel differs from its right or lower neighbour
 * (so lines are 1 pixel wide) by object (`object`, may be null), by depth (a jump over
 * EDGE_DEPTH_JUMP of the nearer depth; a surface seen at a grazing angle needs a proportionally
 * larger jump, so receding floors do not fill with lines; drawn / empty pixels always differ) or
 * by normal (`normal`, view space, may be null: an angle over EDGE_NORMAL_ANGLE); white (255)
 * elsewhere.
 */
export function edgesToBytes(
  object: Uint32Array | null,
  depth: Float32Array,
  normal: Float32Array | null,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height).fill(255);
  const cosLimit = Math.cos(EDGE_NORMAL_ANGLE);
  const differs = (p: number, q: number): boolean => {
    if (object && object[p] !== object[q]) return true;
    const dp = depth[p];
    const dq = depth[q];
    const ep = dp > 0 && dp !== Infinity;
    const eq = dq > 0 && dq !== Infinity;
    if (ep !== eq) return true;
    if (!ep) return false;
    let facing = 1;
    if (normal) {
      const np = Math.abs(normal[p * 3 + 2]);
      const nq = Math.abs(normal[q * 3 + 2]);
      facing = Math.max(np, nq, 0.05);
      const dot =
        normal[p * 3] * normal[q * 3] +
        normal[p * 3 + 1] * normal[q * 3 + 1] +
        normal[p * 3 + 2] * normal[q * 3 + 2];
      if (dot < cosLimit) return true;
    }
    return Math.abs(dp - dq) > (EDGE_DEPTH_JUMP / facing) * Math.min(dp, dq);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if ((x + 1 < width && differs(p, p + 1)) || (y + 1 < height && differs(p, p + width))) out[p] = 0;
    }
  }
  return out;
}

function byte(v: number): number {
  return v > 0 ? (v < 1 ? Math.round(v * 255) : 255) : 0;
}
