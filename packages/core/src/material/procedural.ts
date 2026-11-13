import type { Vec2, Vec3, Vec4 } from '../math/types';
import type { ProceduralTexture, ProceduralType } from '../doc/types';
import {
  NOISE_FBM,
  PFX_STREAM_CELL,
  PFX_STREAM_CELL_B,
  PFX_STREAM_CELL_G,
  PFX_STREAM_CELL_R,
  PFX_STREAM_WARP,
  VORONOI_EDGE,
  VORONOI_F1,
  VORONOI_F2,
  fractalNoise,
  gradientNoise,
  hash3,
  hashStream,
  hashUnit,
  sanitizeCoord,
  seedHash,
  streamSeed,
  voronoi3,
} from './noise';
import {
  PROCEDURAL_COMMON_PARAMS,
  PROCEDURAL_TYPE_DEFAULTS,
  PROCEDURAL_TYPE_PARAMS,
  PROCEDURAL_TYPES,
  type ProceduralParamSpec,
} from './procedural-params';

/*
 * Procedural textures (Blender shader-node-like): NOISE, VORONOI, CHECKER, GRADIENT, WAVE, BRICK,
 * MARBLE, WOOD and MAGIC, followed by a two-stop colour ramp.
 *
 * A ProceduralTexture is first compiled into a flat, validated `CompiledProcedural` (numbers only),
 * which is exactly what the viewport shader receives as a uniform struct; `sampleCompiled` and the
 * GLSL `pfxSample` evaluate the same formulas from it, so the CPU renderers, the glTF baker and the
 * viewport agree.
 */

/**
 * Texture coordinate of a surface point for a procedural texture's `mapping`:
 * GENERATED = position normalised to the object's (base mesh) bounding box (0..1 per axis),
 * OBJECT = object-space position, UV = (u, v, 0).
 */
export function proceduralCoord(
  mapping: ProceduralTexture['mapping'],
  objectPos: Readonly<Vec3>,
  bboxMin: Readonly<Vec3>,
  bboxMax: Readonly<Vec3>,
  uv: Readonly<Vec2> | null,
): Vec3 {
  if (mapping === 'UV') return uv ? [uv[0], uv[1], 0] : [0, 0, 0];
  if (mapping === 'OBJECT') return [objectPos[0], objectPos[1], objectPos[2]];
  const g = (i: number) => {
    const d = bboxMax[i] - bboxMin[i];
    return d > 1e-12 ? (objectPos[i] - bboxMin[i]) / d : 0.5;
  };
  return [g(0), g(1), g(2)];
}

// ---------------------------------------------------------------- ids shared with the GLSL

/** Type ids of the compiled form (`CompiledProcedural.type`). */
export const PROCEDURAL_TYPE_ID: Readonly<Record<ProceduralType, number>> = {
  NOISE: 0,
  VORONOI: 1,
  CHECKER: 2,
  GRADIENT: 3,
  WAVE: 4,
  BRICK: 5,
  MARBLE: 6,
  WOOD: 7,
  MAGIC: 8,
};
/** Type id of an unknown/invalid type: evaluates to a constant color_a. */
export const PROCEDURAL_CONSTANT_ID = 9;
/** Mapping ids of the compiled form. */
export const PROCEDURAL_MAPPING_ID: Readonly<Record<ProceduralTexture['mapping'], number>> = {
  GENERATED: 0,
  OBJECT: 1,
  UV: 2,
};

const T_NOISE = 0;
const T_VORONOI = 1;
const T_CHECKER = 2;
const T_GRADIENT = 3;
const T_WAVE = 4;
const T_BRICK = 5;
const T_MARBLE = 6;
const T_WOOD = 7;
const T_MAGIC = 8;

/** Ramp interpolation ids (`mode[3]`). */
export const RAMP_LINEAR = 0;
export const RAMP_EASE = 1;
export const RAMP_CONSTANT = 2;

/**
 * Where each param of a type lands in the compiled form: `mode[i]` (integers/enum indices) or
 * `k0..k2[i]` (numbers). `mode[3]` is the ramp interpolation for every type; the GLSL reads the same
 * slots.
 */
export const PROCEDURAL_PACKING: Readonly<
  Record<ProceduralType, Readonly<Record<string, readonly ['mode' | 'k0' | 'k1' | 'k2', number]>>>
