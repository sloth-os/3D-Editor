import type { SceneDoc } from '../doc/scene-doc';
import { createMesh } from '../mesh/types';
import { mergeByDistance } from '../mesh/weld';
import { triangulateMesh } from '../mesh/triangulate';
import { ByteWriter, forEachLine, latin1, restOfLine, splitWs, utf8Decode } from './bytes';
import { bakeWorldMesh, collectExport } from './common';
import type { ExportOptions, ExportResult, ImportOptions, ImportResult } from './types';

/*
 * STL (stereolithography). Z-up like the editor (no axis conversion). Import accepts ASCII and
 * binary files, welds the triangle soup (exact duplicates, then `mergeByDistance` with a tiny
 * threshold relative to the model size) and creates one object. Export writes binary STL with
 * world-space triangulated geometry of every exported mesh object.
 */

/** True when the bytes look like a binary STL (size matches the triangle count, or no ASCII marker). */
export function isBinarySTL(data: Uint8Array): boolean {
  if (data.length >= 84) {
    const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(80, true);
    if (84 + n * 50 === data.length) return true;
  }
  const head = latin1(data, 0, Math.min(data.length, 512)).trimStart();
  if (head.toLowerCase().startsWith('solid')) {
    const sample = latin1(data, 0, Math.min(data.length, 4096)).toLowerCase();
    if (sample.includes('facet') || sample.includes('endsolid') || data.length < 84) return false;
  }
  return data.length >= 84;
}

interface Soup {
  name: string | null;
  /** Unique positions (exact duplicates merged). */
  positions: number[];
  /** Polygons as indices into `positions` (triangles, or n-gons from non-standard ASCII loops). */
  faces: number[][];
}

class VertexPool {
  readonly positions: number[] = [];
  private readonly index = new Map<string, number>();
  add(x: number, y: number, z: number): number {
    const k = `${x},${y},${z}`;
    let i = this.index.get(k);
    if (i === undefined) {
      i = this.positions.length / 3;
      this.positions.push(x, y, z);
      this.index.set(k, i);
    }
    return i;
  }
}

function parseBinary(data: Uint8Array): Soup {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const declared = dv.getUint32(80, true);
  const n = Math.min(declared, Math.floor((data.length - 84) / 50));
  const pool = new VertexPool();
  const faces: number[][] = [];
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    const f: number[] = [];
    for (let k = 0; k < 3; k++) {
      const b = o + k * 12;
      f.push(pool.add(dv.getFloat32(b, true), dv.getFloat32(b + 4, true), dv.getFloat32(b + 8, true)));
    }
    faces.push(f);
  }
  return { name: null, positions: pool.positions, faces };
}

function parseAscii(text: string): Soup {
  const pool = new VertexPool();
  const faces: number[][] = [];
  let name: string | null = null;
  let loop: number[] | null = null;
  const tok: string[] = [];
  forEachLine(text, (line) => {
    const n = splitWs(line, tok);
    if (n === 0) return;
    const key = tok[0].toLowerCase();
    if (key === 'vertex' && n >= 4) {
      const i = pool.add(parseFloat(tok[1]) || 0, parseFloat(tok[2]) || 0, parseFloat(tok[3]) || 0);
      if (loop) loop.push(i);
      else faces.push([i]); // vertex outside a loop: group by threes below
    } else if (key === 'outer') {
      loop = [];
    } else if (key === 'endloop' || key === 'endfacet') {
      if (loop && loop.length) faces.push(loop);
      loop = null;
    } else if (key === 'solid' && name === null) {
      name = restOfLine(line) || null;
    }
  });
  // Merge stray single vertices (files without loop statements) into triangles.
  const out: number[][] = [];
  let pending: number[] = [];
  for (const f of faces) {
    if (f.length === 1) {
      pending.push(f[0]);
      if (pending.length === 3) {
        out.push(pending);
        pending = [];
      }
    } else out.push(f);
  }
  return { name, positions: pool.positions, faces: out };
}

export function importSTL(doc: SceneDoc, data: Uint8Array, opts: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const soup = isBinarySTL(data) ? parseBinary(data) : parseAscii(utf8Decode(data));
  let degenerate = 0;
  const faces: number[][] = [];
  for (const f of soup.faces) {
    if (f.length < 3 || new Set(f).size !== f.length) degenerate++;
    else faces.push(f);
  }
  if (faces.length === 0) {
    warnings.push('STL file contains no triangles');
    return { objects: [], warnings };
  }
  // drop vertices only referenced by degenerate triangles
  const used = new Int32Array(soup.positions.length / 3).fill(-1);
  const positions: number[] = [];
  for (const f of faces)
    for (let i = 0; i < f.length; i++) {
      const v = f[i];
      if (used[v] < 0) {
        used[v] = positions.length / 3;
        positions.push(soup.positions[v * 3], soup.positions[v * 3 + 1], soup.positions[v * 3 + 2]);
      }
      f[i] = used[v];
    }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], positions[i + k]);
      max[k] = Math.max(max[k], positions[i + k]);
    }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const welded = mergeByDistance(createMesh({ positions, faces }), Math.max(diag * 1e-6, 1e-9)).mesh;
  if (degenerate) warnings.push(`${degenerate} degenerate triangle(s) skipped`);
  const name = opts.name ?? soup.name ?? 'STL';
  const offset = opts.location ?? [0, 0, 0];
  return doc.transact(() => {
    const meshId = doc.addMesh(name, welded);
    const id = doc.addObject({
      type: 'MESH',
      name,
      data: meshId,
      location: [offset[0], offset[1], offset[2]],
    });
    return { objects: [id], warnings };
  });
}

export function exportSTL(doc: SceneDoc, opts: ExportOptions = {}): ExportResult {
  const { items } = collectExport(doc, opts);
  const tris: number[] = [];
  for (const it of items) {
    if (!it.mesh || it.mesh.faces.length === 0) continue;
    const mesh = bakeWorldMesh(it.mesh, it.ev.worldMatrix);
    const { indices } = triangulateMesh(mesh);
    const p = mesh.positions;
    for (const i of indices) tris.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  const count = tris.length / 9;
  const w = new ByteWriter(84 + count * 50);
  const header = 'Binary STL exported by 3D-Editor';
  w.ascii(header);
  for (let i = header.length; i < 80; i++) w.u8(32);
  w.u32(count);
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o];
    const uy = tris[o + 4] - tris[o + 1];
    const uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o];
    const vy = tris[o + 7] - tris[o + 1];
    const vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    w.f32(nx / l);
    w.f32(ny / l);
    w.f32(nz / l);
    for (let k = 0; k < 9; k++) w.f32(tris[o + k]);
    w.u16(0);
  }
  return {
    data: w.finish(),
    mime: 'model/stl',
    extension: 'stl',
    warnings: count ? [] : ['No mesh faces to export'],
  };
}
