/*
 * Test-only glTF 2.0 tooling: a GLB/glTF parser, a structural validator (the checks the Khronos
 * validator makes that matter for our exporter: buffer views, accessor bounds and alignment, vertex
 * attribute counts, POSITION min/max, morph targets, skins, animation samplers, node hierarchy) and
 * a small evaluator of node transforms, morph targets and skins at an animation time, to compare an
 * exported file with the editor's evaluated scene.
 */

import type { Mat4 } from '../src/math/types';

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
export const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = any;

/** Parses a .glb (or a .gltf with an embedded data URI buffer). */
export function parseGltf(data: Uint8Array): { json: Json; bin: Uint8Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 12 && dv.getUint32(0, true) === GLB_MAGIC) {
    const jsonLen = dv.getUint32(12, true);
    if (dv.getUint32(16, true) !== CHUNK_JSON) throw new Error('GLB: first chunk is not JSON');
    const json = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + jsonLen)));
    let bin = new Uint8Array(0);
    if (20 + jsonLen < data.length) {
      const binLen = dv.getUint32(20 + jsonLen, true);
      if (dv.getUint32(24 + jsonLen, true) !== CHUNK_BIN) throw new Error('GLB: second chunk is not BIN');
      bin = data.slice(28 + jsonLen, 28 + jsonLen + binLen);
    }
    return { json, bin };
  }
  const json = JSON.parse(new TextDecoder().decode(data));
  const uri: string | undefined = json.buffers?.[0]?.uri;
  const bin = uri ? Uint8Array.from(atob(uri.slice(uri.indexOf(',') + 1)), (c) => c.charCodeAt(0)) : new Uint8Array(0);
  return { json, bin };
}

/** Accessor contents as numbers (dense, non-normalized). */
export function readAccessor(json: Json, bin: Uint8Array, index: number): number[] {
  const acc = json.accessors[index];
  const bv = json.bufferViews[acc.bufferView];
  const start = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const n = acc.count * COMPONENTS[acc.type];
  const size = COMPONENT_SIZE[acc.componentType];
  const bytes = bin.slice(start, start + n * size);
  switch (acc.componentType) {
    case 5126:
      return [...new Float32Array(bytes.buffer)];
    case 5125:
      return [...new Uint32Array(bytes.buffer)];
    case 5123:
      return [...new Uint16Array(bytes.buffer)];
    case 5121:
      return [...bytes];
    default:
      throw new Error(`componentType ${acc.componentType}`);
  }
}