> = {
  NOISE: { noise_type: ['mode', 0], lacunarity: ['k0', 0] },
  VORONOI: {
    feature: ['mode', 0],
    distance: ['mode', 1],
    randomness: ['k0', 0],
    color_randomness: ['k0', 1],
  },
  CHECKER: {},
  GRADIENT: { gradient_type: ['mode', 0] },
  WAVE: {
    wave_type: ['mode', 0],
    direction: ['mode', 1],
    wave_profile: ['mode', 2],
    phase: ['k0', 0],
    detail_scale: ['k0', 1],
  },
  BRICK: {
    offset_frequency: ['mode', 0],
    squash_frequency: ['mode', 1],
    plane: ['mode', 2],
    mortar_size: ['k0', 0],
    mortar_smooth: ['k0', 1],
    brick_width: ['k0', 2],
    row_height: ['k0', 3],
    offset: ['k1', 0],
    squash: ['k1', 1],
    bias: ['k1', 2],
    mortar_r: ['k2', 0],
    mortar_g: ['k2', 1],
    mortar_b: ['k2', 2],
  },
  MARBLE: { marble_type: ['mode', 0], wave_profile: ['mode', 1] },
  WOOD: { wood_type: ['mode', 0], wave_profile: ['mode', 1], axis: ['mode', 2], grain: ['k0', 0] },
  MAGIC: {},
};

/**
 * Validated, flat form of a ProceduralTexture (numbers only). Field names and layout match the
 * viewport shader's `PfxTex` uniform struct.
 */
export interface CompiledProcedural {
  /** PROCEDURAL_TYPE_ID (or PROCEDURAL_CONSTANT_ID). */
  type: number;
  /** PROCEDURAL_MAPPING_ID. */
  mapping: number;
  /** Type-specific integer options (PROCEDURAL_PACKING); [3] = ramp interpolation. */
  mode: [number, number, number, number];
  /** scale, detail, roughness, distortion. */
  basic: [number, number, number, number];
  /** ramp_low, ramp_high, 0, 0. */
  ramp: [number, number, number, number];
  colorA: [number, number, number, number];
  colorB: [number, number, number, number];
  /** Texture-space offset xyz (w unused). */
  offset: [number, number, number, number];
  /** Type-specific numbers (PROCEDURAL_PACKING). */
  k0: [number, number, number, number];
  k1: [number, number, number, number];
  k2: [number, number, number, number];
  /** Hashed seed (uint32, `seedHash(tex.seed)`). */
  seed: number;
  /** Bump displacement in metres for height 1 (`params.bump_distance`; normal channel only). */
  bumpDistance: number;
}

/** Shared-field defaults of every type (before PROCEDURAL_TYPE_DEFAULTS). */
const PROCEDURAL_BASE_DEFAULTS: Omit<ProceduralTexture, 'type' | 'params'> = {
  mapping: 'GENERATED',
  scale: 5,
  detail: 2,
  roughness: 0.5,
  distortion: 0,
  color_a: [0, 0, 0, 1],
  color_b: [1, 1, 1, 1],
  ramp_low: 0,
  ramp_high: 1,
  seed: 0,
};

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clampNum(v: number, min = -Infinity, max = Infinity): number {
  return v < min ? min : v > max ? max : v;
}

function color4(v: unknown, fallback: Readonly<Vec4>): [number, number, number, number] {
  const a = Array.isArray(v) ? v : [];
  return [
    finite(a[0], fallback[0]),
    finite(a[1], fallback[1]),
    finite(a[2], fallback[2]),
    finite(a[3], a.length === 3 ? 1 : fallback[3]),
  ];
}

/** Resolved value of a param: enum index, clamped (integer) number. */
function paramValue(spec: ProceduralParamSpec, params: Record<string, unknown> | undefined): number {
  const raw = params ? params[spec.key] : undefined;
  if (spec.kind === 'enum') {
    const values = spec.values!;
    const i = typeof raw === 'string' ? values.indexOf(raw) : -1;
    return i >= 0 ? i : values.indexOf(spec.default as string);
  }
  let v = finite(raw, spec.default as number);
  if (spec.kind === 'int') v = Math.round(v);
  return clampNum(v, spec.min, spec.max);
}

