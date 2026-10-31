import type { Vec2 } from '../math/types';
import type { MeshData } from '../mesh/types';
import type { CurveData } from '../doc/types';
import { evaluateCurveSplines } from './spline';

export interface CurveMeshOptions {
  forRender: boolean;
  /** FONT objects: build the text in `body` instead of the splines. */
  isText: boolean;
  /** Bevel profile (bevel_mode OBJECT): closed/open 2D polylines of another curve object. */
  getBevelProfile?(curveObjectId: string): Vec2[][] | null;
}

export interface CurveMeshResult {
  /** Surface geometry (bevel, extrude, fill, text), null when the curve has none. */
  mesh: MeshData | null;
  /** Wire display of the splines as flat xyz segment pairs (object space). */
  lines: Float32Array | null;
}

/** Wire segments of the sampled splines. */
export function curveLines(curve: CurveData, forRender = false): Float32Array | null {
  const segs: number[] = [];
  for (const s of evaluateCurveSplines(curve, forRender)) {
    const p = s.points;
    for (let i = 0; i + 1 < p.length; i++) segs.push(...p[i], ...p[i + 1]);
    if (s.cyclic && p.length > 2) segs.push(...p[p.length - 1], ...p[0]);
  }
  return segs.length ? new Float32Array(segs) : null;
}

/**
 * Converts curve/text data to geometry (Blender's curve → mesh evaluation).
 *
 * Phase-0 stub: wire lines only. The curve workstream implements bevel/extrude/fill/taper,
 * bevel_factor_start/end, offset, text layout with the built-in font, and FONT objects.
 */
export function curveToMesh(curve: CurveData, opts: CurveMeshOptions): CurveMeshResult {
  if (opts.isText) return { mesh: null, lines: null };
  return { mesh: null, lines: curveLines(curve, opts.forRender) };
}
