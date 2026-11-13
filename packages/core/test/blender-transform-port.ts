/*
 * A port of the parts of Blender's transform code the transform tests compare with: the object
 * branches of ElementRotation_ex and ElementResize and the translation (transform_mode.cc) and
 * ObjectToTransData (transform_convert_object.cc), written from Blender's sources with its matrix
 * layout (m[column][row]) and independently of the editor's code.
 */

export type M3 = number[][];
export const IDENTITY: M3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
export const mul = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((c) => [0, 1, 2].map((r) => a[0][r] * b[c][0] + a[1][r] * b[c][1] + a[2][r] * b[c][2]));
export const mulV = (a: M3, v: number[]) =>
  [0, 1, 2].map((r) => a[0][r] * v[0] + a[1][r] * v[1] + a[2][r] * v[2]);
export const det = (m: M3) =>
  m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
  m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2]) +
  m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2]);
export const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
export const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** invert_m3_m3 (null when the determinant is 0, or the matrix is singular up to rounding) */
export function invert(m: M3): M3 | null {
  const d = det(m);
  if (!(Math.abs(d) > 1e-12 * len(m[0]) * len(m[1]) * len(m[2]))) return null;
  const at = (r: number, c: number) => m[c][r];
  const cofactor = (r: number, c: number) => {
    const rs = [0, 1, 2].filter((x) => x !== r);
    const cs = [0, 1, 2].filter((x) => x !== c);
    const v = at(rs[0], cs[0]) * at(rs[1], cs[1]) - at(rs[0], cs[1]) * at(rs[1], cs[0]);
    return (r + c) % 2 ? -v : v;
  };
  return [0, 1, 2].map((c) => [0, 1, 2].map((r) => cofactor(c, r) / d));
}

/** eul_to_mat3 */
export function eulToMat3(e: number[]): M3 {
  const [ci, cj, ch] = e.map(Math.cos);
  const [si, sj, sh] = e.map(Math.sin);
  const cc = ci * ch;
  const cs = ci * sh;
  const sc = si * ch;
  const ss = si * sh;
  return [
    [cj * ch, cj * sh, -sj],
    [sj * sc - cs, sj * ss + cc, cj * si],
    [sj * cc + ss, sj * cs - sc, cj * ci],
  ];
}

/** ortho_v3_v3 */
export function orthoV3(v: number[]): number[] {
  const x = Math.abs(v[0]);
  const y = Math.abs(v[1]);
  const z = Math.abs(v[2]);
  const axis = x > y ? (x > z ? 0 : 2) : y > z ? 1 : 2;
  if (axis === 0) return [-v[1] - v[2], v[0], v[0]];
  if (axis === 1) return [v[1], -v[0] - v[2], v[1]];
  return [v[2], v[2], -v[0] - v[1]];
}

/** orthogonalize_m3_zero_axes(m, 1.0f) */
export function orthogonalizeZeroAxes(m0: M3): M3 {
  const m = m0.map((c) => c.slice());
  const flag = m.reduce((f, c, i) => f | (c[0] * c[0] + c[1] * c[1] + c[2] * c[2] === 0 ? 1 << i : 0), 0);
  if (flag === 0 || flag === 7) return m;
  if (flag === 3) m[1] = orthoV3(m[2]);
  if (flag === 6) m[2] = orthoV3(m[0]);
  if (flag === 5) m[0] = orthoV3(m[1]);
  if (flag === 1 || flag === 3) m[0] = cross(m[1], m[2]);
  if (flag === 2 || flag === 6) m[1] = cross(m[0], m[2]);
  if (flag === 4 || flag === 5) m[2] = cross(m[0], m[1]);
  for (let i = 0; i < 3; i++)
    if (flag & (1 << i)) {
      const l = len(m[i]);
      if (l === 0) m[i][i] = 1;
      else m[i] = m[i].map((v) => v / l);
    }
  return m;
}

/** invert_m3_m3_safe_ortho */
export const invertSafeOrtho = (m: M3): M3 => invert(m) ?? invert(orthogonalizeZeroAxes(m)) ?? IDENTITY;

/** transform_orientations_create_from_axis */
export function axisMatrix(w: M3): M3 {
  const out = w.map((c) => (len(c) === 0 ? [0, 0, 0] : c.map((v) => v / len(c))));
  const zero = w.map((c) => len(c) === 0);
  const count = zero.filter(Boolean).length;
  if (count === 0) return out;
  if (count === 1) {
    const a = zero.indexOf(true);
    const v = cross(out[(a + 1) % 3], out[(a + 2) % 3]);
    if (len(v) !== 0) {
      out[a] = v.map((x) => x / len(v));
      return out;
    }
  } else if (count === 2) {
    const axis = zero.indexOf(false);
    for (const a of [(axis + 1) % 3, (axis + 2) % 3]) {
      out[a] = [0, 0, 0];
      out[a][a] = 1;
      const d = out[a][0] * out[axis][0] + out[a][1] * out[axis][1] + out[a][2] * out[axis][2];
      out[a] = out[a].map((v, i) => v - d * out[axis][i]);
    }
    const [a, b] = [(axis + 1) % 3, (axis + 2) % 3];
    if (len(out[a]) !== 0 && len(out[b]) !== 0) {
      out[a] = out[a].map((v) => v / len(out[a]));
      out[b] = out[b].map((v) => v / len(out[b]));
      return out;
    }
  }
  return IDENTITY;
}