/** Compiles (validates, applies defaults, clamps) a procedural texture. Never throws. */
export function compileProcedural(tex: ProceduralTexture): CompiledProcedural {
  const t = (tex ?? {}) as Partial<ProceduralTexture>;
  const known = typeof t.type === 'string' && (PROCEDURAL_TYPES as readonly string[]).includes(t.type);
  const type = (known ? t.type : 'NOISE') as ProceduralType;
  const d = { ...PROCEDURAL_BASE_DEFAULTS, ...PROCEDURAL_TYPE_DEFAULTS[type] };
  const params = t.params && typeof t.params === 'object' ? (t.params as Record<string, unknown>) : undefined;
  const c: CompiledProcedural = {
    type: known ? PROCEDURAL_TYPE_ID[type] : PROCEDURAL_CONSTANT_ID,
    mapping: PROCEDURAL_MAPPING_ID[t.mapping as ProceduralTexture['mapping']] ?? 0,
    mode: [0, 0, 0, 0],
    basic: [
      clampNum(finite(t.scale, d.scale), -1e6, 1e6),
      clampNum(finite(t.detail, d.detail), 0, 15),
      clampNum(finite(t.roughness, d.roughness), 0, 1),
      clampNum(finite(t.distortion, d.distortion), -1000, 1000),
    ],
    ramp: [finite(t.ramp_low, d.ramp_low), finite(t.ramp_high, d.ramp_high), 0, 0],
    colorA: color4(t.color_a, d.color_a),
    colorB: color4(t.color_b, d.color_b),
    offset: [0, 0, 0, 0],
    k0: [0, 0, 0, 0],
    k1: [0, 0, 0, 0],
    k2: [0, 0, 0, 1],
    seed: seedHash(finite(t.seed, 0)),
    bumpDistance: 0.1,
  };
  for (const spec of PROCEDURAL_COMMON_PARAMS) {
    const v = paramValue(spec, params);
    if (spec.key === 'offset_x') c.offset[0] = v;
    else if (spec.key === 'offset_y') c.offset[1] = v;
    else if (spec.key === 'offset_z') c.offset[2] = v;
    else if (spec.key === 'ramp_interpolation') c.mode[3] = v;
    else if (spec.key === 'bump_distance') c.bumpDistance = v;
  }
  const packing = PROCEDURAL_PACKING[type];
  for (const spec of PROCEDURAL_TYPE_PARAMS[type]) {
    const slot = packing[spec.key];
    if (slot) c[slot[0]][slot[1]] = paramValue(spec, params);
  }
  if (type === 'MAGIC') c.mode[0] = Math.min(10, Math.floor(c.basic[1]));
  return c;
}

/** A complete procedural texture of `type` with Blender-like defaults, overridden by `init`. */
export function defaultProcedural(
  type: ProceduralType,
  init: Partial<Omit<ProceduralTexture, 'type'>> = {},
): ProceduralTexture {
  const d = { ...PROCEDURAL_BASE_DEFAULTS, ...PROCEDURAL_TYPE_DEFAULTS[type] };
  return {
    type,
    mapping: init.mapping ?? d.mapping,
    scale: init.scale ?? d.scale,
    detail: init.detail ?? d.detail,
    roughness: init.roughness ?? d.roughness,
    distortion: init.distortion ?? d.distortion,
    color_a: [...(init.color_a ?? d.color_a)] as Vec4,
    color_b: [...(init.color_b ?? d.color_b)] as Vec4,
    ramp_low: init.ramp_low ?? d.ramp_low,
    ramp_high: init.ramp_high ?? d.ramp_high,
    seed: init.seed ?? d.seed,
    params: { ...(init.params ?? {}) },
  };
}

// ---------------------------------------------------------------- evaluation

const TWO_PI = Math.PI * 2;
const INV_SQRT3 = 1 / Math.sqrt(3);
const vor = new Float64Array(3);

/** Periodic wave (period 2π) in [0, 1]: 0 SIN (0 at n = 0), 1 SAW, 2 TRI. */
function waveProfile(n: number, profile: number): number {
  if (profile === 1) {
    const t = n / TWO_PI;
    return t - Math.floor(t);
  }
  if (profile === 2) {
    const t = n / TWO_PI;
    return Math.abs(t - Math.floor(t + 0.5)) * 2;
  }
  return 0.5 - 0.5 * Math.cos(n);
}

