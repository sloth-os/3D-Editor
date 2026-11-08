import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  compose4,
  createEditorState,
  createOperatorRegistry,
  fcurveKey,
  multiply4,
  rotationFromEuler,
  scaling4,
  transformObjects,
  type OperatorContext,
  type Vec3,
} from '../src';

/*
 * Rotate and Scale store what Blender's store: a port of the object branches of Blender's
 * ElementRotation_ex and ElementResize (transform_mode.cc) and of ObjectToTransData
 * (transform_convert_object.cc), written from Blender's sources with its matrix layout (m[column][row])
 * and independently of the editor's code, is compared with what the operators store.
 */

const deg = Math.PI / 180;

// ---------------------------------------------------------------- the port of Blender's code

type M3 = number[][];
const IDENTITY: M3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const mul = (a: M3, b: M3): M3 =>
  [0, 1, 2].map((c) => [0, 1, 2].map((r) => a[0][r] * b[c][0] + a[1][r] * b[c][1] + a[2][r] * b[c][2]));
const mulV = (a: M3, v: number[]) => [0, 1, 2].map((r) => a[0][r] * v[0] + a[1][r] * v[1] + a[2][r] * v[2]);
const det = (m: M3) =>
  m[0][0] * (m[1][1] * m[2][2] - m[2][1] * m[1][2]) -
  m[1][0] * (m[0][1] * m[2][2] - m[2][1] * m[0][2]) +
  m[2][0] * (m[0][1] * m[1][2] - m[1][1] * m[0][2]);
