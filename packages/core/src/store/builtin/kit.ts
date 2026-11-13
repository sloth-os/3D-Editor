import { z } from 'zod';
import type { Mat4, Vec3 } from '../../math/types';
import { compose4, multiply4 } from '../../math/mat4';
import type { SceneDoc } from '../../doc/scene-doc';
import type { MaterialData } from '../../doc/types';
import { defaultMaterial } from '../../doc/defaults';
import { FrameState } from '../../eval/frame-state';
import type { MeshData } from '../../mesh/types';
import { OperatorError } from '../../operators/context';
import { srgbToLinear } from '../../render/color';
import {
  MeshBuilder,
  addBox,
  addLathe,
  addRingSurface,
  markSharpEdges,
  type SurfaceOpts,
} from '../../generate/builder';
import type { GeneratorResult } from '../../generate/types';
import type { BuiltinBuildOptions, BuiltinBuildResult, CatalogEntry, StoreCategory } from '../types';

/*
 * The kit every built-in model is assembled with (store/builtin/*.ts): a model is a list of named
 * mesh parts in model space (metres, Z up, front −Y, base centre at the origin), each with its own
 * materials; `assembleModel` adds them under an EMPTY root and honours the build options of spec §10
 * (location of the base centre, turn about Z, real size or the size asked for, main colour, name)
 * the same way for every model. `defineModel` turns a model definition into a CatalogEntry. A few
 * geometry helpers the generators lack (rounded boxes, cylinders, tori, face painting) live here too.
 * What every built-in list shares (CATALOG-B's kit in architecture.ts too): the materials matched by
 * their whole definition (storeMaterialId), the measure of a model in world space (meshWorldBounds)
 * and whether a model takes the `color` option (takesColor).
 */

/** Licence and attribution custom properties a built-in model's root carries (spec §2). */
export const BUILTIN_ROOT_PROPS = {
  store_source: 'builtin',
  license: 'CC0-1.0',
  author: '3D Editor built-in',
} as const;

/** What a build made (its root first) and the warnings store.add reports: sizes or a colour it ignored. */
export interface BuiltModel extends BuiltinBuildResult {
  warnings: string[];
}

/** The warning of a build given a `color` that no material of the model takes. */
export function colorIgnored(id: string): string {
  return `'${id}' has no recolourable material; color ignored`;
}

// ---------------------------------------------------------------- measures

/**
 * World bounds (and their width, depth and height) and the triangles of the mesh objects among
 * `ids`, as frame `frame` evaluates them: parents, bones and their poses, constraints and animation
 * applied (an actor's parts hang from bones). Null when they hold no vertex.
 */
export function meshWorldBounds(
  doc: SceneDoc,
  ids: readonly string[],
  frame: number,
): { min: Vec3; max: Vec3; size: Vec3; triangles: number } | null {
  const fs = new FrameState(doc, Number.isFinite(frame) ? frame : doc.getScene().frame_start);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let any = false;
  for (const id of ids) {
    const o = doc.getObject(id);
    if (!o || o.type !== 'MESH' || !o.data) continue;
    const mesh = doc.getMesh(o.data);
    const m = mesh ? fs.world(id) : null;
    if (!mesh || !m) continue;
    for (const f of mesh.faces) triangles += Math.max(0, f.length - 2);
    const P = mesh.positions;
    for (let i = 0; i + 2 < P.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const w = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
        if (w < min[k]) min[k] = w;
        if (w > max[k]) max[k] = w;
      }
      any = true;
    }
  }
  if (!any) return null;
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], triangles };
}

// ---------------------------------------------------------------- materials

