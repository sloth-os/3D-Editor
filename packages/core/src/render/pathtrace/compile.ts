import type { Mat4, Vec3 } from '../../math/types';
import { invert4 } from '../../math/mat4';
import type { CameraData, LightData, MaterialData, WorldSettings } from '../../doc/types';
import type { MeshData } from '../../mesh/types';
import { meshBounds } from '../../mesh/types';
import type { RenderItem } from '../../eval/renderables';
import type { SampledTexture } from '../raster';
import type { RenderView } from '../view';
import { buildBVH, type BVH } from './bvh';
import { buildCamera, type CameraModel } from './camera';
import { buildEnvironment, skySunLamp, type EnvironmentData } from './environment';
import { meshGeometry, type MeshGeometry } from './geometry';
import type { SceneInstances } from './intersect';
import {
  GROUP_ENV,
  GROUP_LAMP,
  GROUP_MESH,
  buildEmitterGroup,
  buildLamp,
  makeSunLamp,
  type EmitterGroup,
  type LampData,
} from './lights';
import { BLEND_OPAQUE, compileMaterial, defaultPTMaterial, type PTMaterial } from './material';

/** Everything the path tracer needs, as plain data (structured-cloneable, e.g. to a worker). */
export interface CompiledScene {
  geometries: MeshGeometry[];
  instances: CompiledInstances;
  /** Material index for every instance slot (see `slotBase` / `slotCount`). */
  slotMaterials: Int32Array;
  tlas: BVH;
  /** Material 0 is the default material (empty slots and objects without materials). */
  materials: PTMaterial[];
  images: (SampledTexture | null)[];
  lamps: LampData[];
  emitters: EmitterGroup[];
  /** Light groups for light selection: kind (lamp / mesh / environment) and index. */
  lightKinds: Int32Array;
  lightRefs: Int32Array;
  environment: EnvironmentData;
  camera: CameraModel;
  /** World bounds of all geometry (min xyz, max xyz), or null when empty. */
  bounds: number[] | null;
  /** Non-fatal problems (undecodable images, degenerate transforms, …). */
  warnings: string[];
}

export interface CompiledInstances extends SceneInstances {
  /** Index of the first slot of each instance in `slotMaterials`, and the slot count. */
  slotBase: Int32Array;
  slotCount: Int32Array;
  /** Generated-texture-coordinate box per instance (object space): min xyz, max xyz. */
  gen: Float64Array;
  /** Emitter group of each instance's emissive triangles, or −1. */
  emitGroup: Int32Array;
  /**
   * Index into `orcos` of each instance's undeformed positions (GENERATED texture coordinates),
   * or −1 when they are the geometry's own positions.
   */
  orco: Int32Array;
  /** Undeformed object-space position (xyz) of every render vertex of a geometry. */
  orcos: Float32Array[];
  /** Render item ids (object or instance ids). */
  ids: string[];
}

/** A light object of the evaluated scene. */
export interface SceneLight {
  id: string;
  light: LightData;
  matrix: Mat4;
}

