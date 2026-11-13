import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { applyViewTransform, viewTransformOf, type ViewTransform } from '@3d-editor/core';

/*
 * Blender's colour management for the WebGL renders: scene-linear HDR colour → exposure → view
 * transform → sRGB display values, with the curves of the core renderers (the path tracer's
 * `filmToRGBA8` and the CPU rasterizer), so a scene has the same brightness and look in the
 * Rendered viewport, in F12 / Render Animation / MCP renders made by a browser and in path-traced
 * or server renders. It replaces three.js's OutputPass, whose AgX, ACES and Neutral operators are
 * other curves (an AgX render came out about 20 % brighter than the path tracer's).
 *
 * AGX, FILMIC and ACES (core render/pathtrace/display.ts) mix each channel towards the luminance
 * ("inset"), encode it logarithmically from 10 stops below to 6.5 stops above middle grey and
 * shape it with a sigmoid; AgX then re-saturates in linear ("outset"). The sigmoid comes from the
 * core itself as a lookup table (`applyViewTransform` of greys, for which inset and outset do
 * nothing); the inset and outset amounts and the log range mirror display.ts (a unit test checks
 * colours against `applyViewTransform`). NEUTRAL (Khronos PBR Neutral) and STANDARD (plain sRGB,
 * clipping above 1) are computed directly.
 */

/** Middle grey and the stops below / above it that the log encoding spans (display.ts). */
const MIDDLE_GREY = 0.18;
export const LOG_MIN = Math.log2(MIDDLE_GREY) - 10;
export const LOG_RANGE = 10 + 6.5;
/** Samples of a curve table over the log range (a 2048 × 1 texture: the WebGL 2 minimum size). */
export const CURVE_SAMPLES = 2048;

/** How a view transform is computed: 0 STANDARD, 1 log sigmoid (curve table), 2 NEUTRAL. */
export interface ViewTransformParams {
  mode: 0 | 1 | 2;
  /** Mix of every channel towards the luminance before the curve. */
  inset: number;
  /** Inverse mix after the curve, in linear (re-saturation). */
  outset: number;
}

/** The inset / outset of the log-sigmoid transforms (core render/pathtrace/display.ts). */
const PARAMS: Record<ViewTransform, ViewTransformParams> = {
  STANDARD: { mode: 0, inset: 0, outset: 0 },
  AGX: { mode: 1, inset: 0.2, outset: 0.15 },
  FILMIC: { mode: 1, inset: 0.1, outset: 0 },
  ACES: { mode: 1, inset: 0, outset: 0 },
  NEUTRAL: { mode: 2, inset: 0, outset: 0 },
};

export function viewTransformParams(view: ViewTransform): ViewTransformParams {
  return PARAMS[viewTransformOf(view)];
}

/** Linear value of the log encoding position x ∈ [0, 1]. */
export const curveInput = (x: number) => Math.pow(2, LOG_MIN + x * LOG_RANGE);

const tables = new Map<ViewTransform, Float32Array>();

/**
 * The display-encoded sigmoid of a log-sigmoid transform at `CURVE_SAMPLES` evenly spaced positions
 * of the log range (first: 10 stops below middle grey, last: 6.5 stops above), from the core.
 */
export function curveTable(view: ViewTransform): Float32Array {
  const vt = viewTransformOf(view);
  let t = tables.get(vt);
  if (!t) {
    t = new Float32Array(CURVE_SAMPLES);
    const out = [0, 0, 0];
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      const c = curveInput(i / (CURVE_SAMPLES - 1));
      applyViewTransform(vt, c, c, c, out);
      t[i] = out[0];
    }
    tables.set(vt, t);
  }
  return t;
}

const srgbEncode = (c: number) =>
  !(c > 0) ? 0 : c >= 1 ? 1 : c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const srgbDecode = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LUM = [0.2126, 0.7152, 0.0722] as const;

/** The curve table at linear channel value c (non-negative), interpolated like the shader. */
function curveAt(table: Float32Array, c: number): number {
  if (!(c > 0)) return 0;
  const x = (Math.log2(c) - LOG_MIN) / LOG_RANGE;
  if (!(x > 0)) return table[0];
  if (x >= 1) return table[CURVE_SAMPLES - 1];
  const f = x * (CURVE_SAMPLES - 1);
  const i = Math.floor(f);
  return table[i] + (table[i + 1] - table[i]) * (f - i);
}

/**
 * What the shader computes for one scene-linear colour (exposure applied): display-encoded sRGB
 * in [0, 1]. The JavaScript twin of {@link VIEW_TRANSFORM_SHADER}, for tests.
 */
export function viewTransformPixel(view: ViewTransform, r: number, g: number, b: number): number[] {
  const p = viewTransformParams(view);
  let c = [r, g, b].map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  if (p.mode === 0) return c.map(srgbEncode);
  if (p.mode === 2) {
    const x = Math.min(c[0], c[1], c[2]);
    const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    c = c.map((v) => v - offset);
    const peak = Math.max(c[0], c[1], c[2]);
    const START = 0.8 - 0.04;
    if (peak >= START) {
      const d = 1 - START;
      const newPeak = 1 - (d * d) / (peak + d - START);
      c = c.map((v) => (v * newPeak) / peak);
      const w = 1 - 1 / (0.15 * (peak - newPeak) + 1);
      c = c.map((v) => v + (newPeak - v) * w);
    }
    return c.map(srgbEncode);
  }
  if (p.inset > 0) {
    const l = (LUM[0] * c[0] + LUM[1] * c[1] + LUM[2] * c[2]) * p.inset;
    c = c.map((v) => v * (1 - p.inset) + l);
  }
  const table = curveTable(view);
  const e = c.map((v) => curveAt(table, v));
  if (!(p.outset > 0)) return e;
  const lin = e.map(srgbDecode);
  const l = (LUM[0] * lin[0] + LUM[1] * lin[1] + LUM[2] * lin[2]) * p.outset;
  return lin.map((v) => srgbEncode((v - l) / (1 - p.outset)));
}

