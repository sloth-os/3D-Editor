import type { Mat4, Quat, Vec3, Vec4 } from '../math/types';
import { compose4, decompose4, multiply4 } from '../math/mat4';
import { normalizeQuat, quatFromEuler } from '../math/quat';
import type { SceneDoc } from '../doc/scene-doc';
import type { CameraData, FCurve, LightData, MaterialData, ObjectData, TextureSlot } from '../doc/types';
import { evaluateFCurve } from '../anim/fcurve';
import { cameraFovY, orthoHalfExtents } from '../eval/camera';
import type { MeshData } from '../mesh/types';
import { buildRenderBuffers } from '../mesh/render-buffers';
import { base64Encode, stableStringify } from '../util/json';
import { trsToYUp, type TRS } from './axes';
import { utf8Encode } from './bytes';
import { collectExport, type ExportItem } from './common';
import { writeGLB } from './glb';
import {
  GL,
  TYPE_COMPONENTS,
  type GltfAccessor,
  type GltfAnimation,
  type GltfCamera,
  type GltfLight,
  type GltfMaterial,
  type GltfMesh,
  type GltfNode,
  type GltfPrimitive,
  type GltfRoot,
  type GltfTextureInfo,
} from './gltf-types';
import { sniffImageMime } from './image-info';
import type { ExportOptions, ExportResult } from './types';
import {
  bakeGeometryKey,
  bakeMaterialTextures,
  proceduralBakeNeedsGeometry,
  type BakeGeometry,
} from './bake-procedural';
import { hasProceduralTextures, proceduralSurface } from '../material/surface';
import { evaluatedOrco } from '../material/orco';
import { meshBounds } from '../mesh/types';
import { encodePNG, type PNGImage } from '../render/png';

/*
 * glTF 2.0 export (.glb binary container or .gltf with an embedded base64 buffer).
 *
 * - Axes: Z-up → Y-up per node (see axes.ts); mesh data is converted with its node.
 * - Hierarchy: only exported objects become nodes; an exported object whose parent is not exported
 *   becomes a root node carrying its world transform.
 * - Meshes: one primitive per material group (shared vertex attributes), TEXCOORD_0 with V flipped,
 *   loose edges as an extra LINES primitive.
 * - Lights (KHR_lights_punctual): point/spot intensity in candela = W / (4π) (the "unitless"
 *   convention used by Blender's compatibility mode); sun intensity = strength (lux, W/m² as-is);
 *   spot cone angles from spot_size/spot_blend; area lights become point lights (with a warning).
 * - Animation: object location/rotation/scale curves are sampled once per frame over the scene
 *   frame range at the scene fps (LINEAR; rotations as normalized, sign-continuous quaternions).
 * - Procedural texture slots are baked to PNG images in UV space (bake-procedural.ts); materials
 *   whose bake depends on the geometry (GENERATED/OBJECT mapping, bump) get one glTF material per
 *   distinct mesh content (identical meshes share one bake). Primitives without UVs cannot bind
 *   textures (no TEXCOORD_0): their materials carry constant procedural values as factors only.
 */

const ANIM_PATHS = ['location', 'rotation_euler', 'scale'] as const;
type AnimPath = (typeof ANIM_PATHS)[number];

class BinBuilder {
  private parts: Uint8Array[] = [];
  length = 0;

  /** Appends bytes at a 4-byte aligned offset; returns the offset. */
  add(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const offset = this.length;
    this.parts.push(bytes);
    this.length += bytes.length;
    return offset;
  }