export interface CompileInput {
  items: readonly RenderItem[];
  lights: readonly SceneLight[];
  world: WorldSettings;
  view: RenderView;
  /** Camera data of the view (enables depth of field), or null. */
  camera: CameraData | null;
  width: number;
  height: number;
  /** Decoded image datablock (sRGB RGBA8) or null when missing / unsupported. */
  image: (id: string) => SampledTexture | null;
  /**
   * Undeformed ("orco") object-space position of every vertex of an item's mesh (xyz per vertex,
   * see material/orco.ts), or null when the mesh positions are the orco. Asked only for items with
   * GENERATED procedural textures, so those stick to surfaces deformed by shape keys and deform
   * modifiers (default: the evaluated positions).
   */
  orco?: (item: RenderItem) => ArrayLike<number> | null;
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** True when the affine part of M is invertible and `inv` is a usable (finite) inverse. */
function isInvertible(M: Mat4, inv: Mat4): boolean {
  const det =
    M[0] * (M[5] * M[10] - M[6] * M[9]) -
    M[4] * (M[1] * M[10] - M[2] * M[9]) +
    M[8] * (M[1] * M[6] - M[2] * M[5]);
  if (!(Math.abs(det) > 0) || !inv.every(Number.isFinite)) return false;
  // reject numerically singular transforms (relative to the axis lengths)
  const sx = Math.hypot(M[0], M[1], M[2]);
  const sy = Math.hypot(M[4], M[5], M[6]);
  const sz = Math.hypot(M[8], M[9], M[10]);
  return Math.abs(det) > 1e-12 * sx * sy * sz;
}

/** Copy of a mesh with positions transformed to world space (for singular transforms). */
function bakeTransform(mesh: MeshData, M: Mat4): MeshData {
  const p = mesh.positions;
  const out = new Array<number>(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    const z = p[i + 2];
    out[i] = M[0] * x + M[4] * y + M[8] * z + M[12];
    out[i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
    out[i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
  }
  return { ...mesh, positions: out };
}

/** The name of a render item's object (the instanced object for instances), for warnings. */
function itemName(item: RenderItem): string {
  return item.object?.name ?? item.data?.name ?? item.id;
}

/** Objects named in the degenerate triangle warning at most. */
const MAX_NAMED = 8;

/**
 * The warning about degenerate (zero-area or non-finite) triangles, which the BVH skips, naming
 * the objects they belong to with their counts, most first, e.g. "4 degenerate triangle(s) skipped
 * (zero-area or non-finite faces of the render geometry; they do not render): 'Motto Plate' 4".
 * Objects sharing a mesh (linked duplicates, instances) are listed together with the mesh's count.
 * Null when there are none.
 */
function degenerateWarning(byGeometry: Map<MeshGeometry, Set<string>>): string | null {
  const found: { name: string; n: number }[] = [];
  let total = 0;
  for (const [g, names] of byGeometry) {
    total += g.skipped;
    found.push({ name: [...names].join("', '"), n: g.skipped });
  }
  if (!total) return null;
  found.sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const listed = found.slice(0, MAX_NAMED).map((f) => `'${f.name}' ${f.n}`);
  const more = found.length > MAX_NAMED ? `, and ${found.length - MAX_NAMED} more object(s)` : '';
  return (
    `${total} degenerate triangle(s) skipped (zero-area or non-finite faces of the render geometry; ` +
    `they do not render): ${listed.join(', ')}${more}`
  );
}

/** Builds the acceleration structures, materials, lights and environment of a scene. */
export function compileScene(input: CompileInput): CompiledScene {
  const warnings: string[] = [];
  // ---- images
  const images: (SampledTexture | null)[] = [];
  const imageIndex = new Map<string, number>();
  const failedImages = new Set<string>();
  const indexOfImage = (id: string): number => {
    let i = imageIndex.get(id);
    if (i === undefined) {
      let img: SampledTexture | null;
      try {
        img = input.image(id);
      } catch {
        img = null;
      }
      if (img && !(img.width > 0 && img.height > 0 && img.data.length >= img.width * img.height * 4))
        img = null;
      if (!img && !failedImages.has(id)) {
        failedImages.add(id);
        warnings.push(`Image '${id}' could not be decoded; its texture is ignored`);
      }
      i = img ? images.length : -1;
      if (img) images.push(img);
      imageIndex.set(id, i);
    }
    return i;
  };
  // ---- materials (0 = default)
  const materials: PTMaterial[] = [defaultPTMaterial()];
  const materialIndex = new Map<MaterialData, number>();
  const indexOfMaterial = (m: MaterialData | null): number => {
    if (!m) return 0;
    let i = materialIndex.get(m);
    if (i === undefined) {
      i = materials.length;
      materials.push(compileMaterial(m, indexOfImage));
      materialIndex.set(m, i);
    }
    return i;
  };
  // ---- geometry and instances
  const geometries: MeshGeometry[] = [];
  const geomIndex = new Map<MeshGeometry, number>();
  const genBoxes = new Map<MeshData, number[]>();
  // undeformed positions per render vertex, shared by the instances of one evaluated object
  const orcos: Float32Array[] = [];
  const orcoCache = new Map<ArrayLike<number>, { geom: MeshGeometry; index: number }>();
  const orcoFor = (item: RenderItem, mesh: MeshData, g: MeshGeometry): number => {
    let src: ArrayLike<number> | null;
    try {
      src = input.orco?.(item) ?? null;
    } catch {
      src = null;
    }
    if (!src || src.length !== mesh.positions.length) return -1;
    const hit = orcoCache.get(src);
    if (hit?.geom === g) return hit.index;
    const vs = g.vertexSource;
    const out = new Float32Array(vs.length * 3);
    for (let i = 0; i < vs.length; i++) {
      const s = vs[i] * 3;
      const x = src[s];
      const y = src[s + 1];
      const z = src[s + 2];
      if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return -1;
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    orcos.push(out);
    orcoCache.set(src, { geom: g, index: orcos.length - 1 });
    return orcos.length - 1;
  };
  type Inst = {
    item: RenderItem;
    geom: number;
    M: Mat4;
    inv: Mat4;
    slots: number[];
    gen: number[];
    orco: number;
  };
  const list: Inst[] = [];
  const degenerate = new Map<MeshGeometry, Set<string>>();
  for (const item of input.items) {
    let mesh = item.mesh;
    if (!mesh || !mesh.faces.length) continue;
    let M = item.worldMatrix;
    const name = itemName(item);
    if (!M || M.length < 16 || !M.every(Number.isFinite)) {
      warnings.push(`'${name}': invalid (non-finite) transform; not rendered`);
      continue;
    }
    let inv = invert4(M);
    let flat = false;
    if (!isInvertible(M, inv)) {
      // zero scale on an axis (e.g. a plane scaled flat): bake the transform into the geometry
      mesh = bakeTransform(mesh, M);
      M = IDENTITY;
      inv = IDENTITY;
      flat = true;
    }
    let g: MeshGeometry;
    try {
      g = meshGeometry(mesh);
    } catch (e) {
      warnings.push(`'${name}': mesh could not be prepared for rendering (${(e as Error).message})`);
      continue;
    }
    if (g.skipped > 0) {
      // degenerate triangles, named by object (a mesh shared by several objects counts once)
      let names = degenerate.get(g);
      if (!names) degenerate.set(g, (names = new Set()));
      names.add(flat ? `${name} (scaled flat)` : name);
    }
    if (g.triCount === 0) continue;
    let gi = geomIndex.get(g);
    if (gi === undefined) {
      gi = geometries.length;
      geometries.push(g);
      geomIndex.set(g, gi);
    }
    const base = item.object?.baseMesh ?? mesh;
    let gen = genBoxes.get(base);
    if (!gen) {
      const b = meshBounds(base);
      gen =
        b && b.min.every(Number.isFinite) && b.max.every(Number.isFinite)
          ? [...b.min, ...b.max]
          : [0, 0, 0, 1, 1, 1];
      genBoxes.set(base, gen);
    }
    const slots = item.materials.map(indexOfMaterial);
    const orco = slots.some((s) => materials[s].procedural?.usesGenerated) ? orcoFor(item, mesh, g) : -1;
    list.push({ item, geom: gi, M, inv, slots, gen, orco });
  }
  const n = list.length;
  const instances: CompiledInstances = {
    count: n,
    geom: new Int32Array(n),
    xform: new Float64Array(n * 12),
    inv: new Float64Array(n * 12),
    filtered: new Uint8Array(n),
    slotBase: new Int32Array(n),
    slotCount: new Int32Array(n),
    gen: new Float64Array(n * 6),
    emitGroup: new Int32Array(n).fill(-1),
    orco: Int32Array.from(list, (l) => l.orco),
    orcos,
    ids: list.map((l) => l.item.id),
  };
  const slotList: number[] = [];
  const boxes = new Float64Array(n * 6);
  const sceneMin: Vec3 = [Infinity, Infinity, Infinity];
  const sceneMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const { M, inv, geom, slots, gen } = list[i];
    instances.geom[i] = geom;
    const o = i * 12;
    const X = instances.xform;
    const I = instances.inv;
    const cols = [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14];
    for (let k = 0; k < 12; k++) {
      X[o + k] = M[cols[k]];
      I[o + k] = inv[cols[k]];
    }
    instances.slotBase[i] = slotList.length;
    instances.slotCount[i] = slots.length;
    slotList.push(...slots);
    instances.gen.set(gen, i * 6);
    const g = geometries[geom];
    // shadow rays ask about hits on (possibly) transparent and transmissive surfaces
    instances.filtered[i] = slots.some(
      (s) =>
        materials[s].transparent ||
        materials[s].transmissive ||
        (!!g.colors && materials[s].blend !== BLEND_OPAQUE),
    )
      ? 1
      : 0;
    // world bounds: transformed object-space box corners
    const b = g.bounds;
    let x0 = Infinity;
    let y0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let z1 = -Infinity;
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? b[3] : b[0];
      const y = c & 2 ? b[4] : b[1];
      const z = c & 4 ? b[5] : b[2];
      const wx = X[o] * x + X[o + 3] * y + X[o + 6] * z + X[o + 9];
      const wy = X[o + 1] * x + X[o + 4] * y + X[o + 7] * z + X[o + 10];
      const wz = X[o + 2] * x + X[o + 5] * y + X[o + 8] * z + X[o + 11];
      if (wx < x0) x0 = wx;
      if (wy < y0) y0 = wy;
      if (wz < z0) z0 = wz;
      if (wx > x1) x1 = wx;
      if (wy > y1) y1 = wy;
      if (wz > z1) z1 = wz;
    }
    // pad by a relative epsilon so flat objects keep a non-empty box under rounding
    const pad =
      1e-9 * (Math.abs(x0) + Math.abs(x1) + Math.abs(y0) + Math.abs(y1) + Math.abs(z0) + Math.abs(z1) + 1);
    boxes.set([x0 - pad, y0 - pad, z0 - pad, x1 + pad, y1 + pad, z1 + pad], i * 6);
    sceneMin[0] = Math.min(sceneMin[0], x0);
    sceneMin[1] = Math.min(sceneMin[1], y0);
    sceneMin[2] = Math.min(sceneMin[2], z0);
    sceneMax[0] = Math.max(sceneMax[0], x1);
    sceneMax[1] = Math.max(sceneMax[1], y1);
    sceneMax[2] = Math.max(sceneMax[2], z1);
  }
  const tlas = buildBVH(boxes, n, 2);
  const slotMaterials = Int32Array.from(slotList);
  const bounds = n ? [...sceneMin, ...sceneMax] : null;
  const sceneRadius = bounds
    ? Math.max(1, 0.5 * Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]))
    : 1;
  const named = degenerateWarning(degenerate);
  if (named) warnings.push(named);