/** Strict equality of material field values (numbers, strings, arrays, plain objects). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** A stable text of a value (object keys sorted), for cache keys. */
function stableText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableText).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableText((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Id of the document's material for the definition `init` (the fields a built-in model gives it):
 * a material with exactly these fields, under this name or this name with the document's '.001'
 * suffix, which only an earlier built-in model makes; else a new material. Materials are matched by
 * their whole definition, never by name alone: two models whose materials share a name keep their
 * own colours whatever was added before them, and a material someone edited (or a user's own of
 * that name) is left alone, the new one getting a suffixed name. `cache` keeps what one build found.
 */
export function storeMaterialId(
  doc: SceneDoc,
  init: Partial<MaterialData> & { name: string },
  cache: Map<string, string>,
): string {
  const given = Object.fromEntries(
    Object.entries(init).filter(([k, v]) => v !== undefined && k !== 'id'),
  ) as Partial<MaterialData> & { name: string };
  const { id: _id, name: _name, ...want } = { ...defaultMaterial('', given.name), ...given };
  const key = `${given.name}\u0000${stableText(want)}`;
  const hit = cache.get(key);
  if (hit && doc.getMaterial(hit)) return hit;
  const named = new RegExp(`^${escapeRegExp(given.name)}(\\.\\d{3,})?$`);
  const fields = Object.keys(want) as (keyof typeof want)[];
  for (const m of doc.listMaterials()) {
    if (!named.test(m.name) || !fields.every((k) => sameValue(m[k], want[k]))) continue;
    cache.set(key, m.id);
    return m.id;
  }
  const id = doc.addMaterial(given);
  cache.set(key, id);
  return id;
}

/** A part's material: a principled material shared by the models that define it the same way. */
export interface ModelMaterial {
  name: string;
  /** '#rrggbb' (sRGB) or linear RGB. */
  color: string | readonly [number, number, number];
  roughness: number;
  metallic?: number;
  /** Glass-like transmission (0..1). */
  transmission?: number;
  ior?: number;
  /** Below 1: alpha-blended. */
  alpha?: number;
  /** Emission colour ('#rrggbb') and strength, for lamps and screens. */
  emission?: { color: string; strength: number };
  /** Coat (varnish, lacquer, glaze) weight 0..1. */
  coat?: number;
  /** Sheen (fabric) weight 0..1. */
  sheen?: number;
  /** Takes the build's `color` option (the model's main colour). */
  tint?: boolean;
}

/** '#rrggbb' or '#rgb' (sRGB) as linear RGB; null when it is not a colour. */
export function hexToLinear(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
}

function linearColor(c: ModelMaterial['color']): [number, number, number] {
  if (typeof c === 'string') return hexToLinear(c) ?? [0.8, 0.8, 0.8];
  return [c[0], c[1], c[2]];
}

/** The material's fields as the document stores them. */
function materialInit(m: ModelMaterial, color: ModelMaterial['color']): Partial<MaterialData> {
  const rgb = linearColor(color);
  const alpha = m.alpha ?? 1;
  return {
    name: m.name,
    base_color: [rgb[0], rgb[1], rgb[2], 1],
    roughness: m.roughness,
    metallic: m.metallic ?? 0,
    ...(m.transmission ? { transmission: m.transmission } : {}),
    ...(m.ior !== undefined ? { ior: m.ior } : {}),
    ...(alpha < 1 ? { alpha, blend_method: 'BLEND' as const } : {}),
    ...(m.emission
      ? {
          emission_color: hexToLinear(m.emission.color) ?? [1, 1, 1],
          emission_strength: m.emission.strength,
        }
      : {}),
    ...(m.coat ? { coat_weight: m.coat } : {}),
    ...(m.sheen ? { sheen_weight: m.sheen } : {}),
  };
}

/**
 * Id of the material for `m` in the document (storeMaterialId: the same definition is shared, a
 * different one never). A tinted material given another colour is named after the colour
 * ('Fabric #3d8bff') so the models of the default colour keep theirs.
 */
function materialId(
  doc: SceneDoc,
  m: ModelMaterial,
  tint: string | undefined,
  cache: Map<string, string>,
): string {
  const recolor = !!(
    m.tint &&
    tint &&
    (typeof m.color !== 'string' || tint.toLowerCase() !== m.color.toLowerCase())
  );
  const name = recolor ? `${m.name} ${tint!.toLowerCase()}` : m.name;
  const init = materialInit({ ...m, name }, recolor ? tint! : m.color) as Partial<MaterialData> & {
    name: string;
  };
  return storeMaterialId(doc, init, cache);
}

/** `m` taking the build's `color` option (the model's main material). */
export const tinted = (m: ModelMaterial): ModelMaterial => ({ ...m, tint: true });

/** Entries whose build takes no `color` (no material of theirs is the main one): see takesColor. */
const NO_COLOR = new WeakSet<CatalogEntry>();

/** Records that `entry` takes no `color` option (its build warns with colorIgnored). */
export function markNoColor(entry: CatalogEntry): CatalogEntry {
  NO_COLOR.add(entry);
  return entry;
}

/**
 * Whether store.add's `color` option recolours a material of `entry` (the main colour of a model,
 * the body of an actor); otherwise the build warns and keeps the model's own colours.
 */
export function takesColor(entry: CatalogEntry): boolean {
  return !NO_COLOR.has(entry);
}

/** A generator's material (linear colours) as a model material. */
export function generatedMaterial(
  m: GeneratorResult['materials'][number],
  extra: Partial<ModelMaterial> = {},
): ModelMaterial {
  return {
    name: m.name,
    color: [m.base_color[0], m.base_color[1], m.base_color[2]],
    roughness: m.roughness,
    metallic: m.metallic,
    transmission: m.transmission,
    ior: m.ior,
    ...extra,
  };
}

// ---------------------------------------------------------------- parts and models

/** One named mesh part of a model, in model space unless it has a transform of its own. */
export interface ModelPart {
  name: string;
  mesh: MeshData;
  /** Material per slot (faces with material index i use materials[i]). */
  materials: ModelMaterial[];
  /** Transform relative to its parent (default: none). */
  location?: Vec3;
  rotation?: Vec3;
  /** Name of the part it hangs from (default: the root). */
  parent?: string;
}

export interface ModelGeometry {
  parts: ModelPart[];
}

/** A part from a MeshBuilder (sharp edges marked above `sharpAngle` radians when given). */
export function part(
  name: string,
  b: MeshBuilder,
  materials: ModelMaterial[],
  extra: Partial<Pick<ModelPart, 'location' | 'rotation' | 'parent'>> & { sharpAngle?: number } = {},
): ModelPart {
  const mesh = b.build();
  if (extra.sharpAngle !== undefined) markSharpEdges(mesh, extra.sharpAngle);
  return { name, mesh, materials, location: extra.location, rotation: extra.rotation, parent: extra.parent };
}

/** A generator's result as a part (its materials in slot order). */
export function generatedPart(name: string, res: GeneratorResult, materials?: ModelMaterial[]): ModelPart {
  return { name, mesh: res.mesh, materials: materials ?? res.materials.map((m) => generatedMaterial(m)) };
}

/** Triangles of a geometry (a polygon of n corners counts n − 2). */
export function geometryTriangles(g: ModelGeometry): number {
  let t = 0;
  for (const p of g.parts) for (const f of p.mesh.faces) t += Math.max(0, f.length - 2);
  return t;
}

const DEG = Math.PI / 180;
const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Each part's matrix in model space (its own transform after its parents'). */
function partMatrices(parts: readonly ModelPart[]): Mat4[] {
  const byName = new Map(parts.map((p, i) => [p.name, i]));
  const out: (Mat4 | undefined)[] = new Array(parts.length);
  const visiting = new Set<number>();
  const matrix = (i: number): Mat4 => {
    const done = out[i];
    if (done) return done;
    const p = parts[i];
    const local = compose4(p.location ?? [0, 0, 0], p.rotation ?? [0, 0, 0], [1, 1, 1]);
    const pi = p.parent !== undefined ? byName.get(p.parent) : undefined;
    let m = local;
    if (pi !== undefined && pi !== i && !visiting.has(pi)) {
      visiting.add(i);
      m = multiply4(matrix(pi), local);
      visiting.delete(i);
    }
    out[i] = m;
    return m;
  };
  return parts.map((_, i) => matrix(i));
}

/** The parts with every parent before its children (a part whose parent is unknown hangs from the root). */
function parentsFirst(parts: readonly ModelPart[]): ModelPart[] {
  const byName = new Map(parts.map((p, i) => [p.name, i]));
  const placed = new Set<number>();
  const order: ModelPart[] = [];
  const place = (i: number) => {
    if (placed.has(i)) return;
    placed.add(i);
    const pi = parts[i].parent !== undefined ? byName.get(parts[i].parent!) : undefined;
    if (pi !== undefined) place(pi);
    order.push(parts[i]);
  };
  parts.forEach((_, i) => place(i));
  return order;
}

/** Bounds of the parts in model space, or null when there is no geometry. */
export function geometryBounds(parts: readonly ModelPart[]): { min: Vec3; max: Vec3 } | null {
  const mats = partMatrices(parts);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let any = false;
  parts.forEach((p, i) => {
    const m = mats[i] ?? IDENTITY;
    const P = p.mesh.positions;
    for (let v = 0; v + 2 < P.length; v += 3) {
      for (let k = 0; k < 3; k++) {
        const w = m[k] * P[v] + m[4 + k] * P[v + 1] + m[8 + k] * P[v + 2] + m[12 + k];
        if (w < min[k]) min[k] = w;
        if (w > max[k]) max[k] = w;
      }
      any = true;
    }
  });
  return any ? { min, max } : null;
}

/** The size options of a build or an insert (metres; scale is a factor). */
export type SizeOptions = Pick<BuiltinBuildOptions, 'height_m' | 'width_m' | 'depth_m' | 'scale'>;

/**
 * Scale (x, y, z) that gives a model of size `natural` (width, depth, height) the sizes `o` asks for:
 * one size scales the model uniformly; several scale their axes to them and the other axes by the
 * geometric mean of their factors (proportions kept as far as the sizes allow); none: `scale`
 * (default 1). A size along an axis the model has no extent on is ignored (and reported).
 */
export function sizeScale(natural: Readonly<Vec3>, o: SizeOptions, warnings?: string[]): Vec3 {
  const want = [o.width_m, o.depth_m, o.height_m];
  const names = ['width_m', 'depth_m', 'height_m'];
  const factor: (number | null)[] = [null, null, null];
  for (let k = 0; k < 3; k++) {
    const w = want[k];
    if (w === undefined || w === null) continue;
    if (!(w > 0) || !Number.isFinite(w)) continue;
    if (!(natural[k] > 1e-9)) {
      warnings?.push(`${names[k]} ignored: the model has no extent along that axis`);
      continue;
    }
    factor[k] = w / natural[k];
  }
  const given = factor.filter((f): f is number => f !== null);
  if (!given.length) {
    const s = o.scale !== undefined && o.scale > 0 && Number.isFinite(o.scale) ? o.scale : 1;
    return [s, s, s];
  }
  // axes without a size: the one factor, or the geometric mean of the two (none left with three)
  const other = given.length === 1 ? given[0] : Math.sqrt(given[0] * given[1]);
  return factor.map((f) => f ?? other) as Vec3;
}

/** Where a build puts the base centre: the given location (finite numbers), else the origin. */
function locationOf(o: BuiltinBuildOptions): Vec3 {
  const l = o.location;
  return l && l.length >= 3 && l.every((v) => Number.isFinite(v)) ? [l[0], l[1], l[2]] : [0, 0, 0];
}

/**
 * Adds a model to the document: an EMPTY root named `o.name` (default `label`) standing at
 * `o.location` (its base centre), turned by `o.rotation_deg` about +Z and scaled to the asked size,
 * with the parts under it (part names as given; the document makes names unique). The parts are
 * moved so that the base centre of their bounds is the root's origin. `props` are custom properties
 * of the root. Returns the root and every object added (the root first).
 */
export function assembleModel(
  doc: SceneDoc,
  label: string,
  geometry: ModelGeometry,
  o: BuiltinBuildOptions,
  props: Record<string, string | number | boolean> = {},
  /** Catalog id named by the warning of a `color` no material takes (default: `label`). */
  id = label,
): BuiltModel {
  const parts = parentsFirst(geometry.parts.filter((p) => p.mesh.faces.length > 0));
  const bounds = geometryBounds(parts);
  if (!bounds) throw new OperatorError(`${label}: the model has no geometry`, 'FAILED');
  const warnings: string[] = [];
  if (o.color && !parts.some((p) => p.materials.some((m) => m.tint))) warnings.push(colorIgnored(id));
  const natural: Vec3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  const scale = sizeScale(natural, o, warnings);
  const base: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    bounds.min[2],
  ];
  const name = o.name?.trim() || label;
  const rot = Number.isFinite(o.rotation_deg) ? (o.rotation_deg as number) * DEG : 0;
  const tint = o.color && hexToLinear(o.color) ? o.color : undefined;
  const root = doc.addObject({
    type: 'EMPTY',
    name,
    location: locationOf(o),
    rotation_euler: [0, 0, rot],
    scale,
    empty_display_type: 'PLAIN_AXES',
    empty_display_size: Math.min(5, Math.max(0.05, Math.max(natural[0], natural[1]) * 0.6)),
    custom_props: { ...props },
  });
  const objects = [root];
  const ids = new Map<string, string>();
  const cache = new Map<string, string>();
  for (const p of parts) {
    const parentId = p.parent !== undefined ? ids.get(p.parent) : undefined;
    const loc = p.location ?? [0, 0, 0];
    const meshId = doc.addMesh(p.name, p.mesh);
    const id = doc.addObject({
      type: 'MESH',
      name: p.name,
      data: meshId,
      parent: parentId ?? root,
      // parts hanging from the root move with the base centre; deeper ones keep their offsets
      location: parentId ? [loc[0], loc[1], loc[2]] : [loc[0] - base[0], loc[1] - base[1], loc[2] - base[2]],
      rotation_euler: p.rotation ? [p.rotation[0], p.rotation[1], p.rotation[2]] : [0, 0, 0],
      material_slots: p.materials.map((m) => materialId(doc, m, tint, cache)),
      // the part's own name survives the document's '.001' suffixes (as CATALOG-B's parts)
      custom_props: { store_part: p.name },
    });
    ids.set(p.name, id);
    objects.push(id);
  }
  return { root, objects, warnings };
}

