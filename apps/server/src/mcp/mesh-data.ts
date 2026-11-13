import {
  computeVertexNormals,
  countTriangles,
  decodeFloat32,
  faceCenter,
  faceNormal,
  invert4,
  isModifierEnabled,
  modifierDisabledMessage,
  transformPoint3,
  type Mat4,
  type MeshData,
  type ModifierDisabledContext,
  type ObjectData,
  type SceneDoc,
  type Vec3,
} from '@3d-editor/core';
import { evaluateCached } from './eval-cache';
import { ToolError } from './agent';

/*
 * Read access to mesh geometry for agents (the get_mesh_data tool): vertex positions, normals and
 * colors, faces with their material indices, UVs, loose edges and vertex group weights, in pages,
 * plus an optional world-space heightmap of the surface (terrain-aware placement without parsing
 * exports).
 */

/** What get_mesh_data can return. */
export const MESH_DATA_FIELDS = [
  'vertices',
  'normals',
  'colors',
  'faces',
  'face_materials',
  'face_smooth',
  'face_normals',
  'face_centers',
  'uvs',
  'loose_edges',
  'vertex_groups',
  'heightmap',
] as const;
export type MeshDataField = (typeof MESH_DATA_FIELDS)[number];

/** Default and largest page size (vertices and faces per call). */
export const DEFAULT_MESH_PAGE = 2000;
export const MAX_MESH_PAGE = 20_000;
/** Largest heightmap side (samples). */
export const MAX_HEIGHTMAP = 256;

export interface MeshDataOptions {
  /** BASE: the stored mesh (indices edit_mesh uses); EVALUATED / RENDER: after shape keys and modifiers (viewport / render settings). */
  source?: 'BASE' | 'EVALUATED' | 'RENDER';
  space?: 'LOCAL' | 'WORLD';
  include?: readonly MeshDataField[];
  vertex_offset?: number;
  face_offset?: number;
  limit?: number;
  frame: number;
  decimals?: number;
  heightmap_resolution?: number;
}

const DEFAULT_FIELDS: readonly MeshDataField[] = ['vertices', 'faces', 'face_materials'];

function rounder(decimals: number): (v: number) => number {
  const f = 10 ** decimals;
  return (v) => {
    const r = Math.round(v * f) / f;
    return r === 0 ? 0 : r;
  };
}