  // ---- emissive meshes
  const emitters: EmitterGroup[] = [];
  for (let i = 0; i < n; i++) {
    const count = instances.slotCount[i];
    const base = instances.slotBase[i];
    const slotLum = new Float64Array(count);
    let any = false;
    for (let s = 0; s < count; s++) {
      const m = materials[slotMaterials[base + s]];
      // procedural emission colours are unknown here: assume mid grey for the light's weight
      const L = !m.emissive
        ? 0
        : m.procedural?.emission
          ? 0.5 * m.emissionStrength
          : lum(m.emitR, m.emitG, m.emitB);
      slotLum[s] = L > 0 ? L : 0;
      if (L > 0) any = true;
    }
    const def = materials[0];
    const defLum = def.emissive ? lum(def.emitR, def.emitG, def.emitB) : 0;
    if (!any && !(defLum > 0)) continue;
    const g = geometries[instances.geom[i]];
    const group = buildEmitterGroup(i, g, instances.xform, i * 12, slotLum, defLum);
    if (group) {
      instances.emitGroup[i] = emitters.length;
      emitters.push(group);
    }
  }

  // ---- lamps
  const lamps: LampData[] = [];
  for (const l of input.lights) {
    const lamp = buildLamp(l.id, l.light, l.matrix, sceneRadius);
    if (lamp) lamps.push(lamp);
  }
  const world = input.world;
  // the sun of a procedural sky is lit like a sun lamp (its disc only shows on the background)
  const skySun = skySunLamp(world);
  if (skySun) {
    const lamp = makeSunLamp('world:sun', skySun.direction, skySun.halfAngle, skySun.irradiance);
    if (lamp) lamps.push(lamp);
  }

