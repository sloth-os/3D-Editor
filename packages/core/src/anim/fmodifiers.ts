import { z } from 'zod';
import type { FModifierData, FModifierType } from '../doc/types';
import { gradientNoise3 } from './expression';

/*
 * F-curve modifiers (Blender FModifier): procedural changes of an animation curve, evaluated after
 * its keyframes with Blender's stack semantics:
 *
 * - Time modifiers (STEPPED, and LIMITS with use_min_x / use_max_x) change the time at which the
 *   keyframes are sampled. They are applied from the last modifier to the first (Blender's
 *   "macro to micro" order), and every value modifier is evaluated at the resulting time, wherever
 *   it is in the stack — a NOISE listed above a STEPPED modifier is stepped too.
 * - Value modifiers (NOISE, GENERATOR, ENVELOPE, LIMITS with use_min_y / use_max_y) then change the
 *   sampled value from the first modifier to the last.
 * - Every modifier can be muted (`mute`), blended with the unmodified result by `influence` (when
 *   `use_influence`), and — except STEPPED, whose `frame_start` / `frame_end` configure the stepping
 *   like in Blender's Python API — restricted to a frame range with linear fade ramps
 *   (`use_restricted_range`, `frame_start`, `frame_end`, `blend_in`, `blend_out`; inclusive).
 * - A curve's CYCLIC extrapolation acts like Blender's Cycles modifier at the top of the stack: it
 *   wraps the time last (after the other time modifiers), and the value modifiers see the wrapped
 *   time, so they repeat with every cycle (e.g. NOISE gives the same values in each cycle).
 *
 * Parameters use Blender's Python names and defaults and are validated by the exported schemas.
 * List-valued parameters are stored as JSON arrays: GENERATOR `coefficients` (numbers) and
 * ENVELOPE `control_points` ({frame, min, max} objects), mirroring `FModifierGenerator.coefficients`
 * and `FModifierEnvelope.control_points`. Evaluation never throws: invalid stored parameters fall
 * back to their defaults, and a modifier producing a non-finite value or time is skipped.
 */

/** F-curve modifier types, in the order they are listed to users. */
export const FMODIFIER_TYPES: readonly FModifierType[] = [
  'NOISE',
  'STEPPED',
  'GENERATOR',
  'LIMITS',
  'ENVELOPE',
];

/** Thrown by {@link normalizeFModifierParams} / {@link createFModifier} for invalid input. */
export class FModifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FModifierError';
  }
}

// ---------------------------------------------------------------- parameter schemas

const influenceShape = {
  use_influence: z
    .boolean()
    .default(false)
    .describe('Blend the effect by `influence` (false: the modifier applies fully)'),
  influence: z
    .number()
    .min(0)
    .max(1)
    .default(1)
    .describe(
      'Amount of the effect 0..1 when use_influence is true: result = lerp(unmodified, modified, influence)',
    ),
};

const rangeShape = {
  use_restricted_range: z
    .boolean()
    .default(false)
    .describe(
      'Only apply the modifier from frame_start to frame_end inclusive (no effect outside that range)',
    ),
  frame_start: z
    .number()
    .default(1)
    .describe('Start of the restricted range (frame, with use_restricted_range)'),
  frame_end: z
    .number()
    .default(250)
    .describe('End of the restricted range (frame, with use_restricted_range)'),
  blend_in: z
    .number()
    .min(0)
    .default(0)
    .describe('Frames after frame_start over which the effect fades in linearly (with use_restricted_range)'),
  blend_out: z
    .number()
    .min(0)
    .default(0)
    .describe('Frames before frame_end over which the effect fades out linearly (with use_restricted_range)'),
};