/** Structural problems of a glTF (empty when valid). */
export function gltfProblems(json: Json, bin: Uint8Array): string[] {
  const out: string[] = [];
  const bad = (msg: string) => out.push(msg);
  if (json.asset?.version !== '2.0') bad('asset.version is not 2.0');
  const buffer = json.buffers?.[0];
  const bufLen = buffer?.byteLength ?? 0;
  if (buffer && bufLen > bin.length) bad(`buffer byteLength ${bufLen} > binary ${bin.length}`);
  (json.bufferViews ?? []).forEach((bv: Json, i: number) => {
    if (bv.buffer !== 0) bad(`bufferView ${i}: buffer ${bv.buffer}`);
    if ((bv.byteOffset ?? 0) + bv.byteLength > bufLen) bad(`bufferView ${i} exceeds the buffer`);
    if ((bv.byteOffset ?? 0) % 4) bad(`bufferView ${i} not 4-byte aligned`);
  });
  const accessors = json.accessors ?? [];
  accessors.forEach((acc: Json, i: number) => {
    const size = COMPONENT_SIZE[acc.componentType];
    const comps = COMPONENTS[acc.type];
    if (!size || !comps) return bad(`accessor ${i}: bad componentType/type`);
    if (!(acc.count >= 1)) bad(`accessor ${i}: count ${acc.count}`);
    const bv = json.bufferViews?.[acc.bufferView];
    if (!bv) return bad(`accessor ${i}: bufferView ${acc.bufferView} missing`);
    const offset = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    if (offset % size) bad(`accessor ${i}: misaligned`);
    const stride = bv.byteStride ?? size * comps;
    const len = (acc.byteOffset ?? 0) + stride * (acc.count - 1) + size * comps;
    if (len > bv.byteLength) bad(`accessor ${i}: exceeds its bufferView (${len} > ${bv.byteLength})`);
    if (acc.componentType === 5126) {
      const v = readAccessor(json, bin, i);
      if (!v.every(Number.isFinite)) bad(`accessor ${i}: non-finite values`);
      if (acc.min || acc.max)
        for (let k = 0; k < v.length; k++) {
          const c = k % comps;
          if (acc.min && v[k] < acc.min[c] - 1e-6) bad(`accessor ${i}: value below min`);
          if (acc.max && v[k] > acc.max[c] + 1e-6) bad(`accessor ${i}: value above max`);
        }
    }
  });
  const nodes = json.nodes ?? [];
  // hierarchy: each node has at most one parent, no cycles, scene roots are roots
  const parentOf = new Map<number, number>();
  nodes.forEach((n: Json, i: number) => {
    for (const c of n.children ?? []) {
      if (c < 0 || c >= nodes.length) bad(`node ${i}: child ${c} missing`);
      if (parentOf.has(c)) bad(`node ${c} has two parents`);
      parentOf.set(c, i);
    }
    if (n.matrix && (n.translation || n.rotation || n.scale)) bad(`node ${i}: matrix and TRS`);
    if (n.rotation && Math.abs(Math.hypot(...n.rotation) - 1) > 1e-5) bad(`node ${i}: rotation not unit`);
  });
  nodes.forEach((_: Json, i: number) => {
    const seen = new Set<number>();
    for (let p: number | undefined = i; p !== undefined; p = parentOf.get(p)) {
      if (seen.has(p)) {
        bad(`node ${i}: parent cycle`);
        break;
      }
      seen.add(p);
    }
  });
  for (const r of json.scenes?.[json.scene ?? 0]?.nodes ?? []) if (parentOf.has(r)) bad(`scene root ${r} has a parent`);
  // meshes
  (json.meshes ?? []).forEach((mesh: Json, mi: number) => {
    const targetCounts = new Set<number>(mesh.primitives.map((p: Json) => (p.targets ?? []).length));
    if (targetCounts.size > 1) bad(`mesh ${mi}: primitives with different morph target counts`);
    const nTargets = mesh.primitives[0]?.targets?.length ?? 0;
    if (mesh.weights && mesh.weights.length !== nTargets) bad(`mesh ${mi}: weights length ≠ targets`);
    for (const prim of mesh.primitives) {
      const pos = accessors[prim.attributes.POSITION];
      if (!pos) {
        bad(`mesh ${mi}: no POSITION`);
        continue;
      }
      if (!pos.min || !pos.max) bad(`mesh ${mi}: POSITION without min/max`);
      for (const [name, a] of Object.entries(prim.attributes) as [string, number][])
        if (accessors[a]?.count !== pos.count) bad(`mesh ${mi}: ${name} count ≠ POSITION count`);
      if (prim.indices !== undefined) {
        const idx = readAccessor(json, bin, prim.indices);
        if (Math.max(...idx) >= pos.count) bad(`mesh ${mi}: index out of range`);
        if ((prim.mode ?? 4) === 4 && idx.length % 3) bad(`mesh ${mi}: triangle indices not a multiple of 3`);
      }
      for (const t of prim.targets ?? []) {
        for (const [name, a] of Object.entries(t) as [string, number][])
          if (accessors[a]?.count !== pos.count) bad(`mesh ${mi}: target ${name} count ≠ POSITION count`);
        if (t.POSITION !== undefined && (!accessors[t.POSITION].min || !accessors[t.POSITION].max))
          bad(`mesh ${mi}: target POSITION without min/max`);
      }
      if (prim.material !== undefined && !json.materials?.[prim.material]) bad(`mesh ${mi}: material missing`);
    }
  });
  // skins
  (json.skins ?? []).forEach((skin: Json, si: number) => {
    for (const j of skin.joints) if (!nodes[j]) bad(`skin ${si}: joint ${j} missing`);
    if (skin.inverseBindMatrices !== undefined) {
      const acc = accessors[skin.inverseBindMatrices];
      if (acc.type !== 'MAT4' || acc.count !== skin.joints.length) bad(`skin ${si}: inverse bind matrices`);
    }
  });
  nodes.forEach((n: Json, i: number) => {
    if (n.skin === undefined) return;
    const skin = json.skins?.[n.skin];
    if (!skin) return bad(`node ${i}: skin missing`);
    if (n.mesh === undefined) bad(`node ${i}: skin without mesh`);
    for (const prim of json.meshes[n.mesh]?.primitives ?? []) {
      if (prim.attributes.JOINTS_0 === undefined || prim.attributes.WEIGHTS_0 === undefined) {
        bad(`node ${i}: skinned primitive without JOINTS_0/WEIGHTS_0`);
        continue;
      }
      const J = readAccessor(json, bin, prim.attributes.JOINTS_0);
      const W = readAccessor(json, bin, prim.attributes.WEIGHTS_0);
      for (let v = 0; v < W.length; v += 4) {
        const s = W[v] + W[v + 1] + W[v + 2] + W[v + 3];
        if (Math.abs(s - 1) > 2e-3) {
          bad(`node ${i}: weights of vertex ${v / 4} sum to ${s}`);
          break;
        }
        for (let k = 0; k < 4; k++)
          if (W[v + k] > 0 && J[v + k] >= skin.joints.length) {
            bad(`node ${i}: joint index out of range`);
            break;
          }
      }
    }
  });
  // animations
  (json.animations ?? []).forEach((anim: Json, ai: number) => {
    for (const s of anim.samplers) {
      const input = accessors[s.input];
      const output = accessors[s.output];
      if (!input || !output) {
        bad(`animation ${ai}: sampler accessor missing`);
        continue;
      }
      if (input.type !== 'SCALAR' || !input.min || !input.max) bad(`animation ${ai}: input without min/max`);
      const t = readAccessor(json, bin, s.input);
      for (let k = 1; k < t.length; k++) if (!(t[k] > t[k - 1])) bad(`animation ${ai}: times not increasing`);
    }
    for (const ch of anim.channels) {
      const s = anim.samplers[ch.sampler];
      if (!s) {
        bad(`animation ${ai}: channel sampler missing`);
        continue;
      }
      const node = nodes[ch.target.node];
      if (!node) bad(`animation ${ai}: channel node missing`);
      const input = accessors[s.input];
      const output = accessors[s.output];
      const path = ch.target.path;
      const type = { translation: 'VEC3', rotation: 'VEC4', scale: 'VEC3', weights: 'SCALAR' }[path as string];
      if (!type) bad(`animation ${ai}: path ${path}`);
      if (output.type !== type) bad(`animation ${ai}: ${path} output type ${output.type}`);
      if (path === 'weights') {
        const targets = json.meshes?.[node?.mesh]?.primitives?.[0]?.targets?.length ?? 0;
        if (!targets) bad(`animation ${ai}: weights channel of a node without morph targets`);
        if (output.count !== input.count * targets) bad(`animation ${ai}: weights output count`);
      } else if (output.count !== input.count) bad(`animation ${ai}: ${path} output count ≠ input count`);
      if (node?.matrix) bad(`animation ${ai}: animated node with a matrix`);
    }
  });
  return out;
}

