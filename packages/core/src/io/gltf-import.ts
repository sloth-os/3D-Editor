import type { Mat4, Quat, Vec2, Vec3 } from '../math/types';
import { decompose4, multiply4 } from '../math/mat4';
import { eulerFromQuat, normalizeQuat } from '../math/quat';
import type { SceneDoc } from '../doc/scene-doc';
import type {
  CameraData,
  Interpolation,
  Keyframe,
  LightData,
  MaterialData,
  MaterialTextureChannel,
  ObjectType,
  ShapeKeyData,
} from '../doc/types';
import { createFCurve } from '../anim/fcurve';
import { lensFromFovY } from '../eval/camera';
import type { MeshData } from '../mesh/types';
import { createMesh, edgeKey } from '../mesh/types';
import { encodeFloat32 } from '../mesh/shape-keys';
import { base64Decode } from '../util/json';
import { M_Y_TO_Z, M_Z_TO_Y, toZUp, trsToZUp, type TRS } from './axes';
import { lookupFile, utf8Decode } from './bytes';
import { isGLB, readGLB } from './glb';
import {
  COMPONENT_SIZE,
  TYPE_COMPONENTS,
  type GltfCamera,
  type GltfLight,
  type GltfMaterial,
  type GltfRoot,
  type GltfTextureInfo,
} from './gltf-types';
import { readImageInfo, sniffImageMime } from './image-info';
import type { ImportOptions, ImportResult } from './types';

/*
 * glTF 2.0 import (.gltf with embedded data URIs or companion files, and .glb).
 *
 * Nodes become objects (hierarchy and TRS/matrix converted from Y-up, see axes.ts); every glTF
 * mesh becomes one mesh datablock with all primitives merged (one material slot per primitive
 * material, vertices shared between primitives that share attribute accessors, nothing welded).
 * Smooth shading is derived from vertex normals. Materials, embedded images, cameras,
 * KHR_lights_punctual lights and TRS animations (as per-key fcurves) are imported. Morph targets
 * become shape keys of the mesh (POSITION deltas; names from mesh.extras.targetNames, default
 * values from node or mesh weights) and `weights` animations become F-curves on their values.
 * Skins are not imported (with a warning): a skinned mesh keeps the vertex positions stored in the
 * file (its bind pose) at its node, and the joints become empties. Parsing happens before the
 * document is touched so a broken file never leaves a half-imported scene.
 */

const GEOMETRY_COMPRESSION = new Set([
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
]);
const KNOWN_EXTENSIONS = new Set([
  'KHR_lights_punctual',
  'KHR_materials_emissive_strength',
  'KHR_materials_transmission',
  'KHR_materials_ior',
  'KHR_materials_clearcoat',
  'KHR_materials_sheen',
  'KHR_materials_unlit',
  'KHR_materials_pbrSpecularGlossiness',
  'KHR_materials_specular',
  'KHR_materials_volume',
  'KHR_texture_transform',
  'KHR_mesh_quantization',
  'EXT_texture_webp',
]);

interface ParsedMesh {
  name: string;
  mesh: MeshData;
  /** glTF material index per slot (null = no material). */
  slots: (number | null)[];
  /** Morph targets as shape keys: full positions (Z-up) of every target and its default weight. */
  shapeKeys: { name: string; value: number; positions: number[] }[];
}

interface TextureRef {
  texture: number;
  scale: Vec2;
  offset: Vec2;
}

interface ParsedMaterial {
  props: Partial<MaterialData>;
  textures: Partial<Record<MaterialTextureChannel, TextureRef>>;
}

interface ParsedNode {
  index: number;
  name: string | undefined;
  trs: TRS | null;
  matrix: number[] | null;
  mesh?: number;
  /** Morph target weights of this node (override the mesh's default weights). */
  weights?: number[];
  camera?: number;
  light?: number;
  extras?: unknown;
  children: ParsedNode[];
}

interface ParsedChannel {
  node: number;
  path: 'translation' | 'rotation' | 'scale' | 'weights';
  times: Float64Array;
  /** Values per key: 3 (translation, scale), 4 (rotation) or one per morph target (weights). */
  values: Float64Array;
  interpolation: Interpolation;
}