/**
 * Two-stop colour ramp position (0 = color_a, 1 = color_b) of factor `f`, like Blender's ColorRamp
 * with color_a at `low` and color_b at `high`. The stops may be in either order (low > high inverts
 * the ramp). CONSTANT (and coincident stops) hold the colour of the stop at or below the factor, i.e.
 * a hard step at the upper stop.
 */
function rampT(f: number, low: number, high: number, interp: number): number {
  if (!(f === f)) f = 0;
  const span = high - low;
  if (interp === RAMP_CONSTANT || !(span > 1e-9 || span < -1e-9))
    return span < 0 ? (f >= low ? 0 : 1) : f >= high ? 1 : 0;
  let t = (f - low) / span;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return interp === RAMP_EASE ? t * t * (3 - 2 * t) : t;
}

/**
 * Number of values `samplePattern` writes per sample: [0] factor (MAGIC: red factor), [1..2] MAGIC
 * green/blue factors, [3] BRICK mortar amount, [4..6] VORONOI random cell colour.
 */
export const PATTERN_STRIDE = 7;

/**
 * Key of the pattern part of a compiled texture (everything `samplePattern` reads): textures with
 * equal keys produce equal patterns at equal texture coordinates and differ at most in their colour
 * ramp, mortar colour or cell-colour amount, so renderers can evaluate the pattern once for several
 * channels (e.g. one noise driving colour, roughness and bump).
 */
export function patternKey(c: CompiledProcedural): string {
  const voronoi = c.type === T_VORONOI;
  return [
    c.type,
    c.mapping,
    c.mode[0],
    c.mode[1],
    c.mode[2],
    ...c.basic,
    ...c.offset,
    c.k0[0],
    voronoi ? 0 : c.k0[1],
    c.k0[2],
    c.k0[3],
    ...c.k1,
    c.seed,
  ].join(',');
}

/**
 * Pattern stage of `sampleCompiled`: evaluates the texture's factor(s) at a texture coordinate (the
 * texture's offset and scale are applied here) into `pat[o .. o + PATTERN_STRIDE)`; `rampPattern`
 * then turns them into colours.
 */
