import type { EdgeAttr, MeshData } from './types';
import { edgeKey, parseEdgeKey } from './types';
import { checkMeshDecode, type MeshLayout } from './memory';

/*
 * Compact little-endian binary encoding of MeshData, used to store meshes inside the Yjs document
 * (one binary blob per mesh datablock, last-writer-wins) and in project files.
 *
 * Layout (version 1):
 *   magic "M3DM" | u16 version | u16 flags (1 = uvs, 2 = colors)
 *   u32 vertexCount | u32 faceCount | u32 cornerCount | u32 edgeAttrCount | u32 looseEdgePairCount
 *   f32[3V] positions | u32[F] faceSizes | u32[C] faceIndices | u16[F] faceMaterials | u8[F] faceSmooth
 *   f32[2C] uvs? | f32[4V] colors?
 *   edgeAttrs: (u32 a, u32 b, u8 flags(1 seam, 2 sharp), f32 crease) * E
 *   u32[2L] looseEdges
 */

const MAGIC = 0x4d44334d; // "M3DM" read as little-endian u32
const VERSION = 1;
const HEADER_SIZE = 4 + 2 + 2 + 4 * 5;

export function encodeMesh(m: MeshData): Uint8Array {
  const V = m.positions.length / 3;
  const F = m.faces.length;
  let C = 0;
  for (const f of m.faces) C += f.length;
  const edgeKeys = Object.keys(m.edgeAttrs);
  const E = edgeKeys.length;
  const L = m.looseEdges.length / 2;
  const hasUV = !!m.uvs;
  const hasColors = !!m.colors && m.colors.length === V * 4;
  const size =
    HEADER_SIZE +
    V * 12 +
    F * 4 +
    C * 4 +
    F * 2 +
    F +
    (hasUV ? C * 8 : 0) +
    (hasColors ? V * 16 : 0) +
    E * 13 +
    L * 8;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  let o = 0;
  dv.setUint32(o, MAGIC, true);
  o += 4;
  dv.setUint16(o, VERSION, true);
  o += 2;
  dv.setUint16(o, (hasUV ? 1 : 0) | (hasColors ? 2 : 0), true);
  o += 2;
  for (const n of [V, F, C, E, L]) {
    dv.setUint32(o, n, true);
    o += 4;
  }
  for (let i = 0; i < V * 3; i++, o += 4) dv.setFloat32(o, m.positions[i], true);
  for (let f = 0; f < F; f++, o += 4) dv.setUint32(o, m.faces[f].length, true);
  for (const face of m.faces)
    for (const v of face) {
      dv.setUint32(o, v, true);
      o += 4;
    }
  for (let f = 0; f < F; f++, o += 2) dv.setUint16(o, m.faceMaterials[f] ?? 0, true);
  for (let f = 0; f < F; f++, o += 1) dv.setUint8(o, m.faceSmooth[f] ? 1 : 0);
  if (hasUV && m.uvs) {
    for (let f = 0; f < F; f++) {
      const uv = m.uvs[f];
      const n = m.faces[f].length * 2;
      for (let i = 0; i < n; i++, o += 4) dv.setFloat32(o, uv?.[i] ?? 0, true);
    }
  }
  if (hasColors && m.colors) for (let i = 0; i < V * 4; i++, o += 4) dv.setFloat32(o, m.colors[i], true);
  for (const k of edgeKeys) {
    const [a, b] = parseEdgeKey(k);
    const attr = m.edgeAttrs[k];
    dv.setUint32(o, a, true);
    dv.setUint32(o + 4, b, true);
    dv.setUint8(o + 8, (attr.seam ? 1 : 0) | (attr.sharp ? 2 : 0));
    dv.setFloat32(o + 9, attr.crease ?? 0, true);
    o += 13;
  }
  for (let i = 0; i < L * 2; i++, o += 4) dv.setUint32(o, m.looseEdges[i], true);
  return new Uint8Array(buf);
}

export class MeshCodecError extends Error {}