// ---------------------------------------------------------------- catalog entries

/** A built-in procedural model: its catalog fields and how to make its geometry. */
export interface ModelDef<S extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  name: string;
  category: StoreCategory;
  tags: string[];
  synonyms: string[];
  description: string;
  /** Width (X), depth (Y), height (Z) in metres at the default parameters. */
  dimensions_m: [number, number, number];
  /** Triangles at the default parameters. */
  triangles: number;
  params?: z.ZodObject<S>;
  /**
   * False when no material takes the `color` option (food in its own colours, a fire): store.add
   * then warns and search results say so (takesColor). Default: a tinted material takes it.
   */
  color?: false;
  geometry(p: z.output<z.ZodObject<S>>): ModelGeometry;
}

/** The parameters of a build checked by the model's schema (INVALID_PARAMS when they do not fit). */
export function parseModelParams<S extends z.ZodRawShape>(
  def: { id: string; params?: z.ZodObject<S> },
  params: Record<string, unknown> | undefined,
): z.output<z.ZodObject<S>> {
  const given = params ?? {};
  if (!def.params) {
    const keys = Object.keys(given);
    if (keys.length)
      throw new OperatorError(
        `Model '${def.id}' has no parameters (got ${keys.join(', ')})`,
        'INVALID_PARAMS',
      );
    return {} as z.output<z.ZodObject<S>>;
  }
  const r = def.params.strict().safeParse(given);
  if (!r.success)
    throw new OperatorError(
      `Invalid parameters for model '${def.id}': ${r.error.issues
        .map((i) => `${i.path.join('.') || 'params'}: ${i.message}`)
        .join('; ')}`,
      'INVALID_PARAMS',
    );
  return r.data as z.output<z.ZodObject<S>>;
}