function decodeDataUri(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  if (/;base64$/i.test(meta)) return base64Decode(payload);
  const text = decodeURIComponent(payload);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** XYZ Euler closest to `prev` among the equivalent representations of the same rotation. */
function compatibleEuler(e: Vec3, prev: Vec3 | null): Vec3 {
  if (!prev) return e;
  const TAU = Math.PI * 2;
  const wrap = (a: number, ref: number) => a + TAU * Math.round((ref - a) / TAU);
  const c1: Vec3 = [wrap(e[0], prev[0]), wrap(e[1], prev[1]), wrap(e[2], prev[2])];
  const c2: Vec3 = [
    wrap(e[0] + Math.PI, prev[0]),
    wrap(Math.PI - e[1], prev[1]),
    wrap(e[2] + Math.PI, prev[2]),
  ];
  const d = (c: Vec3) => Math.abs(c[0] - prev[0]) + Math.abs(c[1] - prev[1]) + Math.abs(c[2] - prev[2]);
  return d(c2) < d(c1) - 1e-9 ? c2 : c1;
}

export function importGLTF(doc: SceneDoc, data: Uint8Array, opts: ImportOptions = {}): ImportResult {
  const warnings: string[] = [];
  const warn = (m: string) => {
    if (!warnings.includes(m)) warnings.push(m);
  };

  // ---------------------------------------------------------------- container + validation
  let json: GltfRoot;
  let glbBin: Uint8Array | null = null;
  if (isGLB(data)) {
    const r = readGLB(data);
    json = r.json as GltfRoot;
    glbBin = r.bin;
  } else {
    try {
      json = JSON.parse(utf8Decode(data)) as GltfRoot;
    } catch (err) {
      throw new Error(`Invalid glTF JSON: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
  }
  if (!json || typeof json !== 'object' || !json.asset) throw new Error('Not a glTF file (missing "asset")');
  const version = String(json.asset.version ?? '');
  if (!version.startsWith('2'))
    throw new Error(`Unsupported glTF version '${version}' (only 2.x is supported)`);
  for (const ext of json.extensionsRequired ?? []) {
    if (GEOMETRY_COMPRESSION.has(ext))
      throw new Error(`glTF requires unsupported extension ${ext} (compressed geometry)`);
    if (!KNOWN_EXTENSIONS.has(ext))
      warn(`Required extension ${ext} is not supported; the result may be incomplete`);
  }

  // ---------------------------------------------------------------- buffers + accessors
  const buffers: (Uint8Array | null)[] = (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (i === 0 && glbBin) return glbBin;
      warn(`Buffer ${i} has no data`);
      return null;
    }
    if (b.uri.startsWith('data:')) return decodeDataUri(b.uri);
    const file = lookupFile(opts.files, b.uri);
    if (file) return file;
    warn(`External buffer '${b.uri}' was not provided`);
    return null;
  });

  const viewBytes = (index: number): Uint8Array => {
    const bv = json.bufferViews?.[index];
    if (!bv) throw new Error(`Buffer view ${index} not found`);
    const buf = buffers[bv.buffer];
    if (!buf) throw new Error(`Buffer ${bv.buffer} is not available`);
    const start = bv.byteOffset ?? 0;
    if (start + bv.byteLength > buf.length) throw new Error(`Buffer view ${index} exceeds its buffer`);
    return buf.subarray(start, start + bv.byteLength);
  };

  const readComponents = (
    bytes: Uint8Array,
    offset: number,
    stride: number,
    ct: number,
    count: number,
    size: number,
    out: Float64Array,
  ) => {
    const csize = COMPONENT_SIZE[ct];
    if (!csize) throw new Error(`Unknown accessor component type ${ct}`);
    if (count > 0 && offset + stride * (count - 1) + size * csize > bytes.length)
      throw new Error('Accessor exceeds its buffer view');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) {
      const base = offset + i * stride;
      for (let c = 0; c < size; c++) {
        const o = base + c * csize;
        let v: number;
        switch (ct) {
          case 5126:
            v = dv.getFloat32(o, true);
            break;
          case 5121:
            v = bytes[o];
            break;
          case 5123:
            v = dv.getUint16(o, true);
            break;
          case 5125:
            v = dv.getUint32(o, true);
            break;
          case 5120:
            v = dv.getInt8(o);
            break;
          default:
            v = dv.getInt16(o, true);
        }
        out[i * size + c] = v;
      }
    }
  };

  const accessorCache = new Map<number, { values: Float64Array; size: number; count: number }>();
  const readAccessor = (index: number): { values: Float64Array; size: number; count: number } => {
    const cached = accessorCache.get(index);
    if (cached) return cached;
    const acc = json.accessors?.[index];
    if (!acc) throw new Error(`Accessor ${index} not found`);
    const size = TYPE_COMPONENTS[acc.type];
    if (!size) throw new Error(`Accessor ${index} has unknown type '${acc.type}'`);
    const count = acc.count | 0;
    const values = new Float64Array(count * size);
    if (acc.bufferView !== undefined) {
      const bytes = viewBytes(acc.bufferView);
      const stride = json.bufferViews![acc.bufferView].byteStride || size * COMPONENT_SIZE[acc.componentType];
      readComponents(bytes, acc.byteOffset ?? 0, stride, acc.componentType, count, size, values);
    }
    if (acc.sparse && acc.sparse.count > 0) {
      const sp = acc.sparse;
      const idx = new Float64Array(sp.count);
      const ib = viewBytes(sp.indices.bufferView);
      readComponents(
        ib,
        sp.indices.byteOffset ?? 0,
        COMPONENT_SIZE[sp.indices.componentType],
        sp.indices.componentType,
        sp.count,
        1,
        idx,
      );
      const vals = new Float64Array(sp.count * size);
      const vb = viewBytes(sp.values.bufferView);
      readComponents(
        vb,
        sp.values.byteOffset ?? 0,
        size * COMPONENT_SIZE[acc.componentType],
        acc.componentType,
        sp.count,
        size,
        vals,
      );
      for (let k = 0; k < sp.count; k++) {
        const i = idx[k];
        if (i >= count) throw new Error(`Sparse accessor ${index} index out of range`);
        for (let c = 0; c < size; c++) values[i * size + c] = vals[k * size + c];
      }
    }
    if (acc.normalized) {
      const ct = acc.componentType;
      const f =
        ct === 5121
          ? 1 / 255
          : ct === 5123
            ? 1 / 65535
            : ct === 5120
              ? 1 / 127
              : ct === 5122
                ? 1 / 32767
                : ct === 5125
                  ? 1 / 4294967295
                  : 1;
      const signed = ct === 5120 || ct === 5122;
      for (let i = 0; i < values.length; i++)
        values[i] = signed ? Math.max(-1, values[i] * f) : values[i] * f;
    }
    const r = { values, size, count };
    accessorCache.set(index, r);
    return r;
  };

  // ---------------------------------------------------------------- meshes
  const parseMesh = (mi: number): ParsedMesh | null => {
    const gm = json.meshes?.[mi];
    if (!gm) {
      warn(`Mesh ${mi} not found`);
      return null;
    }
    const positions: number[] = [];
    const faces: number[][] = [];
    const faceMaterials: number[] = [];
    const faceSmooth: boolean[] = [];
    const faceUV: (number[] | null)[] = [];
    const lines: number[] = [];
    const slots: (number | null)[] = [];
    const slotOf = new Map<number | null, number>();
    interface Block {
      offset: number;
      count: number;
      normals: Float64Array | null;
      uv: Float64Array | null;
      colors: Float64Array | null;
      colorSize: number;
      /** Morph target POSITION deltas (Z-up), one array per target (null: no delta). */
      targets: (Float64Array | null)[];
    }
    const blocks: Block[] = [];
    const blockOf = new Map<string, Block>();
    let anyUV = false;
    let degenerate = 0;
    let targetCount = 0;
    for (const prim of gm.primitives ?? []) {
      if (prim.extensions && Object.keys(prim.extensions).some((e) => GEOMETRY_COMPRESSION.has(e))) {
        warn('Compressed (Draco/meshopt) primitives are not supported and were skipped');
        continue;
      }
      const attrs = prim.attributes ?? {};
      if (attrs.POSITION === undefined) {
        warn('Primitive without POSITION skipped');
        continue;
      }
      if (prim.targets && prim.targets.length) targetCount = Math.max(targetCount, prim.targets.length);
      if (attrs.JOINTS_0 !== undefined || attrs.WEIGHTS_0 !== undefined)
        warn(
          'Skin weights (JOINTS_0/WEIGHTS_0) are not imported: skinned meshes keep their bind pose, without vertex groups or an Armature modifier',
        );
      if (Object.keys(attrs).some((a) => /^TEXCOORD_[1-9]/.test(a)))
        warn('Only the first UV map (TEXCOORD_0) is imported');
      const key = [attrs.POSITION, attrs.NORMAL, attrs.TEXCOORD_0, attrs.COLOR_0].join(':');
      let block = blockOf.get(key);
      if (!block) {
        const pos = readAccessor(attrs.POSITION);
        if (pos.size !== 3) throw new Error('POSITION accessor must be VEC3');
        const offset = positions.length / 3;
        for (let i = 0; i < pos.count; i++)
          positions.push(pos.values[i * 3], -pos.values[i * 3 + 2] + 0, pos.values[i * 3 + 1]);
        let normals: Float64Array | null = null;
        if (attrs.NORMAL !== undefined) {
          const n = readAccessor(attrs.NORMAL);
          if (n.size === 3 && n.count === pos.count) {
            normals = new Float64Array(n.count * 3);
            for (let i = 0; i < n.count; i++) {
              normals[i * 3] = n.values[i * 3];
              normals[i * 3 + 1] = -n.values[i * 3 + 2];
              normals[i * 3 + 2] = n.values[i * 3 + 1];
            }
          }
        }
        const uvAcc = attrs.TEXCOORD_0 !== undefined ? readAccessor(attrs.TEXCOORD_0) : null;
        const colAcc = attrs.COLOR_0 !== undefined ? readAccessor(attrs.COLOR_0) : null;
        block = {
          offset,
          count: pos.count,
          normals,
          uv: uvAcc && uvAcc.size === 2 && uvAcc.count === pos.count ? uvAcc.values : null,
          colors:
            colAcc && (colAcc.size === 3 || colAcc.size === 4) && colAcc.count === pos.count
              ? colAcc.values
              : null,
          colorSize: colAcc?.size ?? 4,
          targets: (prim.targets ?? []).map((t) => {
            if (t.POSITION === undefined) return null;
            const d = readAccessor(t.POSITION);
            if (d.size !== 3 || d.count !== pos.count) return null;
            const out = new Float64Array(d.count * 3);
            for (let i = 0; i < d.count; i++) {
              out[i * 3] = d.values[i * 3];
              out[i * 3 + 1] = -d.values[i * 3 + 2] + 0;
              out[i * 3 + 2] = d.values[i * 3 + 1];
            }
            return out;
          }),
        };
        blocks.push(block);
        blockOf.set(key, block);
      }
      const b = block;
      let idx: ArrayLike<number>;
      if (prim.indices !== undefined) {
        idx = readAccessor(prim.indices).values;
        for (let i = 0; i < idx.length; i++)
          if (!(idx[i] >= 0 && idx[i] < b.count))
            throw new Error(`Index out of range in mesh '${gm.name ?? mi}'`);
      } else {
        const seq = new Float64Array(b.count);
        for (let i = 0; i < b.count; i++) seq[i] = i;
        idx = seq;
      }
      const matKey = prim.material ?? null;
      let slot = slotOf.get(matKey);
      if (slot === undefined) {
        slot = slots.length;
        slots.push(matKey);
        slotOf.set(matKey, slot);
      }
      const addTri = (a: number, c1: number, c2: number) => {
        if (a === c1 || c1 === c2 || a === c2) {
          degenerate++;
          return;
        }
        faces.push([b.offset + a, b.offset + c1, b.offset + c2]);
        faceMaterials.push(slot!);
        if (b.uv) {
          const uv = b.uv;
          faceUV.push([
            uv[a * 2],
            1 - uv[a * 2 + 1],
            uv[c1 * 2],
            1 - uv[c1 * 2 + 1],
            uv[c2 * 2],
            1 - uv[c2 * 2 + 1],
          ]);
          anyUV = true;
        } else faceUV.push(null);
        let smooth = false;
        if (b.normals) {
          const p = positions;
          const ia = (b.offset + a) * 3;
          const ib = (b.offset + c1) * 3;
          const ic = (b.offset + c2) * 3;
          const ux = p[ib] - p[ia];
          const uy = p[ib + 1] - p[ia + 1];
          const uz = p[ib + 2] - p[ia + 2];
          const vx = p[ic] - p[ia];
          const vy = p[ic + 1] - p[ia + 1];
          const vz = p[ic + 2] - p[ia + 2];
          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;
          const l = Math.hypot(nx, ny, nz);
          if (l > 0) {
            nx /= l;
            ny /= l;
            nz /= l;
            for (const k of [a, c1, c2]) {
              const mx = b.normals[k * 3];
              const my = b.normals[k * 3 + 1];
              const mz = b.normals[k * 3 + 2];
              const ml = Math.hypot(mx, my, mz);
              if (ml > 0 && Math.abs((mx * nx + my * ny + mz * nz) / ml) < 0.99999) {
                smooth = true;
                break;
              }
            }
          }
        }
        faceSmooth.push(smooth);
      };
      const mode = prim.mode ?? 4;
      const n = idx.length;
      switch (mode) {
        case 4:
          for (let i = 0; i + 2 < n; i += 3) addTri(idx[i], idx[i + 1], idx[i + 2]);
          break;
        case 5:
          for (let i = 0; i + 2 < n; i++) {
            if (i % 2 === 0) addTri(idx[i], idx[i + 1], idx[i + 2]);
            else addTri(idx[i + 1], idx[i], idx[i + 2]);
          }
          break;
        case 6:
          for (let i = 1; i + 1 < n; i++) addTri(idx[0], idx[i], idx[i + 1]);
          break;
        case 1:
          for (let i = 0; i + 1 < n; i += 2) lines.push(b.offset + idx[i], b.offset + idx[i + 1]);
          break;
        case 2:
        case 3:
          for (let i = 0; i + 1 < n; i++) lines.push(b.offset + idx[i], b.offset + idx[i + 1]);
          if (mode === 2 && n > 2) lines.push(b.offset + idx[n - 1], b.offset + idx[0]);
          break;
        default:
          break; // POINTS: vertices only
      }
      if (mode === 5 || mode === 6) warn('Triangle strips/fans were converted to triangles');
      else if (mode === 0) warn('Point primitives were imported as loose vertices');
      else if (mode >= 1 && mode <= 3) warn('Line primitives were imported as loose edges');
    }
    if (degenerate) warn(`${degenerate} degenerate triangle(s) skipped`);
    if (positions.length === 0) return null;
    // colors (white where a block has none)
    let colors: number[] | null = null;
    if (blocks.some((bl) => bl.colors)) {
      colors = new Array<number>((positions.length / 3) * 4).fill(1);
      for (const bl of blocks) {
        if (!bl.colors) continue;
        for (let i = 0; i < bl.count; i++)
          for (let c = 0; c < bl.colorSize; c++)
            colors[(bl.offset + i) * 4 + c] = bl.colors[i * bl.colorSize + c];
      }
    }
    const faceEdges = new Set<string>();
    for (const f of faces) for (let i = 0; i < 3; i++) faceEdges.add(edgeKey(f[i], f[(i + 1) % 3]));
    const looseEdges: number[] = [];
    for (let i = 0; i < lines.length; i += 2) {
      const k = edgeKey(lines[i], lines[i + 1]);
      if (lines[i] === lines[i + 1] || faceEdges.has(k)) continue;
      faceEdges.add(k);
      looseEdges.push(lines[i], lines[i + 1]);
    }
    const onlyNone = slots.length === 0 || (slots.length === 1 && slots[0] === null);
    // morph targets → shape keys (relative to the basis = the mesh); NORMAL deltas are not needed
    // (normals are recomputed from the shapes)
    const names: unknown = (gm.extras as { targetNames?: unknown } | undefined)?.targetNames;
    const shapeKeys: ParsedMesh['shapeKeys'] = [];
    // shape keys are addressed by name (F-curve paths, relative keys): names must be unique
    const used = new Set<string>();
    for (let k = 0; k < targetCount; k++) {
      const shape = positions.slice();
      for (const bl of blocks) {
        const d = bl.targets[k];
        if (d) for (let i = 0; i < bl.count * 3; i++) shape[bl.offset * 3 + i] += d[i];
      }
      const given = Array.isArray(names) && typeof names[k] === 'string' ? (names[k] as string).trim() : '';
      let name = given || `Key ${k + 1}`;
      for (let n = 1; used.has(name); n++) name = `${given || `Key ${k + 1}`}.${String(n).padStart(3, '0')}`;
      used.add(name);
      const v = gm.weights?.[k];
      shapeKeys.push({ name, value: typeof v === 'number' && Number.isFinite(v) ? v : 0, positions: shape });
    }
    return {
      name: gm.name ?? '',
      shapeKeys,
      slots: onlyNone ? [] : slots,
      mesh: createMesh({
        positions,
        faces,
        faceMaterials: onlyNone ? faces.map(() => 0) : faceMaterials,
        faceSmooth,
        uvs: anyUV ? faceUV.map((u, f) => u ?? new Array<number>(faces[f].length * 2).fill(0)) : null,
        colors,
        looseEdges,
      }),
    };
  };

  // ---------------------------------------------------------------- materials
  const textureRef = (info: GltfTextureInfo | undefined): TextureRef | undefined => {
    if (!info || info.index === undefined || !json.textures?.[info.index]) return undefined;
    if (info.texCoord) warn('Textures using a second UV map were mapped to the first one');
    const tt = info.extensions?.KHR_texture_transform;
    const scale: Vec2 = tt?.scale ? [tt.scale[0], tt.scale[1]] : [1, 1];
    const off: number[] = tt?.offset ?? [0, 0];
    if (tt?.rotation) warn('Texture transform rotation is not supported');
    return { texture: info.index, scale, offset: [off[0], 1 - scale[1] - off[1]] };
  };

  const parseMaterial = (gm: GltfMaterial, index: number): ParsedMaterial => {
    const props: Partial<MaterialData> = { name: gm.name ?? `Material${index}` };
    const textures: ParsedMaterial['textures'] = {};
    const pbr = gm.pbrMetallicRoughness ?? {};
    const ext = gm.extensions ?? {};
    const bc = pbr.baseColorFactor ?? [1, 1, 1, 1];
    props.base_color = [bc[0], bc[1], bc[2], 1];
    props.alpha = gm.alphaMode === 'BLEND' || gm.alphaMode === 'MASK' ? clamp01(bc[3] ?? 1) : 1;
    props.metallic = clamp01(pbr.metallicFactor ?? 1);
    props.roughness = clamp01(pbr.roughnessFactor ?? 1);
    const sg = ext.KHR_materials_pbrSpecularGlossiness;
    if (sg && !gm.pbrMetallicRoughness) {
      const d = sg.diffuseFactor ?? [1, 1, 1, 1];
      props.base_color = [d[0], d[1], d[2], 1];
      props.metallic = 0;
      props.roughness = clamp01(1 - (sg.glossinessFactor ?? 1));
      const t = textureRef(sg.diffuseTexture);
      if (t) textures.base_color = t;
    }
    const base = textureRef(pbr.baseColorTexture);
    if (base) textures.base_color = base;
    const mr = textureRef(pbr.metallicRoughnessTexture);
    if (mr) {
      textures.metallic = mr;
      textures.roughness = mr;
    }
    const normal = textureRef(gm.normalTexture);
    if (normal) {
      textures.normal = normal;
      props.normal_strength = gm.normalTexture?.scale ?? 1;
    }
    const ef = gm.emissiveFactor ?? [0, 0, 0];
    const emissiveTex = textureRef(gm.emissiveTexture);
    if (ef[0] > 0 || ef[1] > 0 || ef[2] > 0) {
      props.emission_color = [ef[0], ef[1], ef[2]];
      props.emission_strength = ext.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
      if (emissiveTex) textures.emission = emissiveTex;
    }
    if (gm.alphaMode === 'MASK') {
      props.blend_method = 'CLIP';
      props.alpha_threshold = gm.alphaCutoff ?? 0.5;
    } else if (gm.alphaMode === 'BLEND') props.blend_method = 'BLEND';
    else props.blend_method = 'OPAQUE';
    props.use_backface_culling = !gm.doubleSided;
    if (ext.KHR_materials_transmission)
      props.transmission = clamp01(ext.KHR_materials_transmission.transmissionFactor ?? 0);
    if (ext.KHR_materials_ior) props.ior = ext.KHR_materials_ior.ior ?? 1.5;
    if (ext.KHR_materials_clearcoat) {
      props.coat_weight = clamp01(ext.KHR_materials_clearcoat.clearcoatFactor ?? 0);
      props.coat_roughness = clamp01(ext.KHR_materials_clearcoat.clearcoatRoughnessFactor ?? 0);
    }
    const sheen = ext.KHR_materials_sheen;
    if (sheen) {
      const c = sheen.sheenColorFactor ?? [0, 0, 0];
      const m = Math.max(c[0], c[1], c[2]);
      if (m > 0) {
        props.sheen_weight = 1;
        props.sheen_tint = [c[0] / m, c[1] / m, c[2] / m];
      }
    }
    if (ext.KHR_materials_unlit) {
      // emulate "unlit": the surface shows its base color regardless of lighting
      props.emission_color = [bc[0], bc[1], bc[2]];
      props.emission_strength = 1;
      props.base_color = [0, 0, 0, 1];
      if (textures.base_color) textures.emission = textures.base_color;
    }
    return { props, textures };
  };

  // ---------------------------------------------------------------- images
  const parseImage = (
    ii: number,
  ): { name: string; mime: string; width: number; height: number; data: Uint8Array } | null => {
    const im = json.images?.[ii];
    if (!im) return null;
    let bytes: Uint8Array | null = null;
    if (im.bufferView !== undefined) bytes = viewBytes(im.bufferView).slice();
    else if (im.uri?.startsWith('data:')) bytes = decodeDataUri(im.uri);
    else if (im.uri) {
      bytes = lookupFile(opts.files, im.uri);
      if (!bytes) warn(`External image '${im.uri}' was not provided`);
    }
    if (!bytes) return null;
    const info = readImageInfo(bytes);
    const mime = info?.mime ?? im.mimeType ?? sniffImageMime(bytes) ?? 'application/octet-stream';
    const fromUri =
      im.uri && !im.uri.startsWith('data:') ? decodeURIComponent(im.uri).split('/').pop() : undefined;
    return {
      name: im.name || fromUri || `Image${ii}`,
      mime,
      width: info?.width ?? 0,
      height: info?.height ?? 0,
      data: bytes,
    };
  };

  // ---------------------------------------------------------------- cameras / lights
  const renderSettings = doc.getRender();
  const docAspect =
    renderSettings.resolution_x > 0 && renderSettings.resolution_y > 0
      ? renderSettings.resolution_x / renderSettings.resolution_y
      : 16 / 9;
  const parseCamera = (c: GltfCamera, index: number): Partial<CameraData> => {
    const name = c.name ?? `Camera${index}`;
    if (c.type === 'orthographic' && c.orthographic) {
      const o = c.orthographic;
      return {
        name,
        type: 'ORTHO',
        ortho_scale: 2 * Math.max(Math.abs(o.xmag), Math.abs(o.ymag)) || 6,
        clip_start: Math.max(1e-6, o.znear ?? 0.1),
        clip_end: o.zfar ?? 1000,
      };
    }
    const p = c.perspective ?? { yfov: 0.6911, znear: 0.1 };
    const aspect = p.aspectRatio && p.aspectRatio > 0 ? p.aspectRatio : docAspect;
    return {
      name,
      type: 'PERSP',
      lens: lensFromFovY(p.yfov > 0 ? p.yfov : 0.6911, aspect, 36),
      sensor_width: 36,
      sensor_fit: 'AUTO',
      clip_start: Math.max(1e-6, p.znear ?? 0.1),
      clip_end: p.zfar && p.zfar > 0 ? p.zfar : 1000,
    };
  };
  const gltfLights: GltfLight[] = json.extensions?.KHR_lights_punctual?.lights ?? [];
  const parseLight = (l: GltfLight, index: number): Partial<LightData> => {
    const color = l.color ?? [1, 1, 1];
    const intensity = l.intensity ?? 1;
    const base: Partial<LightData> = {
      name: l.name ?? `Light${index}`,
      color: [color[0], color[1], color[2]],
      shadow_soft_size: 0,
    };
    if (l.type === 'directional') return { ...base, type: 'SUN', energy: intensity };
    if (l.type === 'spot') {
      const outer = l.spot?.outerConeAngle ?? Math.PI / 4;
      const inner = l.spot?.innerConeAngle ?? 0;
      return {
        ...base,
        type: 'SPOT',
        energy: intensity * 4 * Math.PI,
        spot_size: 2 * outer,
        spot_blend: outer > 0 ? clamp01((outer - inner) / outer) : 0,
      };
    }
    return { ...base, type: 'POINT', energy: intensity * 4 * Math.PI };
  };

  // ---------------------------------------------------------------- node tree
  const nodes = json.nodes ?? [];
  let rootIndices: number[];
  const sceneIndex = json.scene ?? 0;
  if (json.scenes && json.scenes.length)
    rootIndices = json.scenes[sceneIndex]?.nodes ?? json.scenes[0].nodes ?? [];
  else {
    const isChild = new Set<number>();
    for (const n of nodes) for (const c of n.children ?? []) isChild.add(c);
    rootIndices = nodes.map((_, i) => i).filter((i) => !isChild.has(i));
  }
  if (json.scenes && json.scenes.length > 1)
    warn(`File has ${json.scenes.length} scenes; only scene ${sceneIndex} was imported`);
  const seenNodes = new Set<number>();
  const parseNode = (ni: number): ParsedNode | null => {
    const n = nodes[ni];
    if (!n) return null;
    if (seenNodes.has(ni)) {
      warn('Nodes with multiple parents were imported once');
      return null;
    }
    seenNodes.add(ni);
    if (n.skin !== undefined)
      warn(
        `Skin of node '${n.name ?? ni}' not imported: the mesh is placed as stored in the file (bind pose, not deformed by its joints, which become empties)`,
      );
    let trs: TRS | null = null;
    let matrix: number[] | null = null;
    if (n.matrix && n.matrix.length === 16) matrix = n.matrix;
    else {
      const t = n.translation ?? [0, 0, 0];
      const r = n.rotation ?? [0, 0, 0, 1];
      const s = n.scale ?? [1, 1, 1];
      trs = { t: [t[0], t[1], t[2]], q: normalizeQuat([r[0], r[1], r[2], r[3]]), s: [s[0], s[1], s[2]] };
    }
    const light = n.extensions?.KHR_lights_punctual?.light;
    return {
      index: ni,
      name: n.name,
      trs,
      matrix,
      mesh: n.mesh,
      weights: Array.isArray(n.weights) ? n.weights : undefined,
      camera: n.camera !== undefined && json.cameras?.[n.camera] ? n.camera : undefined,
      light: typeof light === 'number' && gltfLights[light] ? light : undefined,
      extras: n.extras,
      children: (n.children ?? []).map(parseNode).filter((c): c is ParsedNode => !!c),
    };
  };
  const roots = rootIndices.map(parseNode).filter((n): n is ParsedNode => !!n);

  // ---------------------------------------------------------------- parse referenced data up front
  const meshes = new Map<number, ParsedMesh | null>();
  const walk = (n: ParsedNode) => {
    if (n.mesh !== undefined && !meshes.has(n.mesh)) {
      let pm: ParsedMesh | null = null;
      try {
        pm = parseMesh(n.mesh);
      } catch (err) {
        warn(
          `Mesh '${json.meshes?.[n.mesh]?.name ?? n.mesh}' skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      meshes.set(n.mesh, pm);
    }
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  const materials = new Map<number, ParsedMaterial>();
  for (const pm of meshes.values())
    for (const s of pm?.slots ?? [])
      if (s !== null && !materials.has(s)) {
        const gm = json.materials?.[s];
        if (gm) materials.set(s, parseMaterial(gm, s));
      }
  const images = new Map<number, ReturnType<typeof parseImage>>();
  for (const pm of materials.values())
    for (const ref of Object.values(pm.textures)) {
      const tex = json.textures?.[ref!.texture];
      const src =
        tex?.source ??
        tex?.extensions?.EXT_texture_webp?.source ??
        tex?.extensions?.KHR_texture_basisu?.source;
      if (src !== undefined && !images.has(src)) {
        try {
          images.set(src, parseImage(src));
        } catch (err) {
          warn(`Image ${src} skipped: ${err instanceof Error ? err.message : String(err)}`);
          images.set(src, null);
        }
      }
    }
  const channels: ParsedChannel[] = [];
  for (const anim of json.animations ?? []) {
    for (const ch of anim.channels ?? []) {
      const path = ch.target?.path;
      if (ch.target?.node === undefined) continue;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale' && path !== 'weights') {
        warn(`Animation path '${path}' is not supported`);
        continue;
      }
      const sampler = anim.samplers?.[ch.sampler];
      if (!sampler) continue;
      let input: ReturnType<typeof readAccessor>;
      let output: ReturnType<typeof readAccessor>;
      try {
        input = readAccessor(sampler.input);
        output = readAccessor(sampler.output);
      } catch (err) {
        warn(`Animation channel skipped: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const keys = input.count;
      const cubic = sampler.interpolation === 'CUBICSPLINE';
      // weights: one value per morph target and key (CUBICSPLINE: in-tangent, value, out-tangent)
      const size =
        path === 'rotation'
          ? 4
          : path === 'weights'
            ? Math.round(output.values.length / (Math.max(1, keys) * (cubic ? 3 : 1)))
            : 3;
      if (!(size > 0)) continue;
      const values = new Float64Array(keys * size);
      for (let k = 0; k < keys; k++)
        for (let c = 0; c < size; c++) {
          const src = cubic ? (k * 3 + 1) * size + c : k * size + c;
          values[k * size + c] = output.values[src] ?? 0;
        }
      channels.push({
        node: ch.target.node,
        path,
        times: input.values,
        values,
        interpolation: sampler.interpolation === 'STEP' ? 'CONSTANT' : cubic ? 'BEZIER' : 'LINEAR',
      });
    }
  }

  // ---------------------------------------------------------------- commit
  const offset = opts.location ?? [0, 0, 0];
  return doc.transact(() => {
    const objects: string[] = [];
    const imageIds = new Map<number, string | null>();
    const imageId = (texture: number): string | null => {
      const tex = json.textures?.[texture];
      const src =
        tex?.source ??
        tex?.extensions?.EXT_texture_webp?.source ??
        tex?.extensions?.KHR_texture_basisu?.source;
      if (src === undefined) return null;
      if (!imageIds.has(src)) {
        const im = images.get(src);
        imageIds.set(src, im ? doc.addImage(im) : null);
      }
      return imageIds.get(src)!;
    };
    const materialIds = new Map<number, string | null>();
    const materialId = (mi: number): string | null => {
      if (!materialIds.has(mi)) {
        const pm = materials.get(mi);
        let id: string | null = null;
        if (pm) {
          const textures: MaterialData['textures'] = {};
          for (const [ch, ref] of Object.entries(pm.textures)) {
            const img = imageId(ref!.texture);
            if (img)
              textures[ch as MaterialTextureChannel] = { image: img, scale: ref!.scale, offset: ref!.offset };
          }
          id = doc.addMaterial({ ...pm.props, textures });
        }
        materialIds.set(mi, id);
      }
      return materialIds.get(mi)!;
    };
    const meshIds = new Map<number, string>();
    const cameraIds = new Map<number, string>();
    const lightIds = new Map<number, string>();
    const cameraId = (ci: number) => {
      let id = cameraIds.get(ci);
      if (!id) cameraIds.set(ci, (id = doc.addCamera(parseCamera(json.cameras![ci], ci))));
      return id;
    };
    const lightId = (li: number) => {
      let id = lightIds.get(li);
      if (!id) lightIds.set(li, (id = doc.addLight(parseLight(gltfLights[li], li))));
      return id;
    };
    const nodeObject = new Map<number, { id: string; parentConverted: boolean; selfConverted: boolean }>();
    let firstCamera: string | null = null;
    /**
     * Shape keys of a parsed mesh (values: the weights of the first node using it, else the mesh's);
     * slider ranges cover the default and animated weights.
     */
    const shapeKeysOf = (pm: ParsedMesh, gltfMesh: number, nodeWeights?: number[]): ShapeKeyData[] => {
      const values = pm.shapeKeys.map((k, i) => {
        const w = nodeWeights?.length === pm.shapeKeys.length ? nodeWeights[i] : undefined;
        return typeof w === 'number' && Number.isFinite(w) ? w : k.value;
      });
      const lo = values.map((v) => Math.min(0, v));
      const hi = values.map((v) => Math.max(1, v));
      for (const ch of channels) {
        if (ch.path !== 'weights' || json.nodes?.[ch.node]?.mesh !== gltfMesh) continue;
        const n = pm.shapeKeys.length;
        for (let i = 0; i < ch.values.length; i++) {
          const k = i % n;
          if (k < lo.length) {
            lo[k] = Math.min(lo[k], ch.values[i]);
            hi[k] = Math.max(hi[k], ch.values[i]);
          }
        }
      }
      return pm.shapeKeys.map((k, i) => ({
        name: k.name,
        value: values[i],
        slider_min: Math.max(-10, lo[i]),
        slider_max: Math.min(10, hi[i]),
        mute: false,
        relative_key: '',
        data: encodeFloat32(k.positions),
      }));
    };

    const localTransform = (n: ParsedNode, parentConverted: boolean, selfConverted: boolean) => {
      if (n.trs) {
        const z = trsToZUp(n.trs, parentConverted, selfConverted);
        return { location: z.t, rotation_euler: eulerFromQuat(normalizeQuat(z.q)), scale: z.s };
      }
      let m: Mat4 = n.matrix!.slice();
      if (parentConverted) m = multiply4(M_Y_TO_Z, m);
      if (selfConverted) m = multiply4(m, M_Z_TO_Y);
      const d = decompose4(m);
      return { location: d.location, rotation_euler: d.rotation, scale: d.scale };
    };

    const customProps = (extras: unknown): Record<string, string | number | boolean> => {
      const out: Record<string, string | number | boolean> = {};
      if (extras && typeof extras === 'object' && !Array.isArray(extras))
        for (const [k, v] of Object.entries(extras as Record<string, unknown>))
          if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      return out;
    };

    const create = (n: ParsedNode, parent: string | null, parentConverted: boolean) => {
      const pm = n.mesh !== undefined ? meshes.get(n.mesh) : null;
      const type: ObjectType = pm
        ? 'MESH'
        : n.camera !== undefined
          ? 'CAMERA'
          : n.light !== undefined
            ? 'LIGHT'
            : 'EMPTY';
      const selfConverted = type === 'MESH' || type === 'EMPTY';
      const t = localTransform(n, parentConverted, selfConverted);
      if (!parent)
        t.location = [t.location[0] + offset[0], t.location[1] + offset[1], t.location[2] + offset[2]];
      let data: string | null = null;
      let slots: (string | null)[] = [];
      let dataName: string | undefined;
      if (type === 'MESH') {
        let mid = meshIds.get(n.mesh!);
        if (!mid) {
          meshIds.set(n.mesh!, (mid = doc.addMesh(pm!.name || n.name || opts.name || 'Mesh', pm!.mesh)));
          if (pm!.shapeKeys.length) doc.setShapeKeys(mid, shapeKeysOf(pm!, n.mesh!, n.weights));
        }
        data = mid;
        slots = pm!.slots.map((s) => (s === null ? null : materialId(s)));
        dataName = pm!.name || undefined;
      } else if (type === 'CAMERA') {
        data = cameraId(n.camera!);
        dataName = json.cameras![n.camera!].name;
      } else if (type === 'LIGHT') {
        data = lightId(n.light!);
        dataName = gltfLights[n.light!].name;
      }
      const fallback = type === 'MESH' ? 'Mesh' : type.charAt(0) + type.slice(1).toLowerCase();
      const id = doc.addObject({
        type,
        name: n.name || dataName || opts.name || fallback,
        parent,
        data,
        material_slots: slots,
        location: t.location,
        rotation_euler: t.rotation_euler,
        scale: t.scale,
        custom_props: customProps(n.extras),
      });
      objects.push(id);
      nodeObject.set(n.index, { id, parentConverted, selfConverted });
      if (type === 'CAMERA' && !firstCamera) firstCamera = id;
      // a node carrying several things: extra camera/light objects as children with the frame fix-up
      const attach = (kind: 'CAMERA' | 'LIGHT', dataId: string, name: string | undefined) => {
        const att = doc.addObject({
          type: kind,
          name: name || kind.charAt(0) + kind.slice(1).toLowerCase(),
          parent: id,
          data: dataId,
          rotation_euler: selfConverted ? [Math.PI / 2, 0, 0] : [0, 0, 0],
        });
        objects.push(att);
        if (kind === 'CAMERA' && !firstCamera) firstCamera = att;
      };
      if (n.camera !== undefined && type !== 'CAMERA')
        attach('CAMERA', cameraId(n.camera), json.cameras![n.camera].name ?? n.name);
      if (n.light !== undefined && type !== 'LIGHT')
        attach('LIGHT', lightId(n.light), gltfLights[n.light].name ?? n.name);
      for (const c of n.children) create(c, id, selfConverted);
    };
    for (const r of roots) create(r, null, true);

    // animation → fcurves (one key per sample)
    const scene = doc.getScene();
    const fps = scene.fps > 0 ? scene.fps : 24;
    const animated = new Set<string>();
    for (const ch of channels) {
      const target = nodeObject.get(ch.node);
      if (!target) continue;
      if (ch.path === 'weights') {
        // morph target weights → shape key values of the node's mesh
        const gm = json.nodes?.[ch.node]?.mesh;
        const meshId = gm !== undefined ? meshIds.get(gm) : undefined;
        const keysOf = meshId ? doc.getShapeKeys(meshId) : [];
        const n = keysOf.length;
        if (!meshId || !n || ch.values.length !== ch.times.length * n) {
          const node = json.nodes?.[ch.node]?.name ?? String(ch.node);
          warn(
            !meshId
              ? `Morph target weights animation of node '${node}' ignored: the node has no imported mesh`
              : !n
                ? `Morph target weights animation of node '${node}' ignored: its mesh has no morph targets`
                : `Morph target weights animation of node '${node}' ignored: ${ch.values.length / Math.max(1, ch.times.length)} values per key for ${n} morph targets`,
          );
          continue;
        }
        const k0 = `${meshId}:weights`;
        if (animated.has(k0)) {
          warn('Several animations target the same morph weights; only the first was imported');
          continue;
        }
        animated.add(k0);
        keysOf.forEach((key, k) => {
          const fc = createFCurve({
            target_type: 'mesh',
            target_id: meshId,
            path: `shape_keys[${JSON.stringify(key.name)}].value`,
            index: 0,
          });
          const keyframes: Keyframe[] = [];
          for (let i = 0; i < ch.times.length; i++)
            keyframes.push({
              frame: ch.times[i] * fps + scene.frame_start,
              value: ch.values[i * n + k],
              interpolation: ch.interpolation,
            });
          doc.setFCurve({ ...fc, keyframes });
        });
        continue;
      }
      const path =
        ch.path === 'translation' ? 'location' : ch.path === 'rotation' ? 'rotation_euler' : 'scale';
      const k = `${target.id}:${path}`;
      if (animated.has(k)) {
        warn('Several animations target the same property; only the first was imported');
        continue;
      }
      animated.add(k);
      const keys: Keyframe[][] = [[], [], []];
      let prev: Vec3 | null = null;
      for (let i = 0; i < ch.times.length; i++) {
        const frame = ch.times[i] * fps + scene.frame_start;
        let v: Vec3;
        if (ch.path === 'translation') {
          const t: Vec3 = [ch.values[i * 3], ch.values[i * 3 + 1], ch.values[i * 3 + 2]];
          v = target.parentConverted ? toZUp(t) : t;
        } else if (ch.path === 'scale') {
          const s: Vec3 = [ch.values[i * 3], ch.values[i * 3 + 1], ch.values[i * 3 + 2]];
          v = target.selfConverted ? [s[0], s[2], s[1]] : s;
        } else {
          const q: Quat = normalizeQuat([
            ch.values[i * 4],
            ch.values[i * 4 + 1],
            ch.values[i * 4 + 2],
            ch.values[i * 4 + 3],
          ]);
          const z = trsToZUp({ t: [0, 0, 0], q, s: [1, 1, 1] }, target.parentConverted, target.selfConverted);
          v = compatibleEuler(eulerFromQuat(normalizeQuat(z.q)), prev);
          prev = v;
        }
        for (let c = 0; c < 3; c++) keys[c].push({ frame, value: v[c], interpolation: ch.interpolation });
      }
      for (let c = 0; c < 3; c++) {
        const fc = createFCurve({ target_type: 'object', target_id: target.id, path, index: c });
        doc.setFCurve({ ...fc, keyframes: keys[c] });
      }
      if (path === 'rotation_euler' && keys[0].length) {
        // keep the stored rotation consistent with the first key (avoids a jump outside the range)
        doc.updateObject(target.id, {
          rotation_euler: [keys[0][0].value, keys[1][0].value, keys[2][0].value],
        });
      }
    }
    if (firstCamera && !doc.getScene().camera) doc.updateScene({ camera: firstCamera });
    if ((json.animations?.length ?? 0) > 0 && channels.length === 0) warn('Animations could not be imported');
    return { objects, warnings };
  });
}
