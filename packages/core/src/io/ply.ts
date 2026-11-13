import type { SceneDoc } from '../doc/scene-doc';
import { createMesh, edgeKey } from '../mesh/types';
import { linearToSrgb, srgbToLinear } from '../render/color';
import { ByteWriter, latin1 } from './bytes';
import { bakeWorldMesh, cleanLoop, collectExport } from './common';
import type { ExportOptions, ExportResult, ImportOptions, ImportResult } from './types';

/*
 * Stanford PLY. Z-up like the editor (no axis conversion). Import reads `ascii`,
 * `binary_little_endian` and `binary_big_endian` files: vertex positions, optional normals (faces
 * are then smooth-shaded), texture coordinates (s/t, u/v, texture_u/texture_v, …), colors
 * (red/green/blue/alpha as integers or floats, treated as sRGB like Blender) and polygon lists
 * (`vertex_indices`/`vertex_index`, optional per-corner `texcoord`). Export writes one binary
 * little-endian file with all exported meshes in world space (vertices split along UV seams).
 */

type PlyType = 'int8' | 'uint8' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';

const TYPES: Record<string, PlyType> = {
  char: 'int8',
  int8: 'int8',
  uchar: 'uint8',
  uint8: 'uint8',
  short: 'int16',
  int16: 'int16',
  ushort: 'uint16',
  uint16: 'uint16',
  int: 'int32',
  int32: 'int32',
  uint: 'uint32',
  uint32: 'uint32',
  float: 'float32',
  float32: 'float32',
  double: 'float64',
  float64: 'float64',
};

const SIZE: Record<PlyType, number> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  int32: 4,
  uint32: 4,
  float32: 4,
  float64: 8,
};

interface PlyProp {
  name: string;
  type: PlyType;
  /** Count type for list properties. */
  countType?: PlyType;
}

interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

interface ElementData {
  scalars: Map<string, Float64Array>;
  lists: Map<string, { offsets: Uint32Array; values: number[] }>;
}

function parseHeader(data: Uint8Array): { format: string; elements: PlyElement[]; bodyStart: number } {
  const probe = latin1(data, 0, Math.min(data.length, 65536));
  if (!probe.startsWith('ply')) throw new Error('Not a PLY file (missing "ply" magic)');
  const m = /end_header[ \t]*\r?\n/.exec(probe);
  if (!m) throw new Error('PLY header has no end_header');
  const header = probe.slice(0, m.index);
  let format = '';
  const elements: PlyElement[] = [];
  for (const raw of header.split(/\r?\n/)) {
    const t = raw.trim().split(/\s+/);
    switch (t[0]) {
      case 'format':
        format = t[1];
        if (t[2] && t[2] !== '1.0') throw new Error(`Unsupported PLY version ${t[2]}`);
        break;
      case 'element':
        elements.push({ name: t[1], count: Math.max(0, parseInt(t[2], 10) || 0), props: [] });
        break;
      case 'property': {
        const el = elements[elements.length - 1];
        if (!el) throw new Error('PLY property before any element');
        if (t[1] === 'list') {
          const countType = TYPES[t[2]];
          const type = TYPES[t[3]];
          if (!countType || !type) throw new Error(`Unknown PLY list type '${t[2]} ${t[3]}'`);
          el.props.push({ name: t[4], type, countType });
        } else {
          const type = TYPES[t[1]];
          if (!type) throw new Error(`Unknown PLY property type '${t[1]}'`);
          el.props.push({ name: t[2], type });
        }
        break;
      }
      default:
        break; // ply, comment, obj_info
    }
  }
  if (format !== 'ascii' && format !== 'binary_little_endian' && format !== 'binary_big_endian')
    throw new Error(`Unsupported PLY format '${format}'`);
  return { format, elements, bodyStart: m.index + m[0].length };
}

function newElementData(el: PlyElement): ElementData {
  const d: ElementData = { scalars: new Map(), lists: new Map() };
  for (const p of el.props) {
    if (p.countType) d.lists.set(p.name, { offsets: new Uint32Array(el.count + 1), values: [] });
    else d.scalars.set(p.name, new Float64Array(el.count));
  }
  return d;
}