  // ---- environment
  let envImage: SampledTexture | null = null;
  if (world.environment === 'IMAGE' && world.environment_image) {
    const idx = indexOfImage(world.environment_image);
    envImage = idx >= 0 ? images[idx] : null;
  }
  const environment = buildEnvironment({ world, image: envImage }, warnings);
  // Like the rasterizer: a scene without any light source and only a dark, flat world colour gets a
  // camera-relative studio rig so it is never just black (a bright world lights the scene itself).
  const c = environment.color;
  if (!input.lights.length && !emitters.length && environment.kind === 0 && lum(c[0], c[1], c[2]) < 0.1) {
    const v = input.view;
    const rig: [number, number, number, number][] = [
      [-0.45, 0.6, 0.65, 2.0],
      [0.75, 0.05, 0.6, 0.5],
      [0.15, 0.7, -0.7, 1.0],
    ];
    rig.forEach(([x, y, z, e], i) => {
      const d = [
        v.right[0] * x + v.up[0] * y - v.forward[0] * z,
        v.right[1] * x + v.up[1] * y - v.forward[1] * z,
        v.right[2] * x + v.up[2] * y - v.forward[2] * z,
      ];
      const lamp = makeSunLamp(`studio:${i}`, d, 0, [e, e, e]);
      if (lamp) lamps.push(lamp);
    });
    for (let c = 0; c < 3; c++) environment.color[c] += 0.03;
    environment.power = 4 * Math.PI * lum(environment.color[0], environment.color[1], environment.color[2]);
    environment.black = false;
  }

  // ---- light groups
  const kinds: number[] = [];
  const refs: number[] = [];
  lamps.forEach((_, i) => {
    kinds.push(GROUP_LAMP);
    refs.push(i);
  });
  emitters.forEach((_, i) => {
    kinds.push(GROUP_MESH);
    refs.push(i);
  });
  if (!environment.black) {
    kinds.push(GROUP_ENV);
    refs.push(0);
  }

  return {
    geometries,
    instances,
    slotMaterials,
    tlas,
    materials,
    images,
    lamps,
    emitters,
    lightKinds: Int32Array.from(kinds),
    lightRefs: Int32Array.from(refs),
    environment,
    camera: buildCamera(input.view, input.camera, input.width, input.height),
    bounds,
    warnings,
  };
}