/** NOISE: adds smooth deterministic noise (camera shake, flicker, idle motion). */
export const noiseFModifierSchema = z.strictObject({
  blend_type: z
    .enum(['REPLACE', 'ADD', 'SUBTRACT', 'MULTIPLY'])
    .default('REPLACE')
    .describe(
      'How the noise n (0..1) combines with the curve value v: REPLACE = v + (n - 0.5) * strength (noise ' +
        'centred on the curve), ADD = v + n * strength, SUBTRACT = v - n * strength, MULTIPLY = v * n * strength',
    ),
  scale: z
    .number()
    .positive()
    .default(1)
    .describe(
      'Time scale in frames: about one random change per `scale` frames (larger = slower, smoother motion)',
    ),
  strength: z
    .number()
    .default(1)
    .describe(
      'Amplitude in the units of the property (metres, radians, …): REPLACE moves the curve by at most ' +
        '±strength/2 (typically about ±strength/7); ADD / SUBTRACT shift it by 0..strength',
    ),
  phase: z
    .number()
    .default(1)
    .describe('Phase, acts like a seed: different values give unrelated noise with otherwise equal settings'),
  offset: z.number().default(0).describe('Time offset in frames (shifts the noise pattern in time)'),
  depth: z
    .number()
    .int()
    .min(0)
    .max(32)
    .default(0)
    .describe('Extra octaves of finer detail (0 = a single smooth layer)'),
  lacunarity: z
    .number()
    .min(1)
    .max(16)
    .default(2)
    .describe('Frequency multiplier from one octave to the next (only with depth > 0)'),
  roughness: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe(
      'Amplitude multiplier from one octave to the next: higher = more fine detail (only with depth > 0)',
    ),
  ...influenceShape,
  ...rangeShape,
});

/** STEPPED: holds the curve value for `frame_step` frames ("animating on twos", stop motion). */
export const steppedFModifierSchema = z.strictObject({
  frame_step: z
    .number()
    .positive()
    .default(2)
    .describe(
      'Frames each value is held: the curve is sampled at frame_offset + k * frame_step (k rounds toward zero)',
    ),
  frame_offset: z.number().default(0).describe('Frame the steps are aligned to'),
  use_frame_start: z.boolean().default(false).describe('Leave the curve unchanged before frame_start'),
  frame_start: z
    .number()
    .default(0)
    .describe('Frame before which no stepping happens (with use_frame_start)'),
  use_frame_end: z.boolean().default(false).describe('Leave the curve unchanged after frame_end'),
  frame_end: z.number().default(0).describe('Frame after which no stepping happens (with use_frame_end)'),
  ...influenceShape,
});

/** GENERATOR: a polynomial of the frame number that replaces (or is added to) the curve. */
export const generatorFModifierSchema = z.strictObject({
  mode: z
    .enum(['POLYNOMIAL', 'POLYNOMIAL_FACTORISED'])
    .default('POLYNOMIAL')
    .describe(
      'POLYNOMIAL: c0 + c1*t + c2*t^2 + … ; POLYNOMIAL_FACTORISED: (c0*t + c1) * (c2*t + c3) * … (t = frame)',
    ),
  poly_order: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Order of the polynomial. Default: derived from the number of coefficients. When given, coefficients are ' +
        'padded with zeros or truncated to poly_order + 1 entries (factorised: 2 * poly_order)',
    ),
  coefficients: z
    .array(z.number())
    .max(201)
    .default([0, 1])
    .describe('Coefficients, lowest power first; the default [0, 1] gives the frame number itself'),
  use_additive: z
    .boolean()
    .default(false)
    .describe('Add the polynomial to the curve value instead of replacing the value'),
  ...influenceShape,
  ...rangeShape,
});

/** LIMITS: clamps the curve's value (y) and/or the frames it is sampled at (x). */
export const limitsFModifierSchema = z.strictObject({
  use_min_x: z.boolean().default(false).describe('Before min_x, hold the value the curve has at min_x'),
  min_x: z.number().default(0).describe('Earliest frame the curve is sampled at (with use_min_x)'),
  use_max_x: z.boolean().default(false).describe('After max_x, hold the value the curve has at max_x'),
  max_x: z.number().default(0).describe('Latest frame the curve is sampled at (with use_max_x)'),
  use_min_y: z.boolean().default(false).describe('Clamp values below min_y'),
  min_y: z.number().default(0).describe('Lowest value (with use_min_y)'),
  use_max_y: z.boolean().default(false).describe('Clamp values above max_y'),
  max_y: z.number().default(0).describe('Highest value (with use_max_y)'),
  ...influenceShape,
  ...rangeShape,
});

