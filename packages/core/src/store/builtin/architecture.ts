import { z } from 'zod';
import type { Mat4, Vec2, Vec3, Vec4 } from '../../math/types';
import { compose4, determinant4, multiply4 } from '../../math/mat4';
import { transformPoint3 } from '../../math/vec3';
import type { SceneDoc } from '../../doc/scene-doc';
import type {
  CurveData,
  EmptyDisplayType,
  MaterialData,
  ProceduralTexture,
  ProceduralType,
} from '../../doc/types';
import { defaultCurve } from '../../doc/defaults';
import { curveToMesh } from '../../curve/to-mesh';
import { parseEdgeKey, type MeshData } from '../../mesh/types';
import { defaultProcedural } from '../../material/procedural';
import { OperatorError } from '../../operators/context';
import { srgbToLinear } from '../../render/color';
import { cloneJson } from '../../util/json';
import {
  MeshBuilder,
  addBox,
  addBoxBetween,
  addIcoSphere,
  addLathe,
  addPrism,
  addTube,
  type PrismOpts,
} from '../../generate/builder';
import { MATERIALS, type GeneratedMaterial, type GeneratorResult } from '../../generate/types';
import { generateBuilding } from '../../generate/building';
import { generateArch, generateColumn, generateFence, generateStairs } from '../../generate/architecture';
import { Rng } from '../../generate/random';
import type { BuiltinBuildOptions, CatalogEntry, StoreCategory } from '../types';
import { colorIgnored, markNoColor, storeMaterialId, type BuiltModel } from './kit';

/*
 * Built-in architecture models (CATALOG-B), preceded by the model kit every CATALOG-B file
 * (nature, architecture, street, outdoor, vehicles, sports) builds with:
 *
 * - `defineModel` turns a model description and its build function into a CatalogEntry whose build
 *   validates the options, creates an EMPTY root (named after the model, store attribution as
 *   custom properties, base centre at `location`, turned by `rotation_deg` about +Z, scaled to the
 *   requested size) and runs everything in one transaction;
 * - `Model` adds the named parts under the root (meshes with their materials, empties), each
 *   tagged with the custom property `store_part` = its contract name (object names get '.001'
 *   suffixes when a document holds two models with the same part names);
 * - `ModelMaterial` describes materials in sRGB hex; a material is shared by the models that define
 *   it the same way (kit.ts storeMaterialId: never by name alone, so an edited material or a
 *   user's own of that name is left alone), the main colour override makes a new one named after
 *   it; a build given a `color` that no `main` material takes warns (kit.ts colorIgnored);
 * - mesh helpers on top of generate/builder.ts.
 *
 * Conventions: metres, Z up, the front faces −Y, so a model's own left is +X; the origin is at the
 * base centre (z = 0 is the ground).
 */

// ===================================================================== materials

/** A part material: Principled values with the base colour as sRGB hex (or linear RGBA). */
export interface ModelMaterial {
  name: string;
  /** Base colour: '#rrggbb' (sRGB) or linear RGBA. */
  color: string | Vec4;
  roughness: number;
  metallic?: number;
  /** Emission strength with the base colour as emission colour (lamps, flames). */
  emission?: number;
  /** Clear coat weight (car paint, varnish). */
  coat?: number;
  sheen?: number;
  /** Opacity below 1 makes the material alpha blended. */
  alpha?: number;
  transmission?: number;
  ior?: number;
  /** Procedural texture slots (OBJECT mapping in metres). */
  textures?: MaterialData['textures'];
}

/** A material spec from an sRGB hex colour. */
export function material(
  name: string,
  color: string,
  roughness: number,
  extra: Omit<ModelMaterial, 'name' | 'color' | 'roughness'> = {},
): ModelMaterial {
  return { name, color, roughness, ...extra };
}

/** A generator's default material as a model material (same name, so they share one). */
export function fromGenerated(m: GeneratedMaterial): ModelMaterial {
  return {
    name: m.name,
    color: [m.base_color[0], m.base_color[1], m.base_color[2], m.base_color[3]],
    roughness: m.roughness,
    ...(m.metallic ? { metallic: m.metallic } : {}),
    ...(m.transmission !== undefined ? { transmission: m.transmission } : {}),
    ...(m.ior !== undefined ? { ior: m.ior } : {}),
  };
}

/** '#rrggbb' (sRGB) → linear RGBA; throws on anything else. */
export function hexToLinear(hex: string): Vec4 {
  if (!HEX.test(hex)) throw new OperatorError(`colour must be '#rrggbb', got '${hex}'`, 'INVALID_PARAMS');
  const v = (i: number) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255);
  return [v(1), v(3), v(5), 1];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** sRGB hex scaled towards black (k < 1) or white (k > 1), e.g. for trims and shades. */