export function samplePattern(
  c: CompiledProcedural,
  cx: number,
  cy: number,
  cz: number,
  pat: Float64Array | number[],
  o = 0,
): void {
  const scale = c.basic[0];
  const x = sanitizeCoord((cx + c.offset[0]) * scale);
  const y = sanitizeCoord((cy + c.offset[1]) * scale);
  const z = sanitizeCoord((cz + c.offset[2]) * scale);
  const detail = c.basic[1];
  const rough = c.basic[2];
  const dist = c.basic[3];
  const s = c.seed;
  const mode = c.mode;
  const k0 = c.k0;
  let f: number;
  let fg = 0;
  let fb = 0;
  let mortar = 0;
  let cr = 0;
  let cg = 0;
  let cb = 0;
  switch (c.type) {
    case T_NOISE:
    case T_VORONOI: {
      let px = x;
      let py = y;
      let pz = z;
      if (dist !== 0) {
        // domain warp by three decorrelated noises (Blender's Noise Texture "Distortion")
        px += dist * gradientNoise(x, y, z, streamSeed(s, PFX_STREAM_WARP));
        py += dist * gradientNoise(x, y, z, streamSeed(s, PFX_STREAM_WARP + 1));
        pz += dist * gradientNoise(x, y, z, streamSeed(s, PFX_STREAM_WARP + 2));
      }
      if (c.type === T_NOISE) {
        f = fractalNoise(px, py, pz, detail, rough, k0[0], s, mode[0]);
        break;
      }
      const feature = mode[0];
      const h = voronoi3(px, py, pz, k0[0], mode[1], s, feature === 2, vor);
      f =
        feature === 1
          ? vor[VORONOI_F2]
          : feature === 2
            ? vor[VORONOI_EDGE]
            : feature === 3
              ? hashUnit(hashStream(h, PFX_STREAM_CELL))
              : vor[VORONOI_F1];
      cr = hashUnit(hashStream(h, PFX_STREAM_CELL_R));
      cg = hashUnit(hashStream(h, PFX_STREAM_CELL_G));
      cb = hashUnit(hashStream(h, PFX_STREAM_CELL_B));
      break;
    }
    case T_CHECKER: {
      // tiny nudge (as Blender) so faces lying exactly on cell boundaries pick a consistent cell
      const ix = Math.floor((x + 1e-6) * 0.999999) | 0;
      const iy = Math.floor((y + 1e-6) * 0.999999) | 0;
      const iz = Math.floor((z + 1e-6) * 0.999999) | 0;
      f = (ix + iy + iz) & 1;
      break;
    }
    case T_GRADIENT:
      f = gradientFactor(mode[0], x, y, z);
      break;
    case T_WAVE: {
      let n: number;
      const dir = mode[1];
      if (mode[0] === 0) {
        n = dir === 0 ? x * 20 : dir === 1 ? y * 20 : dir === 2 ? z * 20 : (x + y + z) * 10;
      } else {
        const rx = dir === 0 ? 0 : x;
        const ry = dir === 1 ? 0 : y;
        const rz = dir === 2 ? 0 : z;
        n = Math.sqrt(rx * rx + ry * ry + rz * rz) * 20;
      }
      n += k0[0];
      if (dist !== 0) {
        const ds = k0[1];
        n += dist * (fractalNoise(x * ds, y * ds, z * ds, detail, rough, 2, s, NOISE_FBM) * 2 - 1);
      }
      f = waveProfile(n, mode[2]);
      break;
    }
    case T_BRICK: {
      const mortarSize = k0[0];
      const smooth = k0[1];
      const bw = k0[2];
      const rh = k0[3];
      // plane WALL: courses stacked along Z, bricks along X + Y
      const px = mode[2] === 1 ? x + y : x;
      const py = mode[2] === 1 ? z : y;
      const row = Math.floor(py / rh);
      const offFreq = mode[0];
      const sqFreq = mode[1];
      const width = row - sqFreq * Math.floor(row / sqFreq) === 0 ? bw * c.k1[1] : bw;
      const shift = row - offFreq * Math.floor(row / offFreq) === 0 ? width * c.k1[0] : 0;
      const bx = px + shift;
      const brick = Math.floor(bx / width);
      const lx = bx - width * brick;
      const ly = py - rh * row;
      const tint = hashUnit(hash3(brick | 0, row | 0, 0, s)) + c.k1[2];
      f = tint < 0 ? 0 : tint > 1 ? 1 : tint;
      const md = Math.min(lx, ly, width - lx, rh - ly);
      if (md < mortarSize) {
        if (smooth <= 0) mortar = 1;
        else {
          const m = (1 - md / mortarSize) / smooth;
          const t = m < 0 ? 0 : m > 1 ? 1 : m;
          mortar = t * t * (3 - 2 * t);
        }
      }
      break;
    }
    case T_MARBLE: {
      let n = (x + y + z) * INV_SQRT3;
      if (dist !== 0) n += dist * (fractalNoise(x, y, z, detail, rough, 2, s, NOISE_FBM) * 2 - 1);
      let v = waveProfile(n * TWO_PI, mode[1]);
      if (mode[0] >= 1) v = Math.sqrt(v);
      if (mode[0] >= 2) v = Math.sqrt(v);
      f = v;
      break;
    }
    case T_WOOD: {
      // the ring axis becomes w: X → (u, v, w) = (y, z, x), Y → (z, x, y), Z → (x, y, z)
      const u = mode[2] === 1 ? y : mode[2] === 2 ? z : x;
      const v0 = mode[2] === 1 ? z : mode[2] === 2 ? x : y;
      const w = mode[2] === 1 ? x : mode[2] === 2 ? y : z;
      let n = mode[0] === 0 ? Math.sqrt(u * u + v0 * v0) : (u + v0 + w) * INV_SQRT3;
      if (dist !== 0) n += dist * (fractalNoise(u, v0, w * 0.25, detail, rough, 2, s, NOISE_FBM) * 2 - 1);
      let v = waveProfile(n * TWO_PI, mode[1]);
      const grain = k0[0];
      if (grain > 0)
        v *= 1 - grain * fractalNoise(u * 16, v0 * 16, w * 0.5, 1, 0.5, 2, streamSeed(s, 7), NOISE_FBM);
      f = v;
      break;
    }
    case T_MAGIC: {
      // three interfering waves, folded through each other channel by channel (one per depth step)
      const gain = dist * 1.5;
      let a = Math.sin((x + y + z) * 5) * dist;
      let b = Math.cos((-x + y - z) * 5) * dist;
      let cc = -Math.cos((-x - y + z) * 5) * dist;
      for (let i = 0; i < mode[0]; i++) {
        const k = i % 3;
        if (k === 0) b = -Math.cos(a + cc - b) * gain;
        else if (k === 1) cc = Math.sin(a - b - cc) * gain;
        else a = Math.cos(a + b + cc) * gain;
      }
      const inv = gain !== 0 ? 1 / gain : 0;
      f = 0.5 + 0.5 * a * inv;
      fg = 0.5 + 0.5 * b * inv;
      fb = 0.5 + 0.5 * cc * inv;
      break;
    }
    default:
      f = 0;
  }
  pat[o] = f;
  pat[o + 1] = fg;
  pat[o + 2] = fb;
  pat[o + 3] = mortar;
  pat[o + 4] = cr;
  pat[o + 5] = cg;
  pat[o + 6] = cb;
}