function readBinary(
  data: Uint8Array,
  start: number,
  elements: PlyElement[],
  le: boolean,
): Map<string, ElementData> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = start;
  const read = (type: PlyType): number => {
    let v: number;
    switch (type) {
      case 'int8':
        v = dv.getInt8(o);
        break;
      case 'uint8':
        v = dv.getUint8(o);
        break;
      case 'int16':
        v = dv.getInt16(o, le);
        break;
      case 'uint16':
        v = dv.getUint16(o, le);
        break;
      case 'int32':
        v = dv.getInt32(o, le);
        break;
      case 'uint32':
        v = dv.getUint32(o, le);
        break;
      case 'float32':
        v = dv.getFloat32(o, le);
        break;
      case 'float64':
        v = dv.getFloat64(o, le);
        break;
    }
    o += SIZE[type];
    return v;
  };
  const out = new Map<string, ElementData>();
  for (const el of elements) {
    const d = newElementData(el);
    const cols = el.props.map((p) => (p.countType ? d.lists.get(p.name)! : d.scalars.get(p.name)!));
    for (let i = 0; i < el.count; i++) {
      for (let k = 0; k < el.props.length; k++) {
        const p = el.props[k];
        if (p.countType) {
          const list = cols[k] as { offsets: Uint32Array; values: number[] };
          const n = read(p.countType);
          if (o + n * SIZE[p.type] > data.length) throw new Error('PLY data is truncated');
          for (let j = 0; j < n; j++) list.values.push(read(p.type));
          list.offsets[i + 1] = list.values.length;
        } else {
          if (o + SIZE[p.type] > data.length) throw new Error('PLY data is truncated');
          (cols[k] as Float64Array)[i] = read(p.type);
        }
      }
    }
    out.set(el.name, d);
  }
  return out;
}

function readAscii(data: Uint8Array, start: number, elements: PlyElement[]): Map<string, ElementData> {
  const text = latin1(data, start);
  let pos = 0;
  const len = text.length;
  const next = (): number => {
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
      pos++;
    }
    if (pos >= len) throw new Error('PLY data is truncated');
    const s = pos;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      pos++;
    }
    const v = Number(text.slice(s, pos));
    return Number.isFinite(v) ? v : 0;
  };
  const out = new Map<string, ElementData>();
  for (const el of elements) {
    const d = newElementData(el);
    const cols = el.props.map((p) => (p.countType ? d.lists.get(p.name)! : d.scalars.get(p.name)!));
    for (let i = 0; i < el.count; i++) {
      for (let k = 0; k < el.props.length; k++) {
        if (el.props[k].countType) {
          const list = cols[k] as { offsets: Uint32Array; values: number[] };
          const n = next();
          for (let j = 0; j < n; j++) list.values.push(next());
          list.offsets[i + 1] = list.values.length;
        } else (cols[k] as Float64Array)[i] = next();
      }
    }
    out.set(el.name, d);
  }
  return out;
}

function pick<T>(m: Map<string, T>, names: string[]): T | undefined {
  for (const n of names) {
    const v = m.get(n);
    if (v) return v;
  }
  return undefined;
}

/** Scale of integer color channels (1 for floats). */
function colorScale(el: PlyElement, name: string): number {
  const t = el.props.find((p) => p.name === name)?.type;
  if (t === 'uint8' || t === 'int8') return 1 / 255;
  if (t === 'uint16' || t === 'int16') return 1 / 65535;
  return 1;
}