/** Direction transform of normals (inverse transpose of the upper 3×3), normalized. */
function normalTransform(m: Mat4): (n: Vec3) => Vec3 {
  const iv = invert4(m);
  return ([x, y, z]) => {
    const nx = iv[0] * x + iv[1] * y + iv[2] * z;
    const ny = iv[4] * x + iv[5] * y + iv[6] * z;
    const nz = iv[8] * x + iv[9] * y + iv[10] * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
}

/**
 * Highest surface point on a regular XY grid over the world-space bounds of `mesh` (`resolution`
 * samples along the longer side): rows from min Y to max Y, each from min X to max X; null where
 * the surface does not cover a sample.
 */
function heightmap(mesh: MeshData, world: Mat4, resolution: number, round: (v: number) => number) {
  const n = mesh.positions.length / 3;
  const pts = new Float64Array(n * 3);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = transformPoint3(world, [
      mesh.positions[i * 3],
      mesh.positions[i * 3 + 1],
      mesh.positions[i * 3 + 2],
    ]);
    pts.set(p, i * 3);
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
  }
  if (!n || !Number.isFinite(minX)) return null;
  const sx = maxX - minX;
  const sy = maxY - minY;
  const long = Math.max(sx, sy, 1e-9);
  const nx = Math.max(2, Math.round((resolution * sx) / long));
  const ny = Math.max(2, Math.round((resolution * sy) / long));
  const dx = sx / (nx - 1) || 0;
  const dy = sy / (ny - 1) || 0;
  const heights = new Float64Array(nx * ny).fill(-Infinity);
  for (const f of mesh.faces) {
    for (let k = 1; k + 1 < f.length; k++) {
      const a = f[0] * 3;
      const b = f[k] * 3;
      const c = f[k + 1] * 3;
      const ax = pts[a],
        ay = pts[a + 1],
        az = pts[a + 2];
      const bx = pts[b],
        by = pts[b + 1],
        bz = pts[b + 2];
      const cx = pts[c],
        cy = pts[c + 1],
        cz = pts[c + 2];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-18) continue; // vertical or degenerate in XY
      const i0 = dx ? Math.max(0, Math.ceil((Math.min(ax, bx, cx) - minX) / dx - 1e-9)) : 0;
      const i1 = dx ? Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - minX) / dx + 1e-9)) : nx - 1;
      const j0 = dy ? Math.max(0, Math.ceil((Math.min(ay, by, cy) - minY) / dy - 1e-9)) : 0;
      const j1 = dy ? Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - minY) / dy + 1e-9)) : ny - 1;
      for (let j = j0; j <= j1; j++) {
        const y = minY + j * dy;
        for (let i = i0; i <= i1; i++) {
          const x = minX + i * dx;
          const w0 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
          const w1 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
          const z = w0 * az + w1 * bz + w2 * cz;
          const idx = j * nx + i;
          if (z > heights[idx]) heights[idx] = z;
        }
      }
    }
  }
  const rows: (number | null)[][] = [];
  let covered = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let j = 0; j < ny; j++) {
    const row: (number | null)[] = [];
    for (let i = 0; i < nx; i++) {
      const z = heights[j * nx + i];
      if (z === -Infinity) row.push(null);
      else {
        covered++;
        zMin = Math.min(zMin, z);
        zMax = Math.max(zMax, z);
        row.push(round(z));
      }
    }
    rows.push(row);
  }
  return {
    space: 'WORLD',
    samples: [nx, ny],
    min_xy: [round(minX), round(minY)],
    max_xy: [round(maxX), round(maxY)],
    step: [round(dx), round(dy)],
    z_range: covered ? [round(zMin), round(zMax)] : null,
    covered,
    layout:
      'heights[j][i] = highest surface z at x = min_xy[0] + i*step[0], y = min_xy[1] + j*step[1] (null: no surface)',
    heights: rows,
  };
}

/**
 * The modifiers an evaluation of `o` left out, named as get_scene names them: those with an error of
 * their own or skipped on the server because they would not fit into its heap (`errors`, the
 * evaluated object's), and those Blender's is_disabled leaves out (`disabled: true`: a Bevel of width
 * 0, a Boolean without a mesh object …). Nothing when there are none.
 */
function leftOutModifiers(
  scene: SceneDoc,
  o: ObjectData,
  errors: readonly { modifierId: string; message: string }[],
  forRender: boolean,
): Record<string, unknown> {
  const left: { modifier: string; disabled?: true; message: string }[] = errors.map((m) => ({
    modifier:
      m.modifierId === 'shape_keys'
        ? 'shape keys'
        : (o.modifiers.find((x) => x.id === m.modifierId)?.name ?? m.modifierId),
    message: m.message.replace(/[A-Za-z0-9_-]{8,40}/g, (w) => scene.getObject(w)?.name ?? w),
  }));
  const ctx: ModifierDisabledContext = {
    forRender,
    objectType: (id) => scene.getObject(id)?.type ?? null,
    objectName: (id) => scene.getObject(id)?.name ?? id,
  };
  for (const m of o.modifiers) {
    if (!isModifierEnabled(m, { forRender, editMode: false })) continue;
    const disabled = modifierDisabledMessage(m, ctx);
    if (disabled) left.push({ modifier: m.name, disabled: true, message: disabled });
  }
  if (!left.length) return {};
  return {
    modifier_errors: left,
    modifier_errors_note:
      'this geometry is the result without the modifiers listed in modifier_errors: the evaluation left each of ' +
      'them out for the reason given (get_scene lists them too)',
  };
}