/** A catalog entry built by the kit (root EMPTY + named parts; rig null). */
export function defineModel<S extends z.ZodRawShape>(def: ModelDef<S>): CatalogEntry {
  const entry: CatalogEntry = {
    id: def.id,
    name: def.name,
    category: def.category,
    tags: def.tags,
    synonyms: def.synonyms,
    description: def.description,
    dimensions_m: def.dimensions_m,
    triangles: def.triangles,
    rig: null,
    ...(def.params ? { params: def.params as unknown as z.ZodObject<z.ZodRawShape> } : {}),
    build(doc, o): BuiltModel {
      const p = parseModelParams(def, o.params);
      return assembleModel(
        doc,
        def.name,
        def.geometry(p),
        o,
        { store_id: `builtin:${def.id}`, ...BUILTIN_ROOT_PROPS },
        def.id,
      );
    },
  };
  return def.color === false ? markNoColor(entry) : entry;
}

/** A colour parameter ('#rrggbb'). */
export const colorParam = (fallback: string, what: string) =>
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default(fallback)
    .describe(`${what} as '#rrggbb' (default ${fallback})`);

// ---------------------------------------------------------------- geometry helpers

/**
 * Box with rounded edges and corners (radius `r`, clamped to half the smallest side), the shape of
 * cushions, mattresses and appliances: `cs` segments per rounded corner and edge. Smooth shaded.
 */