  finish(): Uint8Array {
    const total = (this.length + 3) & ~3;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function isDefault(v: readonly number[], d: readonly number[], eps = 1e-9): boolean {
  return v.every((x, i) => Math.abs(x - d[i]) <= eps);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Cameras and lights keep their native local frame; everything else uses a converted frame. */
function convertedFrame(it: ExportItem): boolean {
  return !((it.ev.type === 'CAMERA' && it.ev.camera) || (it.ev.type === 'LIGHT' && it.ev.light));
}

function trsFromObject(o: Pick<ObjectData, 'location' | 'rotation_euler' | 'scale'>): TRS {
  return { t: [...o.location] as Vec3, q: quatFromEuler(o.rotation_euler), s: [...o.scale] as Vec3 };
}

function trsFromMatrix(m: Mat4): TRS {
  const d = decompose4(m);
  return { t: d.location, q: quatFromEuler(d.rotation), s: d.scale };
}

class GltfWriter {
  readonly json: GltfRoot = { asset: { version: '2.0', generator: '3D-Editor glTF exporter' } };
  readonly bin = new BinBuilder();
  readonly bufferViews: NonNullable<GltfRoot['bufferViews']> = [];
  readonly accessors: GltfAccessor[] = [];
  readonly extensionsUsed = new Set<string>();

  bufferView(bytes: Uint8Array, target?: number): number {
    const byteOffset = this.bin.add(bytes);
    this.bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, ...(target ? { target } : {}) });
    return this.bufferViews.length - 1;
  }

  accessor(
    data: Float32Array | Uint16Array | Uint32Array,
    type: GltfAccessor['type'],
    target?: number,
    minMax = false,
  ): number {
    const comps = TYPE_COMPONENTS[type];
    const componentType =
      data instanceof Float32Array
        ? GL.FLOAT
        : data instanceof Uint16Array
          ? GL.UNSIGNED_SHORT
          : GL.UNSIGNED_INT;
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const acc: GltfAccessor = {
      bufferView: this.bufferView(bytes, target),
      componentType,
      count: data.length / comps,
      type,
    };
    if (minMax && data.length) {
      const min = new Array<number>(comps).fill(Infinity);
      const max = new Array<number>(comps).fill(-Infinity);
      for (let i = 0; i < data.length; i += comps)
        for (let c = 0; c < comps; c++) {
          const v = data[i + c];
          if (v < min[c]) min[c] = v;
          if (v > max[c]) max[c] = v;
        }
      acc.min = min;
      acc.max = max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  indices(idx: ArrayLike<number>, vertexCount: number): number {
    const arr = vertexCount < 65535 ? Uint16Array.from(idx) : Uint32Array.from(idx);
    return this.accessor(arr, 'SCALAR', GL.ELEMENT_ARRAY_BUFFER);
  }
}

export function exportGLTF(doc: SceneDoc, opts: ExportOptions, binary: boolean): ExportResult {
  const warnings: string[] = [];
  const w = new GltfWriter();
  const { scene, items, ids } = collectExport(doc, opts);
  const json = w.json;
  const render = scene.render;
  const aspect =
    render.resolution_x > 0 && render.resolution_y > 0 ? render.resolution_x / render.resolution_y : 16 / 9;

  // ---------------------------------------------------------------- hierarchy (DFS order)
  const children = new Map<string | null, ExportItem[]>();
  for (const it of items) {
    const p = it.ev.data.parent;
    const key = p && ids.has(p) && p !== it.ev.id ? p : null;
    const list = children.get(key);
    if (list) list.push(it);
    else children.set(key, [it]);
  }
  const order: ExportItem[] = [];
  const nodeOf = new Map<string, number>();
  const dfsParent = new Map<string, string | null>();
  const visit = (it: ExportItem, parent: string | null) => {
    if (nodeOf.has(it.ev.id)) return;
    nodeOf.set(it.ev.id, order.length);
    dfsParent.set(it.ev.id, parent);
    order.push(it);
    for (const c of children.get(it.ev.id) ?? []) visit(c, it.ev.id);
  };
  for (const r of children.get(null) ?? []) visit(r, null);
  for (const it of items) visit(it, null); // objects unreachable from a root (parent cycles)
  const byId = new Map(items.map((it) => [it.ev.id, it]));
  const isRoot = (it: ExportItem) => !dfsParent.get(it.ev.id);
  const parentConverted = (it: ExportItem) => {
    const p = dfsParent.get(it.ev.id);
    return p ? convertedFrame(byId.get(p)!) : true;
  };

  // ---------------------------------------------------------------- images / textures / materials
  const textures: NonNullable<GltfRoot['textures']> = [];
  const images: NonNullable<GltfRoot['images']> = [];
  const textureOf = new Map<string, number>();
  const textureIndex = (imageId: string): number => {
    const cached = textureOf.get(imageId);
    if (cached !== undefined) return cached;
    let index = -1;
    const img = doc.getImage(imageId);
    const bytes = doc.getImageBytes(imageId);
    if (img && bytes && bytes.length) {
      const sniffed = sniffImageMime(bytes);
      const mime = sniffed ?? img.mime;
      if (mime === 'image/png' || mime === 'image/jpeg') {
        if (!json.samplers)
          json.samplers = [
            { magFilter: GL.LINEAR, minFilter: GL.LINEAR_MIPMAP_LINEAR, wrapS: GL.REPEAT, wrapT: GL.REPEAT },
          ];
        images.push({ name: img.name, mimeType: mime, bufferView: w.bufferView(bytes) });
        textures.push({ sampler: 0, source: images.length - 1 });
        index = textures.length - 1;
      } else warnings.push(`Image '${img.name}' (${mime}) is not PNG/JPEG and was not exported`);
    } else warnings.push(`Image ${imageId} has no data and was not exported`);
    textureOf.set(imageId, index);
    return index;
  };
  /** Embeds a baked RGBA8 image as a PNG texture; returns the texture index. */
  const pngTexture = (img: PNGImage, name: string): number => {
    if (!json.samplers)
      json.samplers = [
        { magFilter: GL.LINEAR, minFilter: GL.LINEAR_MIPMAP_LINEAR, wrapS: GL.REPEAT, wrapT: GL.REPEAT },
      ];
    images.push({ name, mimeType: 'image/png', bufferView: w.bufferView(encodePNG(img)) });
    textures.push({ sampler: 0, source: images.length - 1 });
    return textures.length - 1;
  };
  const textureInfo = (slot: TextureSlot | null | undefined): GltfTextureInfo | undefined => {
    // procedural slots are baked separately (see materialIndex)
    if (!slot || !slot.image || slot.procedural) return undefined;
    const index = textureIndex(slot.image);
    if (index < 0) return undefined;
    const info: GltfTextureInfo = { index };
    const sc = slot.scale ?? [1, 1];
    const of = slot.offset ?? [0, 0];
    if (!isDefault(sc, [1, 1]) || !isDefault(of, [0, 0])) {
      // editor UVs have V up; glTF flips V, so the offset is mirrored accordingly
      info.extensions = {
        KHR_texture_transform: { offset: [of[0], 1 - sc[1] - of[1]], scale: [sc[0], sc[1]] },
      };
      w.extensionsUsed.add('KHR_texture_transform');
    }
    return info;
  };

  const materials: GltfMaterial[] = [];
  const materialOf = new Map<string, number>();
  /** Texture indices and factors of one procedural bake, shared by equal materials on equal geometry. */
  interface BakeResult {
    baseColor?: number;
    baseColorFactor?: Vec4;
    metallicRoughness?: number;
    metallicFactor?: number;
    roughnessFactor?: number;
    normal?: number;
    emissive?: number;
    emissiveColor?: Vec3;
  }
  const bakes = new Map<string, BakeResult>();
  const bake = (m: MaterialData, it: ExportItem, hasUv: boolean): { result: BakeResult; key: string } => {
    // the bake depends on the geometry for GENERATED/OBJECT mappings and bumps: key it by content so
    // identical meshes (e.g. many copies of a cube) share one bake and one material
    let geometry: BakeGeometry = { mesh: it.mesh! };
    let geoKey = '';
    if (proceduralBakeNeedsGeometry(m)) {
      const tex = it.ev.baseMesh ? meshBounds(it.ev.baseMesh) : null;
      const orco =
        it.mesh === it.ev.mesh && proceduralSurface(m)?.usesGenerated
          ? evaluatedOrco(doc, scene, it.ev, true)
          : null;
      geometry = { mesh: it.mesh!, texMin: tex?.min, texMax: tex?.max, orco };
      geoKey = bakeGeometryKey(geometry);
    }
    const key = `${hasUv ? 'uv' : 'nouv'}|${geoKey}`;
    const bakeKey = `${stableStringify([
      m.textures,
      m.base_color,
      m.alpha,
      m.metallic,
      m.roughness,
      m.emission_strength,
      m.normal_strength,
    ])}|${key}`;
    let result = bakes.get(bakeKey);
    if (!result) {
      const baked = bakeMaterialTextures(m, geometry);
      warnings.push(...baked.warnings);
      result = {
        baseColor: baked.baseColor && pngTexture(baked.baseColor, `${m.name} base color`),
        baseColorFactor: baked.baseColorFactor,
        metallicRoughness:
          baked.metallicRoughness && pngTexture(baked.metallicRoughness, `${m.name} metallic roughness`),
        metallicFactor: baked.metallicFactor,
        roughnessFactor: baked.roughnessFactor,
        normal: baked.normal && pngTexture(baked.normal, `${m.name} normal`),
        emissive: baked.emissive && pngTexture(baked.emissive, `${m.name} emission`),
        emissiveColor: baked.emissiveColor,
      };
      bakes.set(bakeKey, result);
    }
    return { result, key };
  };
  const materialIndex = (m: MaterialData, it: ExportItem): number => {
    // glTF texture bindings need TEXCOORD_0: primitives without UVs get texture-less materials
    const hasUv = !!it.mesh?.uvs && it.mesh.faces.length > 0;
    const baked = hasProceduralTextures(m) && it.mesh ? bake(m, it, hasUv) : null;
    const key = `${m.id}|${baked ? baked.key : hasUv ? 'uv' : 'nouv'}`;
    const cached = materialOf.get(key);
    if (cached !== undefined) return cached;
    const b = baked?.result ?? null;
    const out: GltfMaterial = { name: m.name };
    const pbr: NonNullable<GltfMaterial['pbrMetallicRoughness']> = {};
    const bc = [
      clamp01(m.base_color[0]),
      clamp01(m.base_color[1]),
      clamp01(m.base_color[2]),
      clamp01((m.base_color[3] ?? 1) * m.alpha),
    ];
    if (!isDefault(bc, [1, 1, 1, 1])) pbr.baseColorFactor = bc;
    if (m.metallic !== 1) pbr.metallicFactor = clamp01(m.metallic);
    if (m.roughness !== 1) pbr.roughnessFactor = clamp01(m.roughness);
    const t = m.textures ?? {};
    // image textures (procedural slots are baked, see `bake`)
    let skippedImages = false;
    const imageTexture = (slot: TextureSlot | null | undefined): GltfTextureInfo | undefined => {
      if (!slot || !slot.image || slot.procedural) return undefined;
      if (!hasUv) {
        skippedImages = true;
        return undefined;
      }
      return textureInfo(slot);
    };
    const base = imageTexture(t.base_color);
    if (base) pbr.baseColorTexture = base;
    if (b?.baseColor !== undefined) pbr.baseColorTexture = { index: b.baseColor };
    if (b?.baseColorFactor) {
      const f = b.baseColorFactor.map(clamp01);
      if (isDefault(f, [1, 1, 1, 1])) delete pbr.baseColorFactor;
      else pbr.baseColorFactor = f;
    }
    const imageSlot = (slot: TextureSlot | null | undefined) =>
      slot?.image && !slot.procedural ? slot : undefined;
    const roughImage = imageSlot(t.roughness);
    const metalImage = imageSlot(t.metallic);
    if (roughImage && metalImage && roughImage.image !== metalImage.image)
      warnings.push(
        `Material '${m.name}': metallic and roughness textures must share one image in glTF; using the roughness texture`,
      );
    const mrInfo = imageTexture(roughImage ?? metalImage);
    if (mrInfo) pbr.metallicRoughnessTexture = mrInfo;
    if (b?.metallicRoughness !== undefined) {
      // absolute values in the texture (G = roughness, B = metallic), factors 1
      pbr.metallicRoughnessTexture = { index: b.metallicRoughness };
      delete pbr.metallicFactor;
      delete pbr.roughnessFactor;
    }
    // constant procedural channels (mesh without UVs)
    if (b?.metallicFactor !== undefined) pbr.metallicFactor = clamp01(b.metallicFactor);
    if (b?.roughnessFactor !== undefined) pbr.roughnessFactor = clamp01(b.roughnessFactor);
    if (pbr.metallicFactor === 1) delete pbr.metallicFactor;
    if (pbr.roughnessFactor === 1) delete pbr.roughnessFactor;
    out.pbrMetallicRoughness = pbr;
    const normal = imageTexture(t.normal);
    if (normal) {
      if (m.normal_strength !== 1) normal.scale = m.normal_strength;
      out.normalTexture = normal;
    }
    if (b?.normal !== undefined) out.normalTexture = { index: b.normal };
    // emission: factor in [0, 1], anything brighter goes to KHR_materials_emissive_strength
    // an emission texture replaces the emission color (like a texture plugged into Emission Color)
    const es = Math.max(0, m.emission_strength);
    const emissiveTex =
      es > 0
        ? b?.emissive !== undefined
          ? { index: b.emissive }
          : imageTexture(t.emission)
        : undefined;
    const ec: Vec3 = emissiveTex
      ? [1, 1, 1]
      : (b?.emissiveColor ?? [m.emission_color[0], m.emission_color[1], m.emission_color[2]]);
    if (skippedImages)
      warnings.push(
        `Material '${m.name}': image textures need UVs, but mesh '${it.ev.name}' has none; exported without them`,
      );
    const f: Vec3 = [Math.max(0, ec[0] * es), Math.max(0, ec[1] * es), Math.max(0, ec[2] * es)];
    const fmax = Math.max(f[0], f[1], f[2]);
    if (fmax > 0) {
      if (fmax <= 1) out.emissiveFactor = f;
      else {
        const cmax = Math.max(ec[0], ec[1], ec[2]);
        let strength: number;
        if (es > 1 && cmax <= 1) {
          out.emissiveFactor = [ec[0], ec[1], ec[2]];
          strength = es;
        } else {
          out.emissiveFactor = [f[0] / fmax, f[1] / fmax, f[2] / fmax];
          strength = fmax;
        }
        out.extensions = {
          ...out.extensions,
          KHR_materials_emissive_strength: { emissiveStrength: strength },
        };
        w.extensionsUsed.add('KHR_materials_emissive_strength');
      }
      if (emissiveTex) out.emissiveTexture = emissiveTex;
    }
    if (m.blend_method === 'CLIP') {
      out.alphaMode = 'MASK';
      if (m.alpha_threshold !== 0.5) out.alphaCutoff = Math.max(0, m.alpha_threshold);
    } else if (m.blend_method === 'BLEND') out.alphaMode = 'BLEND';
    if (!m.use_backface_culling) out.doubleSided = true;
    if (m.transmission > 0) {
      out.extensions = {
        ...out.extensions,
        KHR_materials_transmission: { transmissionFactor: clamp01(m.transmission) },
      };
      w.extensionsUsed.add('KHR_materials_transmission');
    }
    if (Math.abs(m.ior - 1.5) > 1e-6) {
      out.extensions = { ...out.extensions, KHR_materials_ior: { ior: Math.max(1, m.ior) } };
      w.extensionsUsed.add('KHR_materials_ior');
    }
    if (m.coat_weight > 0) {
      out.extensions = {
        ...out.extensions,
        KHR_materials_clearcoat: {
          clearcoatFactor: clamp01(m.coat_weight),
          clearcoatRoughnessFactor: clamp01(m.coat_roughness),
        },
      };
      w.extensionsUsed.add('KHR_materials_clearcoat');
    }
    materials.push(out);
    materialOf.set(key, materials.length - 1);
    return materials.length - 1;
  };

  // ---------------------------------------------------------------- meshes
  const meshes: GltfMesh[] = [];
  const meshOf = new Map<MeshData, Map<string, number>>();
  const exportMesh = (it: ExportItem): number | undefined => {
    const mesh = it.mesh!;
    const slotKey = it.materials.map((m) => m?.id ?? '-').join(',');
    let bySlots = meshOf.get(mesh);
    const cached = bySlots?.get(slotKey);
    if (cached !== undefined) return cached;
    const primitives: GltfPrimitive[] = [];
    const rb = mesh.faces.length ? buildRenderBuffers(mesh) : null;
    if (rb && rb.indices.length) {
      const nv = rb.positions.length / 3;
      const pos = new Float32Array(nv * 3);
      const nrm = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        pos[i * 3] = rb.positions[i * 3];
        pos[i * 3 + 1] = rb.positions[i * 3 + 2];
        pos[i * 3 + 2] = -rb.positions[i * 3 + 1];
        nrm[i * 3] = rb.normals[i * 3];
        nrm[i * 3 + 1] = rb.normals[i * 3 + 2];
        nrm[i * 3 + 2] = -rb.normals[i * 3 + 1];
      }
      const attributes: Record<string, number> = {
        POSITION: w.accessor(pos, 'VEC3', GL.ARRAY_BUFFER, true),
        NORMAL: w.accessor(nrm, 'VEC3', GL.ARRAY_BUFFER),
      };
      if (rb.uvs) {
        const uv = new Float32Array(nv * 2);
        for (let i = 0; i < nv; i++) {
          uv[i * 2] = rb.uvs[i * 2];
          uv[i * 2 + 1] = 1 - rb.uvs[i * 2 + 1];
        }
        attributes.TEXCOORD_0 = w.accessor(uv, 'VEC2', GL.ARRAY_BUFFER);
      }
      if (rb.colors) attributes.COLOR_0 = w.accessor(Float32Array.from(rb.colors), 'VEC4', GL.ARRAY_BUFFER);
      for (const g of rb.groups) {
        const prim: GltfPrimitive = {
          attributes,
          indices: w.indices(rb.indices.subarray(g.start, g.start + g.count), nv),
        };
        const mat = it.materials[g.materialIndex];
        if (mat) prim.material = materialIndex(mat, it);
        primitives.push(prim);
      }
    }
    if (mesh.looseEdges.length) {
      const remap = new Map<number, number>();
      const lp: number[] = [];
      const li: number[] = [];
      for (const v of mesh.looseEdges) {
        let i = remap.get(v);
        if (i === undefined) {
          i = remap.size;
          remap.set(v, i);
          lp.push(mesh.positions[v * 3], mesh.positions[v * 3 + 2], -mesh.positions[v * 3 + 1]);
        }
        li.push(i);
      }
      primitives.push({
        attributes: { POSITION: w.accessor(Float32Array.from(lp), 'VEC3', GL.ARRAY_BUFFER, true) },
        indices: w.indices(li, remap.size),
        mode: 1,
      });
    }
    if (!primitives.length) return undefined;
    const dataName = it.ev.data.data ? doc.getMeshBlock(it.ev.data.data)?.name : undefined;
    meshes.push({ name: dataName ?? it.ev.name, primitives });
    if (!bySlots) meshOf.set(mesh, (bySlots = new Map()));
    bySlots.set(slotKey, meshes.length - 1);
    return meshes.length - 1;
  };

  // ---------------------------------------------------------------- cameras / lights
  const cameras: GltfCamera[] = [];
  const cameraOf = new Map<string, number>();
  const cameraIndex = (cam: CameraData): number => {
    const cached = cameraOf.get(cam.id);
    if (cached !== undefined) return cached;
    const znear = Math.max(1e-6, cam.clip_start);
    const zfar = Math.max(znear * 1.0001, cam.clip_end);
    if (cam.shift_x || cam.shift_y)
      warnings.push(`Camera '${cam.name}': lens shift cannot be exported to glTF`);
    if (cam.type === 'ORTHO') {
      const { halfW, halfH } = orthoHalfExtents(cam, aspect);
      cameras.push({
        name: cam.name,
        type: 'orthographic',
        orthographic: { xmag: halfW, ymag: halfH, znear, zfar },
      });
    } else
      cameras.push({
        name: cam.name,
        type: 'perspective',
        perspective: { aspectRatio: aspect, yfov: cameraFovY(cam, aspect), znear, zfar },
      });
    cameraOf.set(cam.id, cameras.length - 1);
    return cameras.length - 1;
  };

  const lights: GltfLight[] = [];
  const lightOf = new Map<string, number>();
  const lightIndex = (l: LightData): number => {
    const cached = lightOf.get(l.id);
    if (cached !== undefined) return cached;
    const color = [Math.max(0, l.color[0]), Math.max(0, l.color[1]), Math.max(0, l.color[2])];
    let out: GltfLight;
    if (l.type === 'SUN')
      out = { name: l.name, type: 'directional', color, intensity: Math.max(0, l.energy) };
    else {
      const candela = Math.max(0, l.energy) / (4 * Math.PI);
      if (l.type === 'SPOT') {
        const outer = Math.min(Math.PI / 2, Math.max(1e-4, l.spot_size / 2));
        const inner = Math.max(0, Math.min(outer * (1 - clamp01(l.spot_blend)), outer * 0.9999));
        out = {
          name: l.name,
          type: 'spot',
          color,
          intensity: candela,
          spot: { innerConeAngle: inner, outerConeAngle: outer },
        };
      } else {
        if (l.type === 'AREA') warnings.push(`Area light '${l.name}' exported as a point light`);
        out = { name: l.name, type: 'point', color, intensity: candela };
      }
    }
    lights.push(out);
    w.extensionsUsed.add('KHR_lights_punctual');
    lightOf.set(l.id, lights.length - 1);
    return lights.length - 1;
  };

  // ---------------------------------------------------------------- nodes
  const nodes: GltfNode[] = [];
  for (const it of order) {
    const ev = it.ev;
    const rerooted = isRoot(it) && !!ev.data.parent;
    const local = rerooted ? trsFromMatrix(ev.worldMatrix) : trsFromObject(ev.data);
    const g = trsToYUp(local, parentConverted(it), convertedFrame(it));
    const node: GltfNode = { name: ev.name };
    if (!isDefault(g.t, [0, 0, 0])) node.translation = g.t;
    const q = normalizeQuat(g.q);
    if (!isDefault(q, [0, 0, 0, 1])) node.rotation = q;
    if (!isDefault(g.s, [1, 1, 1])) node.scale = g.s;
    const kids = (children.get(ev.id) ?? [])
      .filter((c) => dfsParent.get(c.ev.id) === ev.id)
      .map((c) => nodeOf.get(c.ev.id)!);
    if (kids.length) node.children = kids;
    if (it.mesh && (it.mesh.faces.length || it.mesh.looseEdges.length)) {
      const mi = exportMesh(it);
      if (mi !== undefined) node.mesh = mi;
    } else if (ev.type === 'CAMERA' && ev.camera) node.camera = cameraIndex(ev.camera);
    else if (ev.type === 'LIGHT' && ev.light)
      node.extensions = { KHR_lights_punctual: { light: lightIndex(ev.light) } };
    if (ev.data.custom_props && Object.keys(ev.data.custom_props).length)
      node.extras = { ...ev.data.custom_props };
    nodes.push(node);
  }

  // ---------------------------------------------------------------- animation
  const animation = exportAnimation(doc, w, order, nodeOf, isRoot, parentConverted);
  if (animation) json.animations = [animation];

  // ---------------------------------------------------------------- assemble
  if (!nodes.length) warnings.push('No objects to export');
  const rootNodes = order.filter(isRoot).map((it) => nodeOf.get(it.ev.id)!);
  json.scene = 0;
  json.scenes = [
    rootNodes.length ? { name: scene.scene.name, nodes: rootNodes } : { name: scene.scene.name },
  ];
  if (nodes.length) json.nodes = nodes;
  if (meshes.length) json.meshes = meshes;
  if (materials.length) json.materials = materials;
  if (textures.length) json.textures = textures;
  if (images.length) json.images = images;
  if (cameras.length) json.cameras = cameras;
  if (lights.length) json.extensions = { KHR_lights_punctual: { lights } };
  if (w.accessors.length) json.accessors = w.accessors;
  if (w.bufferViews.length) json.bufferViews = w.bufferViews;
  if (w.extensionsUsed.size) json.extensionsUsed = [...w.extensionsUsed].sort();
  const bin = w.bin.length ? w.bin.finish() : null;
  if (binary) {
    if (bin) json.buffers = [{ byteLength: bin.length }];
    return { data: writeGLB(json, bin), mime: 'model/gltf-binary', extension: 'glb', warnings };
  }
  if (bin)
    json.buffers = [
      { byteLength: bin.length, uri: `data:application/octet-stream;base64,${base64Encode(bin)}` },
    ];
  return { data: utf8Encode(JSON.stringify(json)), mime: 'model/gltf+json', extension: 'gltf', warnings };
}

/** Samples animated object transforms once per frame over the scene range. */
function exportAnimation(
  doc: SceneDoc,
  w: GltfWriter,
  order: ExportItem[],
  nodeOf: Map<string, number>,
  isRoot: (it: ExportItem) => boolean,
  parentConverted: (it: ExportItem) => boolean,
): GltfAnimation | null {
  const curves = new Map<string, FCurve[]>();
  for (const fc of doc.listFCurves()) {
    if (
      fc.target_type !== 'object' ||
      fc.mute ||
      !fc.keyframes.length ||
      !(ANIM_PATHS as readonly string[]).includes(fc.path)
    )
      continue;
    const list = curves.get(fc.target_id);
    if (list) list.push(fc);
    else curves.set(fc.target_id, [fc]);
  }
  if (!curves.size) return null;
  const sceneSettings = doc.getScene();
  const fps = sceneSettings.fps > 0 ? sceneSettings.fps : 24;
  const start = Math.round(sceneSettings.frame_start);
  const end = Math.max(start, Math.round(sceneSettings.frame_end));
  const objCache = new Map<string, ObjectData | null>();
  const getObj = (id: string) => {
    if (!objCache.has(id)) objCache.set(id, doc.getObject(id));
    return objCache.get(id)!;
  };
  const animatedLocal = (
    o: ObjectData,
    frame: number,
  ): Pick<ObjectData, 'location' | 'rotation_euler' | 'scale'> => {
    const location: Vec3 = [...o.location];
    const rotation_euler: Vec3 = [...o.rotation_euler];
    const scale: Vec3 = [...o.scale];
    for (const fc of curves.get(o.id) ?? []) {
      const v = evaluateFCurve(fc, frame);
      if (v === undefined || fc.index < 0 || fc.index > 2) continue;
      (fc.path === 'location' ? location : fc.path === 'rotation_euler' ? rotation_euler : scale)[fc.index] =
        v;
    }
    return { location, rotation_euler, scale };
  };
  const animatedMatrix = (o: ObjectData, frame: number): Mat4 => {
    const l = animatedLocal(o, frame);
    return compose4(l.location, l.rotation_euler, l.scale);
  };

  interface Track {
    node: number;
    paths: Set<AnimPath>;
    it: ExportItem;
    chain: ObjectData[];
  }
  const tracks: Track[] = [];
  for (const it of order) {
    const o = getObj(it.ev.id);
    if (!o) continue;
    const rerooted = isRoot(it) && !!o.parent;
    const chain: ObjectData[] = [o];
    if (rerooted) {
      const seen = new Set([o.id]);
      let p = o.parent ? getObj(o.parent) : null;
      while (p && !seen.has(p.id)) {
        seen.add(p.id);
        chain.unshift(p);
        p = p.parent ? getObj(p.parent) : null;
      }
    }
    const paths = new Set<AnimPath>();
    if (rerooted && chain.some((c) => c !== o && curves.has(c.id))) for (const p of ANIM_PATHS) paths.add(p);
    for (const fc of curves.get(o.id) ?? []) paths.add(fc.path as AnimPath);
    if (paths.size) tracks.push({ node: nodeOf.get(it.ev.id)!, paths, it, chain });
  }
  if (!tracks.length) return null;

  const frames = end - start + 1;
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i++) times[i] = i / fps;
  const input = w.accessor(times, 'SCALAR', undefined, true);
  const anim: GltfAnimation = { name: sceneSettings.name || 'Animation', channels: [], samplers: [] };
  for (const tr of tracks) {
    const t = new Float32Array(frames * 3);
    const r = new Float32Array(frames * 4);
    const s = new Float32Array(frames * 3);
    let prev: Quat | null = null;
    const pc = parentConverted(tr.it);
    const sc = convertedFrame(tr.it);
    for (let i = 0; i < frames; i++) {
      const frame = start + i;
      let local: TRS;
      if (tr.chain.length === 1) local = trsFromObject(animatedLocal(tr.chain[0], frame));
      else {
        let m = animatedMatrix(tr.chain[0], frame);
        for (let k = 1; k < tr.chain.length; k++) m = multiply4(m, animatedMatrix(tr.chain[k], frame));
        local = trsFromMatrix(m);
      }
      const g = trsToYUp(local, pc, sc);
      let q = normalizeQuat(g.q);
      if (prev && prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3] < 0)
        q = [-q[0], -q[1], -q[2], -q[3]];
      prev = q;
      t.set(g.t, i * 3);
      r.set(q, i * 4);
      s.set(g.s, i * 3);
    }
    const add = (path: string, data: Float32Array, type: 'VEC3' | 'VEC4') => {
      anim.samplers.push({ input, output: w.accessor(data, type), interpolation: 'LINEAR' });
      anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: tr.node, path } });
    };
    if (tr.paths.has('location')) add('translation', t, 'VEC3');
    if (tr.paths.has('rotation_euler')) add('rotation', r, 'VEC4');
    if (tr.paths.has('scale')) add('scale', s, 'VEC3');
  }
  return anim;
}