export function importPLY(doc: SceneDoc, data: Uint8Array, opts: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const { format, elements, bodyStart } = parseHeader(data);
  const parsed =
    format === 'ascii'
      ? readAscii(data, bodyStart, elements)
      : readBinary(data, bodyStart, elements, format === 'binary_little_endian');
  const vEl = elements.find((e) => e.name === 'vertex');
  const v = parsed.get('vertex');
  if (!vEl || !v || !v.scalars.has('x') || !v.scalars.has('y') || !v.scalars.has('z'))
    throw new Error('PLY file has no vertex positions');
  const nv = vEl.count;
  if (nv === 0) {
    warnings.push('PLY file contains no vertices');
    return { objects: [], warnings };
  }
  const X = v.scalars.get('x')!;
  const Y = v.scalars.get('y')!;
  const Z = v.scalars.get('z')!;
  const positions = new Array<number>(nv * 3);
  for (let i = 0; i < nv; i++) {
    positions[i * 3] = X[i];
    positions[i * 3 + 1] = Y[i];
    positions[i * 3 + 2] = Z[i];
  }
  const hasNormals = v.scalars.has('nx') && v.scalars.has('ny') && v.scalars.has('nz');
  const uName = ['s', 'u', 'texture_u', 'texture_s'].find((n) => v.scalars.has(n));
  const vName = ['t', 'v', 'texture_v', 'texture_t'].find((n) => v.scalars.has(n));
  const U = uName && vName ? v.scalars.get(uName)! : null;
  const V = uName && vName ? v.scalars.get(vName)! : null;
  const rName = ['red', 'r', 'diffuse_red'].find((n) => v.scalars.has(n));
  const gName = ['green', 'g', 'diffuse_green'].find((n) => v.scalars.has(n));
  const bName = ['blue', 'b', 'diffuse_blue'].find((n) => v.scalars.has(n));
  const aName = ['alpha', 'a', 'diffuse_alpha'].find((n) => v.scalars.has(n));
  let colors: number[] | null = null;
  if (rName && gName && bName) {
    colors = new Array<number>(nv * 4);
    const chans = [rName, gName, bName].map((n) => ({ col: v.scalars.get(n)!, s: colorScale(vEl, n) }));
    const A = aName ? v.scalars.get(aName)! : null;
    const as = aName ? colorScale(vEl, aName) : 1;
    for (let i = 0; i < nv; i++) {
      for (let k = 0; k < 3; k++)
        colors[i * 4 + k] = srgbToLinear(Math.min(1, Math.max(0, chans[k].col[i] * chans[k].s)));
      colors[i * 4 + 3] = A ? Math.min(1, Math.max(0, A[i] * as)) : 1;
    }
  }
  // faces
  const fEl = parsed.get('face');
  const indexList = fEl ? pick(fEl.lists, ['vertex_indices', 'vertex_index']) : undefined;
  const texList = fEl ? pick(fEl.lists, ['texcoord', 'texcoords']) : undefined;
  const faces: number[][] = [];
  const uvs: number[][] = [];
  let skipped = 0;
  if (indexList) {
    const count = indexList.offsets.length - 1;
    for (let f = 0; f < count; f++) {
      const s = indexList.offsets[f];
      const e = indexList.offsets[f + 1];
      const loop = indexList.values.slice(s, e);
      if (loop.some((i) => !(i >= 0 && i < nv && Number.isInteger(i)))) {
        skipped++;
        continue;
      }
      const clean = loop.length === new Set(loop).size && loop.length >= 3 ? loop : cleanLoop(loop);
      if (!clean) {
        skipped++;
        continue;
      }
      faces.push(clean);
      if (
        texList &&
        texList.offsets[f + 1] - texList.offsets[f] === loop.length * 2 &&
        clean.length === loop.length
      )
        uvs.push(texList.values.slice(texList.offsets[f], texList.offsets[f + 1]));
      else if (U && V) uvs.push(clean.flatMap((i) => [U[i], V[i]]));
      else uvs.push(new Array<number>(clean.length * 2).fill(0));
    }
  }
  if (skipped) warnings.push(`${skipped} invalid or degenerate face(s) skipped`);
  // loose edges
  const looseEdges: number[] = [];
  const eEl = parsed.get('edge');
  if (eEl && eEl.scalars.has('vertex1') && eEl.scalars.has('vertex2')) {
    const faceEdges = new Set<string>();
    for (const face of faces)
      for (let i = 0; i < face.length; i++) faceEdges.add(edgeKey(face[i], face[(i + 1) % face.length]));
    const A = eEl.scalars.get('vertex1')!;
    const B = eEl.scalars.get('vertex2')!;
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      const b = B[i];
      if (a === b || !(a >= 0 && a < nv) || !(b >= 0 && b < nv)) continue;
      const k = edgeKey(a, b);
      if (faceEdges.has(k)) continue;
      faceEdges.add(k);
      looseEdges.push(a, b);
    }
  }
  const hasUV = !!(texList || (U && V));
  const mesh = createMesh({
    positions,
    faces,
    faceSmooth: faces.map(() => hasNormals),
    uvs: hasUV && faces.length ? uvs : null,
    colors,
    looseEdges,
  });
  const name = opts.name ?? 'PLY';
  const offset = opts.location ?? [0, 0, 0];
  return doc.transact(() => {
    const meshId = doc.addMesh(name, mesh);
    const id = doc.addObject({
      type: 'MESH',
      name,
      data: meshId,
      location: [offset[0], offset[1], offset[2]],
    });
    return { objects: [id], warnings };
  });
}