/** compatible_eul (Blender 3.6 and later) */
export function compatibleEul(e0: number[], old: number[]): number[] {
  const e = e0.slice();
  const d = [0, 0, 0];
  const pi2 = 2 * Math.PI;
  for (let i = 0; i < 3; i++) {
    d[i] = e[i] - old[i];
    if (d[i] > Math.PI) {
      e[i] -= Math.floor(d[i] / pi2 + 0.5) * pi2;
      d[i] = e[i] - old[i];
    } else if (d[i] < -Math.PI) {
      e[i] += Math.floor(-d[i] / pi2 + 0.5) * pi2;
      d[i] = e[i] - old[i];
    }
  }
  for (let i = 0, j = 1, k = 2; i < 3; j = k, k = i++)
    if (Math.abs(d[i]) > Math.PI && Math.abs(d[j]) < Math.PI / 2 && Math.abs(d[k]) < Math.PI / 2)
      e[i] += d[i] > 0 ? -pi2 : pi2;
  return e;
}

/** mat3_to_compatible_eulO for XYZ (with mat3_normalized_to_eulo2 and EULER_HYPOT_EPSILON) */
export function mat3ToCompatibleEul(m0: M3, old: number[]): { euler: number[]; cosY: number } {
  const m = m0.map((c) => (len(c) > 0 ? c.map((v) => v / len(c)) : [0, 0, 0]));
  const cy = Math.hypot(m[0][0], m[0][1]);
  let e1: number[];
  let e2: number[];
  if (cy > 0.0000375) {
    e1 = [Math.atan2(m[1][2], m[2][2]), Math.atan2(-m[0][2], cy), Math.atan2(m[0][1], m[0][0])];
    e2 = [Math.atan2(-m[1][2], -m[2][2]), Math.atan2(-m[0][2], -cy), Math.atan2(-m[0][1], -m[0][0])];
  } else {
    e1 = [Math.atan2(-m[2][1], m[1][1]), Math.atan2(-m[0][2], cy), 0];
    e2 = e1.slice();
  }
  const a = compatibleEul(e1, old);
  const b = compatibleEul(e2, old);
  const sum = (e: number[]) => e.reduce((s, v, i) => s + Math.abs(v - old[i]), 0);
  return { euler: sum(a) > sum(b) ? b : a, cosY: cy };
}

/** TransMat3ToSize (with mat3_to_rot_size) */
export function transMat3ToSize(mat: M3, smat: M3): number[] {
  let rot = mat.map((c) => (len(c) > 0 ? c.map((v) => v / len(c)) : [0, 0, 0]));
  let size = mat.map(len);
  if (det(rot) < 0) {
    rot = rot.map((c) => c.map((v) => -v));
    size = size.map((v) => -v);
  }
  return size.map((s, i) =>
    rot[i][0] * smat[i][0] + rot[i][1] * smat[i][1] + rot[i][2] * smat[i][2] < 0 ? -s : s,
  );
}

/** A parent's world matrix: its 3×3 part and its translation. */
export interface ParentMatrix {
  m: M3;
  t: number[];
}

/** The 3×3 part and translation of a column-major 4×4 matrix (the editor's layout). */
export function fromMat4(w: readonly number[]): ParentMatrix {
  return {
    m: [
      [w[0], w[1], w[2]],
      [w[4], w[5], w[6]],
      [w[8], w[9], w[10]],
    ],
    t: [w[12], w[13], w[14]],
  };
}

/** loc_eul_size_to_mat4 as a 3×3 part and a translation. */
export function localOf(o: { loc: number[]; rot: number[]; scale: number[] }): ParentMatrix {
  return {
    m: mul(
      eulToMat3(o.rot),
      IDENTITY.map((c, k) => c.map((v) => v * o.scale[k])),
    ),
    t: o.loc,
  };
}

/** parent · local */
export function compose(parent: ParentMatrix | null, local: ParentMatrix): ParentMatrix {
  if (!parent) return local;
  return { m: mul(parent.m, local.m), t: mulV(parent.m, local.t).map((v, k) => v + parent.t[k]) };
}

/**
 * ObjectToTransData for an object with channels `o` under a parent whose world matrix is `parent`
 * (null without one; the object's own constraints switched off), then Blender's Move (`mat` unused,
 * `offset` the world offset), Rotate or Scale (`mat` the world 3×3 about the world point `center`):
 * the channels Blender stores.
 */
export function blenderTransform(
  o: { loc: number[]; rot: number[]; scale: number[] },
  parent: ParentMatrix | null,
  mode: 'TRANSLATE' | 'ROTATE' | 'RESIZE',
  mat: M3,
  center: number[],
  offset: number[] = [0, 0, 0],
): { loc: number[]; rot: number[]; scale: number[]; cosY: number } {
  const local = localOf(o);
  const w = compose(parent, local);
  let smtx = IDENTITY;
  if (parent) smtx = mul(orthogonalizeZeroAxes(local.m), invertSafeOrtho(orthogonalizeZeroAxes(w.m)));
  const mtx = invertSafeOrtho(smtx);
  if (mode === 'TRANSLATE')
    return { loc: mulV(smtx, offset).map((v, k) => o.loc[k] + v), rot: o.rot, scale: o.scale, cosY: 1 };
  const vec = mulV(
    mat,
    [0, 1, 2].map((k) => w.t[k] - center[k]),
  ).map((v, k) => v + center[k] - w.t[k]);
  const loc = mulV(smtx, vec).map((v, k) => o.loc[k] + v);
  if (mode === 'ROTATE') {
    const fmat = mul(mul(smtx, mul(mat, mtx)), eulToMat3(o.rot));
    const { euler, cosY } = mat3ToCompatibleEul(fmat, o.rot);
    return { loc, rot: euler, scale: o.scale, cosY };
  }
  const axismtx = axisMatrix(w.m);
  const f = transMat3ToSize(mul(mat, axismtx), axismtx);
  return { loc, rot: o.rot, scale: o.scale.map((s, k) => s * f[k]), cosY: 1 };
}