/** Fullscreen shader of {@link ViewTransformPass} (see the file comment). */
export const VIEW_TRANSFORM_SHADER = {
  name: 'ViewTransformShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    curve: { value: null as THREE.Texture | null },
    exposure: { value: 1 },
    mode: { value: 0 },
    inset: { value: 0 },
    outset: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D curve;
    uniform float exposure;
    uniform int mode;
    uniform float inset;
    uniform float outset;
    varying vec2 vUv;

    const float LOG_MIN = ${LOG_MIN.toFixed(9)};
    const float LOG_RANGE = ${LOG_RANGE.toFixed(9)};
    const int SAMPLES = ${CURVE_SAMPLES};
    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

    float srgbEncode(float c) {
      if (!(c > 0.0)) return 0.0;
      if (c >= 1.0) return 1.0;
      return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
    }
    vec3 srgbEncode3(vec3 c) { return vec3(srgbEncode(c.r), srgbEncode(c.g), srgbEncode(c.b)); }
    float srgbDecode(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }

    float curveAt(float c) {
      if (!(c > 0.0)) return 0.0;
      float x = (log2(c) - LOG_MIN) / LOG_RANGE;
      if (!(x > 0.0)) return texelFetch(curve, ivec2(0, 0), 0).r;
      if (x >= 1.0) return texelFetch(curve, ivec2(SAMPLES - 1, 0), 0).r;
      float f = x * float(SAMPLES - 1);
      int i = int(floor(f));
      float a = texelFetch(curve, ivec2(i, 0), 0).r;
      float b = texelFetch(curve, ivec2(min(i + 1, SAMPLES - 1), 0), 0).r;
      return mix(a, b, f - float(i));
    }

    vec3 logSigmoid(vec3 c) {
      if (inset > 0.0) c = c * (1.0 - inset) + dot(c, LUM) * inset;
      vec3 e = vec3(curveAt(c.r), curveAt(c.g), curveAt(c.b));
      if (!(outset > 0.0)) return e;
      vec3 lin = vec3(srgbDecode(e.r), srgbDecode(e.g), srgbDecode(e.b));
      return srgbEncode3((lin - dot(lin, LUM) * outset) / (1.0 - outset));
    }

    vec3 neutral(vec3 c) {
      const float START = 0.8 - 0.04;
      const float DESATURATION = 0.15;
      float x = min(c.r, min(c.g, c.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      c -= offset;
      float peak = max(c.r, max(c.g, c.b));
      if (peak >= START) {
        float d = 1.0 - START;
        float newPeak = 1.0 - d * d / (peak + d - START);
        c *= newPeak / peak;
        float w = 1.0 - 1.0 / (DESATURATION * (peak - newPeak) + 1.0);
        c = mix(c, vec3(newPeak), w);
      }
      return srgbEncode3(c);
    }

    void main() {
      vec4 t = texture2D(tDiffuse, vUv);
      vec3 c = t.rgb * exposure;
      // non-finite and negative values count as 0, like the core renderers
      c = vec3(
        isnan(c.r) || isinf(c.r) ? 0.0 : max(c.r, 0.0),
        isnan(c.g) || isinf(c.g) ? 0.0 : max(c.g, 0.0),
        isnan(c.b) || isinf(c.b) ? 0.0 : max(c.b, 0.0)
      );
      vec3 o = mode == 1 ? logSigmoid(c) : mode == 2 ? neutral(c) : srgbEncode3(c);
      gl_FragColor = vec4(o, t.a);
    }`,
};

const curveTextures = new Map<ViewTransform, THREE.DataTexture>();

/** The curve table of a log-sigmoid transform as a float texture (shared, never disposed). */
function curveTexture(view: ViewTransform): THREE.DataTexture {
  let t = curveTextures.get(view);
  if (!t) {
    t = new THREE.DataTexture(curveTable(view), CURVE_SAMPLES, 1, THREE.RedFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    curveTextures.set(view, t);
  }
  return t;
}

/**
 * The output pass of the viewport and of rasterized final renders (instead of three.js's
 * OutputPass): exposure, Blender view transform and sRGB encoding (see the file comment).
 */
export class ViewTransformPass extends ShaderPass {
  view: ViewTransform = 'STANDARD';

  constructor() {
    super(VIEW_TRANSFORM_SHADER);
  }

  /** Sets the view transform (unknown values: STANDARD) and the exposure in stops. */
  setTransform(view: ViewTransform | string | undefined, exposureStops = 0): void {
    const vt = viewTransformOf(view);
    const p = PARAMS[vt];
    this.view = vt;
    const u = this.uniforms as typeof VIEW_TRANSFORM_SHADER.uniforms;
    u.mode.value = p.mode;
    u.inset.value = p.inset;
    u.outset.value = p.outset;
    u.exposure.value = Math.pow(2, Number.isFinite(exposureStops) ? exposureStops : 0);
    u.curve.value = p.mode === 1 ? curveTexture(vt) : null;
  }
}