export function exportPLY(doc: SceneDoc, opts: ExportOptions = {}): ExportResult {
  const { items } = collectExport(doc, opts);
  const meshes = items
    .filter((it) => it.mesh && it.mesh.positions.length)
    .map((it) => bakeWorldMesh(it.mesh!, it.ev.worldMatrix));
  const withUV = meshes.some((m) => m.uvs);
  const withColor = meshes.some((m) => m.colors && m.colors.length === (m.positions.length / 3) * 4);
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const faces: number[][] = [];
  const edges: number[] = [];
  for (const m of meshes) {
    const base = pos.length / 3;
    const nv = m.positions.length / 3;
    const colors = m.colors && m.colors.length === nv * 4 ? m.colors : null;
    const pushVertex = (v: number, u = 0, t = 0) => {
      pos.push(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2]);
      if (withUV) uv.push(u, t);
      if (withColor) {
        if (colors) col.push(colors[v * 4], colors[v * 4 + 1], colors[v * 4 + 2], colors[v * 4 + 3]);
        else col.push(1, 1, 1, 1);
      }
    };
    if (m.uvs) {
      // split vertices per distinct UV so every corner keeps its texture coordinate
      const key = new Map<string, number>();
      const first = new Int32Array(nv).fill(-1);
      for (let f = 0; f < m.faces.length; f++) {
        const face = m.faces[f];
        const fuv = m.uvs[f];
        faces.push(
          face.map((v, i) => {
            const u = fuv[i * 2];
            const t = fuv[i * 2 + 1];
            const k = `${v}|${u}|${t}`;
            let idx = key.get(k);
            if (idx === undefined) {
              idx = pos.length / 3;
              key.set(k, idx);
              if (first[v] < 0) first[v] = idx;
              pushVertex(v, u, t);
            }
            return idx;
          }),
        );
      }
      // vertices not used by faces (loose edges / points)
      for (let v = 0; v < nv; v++)
        if (first[v] < 0) {
          first[v] = pos.length / 3;
          pushVertex(v);
        }
      for (let i = 0; i < m.looseEdges.length; i++) edges.push(first[m.looseEdges[i]]);
    } else {
      for (let v = 0; v < nv; v++) pushVertex(v);
      for (const face of m.faces) faces.push(face.map((v) => v + base));
      for (const v of m.looseEdges) edges.push(v + base);
    }
  }
  const nv = pos.length / 3;
  const maxCorners = faces.reduce((a, f) => Math.max(a, f.length), 0);
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment Created by 3D-Editor',
    `element vertex ${nv}`,
    'property float x',
    'property float y',
    'property float z',
    ...(withUV ? ['property float s', 'property float t'] : []),
    ...(withColor
      ? ['property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha']
      : []),
    `element face ${faces.length}`,
    `property list ${maxCorners > 255 ? 'uint' : 'uchar'} uint vertex_indices`,
    ...(edges.length
      ? [`element edge ${edges.length / 2}`, 'property int vertex1', 'property int vertex2']
      : []),
    'end_header',
    '',
  ].join('\n');
  const w = new ByteWriter(header.length + nv * 32 + faces.length * 17);
  w.ascii(header);
  for (let i = 0; i < nv; i++) {
    w.f32(pos[i * 3]);
    w.f32(pos[i * 3 + 1]);
    w.f32(pos[i * 3 + 2]);
    if (withUV) {
      w.f32(uv[i * 2]);
      w.f32(uv[i * 2 + 1]);
    }
    if (withColor) {
      for (let k = 0; k < 3; k++) w.u8(Math.round(linearToSrgb(col[i * 4 + k]) * 255));
      w.u8(Math.round(Math.min(1, Math.max(0, col[i * 4 + 3])) * 255));
    }
  }
  for (const f of faces) {
    if (maxCorners > 255) w.u32(f.length);
    else w.u8(f.length);
    for (const v of f) w.u32(v);
  }
  for (let i = 0; i < edges.length; i++) w.i32(edges[i]);
  return {
    data: w.finish(),
    mime: 'model/x-ply',
    extension: 'ply',
    warnings: nv ? [] : ['No mesh objects to export'],
  };
}