/** One ENVELOPE control point. */
export const envelopeControlPointSchema = z.strictObject({
  frame: z.number().describe('Frame of the control point'),
  min: z
    .number()
    .default(-1)
    .describe('Output value that reference_value + default_min is mapped to at this frame (default -1)'),
  max: z
    .number()
    .default(1)
    .describe('Output value that reference_value + default_max is mapped to at this frame (default 1)'),
});

/** ENVELOPE: rescales the curve between per-frame min/max bounds (fade an oscillation in or out). */
export const envelopeFModifierSchema = z.strictObject({
  reference_value: z.number().default(0).describe('Centre value of the reference band'),
  default_min: z
    .number()
    .default(-1)
    .describe('Lower edge of the reference band, relative to reference_value'),
  default_max: z
    .number()
    .default(1)
    .describe('Upper edge of the reference band, relative to reference_value'),
  control_points: z
    .array(envelopeControlPointSchema)
    .max(1000)
    .default([])
    .describe(
      'Values in [reference_value + default_min, reference_value + default_max] are mapped linearly onto ' +
        '[min, max] of the control points (absolute values, interpolated linearly between points and held ' +
        'before the first / after the last). Sorted by frame when stored. No points = no effect',
    ),
  ...influenceShape,
  ...rangeShape,
});

/** Parameter schema of every F-curve modifier type (`schema.parse({})` gives the defaults). */
export const FMODIFIER_PARAM_SCHEMAS = {
  NOISE: noiseFModifierSchema,
  STEPPED: steppedFModifierSchema,
  GENERATOR: generatorFModifierSchema,
  LIMITS: limitsFModifierSchema,
  ENVELOPE: envelopeFModifierSchema,
} as const satisfies Record<FModifierType, z.ZodObject>;

export type NoiseFModifierParams = z.infer<typeof noiseFModifierSchema>;
export type SteppedFModifierParams = z.infer<typeof steppedFModifierSchema>;
export type GeneratorFModifierParams = z.infer<typeof generatorFModifierSchema>;
export type LimitsFModifierParams = z.infer<typeof limitsFModifierSchema>;
export type EnvelopeFModifierParams = z.infer<typeof envelopeFModifierSchema>;
export type EnvelopeControlPoint = z.infer<typeof envelopeControlPointSchema>;

/** Validated parameters of any modifier type (as stored in `FModifierData.params`). */
export type FModifierParams =
  | NoiseFModifierParams
  | SteppedFModifierParams
  | GeneratorFModifierParams
  | LimitsFModifierParams
  | EnvelopeFModifierParams;

/** Short description of a modifier type (for menus, docs and agents). */
export interface FModifierTypeInfo {
  type: FModifierType;
  label: string;
  description: string;
  /** Whether the modifier changes the sampling time, the value, or both. */
  affects: 'TIME' | 'VALUE' | 'TIME_AND_VALUE';
}