/** The geometry of an object for get_mesh_data (see the tool description). */
export function meshData(scene: SceneDoc, o: ObjectData, opts: MeshDataOptions): Record<string, unknown> {
  const isMesh = o.type === 'MESH';
  if (!isMesh && o.type !== 'CURVE' && o.type !== 'FONT')
    throw new ToolError(
      `'${o.name}' is a ${o.type} object without geometry; get_mesh_data reads mesh, curve and text objects.`,
    );
  const source = opts.source ?? (isMesh ? 'BASE' : 'EVALUATED');
  if (source === 'BASE' && !isMesh)
    throw new ToolError(
      `'${o.name}' is a ${o.type === 'FONT' ? 'text' : 'curve'} object: its geometry is generated, so read it with source EVALUATED (or RENDER).`,
    );
  const include = new Set<MeshDataField>(opts.include?.length ? opts.include : DEFAULT_FIELDS);
  const decimals = Math.max(0, Math.min(6, Math.round(opts.decimals ?? 4)));
  const round = rounder(decimals);
  const limit = Math.max(1, Math.min(MAX_MESH_PAGE, Math.round(opts.limit ?? DEFAULT_MESH_PAGE)));
  const space = opts.space ?? 'LOCAL';

  // evaluation: needed for evaluated geometry and for world-space data (the matrix at the frame)
  const needsEval = source !== 'BASE' || space === 'WORLD' || include.has('heightmap');
  const ev = needsEval
    ? evaluateCached(scene, opts.frame, source === 'RENDER' ? 'RENDER' : 'VIEWPORT')
    : null;
  const e = ev?.byId.get(o.id);
  const world: Mat4 | null = e?.worldMatrix ?? (needsEval ? scene.worldMatrix(o.id) : null);
  let mesh: MeshData | null | undefined;
  if (source === 'BASE') mesh = o.data ? scene.getMesh(o.data) : null;
  else mesh = e?.mesh;
  if (!mesh)
    throw new ToolError(
      source === 'BASE'
        ? `'${o.name}' has no mesh data.`
        : `'${o.name}' has no surface geometry at frame ${opts.frame}${o.type === 'MESH' ? '' : ' (a wire curve: add bevel_depth, extrude or a 2D fill with curve.properties_set)'}.`,
    );

  const nv = mesh.positions.length / 3;
  const nf = mesh.faces.length;
  const v0 = Math.max(0, Math.min(nv, Math.round(opts.vertex_offset ?? 0)));
  const v1 = Math.min(nv, v0 + limit);
  const f0 = Math.max(0, Math.min(nf, Math.round(opts.face_offset ?? 0)));
  const f1 = Math.min(nf, f0 + limit);
  const toSpace = space === 'WORLD' && world ? (p: Vec3) => transformPoint3(world, p) : (p: Vec3) => p;
  const normalToSpace = space === 'WORLD' && world ? normalTransform(world) : (n: Vec3) => n;
  const vec = (v: Vec3) => [round(v[0]), round(v[1]), round(v[2])];
  const vertexRange = ['vertices', 'normals', 'colors', 'vertex_groups'].some((k) =>
    include.has(k as MeshDataField),
  );
  const faceRange = ['faces', 'face_materials', 'face_smooth', 'face_normals', 'face_centers', 'uvs'].some(
    (k) => include.has(k as MeshDataField),
  );

  const out: Record<string, unknown> = {
    object: o.name,
    type: o.type,
    ...(isMesh && o.data ? { mesh: scene.getMeshBlock(o.data)?.name ?? o.data } : {}),
    source,
    space,
    ...(needsEval ? { frame: ev?.frame ?? opts.frame } : {}),
    totals: {
      vertices: nv,
      faces: nf,
      triangles: countTriangles(mesh),
      loose_edges: mesh.looseEdges.length / 2,
    },
    ...(source === 'BASE'
      ? {
          indices:
            'vertex and face indices are the ones edit_mesh selections, vertex groups and shape keys use',
        }
      : {
          indices:
            'evaluated geometry: indices differ from the stored mesh when modifiers change the topology',
        }),
    ...(source !== 'BASE' ? leftOutModifiers(scene, o, e?.modifierErrors ?? [], source === 'RENDER') : {}),
  };
  if (vertexRange) out.vertex_range = { offset: v0, count: v1 - v0 };
  if (faceRange) out.face_range = { offset: f0, count: f1 - f0 };

  if (include.has('vertices')) {
    const list: number[][] = [];
    for (let i = v0; i < v1; i++)
      list.push(vec(toSpace([mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]])));
    out.vertices = list;
  }
  if (include.has('normals')) {
    const normals = computeVertexNormals(mesh);
    const list: number[][] = [];
    for (let i = v0; i < v1; i++)
      list.push(vec(normalToSpace([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]])));
    out.normals = list;
  }
  if (include.has('colors')) {
    // the vertex color layer (what paint.vertex_color_set / _stroke / _set_data write): RGBA per vertex
    const cols = mesh.colors;
    if (cols && cols.length >= nv * 4) {
      const list: number[][] = [];
      for (let i = v0; i < v1; i++)
        list.push([
          round(cols[i * 4]),
          round(cols[i * 4 + 1]),
          round(cols[i * 4 + 2]),
          round(cols[i * 4 + 3]),
        ]);
      out.colors = list;
    } else {
      out.colors = null;
      out.colors_note =
        source === 'BASE'
          ? 'the mesh has no vertex color layer (paint.vertex_color_set, paint.vertex_color_stroke and paint.vertex_color_set_data add one; renders then multiply the base color by it)'
          : 'the evaluated geometry carries no vertex colors (the mesh has no color layer, or a modifier does not keep it)';
    }
  }
  if (include.has('vertex_groups')) {
    if (source !== 'BASE' || !o.data) out.vertex_groups = null;
    else {
      const groups: Record<string, number[]> = {};
      for (const g of scene.getVertexGroups(o.data)) {
        const w = decodeFloat32(g.weights);
        groups[g.name] = Array.from({ length: v1 - v0 }, (_, k) => round(w[v0 + k] ?? 0));
      }
      out.vertex_groups = groups;
    }
  }
  if (include.has('faces')) out.faces = mesh.faces.slice(f0, f1);
  if (include.has('face_materials')) {
    out.face_materials = mesh.faceMaterials.slice(f0, f1);
    out.material_slots = o.material_slots.map((id) => (id ? (scene.getMaterial(id)?.name ?? id) : null));
  }
  if (include.has('face_smooth')) out.face_smooth = mesh.faceSmooth.slice(f0, f1);
  if (include.has('face_normals')) {
    const list: number[][] = [];
    for (let f = f0; f < f1; f++) list.push(vec(normalToSpace(faceNormal(mesh, f))));
    out.face_normals = list;
  }
  if (include.has('face_centers')) {
    const list: number[][] = [];
    for (let f = f0; f < f1; f++) list.push(vec(toSpace(faceCenter(mesh, f))));
    out.face_centers = list;
  }
  if (include.has('uvs')) out.uvs = mesh.uvs ? mesh.uvs.slice(f0, f1).map((u) => u.map(round)) : null;
  if (include.has('loose_edges')) {
    const edges: [number, number][] = [];
    for (let i = 0; i + 1 < mesh.looseEdges.length && edges.length < limit; i += 2)
      edges.push([mesh.looseEdges[i], mesh.looseEdges[i + 1]]);
    out.loose_edges = edges;
  }
  if (include.has('heightmap') && world) {
    const res = Math.max(8, Math.min(MAX_HEIGHTMAP, Math.round(opts.heightmap_resolution ?? 64)));
    out.heightmap = heightmap(mesh, world, res, round);
  }

  const next: Record<string, number> = {};
  if (vertexRange && v1 < nv) next.vertex_offset = v1;
  if (faceRange && f1 < nf) next.face_offset = f1;
  if (Object.keys(next).length) {
    out.truncated = true;
    out.next = next;
  }
  return out;
}