/**
 * Colour stage of `sampleCompiled`: maps the pattern values at `pat[o]` (from `samplePattern` of a
 * texture with the same `patternKey`) through the colour ramp of `c` and applies its mortar or cell
 * colours; writes linear RGBA into `out[0..3]`.
 */
export function rampPattern(
  c: CompiledProcedural,
  pat: Float64Array | number[],
  o: number,
  out: Float64Array | number[],
): void {
  const A = c.colorA;
  const B = c.colorB;
  const low = c.ramp[0];
  const high = c.ramp[1];
  const interp = c.mode[3];
  if (c.type === T_MAGIC) {
    const fr = pat[o];
    const fg = pat[o + 1];
    const fb = pat[o + 2];
    const tr = rampT(fr, low, high, interp);
    const tg = rampT(fg, low, high, interp);
    const tb = rampT(fb, low, high, interp);
    const ta = rampT((fr + fg + fb) / 3, low, high, interp);
    out[0] = A[0] + tr * (B[0] - A[0]);
    out[1] = A[1] + tg * (B[1] - A[1]);
    out[2] = A[2] + tb * (B[2] - A[2]);
    out[3] = A[3] + ta * (B[3] - A[3]);
  } else {
    const t = rampT(pat[o], low, high, interp);
    out[0] = A[0] + t * (B[0] - A[0]);
    out[1] = A[1] + t * (B[1] - A[1]);
    out[2] = A[2] + t * (B[2] - A[2]);
    out[3] = A[3] + t * (B[3] - A[3]);
  }
  let over = 0;
  let or = 0;
  let og = 0;
  let ob = 0;
  if (c.type === T_BRICK) {
    over = pat[o + 3];
    or = c.k2[0];
    og = c.k2[1];
    ob = c.k2[2];
  } else if (c.type === T_VORONOI && c.k0[1] > 0) {
    over = c.k0[1];
    or = pat[o + 4];
    og = pat[o + 5];
    ob = pat[o + 6];
  }
  if (over > 0) {
    out[0] += over * (or - out[0]);
    out[1] += over * (og - out[1]);
    out[2] += over * (ob - out[2]);
    out[3] += over * (1 - out[3]);
  }
}

const patScratch = new Float64Array(PATTERN_STRIDE);

/**
 * Evaluates a compiled procedural texture at a texture coordinate (the texture's offset and scale
 * are applied here) and writes linear RGBA (after the colour ramp) into `out[0..3]`.
 */
export function sampleCompiled(
  c: CompiledProcedural,
  cx: number,
  cy: number,
  cz: number,
  out: Float64Array | number[],
): void {
  samplePattern(c, cx, cy, cz, patScratch, 0);
  rampPattern(c, patScratch, 0, out);
}