export function addRoundedBox(
  b: MeshBuilder,
  min: Readonly<Vec3>,
  max: Readonly<Vec3>,
  r: number,
  opts: SurfaceOpts & { cs?: number } = {},
): void {
  const hx = Math.abs(max[0] - min[0]) / 2;
  const hy = Math.abs(max[1] - min[1]) / 2;
  const hz = Math.abs(max[2] - min[2]) / 2;
  const c: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const rr = Math.max(0, Math.min(r, hx * 0.999, hy * 0.999, hz * 0.999));
  const cs = Math.max(1, Math.min(8, Math.floor(opts.cs ?? 3)));
  const ix = hx - rr;
  const iy = hy - rr;
  const iz = hz - rr;
  // a horizontal rounded rectangle of corner radius `rad` around the inner box, counter-clockwise
  const ring = (rad: number, z: number): Vec3[] => {
    const pts: Vec3[] = [];
    const corners: [number, number, number][] = [
      [ix, -iy, -Math.PI / 2],
      [ix, iy, 0],
      [-ix, iy, Math.PI / 2],
      [-ix, -iy, Math.PI],
    ];
    for (const [cx, cy, a0] of corners)
      for (let k = 0; k <= cs; k++) {
        const a = a0 + ((Math.PI / 2) * k) / cs;
        pts.push([c[0] + cx + rad * Math.cos(a), c[1] + cy + rad * Math.sin(a), c[2] + z]);
      }
    return pts;
  };
  if (rr < 1e-6) {
    addBox(b, min, max, opts);
    return;
  }
  // rings from the bottom face up: the bottom rounding (from just off the pole, where the ring would
  // collapse onto the inner rectangle, to the equator), then the top rounding; flat caps close it
  const POLE = 1e-3;
  const rings: Vec3[][] = [];
  const at = (a: number, zc: number) => rings.push(ring(rr * Math.cos(a), zc + rr * Math.sin(a)));
  at(-Math.PI / 2 + POLE, -iz);
  for (let k = 1; k <= cs; k++) at(-Math.PI / 2 + ((Math.PI / 2) * k) / cs, -iz);
  for (let k = 0; k < cs; k++) at(((Math.PI / 2) * k) / cs, iz);
  at(Math.PI / 2 - POLE, iz);
  addRingSurface(b, rings, { ...opts, smooth: opts.smooth ?? true, capStart: true, capEnd: true });
}