// ------------------------------------------------------------------ evaluation

const I4: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Readonly<number[]>, b: Readonly<number[]>): Mat4 {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function trs(t: number[], q: number[], s: number[]): Mat4 {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + w * z) * s[0],
    2 * (x * z - w * y) * s[0],
    0,
    2 * (x * y - w * z) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + w * x) * s[1],
    0,
    2 * (x * z + w * y) * s[2],
    2 * (y * z - w * x) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
}

/** A sampled animation channel value at time `t` (LINEAR; rotations normalized lerp). */
function sample(json: Json, bin: Uint8Array, anim: Json, ch: Json, t: number, n: number): number[] {
  const s = anim.samplers[ch.sampler];
  const times = readAccessor(json, bin, s.input);
  const values = readAccessor(json, bin, s.output);
  let k = 0;
  while (k < times.length - 1 && times[k + 1] <= t) k++;
  const k1 = Math.min(times.length - 1, k + 1);
  const u = k1 === k || t <= times[k] ? 0 : Math.min(1, (t - times[k]) / (times[k1] - times[k]));
  const a = values.slice(k * n, k * n + n);
  const b = values.slice(k1 * n, k1 * n + n);
  const v = a.map((x, i) => x + (b[i] - x) * u);
  if (ch.target.path === 'rotation') {
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l);
  }
  return v;
}