/** Blender Gradient Texture factor of a scaled coordinate. */
function gradientFactor(kind: number, x: number, y: number, z: number): number {
  let f: number;
  switch (kind) {
    case 1: {
      const r = x > 0 ? x : 0;
      f = r * r;
      break;
    }
    case 2: {
      const r = x < 0 ? 0 : x > 1 ? 1 : x;
      const t = r * r;
      f = 3 * t - 2 * t * r;
      break;
    }
    case 3:
      f = (x + y) * 0.5;
      break;
    case 4:
      f = Math.max(0.999999 - Math.sqrt(x * x + y * y + z * z), 0);
      break;
    case 5: {
      const r = Math.max(0.999999 - Math.sqrt(x * x + y * y + z * z), 0);
      f = r * r;
      break;
    }
    case 6:
      f = Math.atan2(y, x) / TWO_PI + 0.5;
      break;
    default:
      f = x;
  }
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// ---------------------------------------------------------------- convenience API (contract)

interface CacheEntry {
  sig: unknown[];
  compiled: CompiledProcedural;
}

/** Compiled forms keyed by texture object, validated against a content signature on every hit. */
const compiledCache = new WeakMap<object, CacheEntry>();

/** Flat content signature of a texture (colours as length + items; '#' marks a non-array). */
function signature(tex: ProceduralTexture): unknown[] {
  const sig: unknown[] = [
    tex.type,
    tex.mapping,
    tex.scale,
    tex.detail,
    tex.roughness,
    tex.distortion,
    tex.ramp_low,
    tex.ramp_high,
    tex.seed,
  ];
  for (const col of [tex.color_a, tex.color_b])
    if (Array.isArray(col)) sig.push(col.length, ...col);
    else sig.push('#', col);
  const params = tex.params;
  if (params && typeof params === 'object') for (const k in params) sig.push(k, params[k]);
  return sig;
}

/** Compares a colour with the signature at `i`; returns the next index or −1 (no allocation). */
function matchColour(sig: unknown[], i: number, col: unknown): number {
  if (Array.isArray(col)) {
    if (sig[i] !== col.length) return -1;
    for (let k = 0; k < col.length; k++) if (sig[i + 1 + k] !== col[k]) return -1;
    return i + 1 + col.length;
  }
  return sig[i] === '#' && sig[i + 1] === col ? i + 2 : -1;
}

/** True when `tex` still has the content recorded in `sig` (allocation-free: called per sample). */
function sameSignature(sig: unknown[], tex: ProceduralTexture): boolean {
  if (
    sig[0] !== tex.type ||
    sig[1] !== tex.mapping ||
    sig[2] !== tex.scale ||
    sig[3] !== tex.detail ||
    sig[4] !== tex.roughness ||
    sig[5] !== tex.distortion ||
    sig[6] !== tex.ramp_low ||
    sig[7] !== tex.ramp_high ||
    sig[8] !== tex.seed
  )
    return false;
  let i = matchColour(sig, 9, tex.color_a);
  if (i < 0) return false;
  i = matchColour(sig, i, tex.color_b);
  if (i < 0) return false;
  const params = tex.params;
  if (params && typeof params === 'object')
    for (const k in params) {
      if (sig[i] !== k || sig[i + 1] !== params[k]) return false;
      i += 2;
    }
  return i === sig.length;
}

/**
 * Compiled form of a texture, cached per texture object (the cache entry is re-validated against
 * the texture's content, so mutating a texture between calls is safe).
 */
export function compileProceduralCached(tex: ProceduralTexture): CompiledProcedural {
  if (!tex || typeof tex !== 'object') return compileProcedural(tex);
  const hit = compiledCache.get(tex);
  if (hit && sameSignature(hit.sig, tex)) return hit.compiled;
  const compiled = compileProcedural(tex);
  compiledCache.set(tex, { sig: signature(tex), compiled });
  return compiled;
}

/**
 * Evaluates a procedural texture at a texture coordinate (from `proceduralCoord`; the texture's
 * `scale` and `params.offset_*` are applied here) and returns linear RGBA after the colour ramp.
 * Deterministic, pure and identical on every platform; the viewport GLSL implementation matches it.
 * Invalid data never throws (unknown types evaluate to color_a, bad numbers fall back to defaults).
 */
export function sampleProcedural(tex: ProceduralTexture, coord: Readonly<Vec3>): Vec4 {
  const out: Vec4 = [0, 0, 0, 0];
  sampleCompiled(compileProceduralCached(tex), coord[0], coord[1], coord[2], out);
  return out;
}

/** Scalar value of a texture for scalar channels (roughness, metallic, alpha, bump height): red. */
export function sampleProceduralScalar(tex: ProceduralTexture, coord: Readonly<Vec3>): number {
  return sampleProcedural(tex, coord)[0];
}