/** What each modifier type does, for menus, documentation and AI agents. */
export const FMODIFIER_TYPE_INFO: readonly FModifierTypeInfo[] = [
  {
    type: 'NOISE',
    label: 'Noise',
    description:
      'Adds smooth deterministic noise to the curve (camera shake, flicker, idle motion): scale = frames per ' +
      'random change, strength = amplitude, phase = seed, depth = octaves of detail.',
    affects: 'VALUE',
  },
  {
    type: 'STEPPED',
    label: 'Stepped Interpolation',
    description:
      'Holds the curve value for frame_step frames (sampling it at frame_offset + k * frame_step), for a ' +
      'stop-motion / "on twos" look. Every value modifier of the curve (NOISE, GENERATOR, ENVELOPE, LIMITS y) ' +
      'is evaluated at the stepped time too, wherever it is in the stack, so it is stepped as well.',
    affects: 'TIME',
  },
  {
    type: 'GENERATOR',
    label: 'Generator',
    description:
      'Replaces the curve by (or with use_additive adds) a polynomial of the frame number: coefficients ' +
      '[c0, c1, c2…] give c0 + c1*frame + c2*frame^2 …, e.g. [0, 0.1] = 0.1 per frame.',
    affects: 'VALUE',
  },
  {
    type: 'LIMITS',
    label: 'Limits',
    description:
      'Clamps the value to [min_y, max_y] (use_min_y / use_max_y) and/or holds the curve outside the frames ' +
      '[min_x, max_x] (use_min_x / use_max_x; like STEPPED, this clamped time is what every value modifier ' +
      'of the curve sees).',
    affects: 'TIME_AND_VALUE',
  },
  {
    type: 'ENVELOPE',
    label: 'Envelope',
    description:
      'Rescales the curve over time: the band reference_value + [default_min, default_max] is mapped onto ' +
      'the [min, max] of control points interpolated over frames (e.g. fade an oscillation in or out).',
    affects: 'VALUE',
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** True for the identifiers of the supported modifier types (exact, upper case). */
export function isFModifierType(type: unknown): type is FModifierType {
  return typeof type === 'string' && (FMODIFIER_TYPES as readonly string[]).includes(type);
}

/** Resolves a type name case-insensitively ('noise' → 'NOISE'); null when unknown. */
export function resolveFModifierType(name: string): FModifierType | null {
  const up = typeof name === 'string' ? name.trim().toUpperCase() : '';
  return isFModifierType(up) ? up : null;
}

/** Default parameters of a modifier type. */
export function defaultFModifierParams(type: FModifierType): FModifierParams {
  return finishParams(type, FMODIFIER_PARAM_SCHEMAS[type].parse({}) as FModifierParams, {});
}

/** Fixes list lengths and order after validation (generator order, sorted envelope points). */
function finishParams(
  type: FModifierType,
  params: FModifierParams,
  given: Record<string, unknown>,
): FModifierParams {
  if (type === 'GENERATOR') {
    const p = { ...(params as GeneratorFModifierParams) };
    const factorised = p.mode === 'POLYNOMIAL_FACTORISED';
    const c = [...p.coefficients];
    let order = p.poly_order;
    if (order === undefined || ('coefficients' in given && !('poly_order' in given)))
      order = Math.max(1, Math.min(100, factorised ? Math.ceil(c.length / 2) : c.length - 1));
    const len = factorised ? order * 2 : order + 1;
    while (c.length < len) c.push(0);
    c.length = len;
    p.poly_order = order;
    p.coefficients = c;
    return p;
  }
  if (type === 'ENVELOPE') {
    const p = { ...(params as EnvelopeFModifierParams) };
    // sort by frame (stable); a later point on the same frame replaces an earlier one
    const byFrame = new Map<number, EnvelopeControlPoint>();
    for (const pt of p.control_points) byFrame.set(pt.frame, { frame: pt.frame, min: pt.min, max: pt.max });
    p.control_points = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
    return p;
  }
  return params;
}

/**
 * Validates the parameters of a modifier type and fills in defaults. `base` (the currently stored
 * parameters, when updating) is merged under `params`. GENERATOR coefficients are resized to the
 * polynomial order (derived from the coefficients when only those are given), ENVELOPE control
 * points are sorted by frame. Throws FModifierError listing every problem and the valid names.
 */
export function normalizeFModifierParams(
  type: FModifierType,
  params: Record<string, unknown> = {},
  base: Record<string, unknown> = {},
): FModifierParams {
  if (!isFModifierType(type))
    throw new FModifierError(
      `Unknown F-curve modifier type '${String(type)}'. Valid types: ${FMODIFIER_TYPES.join(', ')}`,
    );
  const schema = FMODIFIER_PARAM_SCHEMAS[type];
  if (!isRecord(params)) throw new FModifierError('F-curve modifier params must be an object');
  const merged: Record<string, unknown> = { ...(isRecord(base) ? base : {}), ...params };
  // new coefficients without an order: derive the order from them (not from the old order)
  if (type === 'GENERATOR' && 'coefficients' in params && !('poly_order' in params)) delete merged.poly_order;
  const res = schema.safeParse(merged);
  if (!res.success) {
    const issues = res.error.issues
      .map((i) => {
        const where = i.path.join('.') || '(params)';
        if (i.code === 'unrecognized_keys')
          return `unknown parameter(s) ${i.keys.map((k) => `'${k}'`).join(', ')}`;
        return `${where}: ${i.message}`;
      })
      .join('; ');
    throw new FModifierError(
      `Invalid ${type} modifier parameters: ${issues}. Valid parameters: ${Object.keys(schema.shape).join(', ')}`,
    );
  }
  return finishParams(type, res.data as FModifierParams, params);
}

/** Creates a modifier with validated parameters (throws FModifierError for invalid input). */
export function createFModifier(
  type: FModifierType,
  params: Record<string, unknown> = {},
  mute = false,
): FModifierData {
  return { type, mute, params: normalizeFModifierParams(type, params) as unknown as FModifierData['params'] };
}

// ---------------------------------------------------------------- evaluation

interface Range {
  start: number;
  end: number;
  blendIn: number;
  blendOut: number;
}

/** A modifier prepared for evaluation. */
interface Prepared {
  /** Maps an evaluation time to the time the keyframes are sampled at (time modifiers). */
  time: ((t: number) => number) | null;
  /** Changes the value at (modified) time t (value modifiers). */
  value: ((v: number, t: number) => number) | null;
  influence: number;
  range: Range | null;
}

/**
 * Parses stored parameters without throwing: valid fields are kept, invalid or missing ones get
 * their defaults (unknown fields are ignored).
 */
function tolerantParams(type: FModifierType, raw: Record<string, unknown>): FModifierParams {
  const schema = FMODIFIER_PARAM_SCHEMAS[type];
  const full = schema.safeParse(raw);
  if (full.success) return finishParams(type, full.data as FModifierParams, {});
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
    const r = field.safeParse(raw[key]);
    out[key] = r.success ? r.data : field.safeParse(undefined).data;
  }
  if (type === 'ENVELOPE') {
    // keep the valid control points (with their defaults filled in) of a list with a few bad ones
    const list: unknown[] = Array.isArray(raw.control_points) ? raw.control_points : [];
    out.control_points = list.flatMap((p) => {
      const r = envelopeControlPointSchema.safeParse(p);
      return r.success ? [r.data] : [];
    });
  }
  return finishParams(type, out as unknown as FModifierParams, {});
}

function prepare(type: FModifierType, p: FModifierParams): Prepared {
  const common = p as { use_influence: boolean; influence: number };
  const influence = common.use_influence ? common.influence : 1;
  let range: Range | null = null;
  if (type !== 'STEPPED') {
    const r = p as { use_restricted_range: boolean; frame_start: number; frame_end: number } & {
      blend_in: number;
      blend_out: number;
    };
    if (r.use_restricted_range)
      range = { start: r.frame_start, end: r.frame_end, blendIn: r.blend_in, blendOut: r.blend_out };
  }
  const out: Prepared = { time: null, value: null, influence, range };
  switch (type) {
    case 'NOISE': {
      const n = p as NoiseFModifierParams;
      const strength = n.strength;
      out.value = (v, t) => {
        const noise = noiseTurbulence(n, t);
        switch (n.blend_type) {
          case 'ADD':
            return v + noise * strength;
          case 'SUBTRACT':
            return v - noise * strength;
          case 'MULTIPLY':
            return v * noise * strength;
          default:
            return v + (noise - 0.5) * strength;
        }
      };
      break;
    }
    case 'STEPPED': {
      const s = p as SteppedFModifierParams;
      out.time = (t) => {
        if (s.use_frame_start && t < s.frame_start) return t;
        if (s.use_frame_end && t > s.frame_end) return t;
        const q = (t - s.frame_offset) / s.frame_step;
        // Blender truncates toward zero; the epsilon keeps exact multiples (0.3 / 0.1) on their step
        const block = Math.trunc(q + Math.sign(q) * 1e-9 * Math.max(1, Math.abs(q)));
        return block * s.frame_step + s.frame_offset;
      };
      break;
    }
    case 'GENERATOR': {
      const g = p as GeneratorFModifierParams;
      const c = g.coefficients;
      const order = g.poly_order ?? 1;
      const factorised = g.mode === 'POLYNOMIAL_FACTORISED';
      out.value = (v, t) => {
        let poly: number;
        if (factorised) {
          poly = 1;
          for (let i = 0; i < order; i++) poly *= c[2 * i] * t + c[2 * i + 1];
        } else {
          poly = 0;
          for (let i = c.length - 1; i >= 0; i--) poly = poly * t + c[i]; // Horner
        }
        return g.use_additive ? v + poly : poly;
      };
      break;
    }
    case 'LIMITS': {
      const l = p as LimitsFModifierParams;
      if (l.use_min_x || l.use_max_x)
        out.time = (t) => (l.use_min_x && t < l.min_x ? l.min_x : l.use_max_x && t > l.max_x ? l.max_x : t);
      if (l.use_min_y || l.use_max_y)
        out.value = (v) => {
          if (l.use_min_y && v < l.min_y) v = l.min_y;
          if (l.use_max_y && v > l.max_y) v = l.max_y;
          return v;
        };
      break;
    }
    case 'ENVELOPE': {
      const e = p as EnvelopeFModifierParams;
      const pts = e.control_points;
      const lowRef = e.reference_value + e.default_min;
      const span = e.default_max - e.default_min;
      if (pts.length && span !== 0)
        out.value = (v, t) => {
          let lo: number;
          let hi: number;
          const last = pts[pts.length - 1];
          if (t <= pts[0].frame) {
            lo = pts[0].min;
            hi = pts[0].max;
          } else if (t >= last.frame) {
            lo = last.min;
            hi = last.max;
          } else {
            let a = 0;
            let b = pts.length - 1;
            while (b - a > 1) {
              const mid = (a + b) >> 1;
              if (pts[mid].frame <= t) a = mid;
              else b = mid;
            }
            const pa = pts[a];
            const pb = pts[b];
            const f = (t - pa.frame) / (pb.frame - pa.frame);
            lo = pa.min + (pb.min - pa.min) * f;
            hi = pa.max + (pb.max - pa.max) * f;
          }
          const fac = (v - lowRef) / span;
          return lo + fac * (hi - lo);
        };
      break;
    }
  }
  return out;
}

/*
 * Gradient noise vanishes on its integer lattice, which integer frames and phases would hit exactly
 * (at scale 1 the noise would almost disappear on whole frames), so samples are shifted off it.
 */
const NOISE_SHIFT_X = 0.3183098861837907;
const NOISE_SHIFT_Y = 0.5772156649015329;
const NOISE_SHIFT_Z = 0.7236067977499789;

/** One layer of noise in [0, 1] at time x for a phase y. */
function noiseLayer(size: number, x: number, y: number): number {
  return (
    0.5 +
    0.5 *
      gradientNoise3(
        (1 + x) / size + NOISE_SHIFT_X,
        (1 + y) / size + NOISE_SHIFT_Y,
        1.1 / size + NOISE_SHIFT_Z,
      )
  );
}

/**
 * Fractal noise of the NOISE modifier at time t, in [0, 1]: octave k has size scale / lacunarity^k
 * and weight roughness^k, normalised by the sum of the weights.
 */
function noiseTurbulence(n: NoiseFModifierParams, t: number): number {
  const x = t - n.offset;
  let sum = noiseLayer(n.scale, x, n.phase);
  let weight = 1;
  let total = 1;
  let size = n.scale;
  for (let k = 0; k < n.depth; k++) {
    weight *= n.roughness;
    size /= n.lacunarity;
    if (weight === 0) break;
    sum += weight * noiseLayer(size, x, n.phase);
    total += weight;
  }
  return sum / total;
}

/**
 * Influence of a prepared modifier at time t: 0 outside its restricted range [start, end]
 * (inclusive, like Blender), linear ramps over the blend-in / blend-out frames inside it.
 */
function influenceAt(m: Prepared, t: number): number {
  const r = m.range;
  if (!r) return m.influence;
  if (!(t >= r.start && t <= r.end)) return 0;
  if (r.blendIn > 0 && t <= r.start + r.blendIn) return (m.influence * (t - r.start)) / r.blendIn;
  if (r.blendOut > 0 && t >= r.end - r.blendOut) return (m.influence * (r.end - t)) / r.blendOut;
  return m.influence;
}

const preparedCache = new Map<string, Prepared>();
const PREPARED_CACHE_LIMIT = 2000;

/** The prepared form of a stored modifier (cached by content), or null when muted or unknown. */
function prepared(m: FModifierData): Prepared | null {
  if (!isRecord(m) || m.mute === true) return null;
  const type = m.type;
  if (!isFModifierType(type)) return null;
  const raw = isRecord(m.params) ? (m.params as Record<string, unknown>) : {};
  let key: string | null;
  try {
    key = `${type}:${JSON.stringify(raw)}`;
  } catch {
    key = null; // not JSON data (never stored by the document): evaluate uncached
  }
  let p = key === null ? undefined : preparedCache.get(key);
  if (!p) {
    p = prepare(type, tolerantParams(type, raw));
    if (key !== null) {
      if (preparedCache.size >= PREPARED_CACHE_LIMIT) preparedCache.clear();
      preparedCache.set(key, p);
    }
  }
  return p;
}

/**
 * Applies an F-curve's modifier stack. `value` is the curve evaluated at `frame`; `sample`, when
 * given, evaluates the unmodified curve (keyframes and extrapolation) at another time, which the
 * time modifiers (STEPPED, LIMITS x) need — without it they are ignored. `cycle`, for a curve with
 * CYCLIC extrapolation, maps a time into the repeated keyframe range: the value modifiers are
 * evaluated (and their restricted ranges tested) at the time the time modifiers produced, wrapped
 * by `cycle`, so they repeat with every cycle like below Blender's Cycles modifier. Muted, unknown
 * and invalid modifiers are skipped; the result is always finite when `value` is.
 */
export function applyFModifiers(
  mods: FModifierData[],
  frame: number,
  value: number,
  sample?: (frame: number) => number,
  cycle?: (frame: number) => number,
): number {
  if (!Array.isArray(mods) || mods.length === 0) return value;
  const list = mods.map(prepared);
  // time modifiers, last to first
  let t = frame;
  if (sample)
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (!m?.time) continue;
      const w = influenceAt(m, t);
      if (!(w > 0)) continue;
      const nt = m.time(t);
      const r = w >= 1 ? nt : t + (nt - t) * w;
      if (Number.isFinite(r)) t = r;
    }
  let v = value;
  if (t !== frame && sample) {
    const s = sample(t);
    if (Number.isFinite(s)) v = s;
  }
  // value modifiers, first to last (wherever the time modifiers are), at the modified time —
  // wrapped into the keyed range of a cyclic curve, where the Cycles modifier would put it
  if (cycle) {
    const c = cycle(t);
    if (Number.isFinite(c)) t = c;
  }
  for (const m of list) {
    if (!m?.value) continue;
    const w = influenceAt(m, t);
    if (!(w > 0)) continue;
    const nv = m.value(v, t);
    const r = w >= 1 ? nv : v + (nv - v) * w;
    if (Number.isFinite(r)) v = r;
  }
  return v;
}