/** The scene of a glTF at an animation time: world matrices and morph weights per node. */
export function gltfPose(json: Json, bin: Uint8Array, t = 0): { world: Mat4[]; weights: (number[] | null)[] } {
  const nodes: Json[] = json.nodes ?? [];
  const local: Mat4[] = nodes.map((n) => (n.matrix ? [...n.matrix] : trs(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1])));
  const weights: (number[] | null)[] = nodes.map((n) =>
    n.mesh !== undefined ? (n.weights ?? json.meshes[n.mesh].weights ?? null) : null,
  );
  const anim = json.animations?.[0];
  if (anim) {
    const parts = nodes.map((n) => ({
      t: n.translation ?? [0, 0, 0],
      r: n.rotation ?? [0, 0, 0, 1],
      s: n.scale ?? [1, 1, 1],
      animated: false,
    }));
    for (const ch of anim.channels) {
      const p = parts[ch.target.node];
      const path = ch.target.path;
      if (path === 'weights') {
        const count = json.meshes[nodes[ch.target.node].mesh].primitives[0].targets.length;
        weights[ch.target.node] = sample(json, bin, anim, ch, t, count);
        continue;
      }
      p.animated = true;
      if (path === 'translation') p.t = sample(json, bin, anim, ch, t, 3);
      else if (path === 'rotation') p.r = sample(json, bin, anim, ch, t, 4);
      else if (path === 'scale') p.s = sample(json, bin, anim, ch, t, 3);
    }
    parts.forEach((p, i) => {
      if (p.animated) local[i] = trs(p.t, p.r, p.s);
    });
  }
  const parentOf = new Map<number, number>();
  nodes.forEach((n, i) => (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));
  const world: Mat4[] = [];
  const get = (i: number): Mat4 => {
    if (world[i]) return world[i];
    const p = parentOf.get(i);
    return (world[i] = p === undefined ? local[i] : mul(get(p), local[i]));
  };
  nodes.forEach((_, i) => get(i));
  return { world, weights };
}

/** World-space (Y-up) vertex positions of a mesh node's first primitive at a pose. */
export function gltfNodePositions(json: Json, bin: Uint8Array, node: number, pose = gltfPose(json, bin)): number[] {
  const n = json.nodes[node];
  const prim = json.meshes[n.mesh].primitives[0];
  const P = readAccessor(json, bin, prim.attributes.POSITION);
  const weights = pose.weights[node];
  if (prim.targets && weights)
    prim.targets.forEach((tg: Json, k: number) => {
      if (!weights[k]) return;
      const d = readAccessor(json, bin, tg.POSITION);
      for (let i = 0; i < P.length; i++) P[i] += weights[k] * d[i];
    });
  const out = new Array<number>(P.length);
  if (n.skin !== undefined) {
    const skin = json.skins[n.skin];
    const ibm = readAccessor(json, bin, skin.inverseBindMatrices);
    const jm = skin.joints.map((j: number, k: number) => mul(pose.world[j], ibm.slice(k * 16, k * 16 + 16)));
    const J = readAccessor(json, bin, prim.attributes.JOINTS_0);
    const W = readAccessor(json, bin, prim.attributes.WEIGHTS_0);
    for (let v = 0; v < P.length / 3; v++) {
      const m = new Array<number>(16).fill(0);
      for (let k = 0; k < 4; k++) {
        const wgt = W[v * 4 + k];
        if (!wgt) continue;
        const j = jm[J[v * 4 + k]];
        for (let e = 0; e < 16; e++) m[e] += wgt * j[e];
      }
      xform(m, P, v, out);
    }
    return out;
  }
  const m = pose.world[node] ?? I4;
  for (let v = 0; v < P.length / 3; v++) xform(m, P, v, out);
  return out;
}

function xform(m: Readonly<number[]>, P: readonly number[], v: number, out: number[]): void {
  const x = P[v * 3];
  const y = P[v * 3 + 1];
  const z = P[v * 3 + 2];
  out[v * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[v * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[v * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
}

/** Z-up (editor) world position → glTF Y-up. */
export const toYUp = (p: readonly number[]): number[] => [p[0], p[2], -p[1]];

/** Index of the node named `name` (throws when missing). */
export function nodeIndex(json: Json, name: string): number {
  const i = (json.nodes ?? []).findIndex((n: Json) => n.name === name);
  if (i < 0) throw new Error(`node '${name}' not found`);
  return i;
}