export function shade(hex: string, k: number): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const out = c.map((v) => Math.round(k <= 1 ? v * k : v + (255 - v) * Math.min(1, k - 1)));
  return `#${out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

/** A procedural texture slot (OBJECT mapping, metres). */
export function procSlot(type: ProceduralType, init: Partial<Omit<ProceduralTexture, 'type'>>) {
  return {
    image: '',
    scale: [1, 1] as Vec2,
    offset: [0, 0] as Vec2,
    procedural: defaultProcedural(type, { mapping: 'OBJECT', ...init }),
  };
}

/** Values of a new material for a spec. */
function materialValues(spec: ModelMaterial): Partial<MaterialData> {
  const base = typeof spec.color === 'string' ? hexToLinear(spec.color) : spec.color;
  const out: Partial<MaterialData> = {
    name: spec.name,
    base_color: [base[0], base[1], base[2], base[3]],
    roughness: spec.roughness,
    metallic: spec.metallic ?? 0,
  };
  if (spec.emission) {
    out.emission_color = [base[0], base[1], base[2]];
    out.emission_strength = spec.emission;
  }
  if (spec.coat) {
    out.coat_weight = spec.coat;
    out.coat_roughness = 0.05;
  }
  if (spec.sheen) out.sheen_weight = spec.sheen;
  if (spec.alpha !== undefined && spec.alpha < 1) {
    out.alpha = spec.alpha;
    out.blend_method = 'BLEND';
  }
  if (spec.transmission !== undefined) out.transmission = spec.transmission;
  if (spec.ior !== undefined) out.ior = spec.ior;
  if (spec.textures) out.textures = cloneJson(spec.textures);
  return out;
}

// ===================================================================== model

/** Where a part goes: relative to its parent (default the model root). */
export interface PartPlacement {
  /** Parent object id (default: the root). */
  parent?: string;
  location?: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
}

/** Custom property naming a part's role (stable across '.001' name suffixes). */
export const STORE_PART_PROP = 'store_part';

const CC0 = { license: 'CC0-1.0', author: '3D Editor built-in' } as const;

/**
 * One model being built into a document: its EMPTY root and the parts added under it. Part
 * transforms are relative to their parent; the root carries the placement and the size scale.
 */
export class Model {
  /** Id of the EMPTY root. */
  readonly root: string;
  /** Root name (the model's name unless the caller gave one). */
  readonly name: string;
  private readonly made: string[] = [];
  /** Direct children of the root with their locations (moved when the model is centred). */
  private readonly top: { id: string; location: Vec3 }[] = [];
  /** Materials this build found or made, by definition (storeMaterialId's cache). */
  private readonly materialIds = new Map<string, string>();
  /** Whether a part took the main colour (main, mainHex), so that an ignored `color` is reported. */
  private mainUsed = false;
  /** The model's own main colour, when a build asked mainHex for the colour to build with. */
  private mainDefault: string | null = null;
  /** Root-space matrix of every part (parts are created after their parents). */
  private readonly space = new Map<string, Mat4>();
  private readonly lo: Vec3 = [Infinity, Infinity, Infinity];
  private readonly hi: Vec3 = [-Infinity, -Infinity, -Infinity];

  constructor(
    readonly doc: SceneDoc,
    readonly entry: CatalogEntry,
    private readonly options: BuiltinBuildOptions,
    /** Main colour override ('#rrggbb') or null. */
    readonly color: string | null,
  ) {
    this.name = options.name?.trim() || entry.name;
    const loc = options.location ?? [0, 0, 0];
    const big = Math.max(...entry.dimensions_m);
    this.root = doc.addObject({
      type: 'EMPTY',
      name: this.name,
      location: [loc[0], loc[1], loc[2]],
      rotation_euler: [0, 0, ((options.rotation_deg ?? 0) * Math.PI) / 180],
      empty_display_type: 'PLAIN_AXES',
      empty_display_size: Math.min(2, Math.max(0.05, big * 0.3)),
      custom_props: {
        store_id: `builtin:${entry.id}`,
        store_source: 'builtin',
        license: CC0.license,
        author: CC0.author,
      },
    });
  }

  /** Material id of a spec: the document's material of exactly that definition, else a new one. */
  material(spec: ModelMaterial): string {
    const init = materialValues(spec) as Partial<MaterialData> & { name: string };
    return storeMaterialId(this.doc, init, this.materialIds);
  }

  /**
   * The model's main material: `spec`, or a copy in the requested colour named after it (a spec
   * already built in that colour through mainHex keeps its textures and is only renamed, unless the
   * colour is the model's own).
   */
  main(spec: ModelMaterial): ModelMaterial {
    this.mainUsed = true;
    if (!this.color) return spec;
    const name = `${spec.name} ${this.color}`;
    if (typeof spec.color === 'string' && spec.color.toLowerCase() === this.color)
      return this.mainDefault === null || this.mainDefault === this.color ? spec : { ...spec, name };
    const { textures: _t, ...rest } = spec;
    return { ...rest, name, color: this.color };
  }

  /** The main colour as hex: the override, else `fallback` (the model's own main colour). */
  mainHex(fallback: string): string {
    this.mainUsed = true;
    this.mainDefault = fallback.toLowerCase();
    return this.color ?? fallback;
  }

  /** Adds a mesh datablock (named after the model and part) and returns its id. */
  mesh(part: string, src: MeshBuilder | MeshData): string {
    const data = src instanceof MeshBuilder ? src.build() : src;
    return this.doc.addMesh(`${this.name} ${part}`, data);
  }

  /** Adds a mesh object using `meshId` (several objects may share one mesh, e.g. wheels). */
  object(name: string, meshId: string, mats: readonly ModelMaterial[], at: PartPlacement = {}): string {
    const mesh = this.doc.getMesh(meshId);
    const used = mesh ? mesh.faceMaterials.reduce((a, v) => Math.max(a, v), -1) : -1;
    if (used >= mats.length)
      throw new Error(`${this.entry.id}/${name}: faces use material slot ${used} but ${mats.length} given`);
    const id = this.doc.addObject({
      type: 'MESH',
      name,
      data: meshId,
      parent: at.parent ?? this.root,
      location: at.location ?? [0, 0, 0],
      rotation_euler: at.rotation ?? [0, 0, 0],
      scale: at.scale ?? [1, 1, 1],
      material_slots: mats.map((m) => this.material(m)),
      custom_props: { [STORE_PART_PROP]: name },
    });
    this.made.push(id);
    const m = this.place(id, at);
    if (mesh) {
      const P = mesh.positions;
      for (let i = 0; i < P.length; i += 3)
        for (let k = 0; k < 3; k++) {
          const v = m[k] * P[i] + m[4 + k] * P[i + 1] + m[8 + k] * P[i + 2] + m[12 + k];
          if (v < this.lo[k]) this.lo[k] = v;
          if (v > this.hi[k]) this.hi[k] = v;
        }
    }
    return id;
  }

  /** Records a new part's root-space matrix. */
  private place(id: string, at: PartPlacement): Mat4 {
    const loc = at.location ?? [0, 0, 0];
    if (!at.parent || at.parent === this.root) this.top.push({ id, location: [loc[0], loc[1], loc[2]] });
    const local = compose4(loc, at.rotation ?? [0, 0, 0], at.scale ?? [1, 1, 1]);
    const parent = at.parent && at.parent !== this.root ? this.space.get(at.parent) : undefined;
    const m = parent ? multiply4(parent, local) : local;
    this.space.set(id, m);
    return m;
  }

  /** Root-space bounds of the parts made so far (at scale 1). */
  bounds(): { min: Vec3; max: Vec3 } {
    return { min: [...this.lo] as Vec3, max: [...this.hi] as Vec3 };
  }

  /** Adds a mesh part built from `src`. */
  part(
    name: string,
    src: MeshBuilder | MeshData,
    mats: readonly ModelMaterial[],
    at: PartPlacement = {},
  ): string {
    return this.object(name, this.mesh(name, src), mats, at);
  }

  /** Adds an EMPTY (pivot, attachment point) under the root or `at.parent`. */
  empty(name: string, at: PartPlacement & { display?: EmptyDisplayType; size?: number } = {}): string {
    const id = this.doc.addObject({
      type: 'EMPTY',
      name,
      parent: at.parent ?? this.root,
      location: at.location ?? [0, 0, 0],
      rotation_euler: at.rotation ?? [0, 0, 0],
      scale: at.scale ?? [1, 1, 1],
      empty_display_type: at.display ?? 'PLAIN_AXES',
      empty_display_size: at.size ?? 0.1,
      custom_props: { [STORE_PART_PROP]: name },
    });
    this.made.push(id);
    this.place(id, at);
    return id;
  }

  /**
   * Centres the parts' bounding box on the root in X and Y unless `centre` is false (the origin is
   * the centre of the base), scales the root to the requested size (measured from the geometry, so size params count) and
   * returns what the build made.
   */
  finish(centre = true): BuiltModel {
    const measured = this.hi[0] >= this.lo[0];
    if (measured && centre) {
      const cx = (this.lo[0] + this.hi[0]) / 2;
      const cy = (this.lo[1] + this.hi[1]) / 2;
      if (Math.abs(cx) > 1e-6 || Math.abs(cy) > 1e-6)
        for (const t of this.top)
          this.doc.updateObject(t.id, { location: [t.location[0] - cx, t.location[1] - cy, t.location[2]] });
    }
    const size = measured ? ([0, 1, 2].map((k) => this.hi[k] - this.lo[k]) as Vec3) : this.entry.dimensions_m;
    this.doc.updateObject(this.root, { scale: sizeScale(size, this.options) });
    const warnings = this.color && !this.mainUsed ? [colorIgnored(this.entry.id)] : [];
    // every object the build added, the root first (as the other built-in lists return them)
    return { root: this.root, objects: [this.root, ...this.made], warnings };
  }
}

/**
 * Root scale for the requested size: each given width_m / depth_m / height_m sets its axis; the
 * other axes follow the geometric mean of the given ones (proportions kept when one is given);
 * without sizes, the uniform `scale` (default 1).
 */
export function sizeScale(size: readonly number[], o: BuiltinBuildOptions): Vec3 {
  const want = [o.width_m, o.depth_m, o.height_m];
  const f = want.map((w, k) => (w !== undefined && size[k] > 1e-9 ? w / size[k] : null));
  const given = f.filter((v): v is number => v !== null);
  if (!given.length) {
    const s = o.scale ?? 1;
    return [s, s, s];
  }
  const g = Math.exp(given.reduce((a, v) => a + Math.log(v), 0) / given.length);
  return [f[0] ?? g, f[1] ?? g, f[2] ?? g];
}

function checkOptions(id: string, o: BuiltinBuildOptions): void {
  const bad = (what: string) => new OperatorError(`${id}: ${what}`, 'INVALID_PARAMS');
  if (o.location && !(o.location.length >= 3 && o.location.slice(0, 3).every(Number.isFinite)))
    throw bad('location must be three finite numbers');
  if (o.rotation_deg !== undefined && !Number.isFinite(o.rotation_deg))
    throw bad('rotation_deg must be finite');
  for (const k of ['height_m', 'width_m', 'depth_m', 'scale'] as const) {
    const v = o[k];
    if (v !== undefined && !(Number.isFinite(v) && v > 0)) throw bad(`${k} must be a positive number`);
  }
  if (o.color !== undefined && !HEX.test(o.color)) throw bad(`color must be '#rrggbb', got '${o.color}'`);
}

function readParams<S extends z.ZodRawShape>(
  id: string,
  schema: z.ZodObject<S> | undefined,
  raw: Record<string, unknown> | undefined,
): z.output<z.ZodObject<S>> {
  const given = raw ?? {};
  if (!schema) {
    const keys = Object.keys(given);
    if (keys.length)
      throw new OperatorError(`${id} takes no params (got ${keys.join(', ')})`, 'INVALID_PARAMS');
    return {} as z.output<z.ZodObject<S>>;
  }
  const allowed = Object.keys(schema.shape);
  const unknown = Object.keys(given).filter((k) => !allowed.includes(k));
  if (unknown.length)
    throw new OperatorError(
      `unknown params for ${id}: ${unknown.join(', ')} (it takes ${allowed.join(', ')})`,
      'INVALID_PARAMS',
    );
  const r = schema.safeParse(given);
  if (!r.success)
    throw new OperatorError(
      `invalid params for ${id}: ${r.error.issues.map((i) => `${i.path.join('.') || '(params)'}: ${i.message}`).join('; ')}`,
      'INVALID_PARAMS',
    );
  return r.data;
}

/** A catalog model description plus the function that builds its parts. */
export interface ModelSpec<S extends z.ZodRawShape> {
  id: string;
  name: string;
  category: StoreCategory;
  tags: string[];
  synonyms: string[];
  description: string;
  /** Size (X, Y, Z) at the default params, metres. */
  dimensions_m: [number, number, number];
  /** Triangles at the default params. */
  triangles: number;
  rig?: 'vehicle';
  /**
   * Where the root origin goes: 'bounds' (default) centres the bounding box over it; 'origin' keeps
   * the build's own origin (the foot of a pole, the base of a trunk) for models whose bounding box
   * is lopsided (lamp arms, signs, tree crowns).
   */
  anchor?: 'bounds' | 'origin';
  params?: z.ZodObject<S>;
  /**
   * False when no material takes the `color` option (nothing calls `main`): store.add then warns
   * and search results say so (kit.ts takesColor).
   */
  color?: false;
  build(m: Model, p: z.output<z.ZodObject<S>>): void;
}

/** A catalog entry whose build makes the model through `Model` (see the file comment). */
export function defineModel<S extends z.ZodRawShape = Record<never, never>>(
  spec: ModelSpec<S>,
): CatalogEntry {
  const entry: CatalogEntry = {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    tags: spec.tags,
    synonyms: spec.synonyms,
    description: spec.description,
    dimensions_m: spec.dimensions_m,
    triangles: spec.triangles,
    rig: spec.rig ?? null,
    ...(spec.params ? { params: spec.params as unknown as z.ZodObject<z.ZodRawShape> } : {}),
    build(doc: SceneDoc, o: BuiltinBuildOptions): BuiltModel {
      checkOptions(spec.id, o);
      const p = readParams(spec.id, spec.params, o.params);
      return doc.transact(() => {
        const m = new Model(doc, entry, o, o.color ? o.color.toLowerCase() : null);
        spec.build(m, p);
        return m.finish(spec.anchor !== 'origin');
      });
    },
  };
  return spec.color === false ? markNoColor(entry) : entry;
}

// ===================================================================== mesh helpers

export const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** Translation (+ rotation about Z, radians) matrix. */
export function at(x: number, y: number, z: number, rz = 0): Mat4 {
  return compose4([x, y, z], [0, 0, rz], [1, 1, 1]);
}

/** Translation + Euler XYZ rotation (radians) + scale. */
export function xf(loc: Vec3, rot: Vec3 = [0, 0, 0], scale: Vec3 = [1, 1, 1]): Mat4 {
  return compose4(loc, rot, scale);
}

/** Axis-aligned box from `min` to `max` (optionally transformed). */
export function box(b: MeshBuilder, min: Vec3, max: Vec3, mat: number, matrix?: Mat4): void {
  addBox(b, min, max, { mat, matrix });
}

/** Box of `size` centred at `c`, turned by `rz` about Z (then by `matrix`). */
export function block(b: MeshBuilder, c: Vec3, size: Vec3, mat: number, rz = 0, matrix?: Mat4): void {
  const m = at(c[0], c[1], c[2], rz);
  addBox(b, [-size[0] / 2, -size[1] / 2, -size[2] / 2], [size[0] / 2, size[1] / 2, size[2] / 2], {
    mat,
    matrix: matrix ? multiply4(matrix, m) : m,
  });
}

/** Square-section beam from p0 to p1 (`w` wide, `h` high; `up` orients the height). */
export function beam(
  b: MeshBuilder,
  p0: Vec3,
  p1: Vec3,
  w: number,
  h: number,
  mat: number,
  up: Vec3 = [0, 0, 1],
): void {
  addBoxBetween(b, p0, p1, w, h, up, { mat });
}

/** Cylinder (or frustum to `r1`) from p0 to p1 with flat caps. */
export function cylinder(
  b: MeshBuilder,
  p0: Vec3,
  p1: Vec3,
  r: number,
  sides: number,
  mat: number,
  opts: { r1?: number; smooth?: boolean; caps?: boolean; capMat?: number } = {},
): void {
  const r1 = opts.r1 ?? r;
  addTube(b, [p0, p1], (i) => (i === 0 ? r : r1), sides, {
    mat,
    smooth: opts.smooth ?? true,
    caps: opts.caps ?? true,
    capMat: opts.capMat,
  });
}

/** Tube of radius `r` along a polyline. */
export function tube(
  b: MeshBuilder,
  path: Vec3[],
  r: number | ((i: number) => number),
  sides: number,
  mat: number,
  opts: { cyclic?: boolean; caps?: boolean; smooth?: boolean } = {},
): void {
  addTube(b, path, r, sides, {
    mat,
    smooth: opts.smooth ?? true,
    caps: opts.caps ?? true,
    cyclic: opts.cyclic,
    miter: true,
  });
}

/** Ellipsoid (icosphere, `level` 1..4) centred at `c`. */
export function sphere(
  b: MeshBuilder,
  c: Vec3,
  r: number | Vec3,
  level: number,
  mat: number,
  opts: { smooth?: boolean; matrix?: Mat4; displace?: (d: Vec3) => number } = {},
): void {
  const radii: Vec3 = typeof r === 'number' ? [r, r, r] : r;
  addIcoSphere(b, c, radii, level, {
    mat,
    smooth: opts.smooth ?? true,
    matrix: opts.matrix,
    displace: opts.displace,
  });
}

/** Surface of revolution of an [r, z] profile about the Z axis (at `matrix`). */
export function lathe(
  b: MeshBuilder,
  profile: Vec2[],
  segments: number,
  mat: number,
  opts: { matrix?: Mat4; smooth?: boolean; loop?: boolean } = {},
): void {
  addLathe(b, profile, segments, { mat, smooth: opts.smooth ?? true, loop: opts.loop, matrix: opts.matrix });
}

/** Torus about the Z axis (ring radius R, tube radius r). */
export function torus(
  b: MeshBuilder,
  R: number,
  r: number,
  segments: number,
  sides: number,
  mat: number,
  matrix?: Mat4,
): void {
  const prof: Vec2[] = [];
  for (let i = 0; i < sides; i++) {
    const t = (i / sides) * TAU;
    prof.push([R + r * Math.cos(t), r * Math.sin(t)]);
  }
  addLathe(b, prof, segments, { mat, smooth: true, loop: true, matrix });
}

const AXIS: Record<'x' | 'y' | 'z', Mat4> = {
  // outline (u, v) → (y, z), extruded along x
  x: [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1],
  // outline (u, v) → (x, z), extruded along y
  y: [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
  z: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
};

/**
 * Closed prism: a 2D outline extruded from a0 to a1 along `axis`. The outline is (y, z) for 'x',
 * (x, z) for 'y' and (x, y) for 'z'.
 */
export function extrude(
  b: MeshBuilder,
  outline: Vec2[],
  axis: 'x' | 'y' | 'z',
  a0: number,
  a1: number,
  mat: number,
  opts: Omit<PrismOpts, 'mat'> = {},
): void {
  const m = opts.matrix ? multiply4(opts.matrix, AXIS[axis]) : AXIS[axis];
  addPrism(b, outline, a0, a1, { ...opts, mat, matrix: m });
}

/** Circle outline (counter-clockwise). */
export function circle(r: number, n: number, a0 = 0, cx = 0, cy = 0): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Rectangle outline `w` × `h` centred at (cx, cy) with rounded corners (radius r). */
export function roundedRect(w: number, h: number, r: number, seg = 3, cx = 0, cy = 0): Vec2[] {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
  const out: Vec2[] = [];
  const corners: [number, number, number][] = [
    [w / 2 - rr, h / 2 - rr, 0],
    [-w / 2 + rr, h / 2 - rr, Math.PI / 2],
    [-w / 2 + rr, -h / 2 + rr, Math.PI],
    [w / 2 - rr, -h / 2 + rr, (3 * Math.PI) / 2],
  ];
  for (const [x, y, a0] of corners)
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      out.push([cx + x + rr * Math.cos(a), cy + y + rr * Math.sin(a)]);
    }
  return out;
}

/**
 * Upward-facing surface of revolution from rings of [r, z] (r = 0 makes a centre pole), e.g. discs,
 * mounds and shore rings. `point(a, r)` maps an angle and ring radius to x/y (default a circle,
 * stretched by `scale` into an ellipse; with `point` no ring is a pole). Rings must move
 * monotonically outwards or inwards.
 */
export function radialSurface(
  b: MeshBuilder,
  rings: Vec2[],
  segments: number,
  mat: number,
  opts: { point?: (a: number, r: number) => Vec2; scale?: Vec2; smooth?: boolean; at?: Vec3 } = {},
): void {
  const n = Math.max(3, Math.floor(segments));
  const o = opts.at ?? [0, 0, 0];
  const [sx, sy] = opts.scale ?? [1, 1];
  const pt = opts.point ?? ((a: number, r: number): Vec2 => [sx * r * Math.cos(a), sy * r * Math.sin(a)]);
  const ids = rings.map(([r, zz]) => {
    if (Math.abs(r) < 1e-9 && !opts.point) return [b.vert([o[0], o[1], o[2] + zz])];
    const ring: number[] = [];
    for (let j = 0; j < n; j++) {
      const [x, y] = pt((j / n) * TAU, r);
      ring.push(b.vert([o[0] + x, o[1] + y, o[2] + zz]));
    }
    return ring;
  });
  const smooth = opts.smooth ?? true;
  for (let k = 0; k + 1 < ids.length; k++) {
    const A = ids[k];
    const B = ids[k + 1];
    const outward = rings[k + 1][0] >= rings[k][0];
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      let f: number[];
      if (A.length === 1) f = [A[0], B[j], B[j1]];
      else if (B.length === 1) f = [A[j], A[j1], B[0]];
      else f = [A[j], B[j], B[j1], A[j1]];
      // pole fans always face up; quads face up when the rings move outwards
      const up = A.length === 1 || B.length === 1 || outward;
      b.face(up ? f : f.reverse(), mat, smooth);
    }
  }
}

/**
 * Height-field grid over x0..x1 × y0..y1 (nx × ny cells, faces up). `mat(x, y, z, nz)` picks each
 * cell's material slot from its centre and the z component of its normal.
 */
export function heightField(
  b: MeshBuilder,
  nx: number,
  ny: number,
  x: [number, number],
  y: [number, number],
  h: (x: number, y: number) => number,
  mat: (x: number, y: number, z: number, nz: number) => number = () => 0,
  smooth = true,
): void {
  const ids: number[] = [];
  const P: Vec3[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const px = x[0] + ((x[1] - x[0]) * i) / nx;
      const py = y[0] + ((y[1] - y[0]) * j) / ny;
      const p: Vec3 = [px, py, h(px, py)];
      P.push(p);
      ids.push(b.vert(p));
    }
  const at = (i: number, j: number) => j * (nx + 1) + i;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const a = P[at(i, j)];
      const c = P[at(i + 1, j + 1)];
      const bb = P[at(i + 1, j)];
      const d = P[at(i, j + 1)];
      // normal from the cell diagonals
      const u: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const v: Vec3 = [d[0] - bb[0], d[1] - bb[1], d[2] - bb[2]];
      const nrm: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const l = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
      const cz = (a[2] + bb[2] + c[2] + d[2]) / 4;
      const slot = mat((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, cz, nrm[2] / l);
      b.face([ids[at(i, j)], ids[at(i + 1, j)], ids[at(i + 1, j + 1)], ids[at(i, j + 1)]], slot, smooth);
    }
}

/**
 * Extruded text from the built-in font, centred on the origin in the XY plane (letters face +Z,
 * `size` is the font size in metres), or null for blank text.
 */
export function textMesh(body: string, size: number, depth: number): MeshData | null {
  const curve: CurveData = {
    ...defaultCurve('', 'text'),
    dimensions: '2D',
    body,
    size,
    extrude: depth / 2,
    align_x: 'CENTER',
    align_y: 'CENTER',
  };
  return curveToMesh(curve, { forRender: true, isText: true }).mesh;
}

/** Flattens the vertices added since vertex `from` that lie below `z` onto it (flat undersides). */
export function floorAt(b: MeshBuilder, z = 0, from = 0): void {
  const P = b.positions;
  for (let i = from * 3 + 2; i < P.length; i += 3) if (P[i] < z) P[i] = z;
}

/** Appends a generated mesh to a builder: material indices mapped by `matMap`, optionally transformed. */
export function appendMesh(
  b: MeshBuilder,
  mesh: MeshData,
  matMap: readonly number[] = [],
  matrix?: Mat4,
): void {
  const P = mesh.positions;
  const ids: number[] = [];
  for (let i = 0; i < P.length; i += 3) {
    const p: Vec3 = [P[i], P[i + 1], P[i + 2]];
    ids.push(b.vert(matrix ? transformPoint3(matrix, p) : p));
  }
  const flip = matrix ? determinant4(matrix) < 0 : false;
  mesh.faces.forEach((f, fi) => {
    const vs = f.map((v) => ids[v]);
    let uv = mesh.uvs?.[fi] ?? null;
    if (flip) {
      vs.reverse();
      if (uv) {
        const r: number[] = [];
        for (let i = uv.length - 2; i >= 0; i -= 2) r.push(uv[i], uv[i + 1]);
        uv = r;
      }
    }
    const mi = mesh.faceMaterials[fi] ?? 0;
    b.face(vs, matMap[mi] ?? mi, mesh.faceSmooth[fi] ?? false, uv);
  });
  for (const [k, attr] of Object.entries(mesh.edgeAttrs))
    if (attr.sharp) {
      const [a, c] = parseEdgeKey(k);
      b.markSharp(ids[a], ids[c]);
    }
}

/** A generator result's mesh with its slots mapped onto `slots` (material indices of the builder). */
export function appendGenerated(
  b: MeshBuilder,
  res: GeneratorResult,
  slots: readonly number[],
  matrix?: Mat4,
): void {
  appendMesh(b, res.mesh, slots, matrix);
}

// ===================================================================== shared materials

/** Materials several CATALOG-B files use (one material per name in a document). */
export const MAT = {
  glass: fromGenerated(MATERIALS.glass),
  frameWhite: material('Painted Trim', '#efece6', 0.5),
  wood: material('Weathered Wood', '#8a6a4a', 0.75),
  woodDark: material('Stained Wood', '#5a3e2b', 0.65),
  woodLight: material('Pale Wood', '#c9a77c', 0.6),
  plank: material('Deck Planks', '#9c7a55', 0.8),
  metal: material('Galvanised Steel', '#9aa0a6', 0.35, { metallic: 1 }),
  darkMetal: material('Dark Steel', '#33363b', 0.45, { metallic: 1 }),
  blackPlastic: material('Matte Black Plastic', '#1d1e20', 0.55),
  rubber: material('Tyre Rubber', '#1a1a1b', 0.9),
  concrete: material('Concrete Grey', '#9a9893', 0.9),
  stone: material('Field Stone', '#8b877f', 0.85),
  roofSlate: material('Slate Roof', '#4a4f57', 0.7),
  roofTile: material('Clay Roof Tiles', '#9c4a32', 0.7),
  thatch: material('Thatch', '#b48b4c', 0.95),
  white: material('Outdoor White Paint', '#f2f0eb', 0.5),
  red: material('Signal Red', '#c62828', 0.45),
  yellow: material('Signal Yellow', '#f2c12e', 0.45),
  water: material('Water Blue', '#2f6fa3', 0.12, { coat: 0.6 }),
  sand: material('Beach Sand', '#c9a66b', 0.95),
  soil: material('Garden Soil', '#4a3626', 0.95),
  grass: fromGenerated(MATERIALS.grass),
  bark: fromGenerated(MATERIALS.bark),
  leaves: fromGenerated(MATERIALS.leaves),
  rock: fromGenerated(MATERIALS.rock),
  hay: material('Hay', '#d8b54a', 0.9),
  fabricRed: material('Red Canvas', '#c0392b', 0.85, { sheen: 0.3 }),
  lampGlow: material('Lamp Glow', '#fff1c9', 0.4, { emission: 6 }),
} satisfies Record<string, ModelMaterial>;

/**
 * A brick material: courses of 215 × 65 mm bricks in shades around `hex` with mortar joints, as a
 * low-contrast colour pattern only (a bump of the sub-pixel joints aliases into moiré in wide shots).
 */
export function brickMaterial(name: string, hex: string): ModelMaterial {
  // low contrast between bricks and mortar: the joints are sub-pixel in wide shots and would alias
  const lo = hexToLinear(shade(hex, 0.94));
  const hi = hexToLinear(shade(hex, 1.03));
  const mortar = hexToLinear(shade(hex, 1.1));
  const layout = {
    plane: 'WALL',
    brick_width: 0.225,
    row_height: 0.075,
    mortar_size: 0.006,
    mortar_smooth: 0.2,
  };
  return {
    name,
    color: hex,
    roughness: 0.85,
    textures: {
      base_color: procSlot('BRICK', {
        color_a: lo,
        color_b: hi,
        params: { ...layout, mortar_r: mortar[0], mortar_g: mortar[1], mortar_b: mortar[2] },
      }),
    },
  };
}

// ===================================================================== architecture models

export interface RoofOpts {
  /** Overhang beyond the side walls (default 0.35). */
  overhang?: number;
  thick?: number;
  /** Overhang beyond the −Y / +Y ends (default: `overhang`). */
  front?: number;
  back?: number;
  /** Rigid placement of the roof (e.g. a quarter turn for a ridge along X). */
  matrix?: Mat4;
}

/**
 * Gable roof over walls at x = ±halfW (eaves at `eave`) with the ridge along Y at `ridge`: two
 * slabs whose undersides lie on the roof line and overlap at the ridge.
 */
export function gableRoof(
  b: MeshBuilder,
  halfW: number,
  depth: number,
  eave: number,
  ridge: number,
  mat: number,
  o: RoofOpts = {},
): void {
  const ov = o.overhang ?? 0.35;
  const thick = o.thick ?? 0.14;
  const front = o.front ?? ov;
  const back = o.back ?? ov;
  const yc = (back - front) / 2;
  const slope = Math.atan2(ridge - eave, halfW);
  const tan = Math.tan(slope);
  const m = o.matrix;
  const pt = (p: Vec3): Vec3 => (m ? transformPoint3(m, p) : p);
  const dir = (v: Vec3): Vec3 =>
    m
      ? [
          m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
        ]
      : v;
  for (const s of [-1, 1]) {
    const n: Vec3 = [s * Math.sin(slope), 0, Math.cos(slope)];
    const h = thick / 2;
    const p0: Vec3 = [s * (halfW + ov) + n[0] * h, yc, eave - ov * tan + n[2] * h];
    const p1: Vec3 = [-s * 0.03 + n[0] * h, yc, ridge + 0.03 * tan + n[2] * h];
    addBoxBetween(b, pt(p0), pt(p1), depth + front + back, thick, dir(n), { mat });
  }
}

/** Gable end wall outline (x, z) for extruding along Y. */
function gableOutline(halfW: number, eave: number, ridge: number): Vec2[] {
  return [
    [-halfW, 0],
    [halfW, 0],
    [halfW, eave],
    [0, ridge],
    [-halfW, eave],
  ];
}

/** An opening in a wall: x range along the wall and z range. */
interface Opening {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * Wall along X (from −len/2 to len/2, `thick` through Y, z from z0 to `height`) with rectangular
 * openings, as boxes around them.
 */
function wallWithOpenings(
  b: MeshBuilder,
  len: number,
  height: number,
  thick: number,
  openings: Opening[],
  mat: number,
  matrix?: Mat4,
  z0 = 0,
): void {
  const t = thick / 2;
  const add = (x0: number, x1: number, za: number, zb: number) => {
    if (x1 - x0 > 1e-4 && zb - za > 1e-4) box(b, [x0, -t, za], [x1, t, zb], mat, matrix);
  };
  let cursor = -len / 2;
  for (const o of [...openings].sort((a, c) => a.x0 - c.x0)) {
    add(cursor, o.x0, z0, height);
    add(o.x0, o.x1, z0, o.z0);
    add(o.x0, o.x1, o.z1, height);
    cursor = o.x1;
  }
  add(cursor, len / 2, z0, height);
}

/** Panelled door leaf hinged at x = 0, spanning x 0..w, z 0..h (slots: leaf, trim/panels, knob). */
function doorLeaf(
  b: MeshBuilder,
  w: number,
  h: number,
  t: number,
  leaf: number,
  panel: number,
  knob: number,
): void {
  box(b, [0, -t / 2, 0], [w, t / 2, h], leaf);
  const pw = w * 0.32;
  for (const cx of [w * 0.28, w * 0.72])
    for (const [z0, z1] of [
      [h * 0.08, h * 0.44],
      [h * 0.52, h * 0.92],
    ]) {
      box(b, [cx - pw / 2, -t / 2 - 0.012, z0], [cx + pw / 2, -t / 2, z1], panel);
      box(b, [cx - pw / 2, t / 2, z0], [cx + pw / 2, t / 2 + 0.012, z1], panel);
    }
  sphere(b, [w - 0.08, -t / 2 - 0.035, h * 0.47], 0.03, 1, knob);
  sphere(b, [w - 0.08, t / 2 + 0.035, h * 0.47], 0.03, 1, knob);
}

/** Window unit with its sill at z = 0, centred on x, glass in the middle of `depth` (slots: frame, glass). */
function windowUnit(
  b: MeshBuilder,
  w: number,
  h: number,
  depth: number,
  frame: number,
  glass: number,
  cols = 2,
  rows = 2,
  matrix?: Mat4,
): void {
  const f = 0.06;
  const d = depth / 2;
  box(b, [-w / 2, -d, 0], [w / 2, d, f], frame, matrix);
  box(b, [-w / 2, -d, h - f], [w / 2, d, h], frame, matrix);
  box(b, [-w / 2, -d, f], [-w / 2 + f, d, h - f], frame, matrix);
  box(b, [w / 2 - f, -d, f], [w / 2, d, h - f], frame, matrix);
  for (let i = 1; i < cols; i++) {
    const x = -w / 2 + (w * i) / cols;
    box(b, [x - 0.02, -0.03, f], [x + 0.02, 0.03, h - f], frame, matrix);
  }
  for (let j = 1; j < rows; j++) {
    const zz = (h * j) / rows;
    box(b, [-w / 2 + f, -0.03, zz - 0.02], [w / 2 - f, 0.03, zz + 0.02], frame, matrix);
  }
  box(b, [-w / 2 + f, -0.008, f], [w / 2 - f, 0.008, h - f], glass, matrix);
  // sill ledge in front
  box(b, [-w / 2 - 0.05, -d - 0.06, -0.04], [w / 2 + 0.05, d, 0.0], frame, matrix);
}

const sizeParam = (def: number, min: number, max: number, what: string) =>
  z.number().min(min).max(max).default(def).describe(what);
const seedParam = z.number().int().min(0).max(9999).default(0).describe('Variation (random layout seed)');

const doorGreen = material('Front Door Green', '#2f5d50', 0.45);

const house = defineModel({
  id: 'house',
  name: 'House',
  category: 'architecture',
  tags: ['building', 'home', 'residential', 'two storey', 'suburb', 'town'],
  synonyms: ['home', 'family house', 'townhouse', 'dwelling', 'residence'],
  description:
    'Two-storey family house with a slate gable roof, white window frames, a chimney and a green front door facing −Y.',
  dimensions_m: [9.4, 8.2, 8.91],
  triangles: 1344,
  params: z.object({ floors: z.number().int().min(1).max(4).default(2).describe('Storeys') }),
  build(m, p) {
    const fh = 2.8;
    const res = generateBuilding({
      floors: p.floors,
      width: 9,
      depth: 7.4,
      floor_height: fh,
      roof: 'GABLE',
      roof_height: 2.8,
      roof_overhang: 0.4,
      window_width: 1.1,
      window_height: 1.3,
      door_width: 1.0,
      door_height: 2.1,
    });
    const b = new MeshBuilder();
    appendGenerated(b, res, [0, 1, 2, 3, 4]);
    const top = p.floors * fh;
    block(b, [-2.6, 1.2, top + 2.1], [0.6, 0.6, 2.2], 5);
    block(b, [-2.6, 1.2, top + 3.25], [0.75, 0.75, 0.12], 5);
    m.part('house', b, [
      m.main(material('House Render', '#e9e1cf', 0.85)),
      MAT.glass,
      MAT.frameWhite,
      MAT.roofSlate,
      doorGreen,
      MAT.stone,
    ]);
  },
});

const apartmentBuilding = defineModel({
  id: 'apartment_building',
  name: 'Apartment Building',
  category: 'architecture',
  tags: ['building', 'city', 'urban', 'flats', 'block', 'residential', 'town'],
  synonyms: ['apartments', 'block of flats', 'flats', 'tenement', 'city building', 'office building'],
  description:
    'Four-storey flat-roofed city apartment block with a parapet, a grid of windows and a central entrance facing −Y.',
  dimensions_m: [12, 10, 12.45],
  triangles: 3800,
  params: z.object({ floors: z.number().int().min(2).max(12).default(4).describe('Storeys') }),
  build(m, p) {
    const res = generateBuilding({
      floors: p.floors,
      width: 12,
      depth: 10,
      floor_height: 3,
      roof: 'FLAT',
      window_width: 1.3,
      window_height: 1.5,
      door_width: 1.6,
      door_height: 2.4,
    });
    m.part('building', res.mesh, [
      m.main(material('Building Brick', '#b9876a', 0.85)),
      MAT.glass,
      MAT.frameWhite,
      material('Flat Roof', '#5c5d5f', 0.9),
      material('Entrance Door', '#3a3f45', 0.4),
    ]);
  },
});

const cottage = defineModel({
  id: 'cottage',
  name: 'Cottage',
  category: 'architecture',
  tags: ['building', 'home', 'house', 'village', 'countryside', 'rural', 'small house', 'thatched'],
  synonyms: ['house', 'small house', 'country house', 'bungalow', 'farmhouse', 'thatched cottage'],
  description:
    'Single-storey whitewashed country cottage with a thatched roof, a stone chimney, a porch canopy over the front door (−Y) and shuttered windows.',
  dimensions_m: [8.71, 6.85, 6.1],
  triangles: 352,
  build(m) {
    const b = new MeshBuilder();
    const W = 7.2;
    const D = 5.4;
    const eave = 2.6;
    const ridge = 5.6;
    extrude(b, gableOutline(W / 2, eave, ridge), 'y', -D / 2, D / 2, 0);
    box(b, [-W / 2 - 0.05, -D / 2 - 0.05, 0], [W / 2 + 0.05, D / 2 + 0.05, 0.35], 5);
    gableRoof(b, W / 2, D, eave, ridge, 1, { overhang: 0.55, thick: 0.32 });
    beam(b, [0, -D / 2 - 0.55, ridge + 0.2], [0, D / 2 + 0.55, ridge + 0.2], 0.4, 0.25, 1);
    block(b, [W / 2 - 0.2, 0.6, 4.6], [0.7, 0.8, 3.0], 5);
    block(b, [W / 2 - 0.2, 0.6, 6.05], [0.85, 0.95, 0.1], 5);
    const fy = -D / 2;
    block(b, [0, fy - 0.03, 1.05], [1.0, 0.08, 2.1], 2);
    block(b, [0, fy - 0.06, 1.05], [0.86, 0.06, 1.96], 3);
    extrude(
      b,
      [
        [-0.85, 2.3],
        [0.85, 2.3],
        [0, 2.85],
      ],
      'y',
      fy - 0.9,
      fy,
      4,
    );
    for (const sx of [-0.75, 0.75]) cylinder(b, [sx, fy - 0.8, 0], [sx, fy - 0.8, 2.3], 0.05, 6, 2);
    for (const [wx, wy, ny] of [
      [-2.2, fy, -1],
      [2.2, fy, -1],
      [-2.2, D / 2, 1],
      [2.2, D / 2, 1],
    ] as const) {
      block(b, [wx, wy + ny * 0.03, 1.45], [1.1, 0.06, 1.2], 2);
      block(b, [wx, wy + ny * 0.06, 1.45], [0.9, 0.04, 1.0], 6);
      for (const s of [-1, 1]) block(b, [wx + s * 0.8, wy + ny * 0.05, 1.45], [0.45, 0.05, 1.2], 3);
    }
    m.part('cottage', b, [
      m.main(material('Whitewash', '#f1ece0', 0.9)),
      MAT.thatch,
      MAT.frameWhite,
      material('Shutter Blue', '#3f6e8c', 0.6),
      MAT.woodDark,
      MAT.stone,
      MAT.glass,
    ]);
  },
});

const logCabin = defineModel({
  id: 'log_cabin',
  name: 'Log Cabin',
  category: 'architecture',
  tags: ['building', 'cabin', 'lodge', 'forest', 'mountain', 'wood', 'rustic', 'camp'],
  synonyms: ['lodge', 'cabin', 'hunting lodge', 'mountain hut', 'chalet'],
  description:
    'Rustic log cabin (lodge) of stacked round logs with crossed corners, a gable roof over a front porch (−Y), a door, windows and a stone chimney.',
  dimensions_m: [8.078, 9.9, 6.14],
  triangles: 1372,
  build(m) {
    const b = new MeshBuilder();
    const W = 6.4;
    const D = 7;
    const r = 0.14;
    const courses = 10;
    const eave = courses * 2 * r + r;
    const ridge = eave + 2.6;
    const over = 0.32;
    for (let i = 0; i < courses; i++) {
      const zf = r + 2 * r * i;
      const zs = 2 * r + 2 * r * i;
      for (const y of [-D / 2, D / 2]) cylinder(b, [-W / 2 - over, y, zf], [W / 2 + over, y, zf], r, 8, 0);
      for (const x of [-W / 2, W / 2]) cylinder(b, [x, -D / 2 - over, zs], [x, D / 2 + over, zs], r, 8, 0);
    }
    // gable triangles (planks) on both ends
    for (const y of [-D / 2, D / 2])
      extrude(
        b,
        [
          [-W / 2 - r, eave],
          [W / 2 + r, eave],
          [0, ridge],
        ],
        'y',
        y - r,
        y + r,
        0,
      );
    const front = 2.0;
    gableRoof(b, W / 2 + r, D, eave, ridge, 1, { overhang: 0.6, front: front + 0.3, thick: 0.16 });
    // porch deck and posts
    box(b, [-W / 2, -D / 2 - front, 0], [W / 2, -D / 2, 0.3], 2);
    for (const x of [-W / 2 + 0.2, W / 2 - 0.2])
      cylinder(b, [x, -D / 2 - front + 0.2, 0.3], [x, -D / 2 - front + 0.2, eave + 0.25], 0.11, 8, 0);
    // door and windows over the logs
    const fy = -D / 2 - r;
    box(b, [-0.5, fy - 0.04, 0.3], [0.5, fy + 0.02, 2.3], 3);
    box(b, [-0.6, fy - 0.06, 2.3], [0.6, fy + 0.02, 2.42], 2);
    for (const wx of [-2.0, 2.0]) {
      box(b, [wx - 0.6, fy - 0.03, 1.0], [wx + 0.6, fy + 0.02, 2.0], 2);
      box(b, [wx - 0.5, fy - 0.05, 1.08], [wx + 0.5, fy, 1.92], 5);
    }
    for (const sx of [-1, 1]) {
      const x = sx * (W / 2 + r);
      box(b, [x - 0.03, -1.0, 1.0], [x + 0.03, 1.0, 2.0], 2);
      box(b, [x - 0.05, -0.9, 1.08], [x + 0.05, 0.9, 1.92], 5);
    }
    // stone chimney on the left wall
    box(b, [W / 2 + r, 1.0, 0], [W / 2 + r + 0.7, 2.2, ridge - 0.4], 4);
    box(b, [W / 2 + r + 0.1, 1.2, ridge - 0.4], [W / 2 + r + 0.6, 2.0, ridge + 0.6], 4);
    m.part('cabin', b, [
      m.main(material('Cabin Logs', '#8b5e3c', 0.8)),
      material('Cabin Roof', '#4b3b31', 0.85),
      MAT.plank,
      MAT.woodDark,
      MAT.stone,
      MAT.glass,
    ]);
  },
});

const barn = defineModel({
  id: 'barn',
  name: 'Barn',
  category: 'architecture',
  tags: ['farm', 'building', 'agriculture', 'red barn', 'countryside', 'rural'],
  synonyms: ['farm building', 'red barn', 'hay barn', 'granary', 'cow shed'],
  description:
    'Red farm barn with a gambrel roof, white trim, big cross-braced double doors facing −Y, a hayloft door and a ridge cupola.',
  dimensions_m: [8.504, 12.6, 8.8],
  triangles: 464,
  build(m) {
    const b = new MeshBuilder();
    const W = 8;
    const D = 12;
    const eave = 3.6;
    const knee = 5.9;
    const ridge = 7.2;
    const kx = 2.55;
    const prof: Vec2[] = [
      [-W / 2, 0],
      [W / 2, 0],
      [W / 2, eave],
      [kx, knee],
      [0, ridge],
      [-kx, knee],
      [-W / 2, eave],
    ];
    extrude(b, prof, 'y', -D / 2, D / 2, 0);
    const ov = 0.3;
    for (let i = 2; i < 6; i++) {
      const a = prof[i];
      const c = prof[i + 1];
      const dx = c[0] - a[0];
      const dz = c[1] - a[1];
      const l = Math.hypot(dx, dz);
      const n: Vec3 = [dz / l, 0, -dx / l];
      const t = 0.14;
      const ext = i === 2 || i === 5 ? 0.25 : 0;
      const sa = i === 5 ? 0 : ext;
      const sc = i === 5 ? ext : 0;
      const p0: Vec3 = [a[0] - (dx / l) * sa + n[0] * t * 0.5, 0, a[1] - (dz / l) * sa + n[2] * t * 0.5];
      const p1: Vec3 = [c[0] + (dx / l) * sc + n[0] * t * 0.5, 0, c[1] + (dz / l) * sc + n[2] * t * 0.5];
      addBoxBetween(b, p0, p1, D + 2 * ov, t, n, { mat: 1 });
    }
    for (const y of [-D / 2 - 0.04, D / 2 + 0.04]) {
      for (const sx of [-1, 1]) block(b, [sx * (W / 2 - 0.08), y, eave / 2], [0.18, 0.1, eave], 2);
      for (let i = 2; i < 6; i++) {
        const a = prof[i];
        const c = prof[i + 1];
        beam(b, [a[0], y, a[1] - 0.1], [c[0], y, c[1] - 0.1], 0.1, 0.18, 2, [0, 1, 0]);
      }
    }
    const fy = -D / 2 - 0.06;
    const frame = (x0: number, x1: number, z0: number, z1: number, diag: boolean) => {
      const lines: [Vec2, Vec2][] = [
        [
          [x0, z0],
          [x1, z0],
        ],
        [
          [x0, z1],
          [x1, z1],
        ],
        [
          [x0, z0],
          [x0, z1],
        ],
        [
          [x1, z0],
          [x1, z1],
        ],
      ];
      if (diag)
        lines.push(
          [
            [x0, z0],
            [x1, z1],
          ],
          [
            [x1, z0],
            [x0, z1],
          ],
        );
      for (const [p, q] of lines)
        beam(b, [p[0], fy - 0.05, p[1]], [q[0], fy - 0.05, q[1]], 0.14, 0.05, 2, [0, -1, 0]);
    };
    for (const s of [-1, 1]) {
      const cx = s * 1.05;
      block(b, [cx, fy, 1.55], [2.0, 0.08, 3.1], 0);
      frame(cx - 0.95, cx + 0.95, 0.1, 3.0, true);
    }
    block(b, [0, fy, 4.75], [1.5, 0.08, 1.5], 3);
    frame(-0.75, 0.75, 4.0, 5.5, false);
    block(b, [0, 0, ridge + 0.55], [0.9, 0.9, 1.0], 2);
    extrude(
      b,
      [
        [-0.65, ridge + 1.05],
        [0.65, ridge + 1.05],
        [0, ridge + 1.6],
      ],
      'y',
      -0.65,
      0.65,
      1,
    );
    m.part('barn', b, [m.main(material('Barn Red', '#9e2b25', 0.8)), MAT.roofSlate, MAT.white, MAT.woodDark]);
  },
});

const stable = defineModel({
  id: 'stable',
  name: 'Stable',
  category: 'architecture',
  tags: ['farm', 'horse', 'pony', 'stalls', 'building', 'equestrian', 'countryside'],
  synonyms: ['horse stable', 'stables', 'stall barn', 'pony stable', 'livery', 'horse barn'],
  description:
    'Wooden stable block with four Dutch stall doors (top halves open) under a sloping roof that shelters a front walkway on posts (−Y).',
  dimensions_m: [12.6, 6.315, 3.471],
  triangles: 336,
  build(m) {
    const b = new MeshBuilder();
    const W = 12;
    const D = 4.2;
    const hb = 3.3;
    const hf = 2.85;
    extrude(
      b,
      [
        [-D / 2, 0],
        [D / 2, 0],
        [D / 2, hb],
        [-D / 2, hf],
      ],
      'x',
      -W / 2,
      W / 2,
      0,
    );
    // lean-to roof over the walkway
    const yb = D / 2 + 0.3;
    const yf = -D / 2 - 1.8;
    const slope = (hb - hf) / D;
    const zb = hb + 0.3 * slope;
    const zf = hf - 1.8 * slope;
    const n = (() => {
      const l = Math.hypot(yb - yf, zb - zf);
      return [0, -(zb - zf) / l, (yb - yf) / l] as Vec3;
    })();
    addBoxBetween(
      b,
      [0, yb + n[1] * 0.07, zb + 0.07 * n[2]],
      [0, yf + n[1] * 0.07, zf + 0.07 * n[2]],
      W + 0.6,
      0.14,
      n,
      { mat: 1 },
    );
    // walkway posts and beam
    for (let i = 0; i <= 4; i++) {
      const x = -W / 2 + 0.25 + ((W - 0.5) * i) / 4;
      box(b, [x - 0.08, yf + 0.2, 0], [x + 0.08, yf + 0.36, zf + 0.1], 2);
    }
    beam(b, [-W / 2, yf + 0.28, zf - 0.05], [W / 2, yf + 0.28, zf - 0.05], 0.16, 0.18, 2, [0, 0, 1]);
    // four Dutch stall doors: closed lower halves with X braces, open dark upper halves
    const fy = -D / 2;
    for (let i = 0; i < 4; i++) {
      const cx = -W / 2 + 1.5 + i * 3;
      box(b, [cx - 0.7, fy - 0.06, 0], [cx + 0.7, fy + 0.01, 2.45], 3);
      box(b, [cx - 0.58, fy - 0.08, 0.05], [cx + 0.58, fy - 0.05, 1.2], 4);
      box(b, [cx - 0.58, fy - 0.04, 1.3], [cx + 0.58, fy - 0.01, 2.3], 5);
      beam(b, [cx - 0.5, fy - 0.1, 0.15], [cx + 0.5, fy - 0.1, 1.1], 0.1, 0.03, 3, [0, -1, 0]);
      beam(b, [cx + 0.5, fy - 0.1, 0.15], [cx - 0.5, fy - 0.1, 1.1], 0.1, 0.03, 3, [0, -1, 0]);
    }
    m.part('stable', b, [
      m.main(material('Stable Boards', '#a0714b', 0.8)),
      material('Stable Roof', '#5b5e63', 0.75),
      MAT.woodDark,
      MAT.white,
      material('Stall Door Green', '#3d6b4a', 0.6),
      material('Stall Shadow', '#141210', 0.95),
    ]);
  },
});

const storefront = defineModel({
  id: 'storefront',
  name: 'Storefront',
  category: 'architecture',
  tags: ['shop', 'store', 'street', 'town', 'city', 'retail', 'cafe', 'bakery'],
  synonyms: ['shop', 'store', 'corner shop', 'boutique', 'cafe', 'bakery', 'shopfront', 'retail store'],
  description:
    'Small town shop with big display windows either side of a glazed door, a striped awning and a blank sign board, facing −Y.',
  dimensions_m: [6.6, 6.42, 4.55],
  triangles: 372,
  build(m) {
    const b = new MeshBuilder();
    const W = 6.4;
    const D = 5;
    const H = 4.2;
    box(b, [-W / 2, -D / 2, 0], [W / 2, D / 2, H], 0);
    box(b, [-W / 2 - 0.1, -D / 2 - 0.1, H], [W / 2 + 0.1, D / 2 + 0.1, H + 0.35], 1);
    const fy = -D / 2;
    // shopfront frame, windows and door
    box(b, [-W / 2 + 0.2, fy - 0.08, 0], [W / 2 - 0.2, fy, 0.5], 1);
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -W / 2 + 0.3 : 0.75;
      const x1 = s < 0 ? -0.75 : W / 2 - 0.3;
      box(b, [x0, fy - 0.06, 0.5], [x1, fy + 0.01, 2.9], 3);
      box(b, [x0 + 0.08, fy - 0.08, 0.58], [x1 - 0.08, fy - 0.04, 2.82], 2);
    }
    box(b, [-0.62, fy - 0.06, 0], [0.62, fy + 0.01, 2.6], 3);
    box(b, [-0.5, fy - 0.08, 0.08], [0.5, fy - 0.04, 2.5], 2);
    // sign board above
    box(b, [-W / 2 + 0.25, fy - 0.12, 3.35], [W / 2 - 0.25, fy, 4.0], 4);
    box(b, [-W / 2 + 0.4, fy - 0.15, 3.47], [W / 2 - 0.4, fy - 0.12, 3.88], 1);
    // striped awning
    const stripes = 10;
    for (let i = 0; i < stripes; i++) {
      const x0 = -W / 2 + 0.2 + ((W - 0.4) * i) / stripes;
      const x1 = -W / 2 + 0.2 + ((W - 0.4) * (i + 1)) / stripes;
      const mat = i % 2 ? 5 : 6;
      const xc = (x0 + x1) / 2;
      beam(b, [xc, fy, 3.2], [xc, fy - 1.3, 2.6], x1 - x0, 0.04, mat, [0, -0.42, 0.9]);
      box(b, [x0, fy - 1.32, 2.4], [x1, fy - 1.26, 2.62], mat);
    }
    m.part('shop', b, [
      material('Shop Wall', '#d9cbb4', 0.85),
      MAT.frameWhite,
      MAT.glass,
      m.main(material('Shopfront Green', '#2e5e4e', 0.5)),
      material('Sign Board', '#283845', 0.6),
      MAT.white,
      m.main(material('Awning Red', '#b23a3a', 0.8)),
    ]);
  },
});

const beachHut = defineModel({
  id: 'beach_hut',
  name: 'Beach Hut',
  category: 'architecture',
  tags: ['beach', 'seaside', 'hut', 'cabin', 'summer', 'coast', 'shed'],
  synonyms: ['bathing hut', 'beach cabin', 'beach house', 'changing hut', 'bathing box'],
  description:
    'Small striped wooden beach hut on a low deck, pitched roof, white trim and double doors facing −Y.',
  dimensions_m: [2.632, 3.48, 3.037],
  triangles: 268,
  build(m) {
    const b = new MeshBuilder();
    const W = 2.2;
    const D = 2.4;
    const deck = 0.3;
    const eave = deck + 2.1;
    const ridge = eave + 0.55;
    // deck on blocks
    box(b, [-W / 2 - 0.1, -D / 2 - 0.9, 0.18], [W / 2 + 0.1, D / 2 + 0.1, deck], 3);
    for (const x of [-W / 2, W / 2])
      for (const y of [-D / 2 - 0.8, 0, D / 2])
        box(b, [x - 0.07, y - 0.07, 0], [x + 0.07, y + 0.07, 0.18], 3);
    // body (gable along Y), striped front boards
    extrude(
      b,
      gableOutline(W / 2, eave - deck, ridge - deck).map(([x, zz]) => [x, zz + deck] as Vec2),
      'y',
      -D / 2,
      D / 2,
      0,
    );
    const boards = 9;
    for (let i = 0; i < boards; i++) {
      const x0 = -W / 2 + (W * i) / boards;
      const x1 = -W / 2 + (W * (i + 1)) / boards;
      const xc = (x0 + x1) / 2;
      const topZ = eave + (ridge - eave) * (1 - Math.abs(xc) / (W / 2));
      box(b, [x0 + 0.005, -D / 2 - 0.03, deck], [x1 - 0.005, -D / 2, topZ - 0.05], i % 2 ? 1 : 0);
    }
    // doors
    for (const s of [-1, 1])
      box(
        b,
        [s < 0 ? -0.62 : 0.02, -D / 2 - 0.06, deck + 0.05],
        [s < 0 ? -0.02 : 0.62, -D / 2 - 0.03, deck + 1.95],
        4,
      );
    box(b, [-0.7, -D / 2 - 0.07, deck + 1.95], [0.7, -D / 2 - 0.03, deck + 2.05], 1);
    gableRoof(b, W / 2, D, eave, ridge, 2, { overhang: 0.18, thick: 0.08 });
    const hex = m.mainHex('#4fa3c7');
    m.part('hut', b, [
      m.main(material('Beach Hut Blue', hex, 0.6)),
      MAT.white,
      material('Beach Hut Roof', '#e9e5dc', 0.6),
      MAT.plank,
      material(`Beach Hut Door ${shade(hex, 0.8)}`, shade(hex, 0.8), 0.6),
    ]);
  },
});

const lifeguardTower = defineModel({
  id: 'lifeguard_tower',
  name: 'Lifeguard Tower',
  category: 'architecture',
  tags: ['beach', 'lifeguard', 'tower', 'seaside', 'coast', 'watch'],
  synonyms: ['lifeguard stand', 'lifeguard hut', 'watchtower', 'baywatch tower', 'life guard station'],
  description:
    'Beach lifeguard tower: a red and white hut on braced stilts with a deck railing, a sloped roof, a ramp down to the sand (−Y) and a life ring.',
  dimensions_m: [2.8, 6.133, 4.368],
  triangles: 492,
  build(m) {
    const b = new MeshBuilder();
    const yc = 1.4;
    const deckZ = 2.0;
    // stilts with cross bracing
    for (const x of [-1.1, 1.1])
      for (const y of [yc - 1.1, yc + 1.1]) box(b, [x - 0.08, y - 0.08, 0], [x + 0.08, y + 0.08, deckZ], 3);
    for (const x of [-1.1, 1.1]) {
      beam(b, [x, yc - 1.1, 0.2], [x, yc + 1.1, deckZ - 0.2], 0.06, 0.12, 3, [1, 0, 0]);
      beam(b, [x, yc + 1.1, 0.2], [x, yc - 1.1, deckZ - 0.2], 0.06, 0.12, 3, [1, 0, 0]);
    }
    for (const y of [yc - 1.1, yc + 1.1]) {
      beam(b, [-1.1, y, 0.2], [1.1, y, deckZ - 0.2], 0.06, 0.12, 3, [0, 1, 0]);
      beam(b, [1.1, y, 0.2], [-1.1, y, deckZ - 0.2], 0.06, 0.12, 3, [0, 1, 0]);
    }
    // deck
    box(b, [-1.4, yc - 1.4, deckZ], [1.4, yc + 1.3, deckZ + 0.12], 3);
    // hut
    const hz = deckZ + 0.12;
    box(b, [-1.0, yc - 0.6, hz], [1.0, yc + 1.1, hz + 1.9], 0);
    for (const s of [-1, 1])
      box(b, [s * 0.98 - 0.02, yc - 0.65, hz + 0.05], [s * 0.98 + 0.02, yc + 1.15, hz + 0.15], 1);
    box(b, [-0.75, yc - 0.63, hz + 1.0], [0.75, yc - 0.6, hz + 1.6], 5);
    box(b, [-1.02, yc - 0.62, hz + 0.6], [1.02, yc - 0.6, hz + 0.85], 1);
    // roof sloping to the front
    const n: Vec3 = [0, -Math.sin(0.25), Math.cos(0.25)];
    addBoxBetween(b, [0, yc + 1.4, hz + 2.2], [0, yc - 1.0, hz + 2.2 - 2.4 * Math.tan(0.25)], 2.5, 0.1, n, {
      mat: 1,
    });
    // railing on the front deck
    for (const x of [-1.35, -0.45, 0.45, 1.35])
      box(b, [x - 0.03, yc - 1.38, hz], [x + 0.03, yc - 1.32, hz + 0.95], 1);
    box(b, [-1.4, yc - 1.4, hz + 0.9], [1.4, yc - 1.3, hz + 0.98], 1);
    // ramp down to the sand
    beam(b, [0, yc - 1.4, deckZ + 0.06], [0, -3.3, 0.06], 0.9, 0.08, 3, [0, 0, 1]);
    // life ring on the hut front
    torus(b, 0.24, 0.06, 16, 6, 4, xf([0.6, yc - 0.68, hz + 0.45], [Math.PI / 2, 0, 0]));
    m.part('tower', b, [
      m.main(material('Lifeguard Red', '#c8352e', 0.6)),
      MAT.white,
      material('Tower Roof', '#e8e3d6', 0.6),
      MAT.plank,
      material('Life Ring Orange', '#f06a28', 0.5),
      MAT.glass,
    ]);
  },
});

const footbridge = defineModel({
  id: 'footbridge',
  name: 'Footbridge',
  category: 'architecture',
  tags: ['bridge', 'park', 'garden', 'stream', 'river', 'wooden bridge', 'crossing'],
  synonyms: ['bridge', 'wooden bridge', 'garden bridge', 'arched bridge', 'foot bridge', 'pedestrian bridge'],
  description: 'Arched wooden footbridge spanning 6 m along X, plank deck with railings on both sides.',
  dimensions_m: [6.12, 1.52, 1.9],
  triangles: 2712,
  params: z.object({ span: sizeParam(6, 2, 20, 'Span along X in metres') }),
  build(m, p) {
    const b = new MeshBuilder();
    const L = p.span;
    const rise = L * 0.12;
    const halfW = 0.7;
    const zAt = (x: number) => 0.2 + rise * (1 - ((2 * x) / L) ** 2);
    const n = Math.max(8, Math.round(L / 0.2));
    for (let i = 0; i < n; i++) {
      const x0 = -L / 2 + (L * i) / n;
      const x1 = -L / 2 + (L * (i + 1)) / n;
      beam(b, [x0 + 0.01, 0, zAt(x0)], [x1 - 0.01, 0, zAt(x1)], 2 * halfW, 0.05, 0, [0, 0, 1]);
    }
    // stringers under the deck edges
    const path = (y: number, dz: number) =>
      Array.from({ length: n + 1 }, (_, i) => {
        const x = -L / 2 + (L * i) / n;
        return [x, y, zAt(x) + dz] as Vec3;
      });
    for (const y of [-halfW + 0.08, halfW - 0.08]) {
      const pts = path(y, -0.1);
      for (let i = 0; i < n; i++) beam(b, pts[i], pts[i + 1], 0.1, 0.16, 1, [0, 0, 1]);
    }
    // posts and handrails
    const posts = Math.max(3, Math.round(L / 1.0));
    for (const y of [-halfW + 0.04, halfW - 0.04]) {
      for (let i = 0; i <= posts; i++) {
        const x = -L / 2 + 0.05 + ((L - 0.1) * i) / posts;
        box(b, [x - 0.04, y - 0.04, zAt(x) - 0.02], [x + 0.04, y + 0.04, zAt(x) + 0.95], 1);
      }
      const rail = path(y, 0.95);
      for (let i = 0; i < n; i++) beam(b, rail[i], rail[i + 1], 0.07, 0.06, 1, [0, 0, 1]);
      const mid = path(y, 0.5);
      for (let i = 0; i < n; i++) beam(b, mid[i], mid[i + 1], 0.04, 0.05, 1, [0, 0, 1]);
    }
    // stone footings under both ends carry the stringers to the ground
    for (const sx of [-1, 1])
      box(b, [sx * (L / 2 + 0.06), -halfW - 0.06, 0], [sx * (L / 2 - 0.5), halfW + 0.06, 0.1], 2);
    m.part('bridge', b, [m.main(MAT.plank), MAT.woodDark, MAT.stone]);
  },
});

const pier = defineModel({
  id: 'pier',
  name: 'Pier',
  category: 'architecture',
  tags: ['dock', 'jetty', 'lake', 'sea', 'harbour', 'boardwalk', 'wooden', 'water'],
  synonyms: ['dock', 'jetty', 'wharf', 'landing stage', 'boardwalk', 'boat dock', 'quay'],
  description:
    'Wooden pier on piles: an 8 m plank deck 1.2 m above the base running along Y, cross beams, a ladder and mooring bollards at the far end.',
  dimensions_m: [2.49, 8, 1.7],
  triangles: 1152,
  params: z.object({
    length: sizeParam(8, 2, 40, 'Length along Y in metres'),
    deck_height: sizeParam(1.2, 0.3, 4, 'Deck height above the base in metres'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const L = p.length;
    const H = p.deck_height;
    const hw = 1.2;
    const piles = Math.max(2, Math.round(L / 2) + 1);
    for (let i = 0; i < piles; i++) {
      const y = -L / 2 + 0.15 + ((L - 0.3) * i) / (piles - 1);
      for (const x of [-hw + 0.1, hw - 0.1]) cylinder(b, [x, y, 0], [x, y, H + 0.25], 0.11, 8, 1);
      box(b, [-hw, y - 0.08, H - 0.28], [hw, y + 0.08, H - 0.06], 1);
    }
    for (const x of [-hw + 0.25, 0, hw - 0.25])
      box(b, [x - 0.07, -L / 2, H - 0.2], [x + 0.07, L / 2, H - 0.06], 1);
    const planks = Math.round(L / 0.18);
    for (let i = 0; i < planks; i++) {
      const y0 = -L / 2 + (L * i) / planks;
      box(b, [-hw, y0 + 0.01, H - 0.06], [hw, y0 + L / planks - 0.01, H], 0);
    }
    // ladder on the right side at the far end
    const ly = L / 2 - 0.8;
    for (const dy of [-0.22, 0.22])
      box(b, [-hw - 0.08, ly + dy - 0.03, 0.05], [-hw - 0.02, ly + dy + 0.03, H + 0.5], 2);
    for (let k = 0; k < 4; k++)
      cylinder(
        b,
        [-hw - 0.05, ly - 0.22, 0.25 + k * 0.28],
        [-hw - 0.05, ly + 0.22, 0.25 + k * 0.28],
        0.02,
        6,
        2,
      );
    for (const x of [-hw + 0.2, hw - 0.2]) {
      cylinder(b, [x, L / 2 - 0.25, H], [x, L / 2 - 0.25, H + 0.22], 0.09, 10, 2);
      cylinder(b, [x, L / 2 - 0.25, H + 0.22], [x, L / 2 - 0.25, H + 0.27], 0.12, 10, 2);
    }
    m.part('pier', b, [m.main(MAT.plank), MAT.woodDark, MAT.darkMetal]);
  },
});

const brickWall = defineModel({
  id: 'brick_wall',
  name: 'Brick Wall',
  category: 'architecture',
  tags: ['wall', 'brick', 'boundary', 'garden wall', 'masonry'],
  synonyms: ['wall', 'garden wall', 'red brick wall', 'masonry wall', 'boundary wall'],
  description: 'Free-standing red brick garden wall with end piers and a stone coping, running along X.',
  dimensions_m: [4.06, 0.4, 1.74],
  triangles: 72,
  params: z.object({
    length: sizeParam(4, 0.5, 50, 'Length along X in metres'),
    height: sizeParam(1.5, 0.3, 4, 'Height of the brickwork in metres'),
  }),
  build(m, p) {
    const b = new MeshBuilder();
    const L = p.length;
    const H = p.height;
    const pier = Math.min(0.36, L / 4);
    // brickwork between two end piers, a coping on top of the wall and caps on the piers
    box(b, [-L / 2 + pier, -0.12, 0], [L / 2 - pier, 0.12, H], 0);
    box(b, [-L / 2 + pier, -0.15, H], [L / 2 - pier, 0.15, H + 0.07], 1);
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? -L / 2 : L / 2 - pier;
      box(b, [x0, -0.17, 0], [x0 + pier, 0.17, H + 0.16], 0);
      box(b, [x0 - 0.03, -0.2, H + 0.16], [x0 + pier + 0.03, 0.2, H + 0.24], 1);
    }
    m.part('wall', b, [m.main(brickMaterial('Red Brick', m.mainHex('#9a3f2c'))), MAT.concrete]);
  },
});

const stoneWall = defineModel({
  id: 'stone_wall',
  name: 'Stone Wall',
  category: 'architecture',
  tags: ['wall', 'stone', 'dry stone', 'field boundary', 'countryside', 'rural'],
  synonyms: ['dry stone wall', 'drystone wall', 'field wall', 'rock wall', 'boundary wall'],
  description: 'Dry stone field wall of irregular stacked stones with capping stones, running along X.',
  dimensions_m: [4.005, 0.651, 1.145],
  triangles: 1356,
  params: z.object({ length: sizeParam(4, 0.5, 30, 'Length along X in metres'), seed: seedParam }),
  build(m, p) {
    const b = new MeshBuilder();
    const rng = new Rng(p.seed, 0x570e);
    const L = p.length;
    const rows = [
      { z: 0, h: 0.26, d: 0.6 },
      { z: 0.26, h: 0.24, d: 0.54 },
      { z: 0.5, h: 0.22, d: 0.48 },
      { z: 0.72, h: 0.2, d: 0.42 },
    ];
    for (const [ri, row] of rows.entries()) {
      let x = -L / 2 - (ri % 2 ? 0.12 : 0);
      while (x < L / 2) {
        const w = Math.min(rng.range(0.28, 0.55), L / 2 - x);
        const x0 = Math.max(-L / 2, x);
        const ww = x + w - x0;
        if (ww > 0.06)
          for (const side of [-1, 1]) {
            const h = row.h * rng.range(0.85, 1.05);
            const d = row.d / 2 + rng.spread(0.03);
            block(
              b,
              [x0 + ww / 2, (side * row.d) / 4 + rng.spread(0.02), row.z + h / 2],
              [ww * 0.96, d, h],
              rng.chance(0.3) ? 1 : 0,
              rng.spread(0.06),
            );
          }
        x += w;
      }
    }
    let x = -L / 2;
    while (x < L / 2 - 0.05) {
      const w = Math.min(rng.range(0.1, 0.16), L / 2 - x);
      block(b, [x + w / 2, 0, 1.0], [w * 0.9, 0.36, rng.range(0.24, 0.3)], rng.chance(0.4) ? 1 : 0);
      x += w;
    }
    m.part('wall', b, [
      m.main(material('Wall Stone', '#8f8a80', 0.9)),
      material('Wall Stone Dark', '#6f6b64', 0.9),
    ]);
  },
});

const picketFence = defineModel({
  id: 'picket_fence',
  name: 'Picket Fence',
  category: 'architecture',
  tags: ['fence', 'garden', 'boundary', 'white fence', 'yard'],
  synonyms: ['fence', 'white picket fence', 'garden fence', 'paling fence'],
  description: 'White wooden picket fence with pointed boards on two rails, running along X.',
  dimensions_m: [6.1, 0.1, 1.06],
  triangles: 840,
  params: z.object({ length: sizeParam(6, 1, 50, 'Length along X in metres') }),
  build(m, p) {
    const b = new MeshBuilder();
    appendGenerated(
      b,
      generateFence({ style: 'PICKET', length: p.length, height: 1 }),
      [0],
      at(-p.length / 2, 0, 0),
    );
    m.part('fence', b, [m.main(material('Fence White', '#eceae4', 0.6))]);
  },
});

const railFence = defineModel({
  id: 'rail_fence',
  name: 'Rail Fence',
  category: 'architecture',
  tags: ['fence', 'farm', 'paddock', 'ranch', 'field', 'countryside', 'post and rail'],
  synonyms: ['post and rail fence', 'farm fence', 'paddock fence', 'ranch fence', 'wooden fence', 'fence'],
  description: 'Weathered wooden post-and-rail paddock fence with three rails, running along X.',
  dimensions_m: [6.1, 0.1, 1.18],
  triangles: 156,
  params: z.object({ length: sizeParam(6, 1, 50, 'Length along X in metres') }),
  build(m, p) {
    const b = new MeshBuilder();
    appendGenerated(
      b,
      generateFence({ style: 'RAIL', rails: 3, length: p.length, height: 1.1, post_spacing: 2.5 }),
      [0],
      at(-p.length / 2, 0, 0),
    );
    m.part('fence', b, [m.main(MAT.wood)]);
  },
});

const gate = defineModel({
  id: 'gate',
  name: 'Gate',
  category: 'architecture',
  tags: ['gate', 'farm', 'field', 'fence', 'entrance', 'paddock', 'countryside'],
  synonyms: ['farm gate', 'field gate', 'five bar gate', 'wooden gate', 'garden gate', 'paddock gate'],
  description:
    'Wooden five-bar farm gate between two posts; the leaf (part `gate`) is hinged on the right post (−X) so it can swing about Z.',
  dimensions_m: [3.44, 0.24, 1.35],
  triangles: 144,
  build(m) {
    const posts = new MeshBuilder();
    for (const x of [-1.6, 1.6]) {
      box(posts, [x - 0.11, -0.11, 0], [x + 0.11, 0.11, 1.3], 0);
      box(posts, [x - 0.12, -0.12, 1.3], [x + 0.12, 0.12, 1.35], 0);
    }
    m.part('posts', posts, [MAT.woodDark]);
    const leaf = new MeshBuilder();
    const w = 3.0;
    box(leaf, [0, -0.04, 0.15], [0.1, 0.04, 1.2], 0);
    box(leaf, [w - 0.1, -0.04, 0.15], [w, 0.04, 1.2], 0);
    for (let i = 0; i < 5; i++) {
      const zz = 0.2 + i * 0.24;
      box(leaf, [0.1, -0.03, zz], [w - 0.1, 0.03, zz + 0.09], 0);
    }
    beam(leaf, [0.12, -0.05, 0.25], [w - 0.15, -0.05, 1.15], 0.1, 0.03, 0, [0, -1, 0]);
    m.part('gate', leaf, [m.main(MAT.wood)], { location: [-1.48, 0, 0] });
  },
});

const door = defineModel({
  id: 'door',
  name: 'Door',
  category: 'architecture',
  tags: ['door', 'entrance', 'interior', 'house', 'panel door'],
  synonyms: ['front door', 'wooden door', 'interior door', 'doorway', 'entrance door'],
  description:
    'Four-panel door in its frame; the leaf (part `door`) is hinged at its right edge (−X, seen from the front) to swing about Z.',
  dimensions_m: [1.1, 0.166, 2.17],
  triangles: 184,
  build(m) {
    const frame = new MeshBuilder();
    box(frame, [-0.55, -0.08, 0], [-0.47, 0.08, 2.17], 0);
    box(frame, [0.47, -0.08, 0], [0.55, 0.08, 2.17], 0);
    box(frame, [-0.55, -0.08, 2.09], [0.55, 0.08, 2.17], 0);
    m.part('frame', frame, [MAT.frameWhite]);
    const leaf = new MeshBuilder();
    doorLeaf(leaf, 0.92, 2.07, 0.045, 0, 1, 2);
    m.part(
      'door',
      leaf,
      [m.main(material('Door Paint', '#6b4a32', 0.5)), material('Door Panel', '#5c3f2b', 0.55), MAT.metal],
      { location: [-0.46, 0, 0.01] },
    );
  },
});

const windowModel = defineModel({
  id: 'window',
  name: 'Window',
  category: 'architecture',
  tags: ['window', 'glass', 'house', 'interior', 'frame'],
  synonyms: ['window frame', 'casement window', 'sash window', 'glazing', 'pane'],
  description:
    'White-framed window with four panes and a sill, its base at the sill (place it at sill height in a wall).',
  dimensions_m: [1.32, 0.18, 1.34],
  triangles: 108,
  build(m) {
    const b = new MeshBuilder();
    windowUnit(b, 1.2, 1.3, 0.12, 0, 1, 2, 2, at(0, 0, 0.04));
    // the sill, sloped out to the front
    extrude(
      b,
      [
        [-0.12, 0],
        [0.06, 0],
        [0.06, 0.045],
        [-0.12, 0.03],
      ],
      'x',
      -0.66,
      0.66,
      0,
    );
    m.part('window', b, [m.main(MAT.frameWhite), MAT.glass]);
  },
});

const room = defineModel({
  id: 'room',
  name: 'Room',
  category: 'architecture',
  tags: ['interior', 'room', 'indoor', 'walls', 'floor', 'set', 'living room', 'bedroom'],
  synonyms: [
    'interior',
    'indoor set',
    'living room',
    'bedroom',
    'kitchen',
    'house interior',
    'room set',
    'walls',
  ],
  description:
    'Interior set: a wooden floor and three plastered walls (the −Y wall is left open for the camera) with a door opening in the left wall (+X) and a window in the back wall; door and window are parts.',
  dimensions_m: [5.261, 4.12, 2.7],
  triangles: 388,
  params: z.object({
    width: sizeParam(5, 2, 20, 'Inside width along X in metres'),
    depth: sizeParam(4, 2, 20, 'Inside depth along Y in metres'),
    height: sizeParam(2.7, 2, 6, 'Wall height in metres'),
    door: z.boolean().default(true).describe('Door opening (with a door) in the +X wall'),
    window: z.boolean().default(true).describe('Window opening (with a window) in the back wall'),
  }),
  build(m, p) {
    const W = p.width;
    const D = p.depth;
    const H = p.height;
    const t = 0.12;
    const floor = new MeshBuilder();
    box(floor, [-W / 2 - t, -D / 2, 0], [W / 2 + t, D / 2 + t, 0.02], 0);
    m.part('floor', floor, [material('Floor Boards', '#9b7653', 0.55)]);
    const walls = new MeshBuilder();
    const winW = Math.min(1.6, W * 0.4);
    const back: Opening[] = p.window
      ? [{ x0: -winW / 2, x1: winW / 2, z0: 0.95, z1: 0.95 + Math.min(1.3, H - 1.3) }]
      : [];
    wallWithOpenings(walls, W + 2 * t, H, t, back, 0, at(0, D / 2 + t / 2, 0), 0.02);
    const doorY = -D / 2 + Math.min(1.2, D * 0.3);
    const left: Opening[] = p.door ? [{ x0: doorY - 0.45, x1: doorY + 0.45, z0: 0.02, z1: 2.1 }] : [];
    // the +X wall runs along Y: build along X then turn it a quarter (x → y)
    wallWithOpenings(
      walls,
      D,
      H,
      t,
      left.map((o) => ({ ...o })),
      0,
      at(W / 2 + t / 2, 0, 0, Math.PI / 2),
      0.02,
    );
    wallWithOpenings(walls, D, H, t, [], 0, at(-W / 2 - t / 2, 0, 0, Math.PI / 2), 0.02);
    // skirting boards
    box(walls, [-W / 2, D / 2 - 0.015, 0.02], [W / 2, D / 2, 0.12], 1);
    for (const s of [-1, 1])
      box(
        walls,
        [s < 0 ? -W / 2 : W / 2 - 0.015, -D / 2, 0.02],
        [s < 0 ? -W / 2 + 0.015 : W / 2, D / 2, 0.12],
        1,
      );
    m.part('walls', walls, [m.main(material('Plaster Wall', '#e6dfd2', 0.9)), MAT.frameWhite]);
    if (p.window) {
      const w = new MeshBuilder();
      windowUnit(w, winW, Math.min(1.3, H - 1.3), t, 0, 1, 2, 2);
      m.part('window', w, [MAT.frameWhite, MAT.glass], { location: [0, D / 2 + t / 2, 0.95] });
    }
    if (p.door) {
      const d = new MeshBuilder();
      doorLeaf(d, 0.88, 2.06, 0.04, 0, 1, 2);
      // hinged at the −Y jamb, swinging about Z; the leaf runs along +Y
      m.part(
        'door',
        d,
        [material('Door Paint', '#6b4a32', 0.5), material('Door Panel', '#5c3f2b', 0.55), MAT.metal],
        { location: [W / 2 + t / 2, doorY - 0.44, 0.03], rotation: [0, 0, Math.PI / 2] },
      );
    }
  },
});

const stairs = defineModel({
  id: 'stairs',
  name: 'Stairs',
  category: 'architecture',
  tags: ['stairs', 'steps', 'staircase', 'concrete', 'railing'],
  synonyms: ['staircase', 'steps', 'stairway', 'flight of stairs', 'stair'],
  description:
    'Straight concrete flight of twelve steps climbing towards +Y (the first step faces −Y) with metal handrails.',
  dimensions_m: [1, 3.36, 3.101],
  triangles: 324,
  params: z.object({
    steps: z
      .number()
      .int()
      .min(1)
      .max(40)
      .default(12)
      .describe('Number of steps (0.18 m rise, 0.28 m run each)'),
  }),
  build(m, p) {
    const res = generateStairs({ steps: p.steps, railing: true });
    const b = new MeshBuilder();
    appendGenerated(b, res, [0, 1], at(0, (-p.steps * 0.28) / 2, 0));
    m.part('stairs', b, [m.main(MAT.concrete), MAT.metal]);
  },
});

const column = defineModel({
  id: 'column',
  name: 'Column',
  category: 'architecture',
  tags: ['column', 'pillar', 'classical', 'marble', 'temple', 'greek', 'roman'],
  synonyms: ['pillar', 'classical column', 'doric column', 'marble column', 'colonnade'],
  description:
    'Classical marble column, 3 m: square plinth, round base moulding, tapering fluted shaft and a capital.',
  dimensions_m: [0.675, 0.675, 3],
  triangles: 3668,
  build(m) {
    const res = generateColumn({ flutes: 8, segments: 24 });
    m.part('column', res.mesh, [
      m.main(fromGenerated(MATERIALS.marble)),
      fromGenerated(MATERIALS.marbleTrim),
    ]);
  },
});

const arch = defineModel({
  id: 'arch',
  name: 'Arch',
  category: 'architecture',
  tags: ['arch', 'archway', 'stone', 'gateway', 'ruin', 'entrance'],
  synonyms: ['archway', 'stone arch', 'gateway', 'portal', 'round arch'],
  description: 'Free-standing round stone archway, 2 m clear opening, facing −Y.',
  dimensions_m: [3, 0.5, 3],
  triangles: 120,
  build(m) {
    m.part('arch', generateArch({}).mesh, [m.main(fromGenerated(MATERIALS.stone))]);
  },
});

/** Built-in architecture models. */
export const ARCHITECTURE_MODELS: CatalogEntry[] = [
  house,
  apartmentBuilding,
  cottage,
  logCabin,
  barn,
  stable,
  storefront,
  beachHut,
  lifeguardTower,
  footbridge,
  pier,
  brickWall,
  stoneWall,
  picketFence,
  railFence,
  gate,
  door,
  windowModel,
  room,
  stairs,
  column,
  arch,
];