export function decodeMesh(bytes: Uint8Array): MeshData {
  if (bytes.byteLength < HEADER_SIZE) throw new MeshCodecError('mesh blob too small');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  if (dv.getUint32(o, true) !== MAGIC) throw new MeshCodecError('bad mesh magic');
  o += 4;
  const version = dv.getUint16(o, true);
  o += 2;
  if (version !== VERSION) throw new MeshCodecError(`unsupported mesh version ${version}`);
  const flags = dv.getUint16(o, true);
  o += 2;
  const [V, F, C, E, L] = [0, 0, 0, 0, 0].map(() => {
    const n = dv.getUint32(o, true);
    o += 4;
    return n;
  });
  // a host that keeps its heap in bounds (the server) may refuse a mesh too large for it (memory.ts)
  checkMeshDecode({
    vertices: V,
    faces: F,
    corners: C,
    uvs: (flags & 1) !== 0,
    colors: (flags & 2) !== 0,
    edgeAttrs: E,
    looseEdges: L,
  });
  const positions = new Array<number>(V * 3);
  for (let i = 0; i < V * 3; i++, o += 4) positions[i] = dv.getFloat32(o, true);
  const sizes = new Array<number>(F);
  for (let f = 0; f < F; f++, o += 4) sizes[f] = dv.getUint32(o, true);
  const faces: number[][] = new Array(F);
  for (let f = 0; f < F; f++) {
    const n = sizes[f];
    const face = new Array<number>(n);
    for (let i = 0; i < n; i++, o += 4) face[i] = dv.getUint32(o, true);
    faces[f] = face;
  }
  const faceMaterials = new Array<number>(F);
  for (let f = 0; f < F; f++, o += 2) faceMaterials[f] = dv.getUint16(o, true);
  const faceSmooth = new Array<boolean>(F);
  for (let f = 0; f < F; f++, o += 1) faceSmooth[f] = dv.getUint8(o) === 1;
  let uvs: number[][] | null = null;
  if (flags & 1) {
    uvs = new Array(F);
    for (let f = 0; f < F; f++) {
      const n = sizes[f] * 2;
      const uv = new Array<number>(n);
      for (let i = 0; i < n; i++, o += 4) uv[i] = dv.getFloat32(o, true);
      uvs[f] = uv;
    }
  }
  let colors: number[] | null = null;
  if (flags & 2) {
    colors = new Array<number>(V * 4);
    for (let i = 0; i < V * 4; i++, o += 4) colors[i] = dv.getFloat32(o, true);
  }
  const edgeAttrs: Record<string, EdgeAttr> = {};
  for (let i = 0; i < E; i++) {
    const a = dv.getUint32(o, true);
    const b = dv.getUint32(o + 4, true);
    const fl = dv.getUint8(o + 8);
    const crease = dv.getFloat32(o + 9, true);
    o += 13;
    const attr: EdgeAttr = {};
    if (fl & 1) attr.seam = true;
    if (fl & 2) attr.sharp = true;
    if (crease) attr.crease = crease;
    edgeAttrs[edgeKey(a, b)] = attr;
  }
  const looseEdges = new Array<number>(L * 2);
  for (let i = 0; i < L * 2; i++, o += 4) looseEdges[i] = dv.getUint32(o, true);
  if (C !== sizes.reduce((s, n) => s + n, 0)) throw new MeshCodecError('corrupt corner count');
  return { positions, faces, faceMaterials, faceSmooth, uvs, colors, edgeAttrs, looseEdges };
}

/** Reads only the header counts (cheap, for statistics). */
export function peekMeshCounts(bytes: Uint8Array): { vertices: number; faces: number; corners: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { vertices: dv.getUint32(8, true), faces: dv.getUint32(12, true), corners: dv.getUint32(16, true) };
}

/** Reads only the header: the counts and layers (cheap, for memory estimates; see memory.ts). */
export function peekMeshLayout(bytes: Uint8Array): MeshLayout {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = dv.getUint16(6, true);
  return {
    vertices: dv.getUint32(8, true),
    faces: dv.getUint32(12, true),
    corners: dv.getUint32(16, true),
    uvs: (flags & 1) !== 0,
    colors: (flags & 2) !== 0,
    edgeAttrs: dv.getUint32(20, true),
    looseEdges: dv.getUint32(24, true),
  };
}