/** Closed cylinder along Z from z0 to z1 centred on (x, y). */
export function addCylinder(
  b: MeshBuilder,
  x: number,
  y: number,
  radius: number,
  z0: number,
  z1: number,
  segments: number,
  opts: SurfaceOpts = {},
): void {
  const start = b.vertexCount;
  addLathe(
    b,
    [
      [0, z0],
      [radius, z0],
      [radius, z1],
      [0, z1],
    ],
    segments,
    { smooth: true, ...opts },
  );
  if (x || y) offsetVerts(b, start, [x, y, 0]);
}

/** Torus around Z (major radius R, tube radius r) centred at `c`. */
export function addTorus(
  b: MeshBuilder,
  c: Readonly<Vec3>,
  R: number,
  r: number,
  segments: number,
  sides: number,
  opts: SurfaceOpts = {},
): void {
  const start = b.vertexCount;
  const prof: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    prof.push([R + r * Math.cos(a), r * Math.sin(a)]);
  }
  addLathe(b, prof, segments, { smooth: true, ...opts, loop: true });
  offsetVerts(b, start, c);
}

/** Moves the vertices added since `start` by `d`. */
export function offsetVerts(b: MeshBuilder, start: number, d: Readonly<Vec3>): void {
  const P = b.positions;
  for (let i = start * 3; i < P.length; i += 3) {
    P[i] += d[0];
    P[i + 1] += d[1];
    P[i + 2] += d[2];
  }
}

/** Applies `f` to the vertices added since `start` (in place). */
export function mapVerts(b: MeshBuilder, start: number, f: (p: Vec3) => Vec3): void {
  const P = b.positions;
  for (let i = start * 3; i < P.length; i += 3) {
    const q = f([P[i], P[i + 1], P[i + 2]]);
    P[i] = q[0];
    P[i + 1] = q[1];
    P[i + 2] = q[2];
  }
}