const len = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
const cross = (a: number[], b: number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** invert_m3_m3 (null when the determinant is 0, or the matrix is singular up to rounding) */
function invert(m: M3): M3 | null {
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
function eulToMat3(e: number[]): M3 {
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
function orthoV3(v: number[]): number[] {
  const x = Math.abs(v[0]);
  const y = Math.abs(v[1]);
  const z = Math.abs(v[2]);
  const axis = x > y ? (x > z ? 0 : 2) : y > z ? 1 : 2;
  if (axis === 0) return [-v[1] - v[2], v[0], v[0]];
  if (axis === 1) return [v[1], -v[0] - v[2], v[1]];
  return [v[2], v[2], -v[0] - v[1]];
}

/** orthogonalize_m3_zero_axes(m, 1.0f) */
function orthogonalizeZeroAxes(m0: M3): M3 {
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
const invertSafeOrtho = (m: M3): M3 => invert(m) ?? invert(orthogonalizeZeroAxes(m)) ?? IDENTITY;

/** transform_orientations_create_from_axis */
function axisMatrix(w: M3): M3 {
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
function compatibleEul(e0: number[], old: number[]): number[] {
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
function mat3ToCompatibleEul(m0: M3, old: number[]): { euler: number[]; cosY: number } {
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
function transMat3ToSize(mat: M3, smat: M3): number[] {
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

interface Obj {
  loc: number[];
  rot: number[];
  scale: number[];
  parent: number | null;
}

/** object_to_world as BKE_object_where_is_calc computes it (no parent inverse) */
function worldOf(objs: Obj[], i: number): { m: M3; t: number[] } {
  const o = objs[i];
  const local = mul(
    eulToMat3(o.rot),
    IDENTITY.map((c, k) => c.map((v) => v * o.scale[k])),
  );
  if (o.parent === null) return { m: local, t: o.loc };
  const p = worldOf(objs, o.parent);
  return { m: mul(p.m, local), t: mulV(p.m, o.loc).map((v, k) => v + p.t[k]) };
}

/** ObjectToTransData, then the object branch of ElementRotation_ex or ElementResize */
function blender(objs: Obj[], i: number, mode: 'ROTATE' | 'RESIZE', mat: M3, center: number[]) {
  const o = objs[i];
  const w = worldOf(objs, i);
  let smtx = IDENTITY;
  if (o.parent !== null) {
    const obmtx = orthogonalizeZeroAxes(
      mul(
        eulToMat3(o.rot),
        IDENTITY.map((c, k) => c.map((v) => v * o.scale[k])),
      ),
    );
    smtx = mul(obmtx, invertSafeOrtho(orthogonalizeZeroAxes(w.m)));
  }
  const mtx = invertSafeOrtho(smtx);
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

// ---------------------------------------------------------------- the editor

/** One registry for every test (it keeps nothing between runs; building it takes a while). */
const reg = createOperatorRegistry();

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r;
  };
  return { doc, ctx, run };
}

/** The keys of the objects' maps (by object name) that `fn` writes. */
function objectWrites(doc: SceneDoc, fn: () => void): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const listener = (tr: Y.Transaction) => {
    for (const [type, keys] of tr.changed) {
      if (!(type instanceof Y.Map) || type.parent !== doc.map('objects')) continue;
      for (const k of keys) if (k !== null) (out[String(type.get('name'))] ??= new Set()).add(k);
    }
  };
  doc.ydoc.on('afterTransaction', listener);
  try {
    fn();
  } finally {
    doc.ydoc.off('afterTransaction', listener);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** Adds the chain of objects `objs` (each the parent of the next) and returns their ids. */
function addChain(doc: SceneDoc, objs: Obj[]): string[] {
  const ids: string[] = [];
  objs.forEach((o, i) =>
    ids.push(
      doc.addObject({
        type: 'EMPTY',
        name: `O${i}`,
        location: o.loc as Vec3,
        rotation_euler: o.rot as Vec3,
        scale: o.scale as Vec3,
        parent: o.parent === null ? null : ids[o.parent],
      }),
    ),
  );
  return ids;
}

const maxDiff = (a: readonly number[], b: readonly number[]) =>
  Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe('Rotate and Scale store what Blender’s store', () => {
  it('for random objects and parents (rotated, scaled unevenly, mirrored, scaled to 0), about their origins and the cursor', () => {
    let seed = 20261108;
    const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
    const factor = () => {
      const s = Math.exp((rnd() * 2 - 1) * Math.log(5));
      return rnd() < 0.15 ? -s : s;
    };
    let compared = 0;
    for (let n = 0; n < 400; n++) {
      const { doc, ctx, run } = setup();
      const depth = Math.floor(rnd() * 3);
      const objs: Obj[] = [];
      for (let d = 0; d <= depth; d++) {
        const o: Obj = {
          loc: [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3],
          rot: [(rnd() * 2 - 1) * 4, (rnd() * 2 - 1) * 1.6, (rnd() * 2 - 1) * 4],
          scale: rnd() < 0.3 ? [1, 1, 1] : [factor(), factor(), factor()],
          parent: d === 0 ? null : d - 1,
        };
        if (d === depth && rnd() < 0.1) o.scale[Math.floor(rnd() * 3)] = 0;
        objs.push(o);
      }
      const ids = addChain(doc, objs);
      const id = ids[depth];
      ctx.state.selectedIds = [id];
      ctx.state.activeId = id;
      const aboutCursor = rnd() < 0.5;
      ctx.state.pivotPoint = aboutCursor ? 'CURSOR' : 'MEDIAN_POINT';
      ctx.state.cursorLocation = [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2];
      const w = worldOf(objs, depth);
      const center = aboutCursor ? ctx.state.cursorLocation : w.t;
      const rotate = rnd() < 0.5;
      let mat: M3;
      const writes = objectWrites(doc, () => {
        if (rotate) {
          const axis = Math.floor(rnd() * 3);
          const angle = (rnd() * 2 - 1) * Math.PI * (rnd() < 0.3 ? 2 : 1);
          mat = eulToMat3([0, 1, 2].map((k) => (k === axis ? angle : 0)));
          run('transform.rotate', { value: angle, orient_axis: 'XYZ'[axis] });
        } else {
          const f = rnd() < 0.4 ? [1, 1, 1].map((_, k) => (k === 0 ? -1 : 1) * factor()) : [factor(), 1, 1];
          if (rnd() < 0.3) f.fill(f[0]);
          mat = IDENTITY.map((c, k) => c.map((v) => v * f[k]));
          run('transform.resize', { value: f });
        }
      });
      const ref = blender(objs, depth, rotate ? 'ROTATE' : 'RESIZE', mat!, center);
      const got = doc.getObject(id)!;
      const what = `case ${n}: ${rotate ? 'R' : 'S'} ${aboutCursor ? 'about the cursor' : 'about the origin'} ${JSON.stringify(objs)}`;
      expect(maxDiff(got.location, ref.loc) / Math.max(1, ...ref.loc.map(Math.abs)), what).toBeLessThan(
        1e-12,
      );
      expect(maxDiff(got.scale, ref.scale) / Math.max(1e-300, ...ref.scale.map(Math.abs)), what).toBeLessThan(
        1e-12,
      );
      // near gimbal lock the editor reads the rotation more precisely than Blender's formulas
      if (ref.cosY > 0.01) expect(maxDiff(got.rotation_euler, ref.rot), what).toBeLessThan(1e-11);
      // the channel the operation leaves as it was is not written, nor the location about the origin
      if (rotate) expect(got.scale, what).toEqual(objs[depth].scale);
      else expect(got.rotation_euler, what).toEqual(objs[depth].rot);
      if (!aboutCursor) expect(writes[`O${depth}`] ?? [], what).not.toContain('location');
      compared++;
    }
    expect(compared).toBe(400);
  });

  it('a scale along the object’s own axes multiplies each scale by its factor, also two negative ones', () => {
    const { doc, ctx, run } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 2, 3] });
    ctx.state.selectedIds = [id];
    ctx.state.activeId = id;
    const writes = objectWrites(doc, () => run('transform.resize', { value: [-1, -1, 1] }));
    expect(writes).toEqual({ A: ['scale'] });
    expect(doc.getObject(id)!.scale).toEqual([-1, -1, 1]);
    expect(doc.getObject(id)!.rotation_euler).toEqual([0, 0, 0]);
    // along the axes of a turned object (Blender's LOCAL orientation): each scale gets its factor
    const turnedId = doc.addObject({
      type: 'EMPTY',
      name: 'B',
      rotation_euler: [10 * deg, 20 * deg, 30 * deg],
      scale: [1.5, -0.5, 2],
    });
    const axes = rotationFromEuler([10 * deg, 20 * deg, 30 * deg]);
    const inverse = [
      axes[0],
      axes[4],
      axes[8],
      0,
      axes[1],
      axes[5],
      axes[9],
      0,
      axes[2],
      axes[6],
      axes[10],
      0,
      0,
      0,
      0,
      1,
    ];
    const local = multiply4(axes, multiply4(scaling4([2, -1, 0.5]), inverse));
    transformObjects(doc, [turnedId], local, [0, 0, 0], 'INDIVIDUAL_ORIGINS', 'RESIZE');
    doc.getObject(turnedId)!.scale.forEach((v, i) => expect(v).toBeCloseTo([3, 0.5, 1][i], 12));
    expect(doc.getObject(turnedId)!.rotation_euler).toEqual([10 * deg, 20 * deg, 30 * deg]);
  });

  it('a scale along a world axis keeps the rotation of a turned object and gives each of its axes the length it gets', () => {
    for (const c of [
      { value: [-1, 1, 1], scale: [-1, 1, 1] },
      { value: [2, 1, 1], scale: [Math.sqrt(3.25), Math.sqrt(1.75), 1] },
    ]) {
      const { doc, ctx, run } = setup();
      const id = doc.addObject({
        type: 'EMPTY',
        name: 'A',
        location: [1, 2, 3],
        rotation_euler: [0, 0, 30 * deg],
      });
      ctx.state.selectedIds = [id];
      ctx.state.activeId = id;
      const writes = objectWrites(doc, () => run('transform.resize', { value: c.value }));
      expect(writes, `S ${c.value}`).toEqual({ A: ['scale'] });
      expect(doc.getObject(id)!.rotation_euler).toEqual([0, 0, 30 * deg]);
      doc.getObject(id)!.scale.forEach((v, i) => expect(v, `S ${c.value}`).toBeCloseTo(c.scale[i], 12));
    }
  });

  it('a scale by 0 keeps the rotation, and a rotation keeps a scale of 0', () => {
    const { doc, ctx, run } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [10 * deg, 120 * deg, -30 * deg] });
    ctx.state.selectedIds = [id];
    ctx.state.activeId = id;
    expect(objectWrites(doc, () => run('transform.resize', { value: [0, 0, 0] }))).toEqual({ A: ['scale'] });
    expect(doc.getObject(id)!.rotation_euler).toEqual([10 * deg, 120 * deg, -30 * deg]);
    expect(objectWrites(doc, () => run('transform.rotate', { value: 20 * deg, orient_axis: 'X' }))).toEqual({
      A: ['rotation_euler'],
    });
    expect(doc.getObject(id)!.scale.map(Math.abs)).toEqual([0, 0, 0]);
  });

  it('a child scaled to 0 on an axis turns as Blender turns it: its zero axis counts as length 1 in both spaces', () => {
    // Blender converts to the parent's space with local 3×3 · inverse(world 3×3), each with its zero
    // axes made unit length: under a parent scaled 2 that is not the parent's inverse along that axis
    const { doc, ctx, run } = setup();
    const objs: Obj[] = [
      { loc: [5, 0, 0], rot: [0, 0, 40 * deg], scale: [2, 2, 2], parent: null },
      { loc: [0.3, 0.7, -0.9], rot: [0, 0, 30 * deg], scale: [0, 1, 1], parent: 0 },
    ];
    const ids = addChain(doc, objs);
    ctx.state.selectedIds = [ids[1]];
    ctx.state.activeId = ids[1];
    run('transform.rotate', { value: 20 * deg, orient_axis: 'X' });
    const ref = blender(objs, 1, 'ROTATE', eulToMat3([20 * deg, 0, 0]), worldOf(objs, 1).t);
    const got = doc.getObject(ids[1])!;
    got.rotation_euler.forEach((v, i) => expect(v).toBeCloseTo(ref.rot[i], 12));
    // which differs from turning the child's axes by 20° about X
    const turned = multiply4(
      rotationFromEuler([20 * deg, 0, 0]),
      multiply4(rotationFromEuler([0, 0, 40 * deg]), rotationFromEuler(objs[1].rot as Vec3)),
    );
    const stored = multiply4(rotationFromEuler([0, 0, 40 * deg]), rotationFromEuler(got.rotation_euler));
    expect(maxDiff(stored, turned)).toBeGreaterThan(1e-3);
  });

  it('a child scaled to 0 on two axes turns and moves as Blender’s Rotate and Scale turn and move it', () => {
    // Blender rebuilds the two zero axes of the child's local and world 3×3 from the third
    // (ortho_v3_v3, then a cross product) before it converts to the parent's space, which then
    // differs from the parent's inverse
    for (const scale of [
      [0, 1.5, 0],
      [2, 0, 0],
      [0, 0, -0.5],
    ]) {
      const objs: Obj[] = [
        { loc: [5, 0, 0], rot: [20 * deg, -35 * deg, 50 * deg], scale: [2, 0.5, 1.5], parent: null },
        { loc: [0.3, 0.7, -0.9], rot: [10 * deg, 20 * deg, 30 * deg], scale, parent: 0 },
      ];
      const what = `child scale ${scale}`;
      // R about its own origin: the rotation
      const r = setup();
      const ids = addChain(r.doc, objs);
      r.ctx.state.selectedIds = [ids[1]];
      r.ctx.state.activeId = ids[1];
      r.run('transform.rotate', { value: 25 * deg, orient_axis: 'Y' });
      const turned = blender(objs, 1, 'ROTATE', eulToMat3([0, 25 * deg, 0]), worldOf(objs, 1).t);
      expect(maxDiff(r.doc.getObject(ids[1])!.rotation_euler, turned.rot), what).toBeLessThan(1e-12);
      // S about the 3D cursor: the location and the scale
      const s = setup();
      const sids = addChain(s.doc, objs);
      s.ctx.state.selectedIds = [sids[1]];
      s.ctx.state.activeId = sids[1];
      s.ctx.state.pivotPoint = 'CURSOR';
      s.ctx.state.cursorLocation = [1, -2, 0.5];
      s.run('transform.resize', { value: [1.5, 0.5, 2] });
      const mat = IDENTITY.map((c, k) => c.map((v) => v * [1.5, 0.5, 2][k]));
      const scaled = blender(objs, 1, 'RESIZE', mat, [1, -2, 0.5]);
      expect(maxDiff(s.doc.getObject(sids[1])!.location, scaled.loc), what).toBeLessThan(1e-12);
      expect(maxDiff(s.doc.getObject(sids[1])!.scale, scaled.scale), what).toBeLessThan(1e-12);
    }
  });

  it('near gimbal lock the rotation of a sheared child is what Blender’s formulas read from its matrix', () => {
    // under a parent scaled unevenly the turned matrix is not a rotation: Blender's formulas
    // define its angles (only a rotation's are read from the entries that keep their size)
    const { doc, ctx, run } = setup();
    const objs: Obj[] = [
      { loc: [0, 0, 0], rot: [0, 0, 0], scale: [1.5, 0.7, 0.7], parent: null },
      { loc: [1, 0, 0], rot: [148 * deg, 89 * deg, 87 * deg], scale: [1, 1, 1], parent: 0 },
    ];
    const ids = addChain(doc, objs);
    ctx.state.selectedIds = [ids[1]];
    ctx.state.activeId = ids[1];
    run('transform.rotate', { value: 108 * deg, orient_axis: 'Z' });
    const ref = blender(objs, 1, 'ROTATE', eulToMat3([0, 0, 108 * deg]), worldOf(objs, 1).t);
    expect(ref.cosY).toBeLessThan(0.01);
    expect(maxDiff(doc.getObject(ids[1])!.rotation_euler, ref.rot)).toBeLessThan(1e-12);
  });

  describe('pivot points', () => {
    /** Two objects, A (selected and active) and B (selected), and an unselected C. */
    function scene() {
      const t = setup();
      const objs: Obj[] = [
        { loc: [1, 2, 3], rot: [10 * deg, 20 * deg, 30 * deg], scale: [1.5, 0.5, 2], parent: null },
        { loc: [-2, 0.5, 1], rot: [0, 120 * deg, 0], scale: [1, -1, 1], parent: null },
        { loc: [4, -3, 0], rot: [0, 0, 0], scale: [1, 1, 1], parent: null },
      ];
      const ids = objs.map((o, i) =>
        t.doc.addObject({
          type: 'EMPTY',
          name: 'ABC'[i],
          location: o.loc as Vec3,
          rotation_euler: o.rot as Vec3,
          scale: o.scale as Vec3,
        }),
      );
      t.ctx.state.selectedIds = [ids[1], ids[0]];
      t.ctx.state.activeId = ids[0];
      t.ctx.state.cursorLocation = [0.5, -1, 2];
      return { ...t, objs, ids };
    }
    const cases: { pivot: string; center: (objs: Obj[], cursor: number[]) => number[] | null }[] = [
      { pivot: 'INDIVIDUAL_ORIGINS', center: () => null },
      { pivot: 'MEDIAN_POINT', center: (o) => o[0].loc.map((v, k) => (v + o[1].loc[k]) / 2) },
      {
        pivot: 'BOUNDING_BOX_CENTER',
        center: (o) => o[0].loc.map((v, k) => (Math.min(v, o[1].loc[k]) + Math.max(v, o[1].loc[k])) / 2),
      },
      { pivot: 'ACTIVE_ELEMENT', center: (o) => o[0].loc },
      { pivot: 'CURSOR', center: (_, cursor) => cursor },
    ];
    for (const c of cases)
      for (const mode of ['ROTATE', 'RESIZE'] as const)
        it(`${mode === 'ROTATE' ? 'R' : 'S'} about ${c.pivot}`, () => {
          const { doc, ctx, run, objs, ids } = scene();
          ctx.state.pivotPoint = c.pivot as typeof ctx.state.pivotPoint;
          const mat =
            mode === 'ROTATE'
              ? eulToMat3([0, 0, 35 * deg])
              : IDENTITY.map((col, k) => col.map((v) => v * [2, 1, 0.5][k]));
          const writes = objectWrites(doc, () =>
            mode === 'ROTATE'
              ? run('transform.rotate', { value: 35 * deg, orient_axis: 'Z' })
              : run('transform.resize', { value: [2, 1, 0.5] }),
          );
          for (const i of [0, 1]) {
            const center = c.center(objs, ctx.state.cursorLocation) ?? objs[i].loc;
            const ref = blender(objs, i, mode, mat, center);
            const got = doc.getObject(ids[i])!;
            expect(maxDiff(got.location, ref.loc), `${'AB'[i]} location`).toBeLessThan(1e-12);
            expect(maxDiff(got.rotation_euler, ref.rot), `${'AB'[i]} rotation`).toBeLessThan(1e-12);
            expect(maxDiff(got.scale, ref.scale), `${'AB'[i]} scale`).toBeLessThan(1e-12);
            // about an object's own origin its location is not written
            const own = center.every((v, k) => v === objs[i].loc[k]);
            expect(writes['AB'[i]].includes('location'), `${'AB'[i]} location written`).toBe(!own);
          }
          expect(writes.C).toBeUndefined();
        });

    it('with Individual Origins a selected child of a selected parent also turns about its own origin (BA_TRANSFORM_CHILD)', () => {
      // Blender transforms such a child too when rotating about individual origins (it turns by the
      // rotation on top of following its parent, its location stays), and leaves it out otherwise
      const objs: Obj[] = [
        { loc: [1, 2, 3], rot: [10 * deg, 20 * deg, 30 * deg], scale: [2, 0.5, 1.5], parent: null },
        { loc: [2, 0, 0], rot: [0, 120 * deg, 0], scale: [1, -1, 1], parent: 0 },
      ];
      const mat = eulToMat3([0, 0, 30 * deg]);
      const t = setup();
      const ids = addChain(t.doc, objs);
      t.ctx.state.selectedIds = [ids[0], ids[1]];
      t.ctx.state.activeId = ids[1];
      t.ctx.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
      const writes = objectWrites(t.doc, () =>
        t.run('transform.rotate', { value: 30 * deg, orient_axis: 'Z' }),
      );
      expect(writes).toEqual({ O0: ['rotation_euler'], O1: ['rotation_euler'] });
      for (const i of [0, 1]) {
        const ref = blender(objs, i, 'ROTATE', mat, worldOf(objs, i).t);
        expect(maxDiff(t.doc.getObject(ids[i])!.rotation_euler, ref.rot), `O${i}`).toBeLessThan(1e-12);
      }
      expect(t.doc.getObject(ids[1])!.location).toEqual([2, 0, 0]);
      // Blender converts the child to its parent's space with the parent's matrix from before the
      // rotation, which matters for a child scaled to 0 on two axes (their rebuilt directions do not
      // turn with the parent)
      const flat: Obj[] = [objs[0], { ...objs[1], scale: [0, 1.5, 0] }];
      const f = setup();
      const fids = addChain(f.doc, flat);
      f.ctx.state.selectedIds = [fids[0], fids[1]];
      f.ctx.state.activeId = fids[1];
      f.ctx.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
      f.run('transform.rotate', { value: 30 * deg, orient_axis: 'Z' });
      const flatRef = blender(flat, 1, 'ROTATE', mat, worldOf(flat, 1).t);
      expect(maxDiff(f.doc.getObject(fids[1])!.rotation_euler, flatRef.rot)).toBeLessThan(1e-12);
      // an unrotated parent and child: the child turns by 30° in its parent and by 60° in the world
      const u = setup();
      const p = u.doc.addObject({ type: 'EMPTY', name: 'P' });
      const c = u.doc.addObject({ type: 'EMPTY', name: 'C', location: [2, 0, 0], parent: p });
      u.ctx.state.selectedIds = [p, c];
      u.ctx.state.activeId = p;
      u.ctx.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
      u.run('transform.rotate', { value: 30 * deg, orient_axis: 'Z' });
      expect(u.doc.getObject(c)!.rotation_euler[2] / deg).toBeCloseTo(30, 12);
      const w = u.doc.worldMatrix(c);
      expect(Math.atan2(w[1], w[0]) / deg).toBeCloseTo(60, 12);
      // a scale about individual origins, and a rotation about another pivot, leave the child out
      for (const [op, pivot] of [
        ['transform.resize', 'INDIVIDUAL_ORIGINS'],
        ['transform.rotate', 'MEDIAN_POINT'],
      ] as const) {
        const v = setup();
        const vids = addChain(v.doc, objs);
        v.ctx.state.selectedIds = [vids[0], vids[1]];
        v.ctx.state.activeId = vids[1];
        v.ctx.state.pivotPoint = pivot;
        const params =
          op === 'transform.resize' ? { value: [2, 1, 1] } : { value: 30 * deg, orient_axis: 'Z' };
        const w2 = objectWrites(v.doc, () => v.run(op, params));
        expect(w2.O1, `${op} about ${pivot}`).toBeUndefined();
      }
    });

    it('auto keying keys the objects a transform changes, not the selected children that follow them', () => {
      const t = setup();
      const p = t.doc.addObject({ type: 'EMPTY', name: 'P' });
      const c = t.doc.addObject({ type: 'EMPTY', name: 'C', location: [2, 0, 0], parent: p });
      t.ctx.state.selectedIds = [p, c];
      t.ctx.state.activeId = p;
      t.ctx.state.autoKeying = true;
      t.run('transform.translate', { value: [1, 0, 0] });
      expect(t.doc.listFCurves(p).length).toBe(9);
      expect(t.doc.listFCurves(c)).toEqual([]);
      // a rotation about individual origins turns (and keys) the child too
      t.ctx.state.pivotPoint = 'INDIVIDUAL_ORIGINS';
      t.ctx.state.frame = 5;
      t.run('transform.rotate', { value: 30 * deg, orient_axis: 'Z' });
      expect(t.doc.listFCurves(c).length).toBe(9);
    });

    it('with another, unselected object active, Active Element pivots about that object', () => {
      const { doc, ctx, run, objs, ids } = scene();
      ctx.state.pivotPoint = 'ACTIVE_ELEMENT';
      ctx.state.selectedIds = [ids[0]];
      ctx.state.activeId = ids[2];
      const writes = objectWrites(doc, () => run('transform.rotate', { value: 35 * deg, orient_axis: 'Z' }));
      expect(writes).toEqual({ A: ['location', 'rotation_euler'] });
      const ref = blender(objs, 0, 'ROTATE', eulToMat3([0, 0, 35 * deg]), objs[2].loc);
      expect(maxDiff(doc.getObject(ids[0])!.location, ref.loc)).toBeLessThan(1e-12);
    });
  });

  it('a rotation about the active object’s own axis (LOCAL orientation) turns the object about its own axis', () => {
    const { doc, ctx, run } = setup();
    const rotation: Vec3 = [10 * deg, 20 * deg, 30 * deg];
    const id = doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: rotation, scale: [1, 2, 3] });
    ctx.state.selectedIds = [id];
    ctx.state.activeId = id;
    run('transform.rotate', { value: 25 * deg, orient_axis: 'X', orient_type: 'LOCAL' });
    // about its own X axis: R(stored) · Rx
    const expected = multiply4(rotationFromEuler(rotation), rotationFromEuler([25 * deg, 0, 0]));
    const got = rotationFromEuler(doc.getObject(id)!.rotation_euler);
    expect(maxDiff(got, expected)).toBeLessThan(1e-12);
    expect(doc.getObject(id)!.scale).toEqual([1, 2, 3]);
  });

  it('auto keying keys the values a scale stores: the new scale and the rotation it keeps', () => {
    const { doc, ctx, run } = setup();
    const id = doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [0, 0, 30 * deg] });
    ctx.state.selectedIds = [id];
    ctx.state.activeId = id;
    ctx.state.autoKeying = true;
    ctx.state.frame = 5;
    run('transform.resize', { value: [2, 1, 1] });
    const key = (path: string, i: number) =>
      doc
        .getFCurve(fcurveKey({ target_type: 'object', target_id: id, path, index: i }))!
        .keyframes.map((k) => [k.frame, k.value]);
    [Math.sqrt(3.25), Math.sqrt(1.75), 1].forEach((v, i) => {
      expect(key('scale', i)).toEqual([[5, doc.getObject(id)!.scale[i]]]);
      expect(doc.getObject(id)!.scale[i]).toBeCloseTo(v, 12);
    });
    [0, 0, 30 * deg].forEach((v, i) => expect(key('rotation_euler', i)).toEqual([[5, v]]));
  });

  describe('a rotation by 0 or a whole turn, a scale by 1 and a move by 0 write nothing', () => {
    // their values come back from the matrices with the last digits changed: up to 4.8e-15 of
    // themselves for an unparented object, 5.0e-11 under a parent scaled [1000, 0.01, 1], whose
    // inverse amplifies rounding (transformTolerance)
    for (const parent of [null, [1000, 0.01, 1], [1e4, 1e-3, 1]] as (Vec3 | null)[])
      it(parent ? `under a parent scaled ${parent.join(', ')}` : 'without a parent', () => {
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
        for (let n = 0; n < 50; n++) {
          const { doc, ctx, run } = setup();
          const p = parent
            ? doc.addObject({
                type: 'EMPTY',
                name: 'P',
                rotation_euler: [rnd() * 6, rnd() * 3 - 1.5, rnd() * 6],
                scale: parent,
              })
            : null;
          const id = doc.addObject({
            type: 'EMPTY',
            name: 'A',
            location: [rnd(), rnd(), rnd()],
            rotation_euler: [rnd() * 6, rnd() * 3 - 1.5, rnd() * 6],
            scale: [0.5 + rnd(), 0.5 + rnd(), 0.5 + rnd()],
            parent: p,
          });
          ctx.state.selectedIds = [id];
          ctx.state.activeId = id;
          const writes = objectWrites(doc, () => {
            run('transform.rotate', { value: 0, orient_axis: 'Z' });
            run('transform.rotate', { value: 2 * Math.PI, orient_axis: 'X' });
            run('transform.resize', { value: [1, 1, 1] });
            run('transform.translate', { value: [0, 0, 0] });
          });
          expect(writes, `case ${n}`).toEqual({});
        }
      });

    it('except in gimbal lock, where a rotation by 0 rewrites the rotation with Z = 0, as Blender’s does', () => {
      // Y at ±90° leaves only X − Z (90°) or X + Z (−90°) defined: Blender's mat3_to_compatible_eulO
      // sets Z to 0 there, and so does the editor (only in exact gimbal lock, see matrixToStoredEuler)
      for (const [y, x] of [
        [90, -20],
        [-90, 40],
      ]) {
        const { doc, ctx, run } = setup();
        const id = doc.addObject({ type: 'EMPTY', name: 'A', rotation_euler: [10 * deg, y * deg, 30 * deg] });
        ctx.state.selectedIds = [id];
        ctx.state.activeId = id;
        const before = doc.worldMatrix(id);
        const writes = objectWrites(doc, () => run('transform.rotate', { value: 0, orient_axis: 'Z' }));
        expect(writes, `Y ${y}°`).toEqual({ A: ['rotation_euler'] });
        doc
          .getObject(id)!
          .rotation_euler.forEach((v, i) => expect(v / deg, `Y ${y}°`).toBeCloseTo([x, y, 0][i], 9));
        expect(maxDiff(doc.worldMatrix(id), before), `Y ${y}°`).toBeLessThan(1e-15);
      }
    });
  });
});

it('compose4 and the port agree on the world matrix of a chain', () => {
  // the port's world matrix (BKE_object_where_is_calc without parent inverse) is the editor's
  const objs: Obj[] = [
    { loc: [1, 2, 3], rot: [0.3, -0.7, 1.9], scale: [2, -0.5, 1.5], parent: null },
    { loc: [-1, 0.5, 2], rot: [1.1, 0.2, -2.5], scale: [0.7, 3, -1], parent: 0 },
  ];
  const { doc } = setup();
  const ids = addChain(doc, objs);
  const w = worldOf(objs, 1);
  const m = doc.worldMatrix(ids[1]);
  const flat = [...w.m[0], 0, ...w.m[1], 0, ...w.m[2], 0, ...w.t, 1];
  expect(maxDiff(m, flat)).toBeLessThan(1e-14);
  expect(
    maxDiff(compose4(objs[0].loc as Vec3, objs[0].rot as Vec3, objs[0].scale as Vec3), [
      ...worldOf(objs, 0).m[0],
      0,
      ...worldOf(objs, 0).m[1],
      0,
      ...worldOf(objs, 0).m[2],
      0,
      ...objs[0].loc,
      1,
    ]),
  ).toBeLessThan(1e-15);
});
