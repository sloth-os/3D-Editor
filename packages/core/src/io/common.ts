import type { Mat4, Vec3 } from '../math/types';
import { determinant4 } from '../math/mat4';
import type { MaterialData } from '../doc/types';
import type { SceneDoc } from '../doc/scene-doc';
import type { EvaluatedObject, EvaluatedScene } from '../eval/evaluate';
import { SceneEvaluator } from '../eval/evaluate';
import type { MeshData } from '../mesh/types';
import { cloneMesh } from '../mesh/types';
import { buildRenderBuffers } from '../mesh/render-buffers';
import { faceNormalRaw } from '../mesh/normals';
import type { ExportOptions } from './types';

/** One object selected for export. */
export interface ExportItem {
  ev: EvaluatedObject;
  /** Mesh to write (evaluated or base, object space); null for non-mesh objects. */
  mesh: MeshData | null;
  /** Material per slot (null for empty slots). */
  materials: (MaterialData | null)[];
}

export interface ExportCollection {
  scene: EvaluatedScene;
  /** Exported objects, sorted by name. */
  items: ExportItem[];
  ids: Set<string>;
}

/**
 * Evaluates the scene and picks the objects to export: explicit ids (or names), or every object
 * visible in renders. Meshes are post-modifier unless `applyModifiers` is false.
 */
export function collectExport(doc: SceneDoc, opts: ExportOptions): ExportCollection {
  const frame = opts.frame ?? doc.getScene().frame_start;
  const scene = new SceneEvaluator(doc).evaluate(frame, { forRender: true });
  const apply = opts.applyModifiers !== false;
  let picked: EvaluatedObject[];
  if (opts.objectIds) {
    const want = new Set<string>();
    for (const ref of opts.objectIds) {
      const o = doc.resolveObject(ref);
      if (o) want.add(o.id);
    }
    picked = scene.objects.filter((o) => want.has(o.id));
  } else picked = scene.objects.filter((o) => o.renderVisible);
  const items = picked.map((ev) => ({
    ev,
    mesh: ev.mesh ? ((apply ? ev.mesh : ev.baseMesh) ?? null) : null,
    materials: ev.materials,
  }));
  return { scene, items, ids: new Set(items.map((i) => i.ev.id)) };
}

/** Material of a face's slot (null when the slot is empty or out of range). */
export function slotMaterial(materials: (MaterialData | null)[], index: number): MaterialData | null {
  return materials[index] ?? null;
}

/**
 * Copy of `mesh` with positions transformed to world space. Faces are reversed when the matrix
 * mirrors (negative determinant) so that winding — and thus outward normals — is preserved.
 */
export function bakeWorldMesh(mesh: MeshData, m: Readonly<Mat4>): MeshData {
  const out = cloneMesh(mesh);
  const p = out.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    p[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  if (determinant4(m) < 0) {
    for (let f = 0; f < out.faces.length; f++) {
      const face = out.faces[f];
      const n = face.length;
      const rev = new Array<number>(n);
      for (let i = 0; i < n; i++) rev[i] = face[(n - i) % n];
      out.faces[f] = rev;
      if (out.uvs) {
        const uv = out.uvs[f];
        const ruv = new Array<number>(n * 2);
        for (let i = 0; i < n; i++) {
          const j = (n - i) % n;
          ruv[i * 2] = uv[j * 2];
          ruv[i * 2 + 1] = uv[j * 2 + 1];
        }
        out.uvs[f] = ruv;
      }
    }
  }
  return out;
}

/**
 * Split normals per face corner (flat xyz, faces in order), honouring smooth flags and sharp edges
 * exactly like the viewport (derived from `buildRenderBuffers`).
 */
export function cornerNormals(m: MeshData): Float32Array {
  const start = new Int32Array(m.faces.length + 1);
  for (let f = 0; f < m.faces.length; f++) start[f + 1] = start[f] + m.faces[f].length;
  const out = new Float32Array(start[m.faces.length] * 3);
  for (let f = 0; f < m.faces.length; f++) {
    const n = faceNormalRaw(m, f);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    for (let c = start[f]; c < start[f + 1]; c++) {
      out[c * 3] = n[0] / l;
      out[c * 3 + 1] = n[1] / l;
      out[c * 3 + 2] = n[2] / l;
    }
  }
  if (!m.faceSmooth.some((s) => s)) return out;
  const rb = buildRenderBuffers(m);
  const tris = rb.indices.length / 3;
  for (let t = 0; t < tris; t++) {
    const f = rb.triFace[t];
    const face = m.faces[f];
    if (!m.faceSmooth[f]) continue;
    for (let k = 0; k < 3; k++) {
      const rv = rb.indices[t * 3 + k];
      const i = face.indexOf(rb.vertexSource[rv]);
      if (i < 0) continue;
      const c = start[f] + i;
      out[c * 3] = rb.normals[rv * 3];
      out[c * 3 + 1] = rb.normals[rv * 3 + 1];
      out[c * 3 + 2] = rb.normals[rv * 3 + 2];
    }
  }
  return out;
}

/** Converts a face loop with duplicate vertices into a clean loop (null when degenerate). */
export function cleanLoop(face: number[]): number[] | null {
  const out: number[] = [];
  for (const v of face) if (out[out.length - 1] !== v) out.push(v);
  while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
  if (out.length < 3) return null;
  if (new Set(out).size !== out.length) return null;
  return out;
}

/** A filename-safe version of a document or object name. */
export function safeFileName(name: string, fallback = 'scene'): string {
  let s = '';
  for (const ch of name.trim())
    s += ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) || /\s/.test(ch) ? '_' : ch;
  return s.replace(/_+/g, '_') || fallback;
}

/** World-space bounding box of evaluated mesh objects (null when there is no geometry). */
export function evaluatedBounds(
  objects: Iterable<{ mesh?: MeshData; worldMatrix: Mat4 }>,
): { min: Vec3; max: Vec3 } | null {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const o of objects) {
    const mesh = o.mesh;
    if (!mesh || mesh.positions.length < 3) continue;
    const m = o.worldMatrix;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (wx < min[0]) min[0] = wx;
      if (wy < min[1]) min[1] = wy;
      if (wz < min[2]) min[2] = wz;
      if (wx > max[0]) max[0] = wx;
      if (wy > max[1]) max[1] = wy;
      if (wz > max[2]) max[2] = wz;
    }
    any = true;
  }
  return any ? { min, max } : null;
}