/** Sets the material of the faces added since face `start` from their centroid (`mat` returns a slot). */
export function paintFaces(
  b: MeshBuilder,
  start: number,
  mat: (centroid: Vec3, face: number) => number,
): void {
  const P = b.positions;
  for (let f = start; f < b.faces.length; f++) {
    const vs = b.faces[f];
    const c: Vec3 = [0, 0, 0];
    for (const v of vs) {
      c[0] += P[v * 3];
      c[1] += P[v * 3 + 1];
      c[2] += P[v * 3 + 2];
    }
    b.faceMats[f] = Math.max(0, Math.floor(mat([c[0] / vs.length, c[1] / vs.length, c[2] / vs.length], f)));
  }
}

/** Square leg along Z from z0 to z1 at (x, y), tapering from width w0 (bottom) to w1 (top). */
export function addLeg(
  b: MeshBuilder,
  x: number,
  y: number,
  z0: number,
  z1: number,
  w0: number,
  w1: number,
  opts: SurfaceOpts = {},
): void {
  const start = b.vertexCount;
  // a 4-sided lathe turned 45°: its corner radius is half the diagonal
  addLathe(
    b,
    [
      [0, z0],
      [w0 / Math.SQRT2, z0],
      [w1 / Math.SQRT2, z1],
      [0, z1],
    ],
    4,
    { ...opts, angle0: Math.PI / 4 },
  );
  offsetVerts(b, start, [x, y, 0]);
}

/** Round leg (cylinder or cone frustum) along Z at (x, y). */
export function addRoundLeg(
  b: MeshBuilder,
  x: number,
  y: number,
  z0: number,
  z1: number,
  r0: number,
  r1: number,
  segments: number,
  opts: SurfaceOpts = {},
): void {
  const start = b.vertexCount;
  addLathe(
    b,
    [
      [0, z0],
      [r0, z0],
      [r1, z1],
      [0, z1],
    ],
    segments,
    { smooth: true, ...opts },
  );
  offsetVerts(b, start, [x, y, 0]);
}

// ---------------------------------------------------------------- shared materials

/** Materials several built-in models share (by name, like the generators' MATERIALS). */
export const MATS = {
  oak: { name: 'Oak', color: '#a97e52', roughness: 0.5, coat: 0.15 },
  walnut: { name: 'Walnut', color: '#5b3b25', roughness: 0.45, coat: 0.2 },
  darkWood: { name: 'Dark Wood', color: '#3b281b', roughness: 0.55 },
  pine: { name: 'Pine', color: '#c9a173', roughness: 0.6 },
  whitePaint: { name: 'White Paint', color: '#e8e5de', roughness: 0.45 },
  steel: { name: 'Brushed Steel', color: '#b5b9be', roughness: 0.35, metallic: 1 },
  chrome: { name: 'Chrome', color: '#e3e6ea', roughness: 0.12, metallic: 1 },
  blackMetal: { name: 'Black Metal', color: '#26282b', roughness: 0.4, metallic: 1 },
  blackPlastic: { name: 'Black Plastic', color: '#1c1d20', roughness: 0.45 },
  greyPlastic: { name: 'Grey Plastic', color: '#8d9196', roughness: 0.5 },
  whitePlastic: { name: 'White Plastic', color: '#ecebe7', roughness: 0.35 },
  rubber: { name: 'Rubber Black', color: '#141414', roughness: 0.9 },
  ceramic: { name: 'Glazed Ceramic', color: '#f1eee8', roughness: 0.18, coat: 0.6 },
  // half opaque with a slight cool tint, so that it reads against a light background in RASTER
  glass: { name: 'Clear Glass', color: '#dce8ee', roughness: 0.03, transmission: 1, ior: 1.45, alpha: 0.5 },
  /** The lip and foot of drinking glasses: a brighter, near-opaque edge that outlines them. */
  glassEdge: {
    name: 'Glass Edge',
    color: '#f4f8fa',
    roughness: 0.05,
    transmission: 0.5,
    ior: 1.45,
    alpha: 0.85,
  },
  linen: { name: 'Linen', color: '#efede6', roughness: 0.95, sheen: 0.4 },
  paper: { name: 'Paper', color: '#f3efe2', roughness: 0.85 },
  cardboard: { name: 'Cardboard', color: '#b88a5a', roughness: 0.9 },
  screen: { name: 'Screen', color: '#0d1117', roughness: 0.08, coat: 0.8 },
  litScreen: {
    name: 'Lit Screen',
    color: '#1d3557',
    roughness: 0.1,
    emission: { color: '#5d8ec4', strength: 0.6 },
  },
} satisfies Record<string, ModelMaterial>;
