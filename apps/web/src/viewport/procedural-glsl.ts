import {
  PFX_FMIX_M1,
  PFX_FMIX_M2,
  PFX_GRADIENTS,
  PFX_STREAM,
  PFX_STREAM_CELL,
  PFX_STREAM_CELL_B,
  PFX_STREAM_CELL_G,
  PFX_STREAM_CELL_R,
  PFX_STREAM_JITTER_Y,
  PFX_STREAM_JITTER_Z,
  PFX_STREAM_WARP,
  PFX_COORD_LIMIT,
  type CompiledProcedural,
  type MaterialTextureChannel,
} from '@3d-editor/core';

/*
 * GLSL ES 3.0 port of the procedural textures of `@3d-editor/core` (material/noise.ts and
 * material/procedural.ts). The hash constants, gradient table and stream ids are generated from
 * the core constants; the integer hash uses `uint` arithmetic and is bit-identical to the CPU, the
 * float code is the same formula line by line (results agree to float32 precision). Any change to
 * the TypeScript evaluation must be mirrored here.
 *
 * A texture is passed as a `PfxTex` uniform struct whose members are exactly the fields of
 * `CompiledProcedural` (see `proceduralUniformValue`).
 */

const u = (v: number) => `${v >>> 0}u`;
const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

const gradients = Array.from({ length: 16 }, (_, i) => {
  const g = PFX_GRADIENTS.slice(i * 3, i * 3 + 3).map(f);
  return `vec3(${g.join(', ')})`;
}).join(', ');

/** Function library: hashing, gradient/fractal/Voronoi noise and `pfxSample`. */
export const PROCEDURAL_GLSL_LIB = /* glsl */ `
struct PfxTex {
  int type;
  int mapping;
  ivec4 mode;
  vec4 basic;
  vec4 ramp;
  vec4 colorA;
  vec4 colorB;
  vec4 offset;
  vec4 k0;
  vec4 k1;
  vec4 k2;
  uint seed;
};

const float PFX_TWO_PI = 6.283185307179586;
const float PFX_INV_SQRT3 = 0.5773502691896258;
const vec3 PFX_GRAD[16] = vec3[16](${gradients});

uint pfxFmix(uint h) {
  h ^= h >> 16u;
  h *= ${u(PFX_FMIX_M1)};
  h ^= h >> 13u;
  h *= ${u(PFX_FMIX_M2)};
  h ^= h >> 16u;
  return h;
}

uint pfxStream(uint h, uint k) {
  return pfxFmix(h + k * ${u(PFX_STREAM)});
}

uint pfxStreamSeed(uint s, uint k) {
  return s + k * ${u(PFX_STREAM)};
}

float pfxUnit(uint h) {
  return float(h >> 8u) * (1.0 / 16777216.0);
}

uint pfxHash(int x, int y, int z, uint s) {
  return pfxFmix(uint(x) + pfxFmix(uint(y) + pfxFmix(uint(z) + s)));
}

float pfxGrad(uint h, float x, float y, float z) {
  vec3 g = PFX_GRAD[int(h & 15u)];
  return g.x * x + g.y * y + g.z * z;
}

float pfxFade(float t) {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float pfxNoise(vec3 p, uint s) {
  vec3 fl = floor(p);
  ivec3 i = ivec3(fl);
  vec3 t = p - fl;
  float u = pfxFade(t.x);
  float v = pfxFade(t.y);
  float w = pfxFade(t.z);
  uint hz0 = pfxFmix(uint(i.z) + s);
  uint hz1 = pfxFmix(uint(i.z + 1) + s);
  uint h00 = pfxFmix(uint(i.y) + hz0);
  uint h10 = pfxFmix(uint(i.y + 1) + hz0);
  uint h01 = pfxFmix(uint(i.y) + hz1);
  uint h11 = pfxFmix(uint(i.y + 1) + hz1);
  float n000 = pfxGrad(pfxFmix(uint(i.x) + h00), t.x, t.y, t.z);
  float n100 = pfxGrad(pfxFmix(uint(i.x + 1) + h00), t.x - 1.0, t.y, t.z);
  float n010 = pfxGrad(pfxFmix(uint(i.x) + h10), t.x, t.y - 1.0, t.z);
  float n110 = pfxGrad(pfxFmix(uint(i.x + 1) + h10), t.x - 1.0, t.y - 1.0, t.z);
  float n001 = pfxGrad(pfxFmix(uint(i.x) + h01), t.x, t.y, t.z - 1.0);
  float n101 = pfxGrad(pfxFmix(uint(i.x + 1) + h01), t.x - 1.0, t.y, t.z - 1.0);
  float n011 = pfxGrad(pfxFmix(uint(i.x) + h11), t.x, t.y - 1.0, t.z - 1.0);
  float n111 = pfxGrad(pfxFmix(uint(i.x + 1) + h11), t.x - 1.0, t.y - 1.0, t.z - 1.0);
  float x00 = n000 + u * (n100 - n000);
  float x10 = n010 + u * (n110 - n010);
  float x01 = n001 + u * (n101 - n001);
  float x11 = n011 + u * (n111 - n011);
  float y0 = x00 + v * (x10 - x00);
  float y1 = x01 + v * (x11 - x01);
  return y0 + w * (y1 - y0);
}

float pfxOctave(vec3 p, uint s, int mode) {
  float n = pfxNoise(p, s);
  if (mode == 0) return n;
  float a = abs(n);
  if (mode == 2) return a;
  float r = 1.0 - a;
  return r * r;
}

float pfxNormOctaves(float sum, float maxAmp, int mode) {
  return mode == 0 ? (0.5 * sum) / maxAmp + 0.5 : sum / maxAmp;
}

float pfxFractal(vec3 p, float detail, float roughness, float lacunarity, uint s, int mode) {
  int octaves = int(floor(detail));
  float freq = 1.0;
  float amp = 1.0;
  float sum = 0.0;
  float maxAmp = 0.0;
  for (int i = 0; i <= 15; i++) {
    if (i > octaves) break;
    sum += amp * pfxOctave(p * freq, pfxStreamSeed(s, uint(i)), mode);
    maxAmp += amp;
    amp *= roughness;
    freq *= lacunarity;
  }
  float value = pfxNormOctaves(sum, maxAmp, mode);
  float rest = detail - float(octaves);
  if (rest > 0.0) {
    float sum2 = sum + amp * pfxOctave(p * freq, pfxStreamSeed(s, uint(octaves + 1)), mode);
    value += rest * (pfxNormOctaves(sum2, maxAmp + amp, mode) - value);
  }
  return value;
}

// res = (F1, F2, distance to edge); returns the hash of the nearest feature point's cell (the
// Euclidean nearest one when edge is set: the edge distance always uses Euclidean cells)
uint pfxVoronoi(vec3 p, float randomness, int metric, uint s, bool edge, out vec3 res) {
  vec3 fl = floor(p);
  ivec3 c = ivec3(fl);
  vec3 f = p - fl;
  float d1 = 1e30;
  float d2 = 1e30;
  uint h1 = 0u;
  float dE = 1e30;
  int bE = 0;
  uint hE = 0u;
  vec3 pts[27];
  int n = 0;
  for (int k = -1; k <= 1; k++) {
    uint hz = pfxFmix(uint(c.z + k) + s);
    for (int j = -1; j <= 1; j++) {
      uint hy = pfxFmix(uint(c.y + j) + hz);
      for (int i = -1; i <= 1; i++) {
        uint h = pfxFmix(uint(c.x + i) + hy);
        vec3 q = vec3(
          float(i) + pfxUnit(h) * randomness,
          float(j) + pfxUnit(pfxStream(h, ${u(PFX_STREAM_JITTER_Y)})) * randomness,
          float(k) + pfxUnit(pfxStream(h, ${u(PFX_STREAM_JITTER_Z)})) * randomness
        );
        pts[n] = q;
        vec3 dv = q - f;
        float e2 = dv.x * dv.x + dv.y * dv.y + dv.z * dv.z;
        float d;
        if (metric == 1) d = abs(dv.x) + abs(dv.y) + abs(dv.z);
        else if (metric == 2) d = max(max(abs(dv.x), abs(dv.y)), abs(dv.z));
        else d = sqrt(e2);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          h1 = h;
        } else if (d < d2) d2 = d;
        if (e2 < dE) {
          dE = e2;
          bE = n;
          hE = h;
        }
        n++;
      }
    }
  }
  float e = 0.0;
  if (edge) {
    vec3 a = pts[bE];
    float best = 1e30;
    for (int m = 0; m < 27; m++) {
      if (m == bE) continue;
      vec3 dq = pts[m] - a;
      float len = sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
      if (len < 1e-6) continue;
      vec3 mid = 0.5 * (a + pts[m]) - f;
      best = min(best, (mid.x * dq.x + mid.y * dq.y + mid.z * dq.z) / len);
    }
    e = best > 1e29 ? 0.0 : max(0.0, best);
    h1 = hE;
  }
  res = vec3(d1, d2, e);
  return h1;
}

float pfxWaveProfile(float n, int profile) {
  if (profile == 1) {
    float t = n / PFX_TWO_PI;
    return t - floor(t);
  }
  if (profile == 2) {
    float t = n / PFX_TWO_PI;
    return abs(t - floor(t + 0.5)) * 2.0;
  }
  return 0.5 - 0.5 * cos(n);
}

float pfxRampT(float f, float lo, float hi, int interp) {
  float span = hi - lo;
  if (interp == 2 || !(span > 1e-9 || span < -1e-9)) return span < 0.0 ? (f >= lo ? 0.0 : 1.0) : (f >= hi ? 1.0 : 0.0);
  float t = clamp((f - lo) / span, 0.0, 1.0);
  return interp == 1 ? t * t * (3.0 - 2.0 * t) : t;
}

float pfxGradient(int kind, vec3 p) {
  float f;
  if (kind == 1) {
    float r = max(p.x, 0.0);
    f = r * r;
  } else if (kind == 2) {
    float r = clamp(p.x, 0.0, 1.0);
    float t = r * r;
    f = 3.0 * t - 2.0 * t * r;
  } else if (kind == 3) {
    f = (p.x + p.y) * 0.5;
  } else if (kind == 4) {
    f = max(0.999999 - sqrt(p.x * p.x + p.y * p.y + p.z * p.z), 0.0);
  } else if (kind == 5) {
    float r = max(0.999999 - sqrt(p.x * p.x + p.y * p.y + p.z * p.z), 0.0);
    f = r * r;
  } else if (kind == 6) {
    f = atan(p.y, p.x) / PFX_TWO_PI + 0.5;
  } else {
    f = p.x;
  }
  return clamp(f, 0.0, 1.0);
}

vec4 pfxSample(PfxTex t, vec3 coord) {
  vec3 p = clamp((coord + t.offset.xyz) * t.basic.x, ${f(-PFX_COORD_LIMIT)}, ${f(PFX_COORD_LIMIT)});
  float detail = t.basic.y;
  float rough = t.basic.z;
  float dist = t.basic.w;
  uint s = t.seed;
  float fac = 0.0;
  bool magic = false;
  vec3 fm = vec3(0.0);
  float over = 0.0;
  vec3 overColor = vec3(0.0);
  if (t.type == 0 || t.type == 1) {
    vec3 q = p;
    if (dist != 0.0) {
      q.x += dist * pfxNoise(p, pfxStreamSeed(s, ${u(PFX_STREAM_WARP)}));
      q.y += dist * pfxNoise(p, pfxStreamSeed(s, ${u(PFX_STREAM_WARP + 1)}));
      q.z += dist * pfxNoise(p, pfxStreamSeed(s, ${u(PFX_STREAM_WARP + 2)}));
    }
    if (t.type == 0) {
      fac = pfxFractal(q, detail, rough, t.k0.x, s, t.mode.x);
    } else {
      int feature = t.mode.x;
      vec3 v;
      uint h = pfxVoronoi(q, t.k0.x, t.mode.y, s, feature == 2, v);
      fac = feature == 1 ? v.y : feature == 2 ? v.z : feature == 3 ? pfxUnit(pfxStream(h, ${u(PFX_STREAM_CELL)})) : v.x;
      if (t.k0.y > 0.0) {
        over = t.k0.y;
        overColor = vec3(
          pfxUnit(pfxStream(h, ${u(PFX_STREAM_CELL_R)})),
          pfxUnit(pfxStream(h, ${u(PFX_STREAM_CELL_G)})),
          pfxUnit(pfxStream(h, ${u(PFX_STREAM_CELL_B)}))
        );
      }
    }
  } else if (t.type == 2) {
    ivec3 ci = ivec3(floor((p + 1e-6) * 0.999999));
    fac = float((ci.x + ci.y + ci.z) & 1);
  } else if (t.type == 3) {
    fac = pfxGradient(t.mode.x, p);
  } else if (t.type == 4) {
    float n;
    int dir = t.mode.y;
    if (t.mode.x == 0) {
      n = dir == 0 ? p.x * 20.0 : dir == 1 ? p.y * 20.0 : dir == 2 ? p.z * 20.0 : (p.x + p.y + p.z) * 10.0;
    } else {
      vec3 r = vec3(dir == 0 ? 0.0 : p.x, dir == 1 ? 0.0 : p.y, dir == 2 ? 0.0 : p.z);
      n = sqrt(r.x * r.x + r.y * r.y + r.z * r.z) * 20.0;
    }
    n += t.k0.x;
    if (dist != 0.0) n += dist * (pfxFractal(p * t.k0.y, detail, rough, 2.0, s, 0) * 2.0 - 1.0);
    fac = pfxWaveProfile(n, t.mode.z);
  } else if (t.type == 5) {
    float mortarSize = t.k0.x;
    float smoothness = t.k0.y;
    float bw = t.k0.z;
    float rh = t.k0.w;
    float px = t.mode.z == 1 ? p.x + p.y : p.x;
    float py = t.mode.z == 1 ? p.z : p.y;
    float row = floor(py / rh);
    float offFreq = float(t.mode.x);
    float sqFreq = float(t.mode.y);
    float width = row - sqFreq * floor(row / sqFreq) == 0.0 ? bw * t.k1.y : bw;
    float shift = row - offFreq * floor(row / offFreq) == 0.0 ? width * t.k1.x : 0.0;
    float bx = px + shift;
    float brick = floor(bx / width);
    float lx = bx - width * brick;
    float ly = py - rh * row;
    fac = clamp(pfxUnit(pfxHash(int(brick), int(row), 0, s)) + t.k1.z, 0.0, 1.0);
    float md = min(min(lx, ly), min(width - lx, rh - ly));
    if (md < mortarSize) {
      if (smoothness <= 0.0) over = 1.0;
      else {
        float m = clamp((1.0 - md / mortarSize) / smoothness, 0.0, 1.0);
        over = m * m * (3.0 - 2.0 * m);
      }
      overColor = t.k2.xyz;
    }
  } else if (t.type == 6) {
    float n = (p.x + p.y + p.z) * PFX_INV_SQRT3;
    if (dist != 0.0) n += dist * (pfxFractal(p, detail, rough, 2.0, s, 0) * 2.0 - 1.0);
    float v = pfxWaveProfile(n * PFX_TWO_PI, t.mode.y);
    if (t.mode.x >= 1) v = sqrt(v);
    if (t.mode.x >= 2) v = sqrt(v);
    fac = v;
  } else if (t.type == 7) {
    // params.axis (mode.z): the ring axis becomes w, X → (y, z, x), Y → (z, x, y) (as procedural.ts)
    vec3 q = t.mode.z == 1 ? p.yzx : (t.mode.z == 2 ? p.zxy : p);
    float n = t.mode.x == 0 ? sqrt(q.x * q.x + q.y * q.y) : (q.x + q.y + q.z) * PFX_INV_SQRT3;
    if (dist != 0.0) n += dist * (pfxFractal(vec3(q.x, q.y, q.z * 0.25), detail, rough, 2.0, s, 0) * 2.0 - 1.0);
    float v = pfxWaveProfile(n * PFX_TWO_PI, t.mode.y);
    if (t.k0.x > 0.0)
      v *= 1.0 - t.k0.x * pfxFractal(vec3(q.x * 16.0, q.y * 16.0, q.z * 0.5), 1.0, 0.5, 2.0, pfxStreamSeed(s, 7u), 0);
    fac = v;
  } else if (t.type == 8) {
    float gain = dist * 1.5;
    float a = sin((p.x + p.y + p.z) * 5.0) * dist;
    float b = cos((-p.x + p.y - p.z) * 5.0) * dist;
    float cc = -cos((-p.x - p.y + p.z) * 5.0) * dist;
    for (int i = 0; i < 10; i++) {
      if (i >= t.mode.x) break;
      int k = i - 3 * (i / 3);
      if (k == 0) b = -cos(a + cc - b) * gain;
      else if (k == 1) cc = sin(a - b - cc) * gain;
      else a = cos(a + b + cc) * gain;
    }
    float inv = gain != 0.0 ? 1.0 / gain : 0.0;
    magic = true;
    fm = vec3(0.5 + 0.5 * a * inv, 0.5 + 0.5 * b * inv, 0.5 + 0.5 * cc * inv);
  }
  vec4 A = t.colorA;
  vec4 B = t.colorB;
  float lo = t.ramp.x;
  float hi = t.ramp.y;
  int interp = t.mode.w;
  vec4 col;
  if (magic) {
    vec4 tt = vec4(
      pfxRampT(fm.x, lo, hi, interp),
      pfxRampT(fm.y, lo, hi, interp),
      pfxRampT(fm.z, lo, hi, interp),
      pfxRampT((fm.x + fm.y + fm.z) / 3.0, lo, hi, interp)
    );
    col = A + tt * (B - A);
  } else {
    col = A + pfxRampT(fac, lo, hi, interp) * (B - A);
  }
  if (over > 0.0) {
    col.rgb += over * (overColor - col.rgb);
    col.a += over * (1.0 - col.a);
  }
  return col;
}

// Mikkelsen's surface-gradient bump with explicit offsets (same as material/surface.ts bumpNormal)
vec3 pfxBump(PfxTex t, float dist, vec3 c, vec3 dcx, vec3 dcy, vec3 dpx, vec3 dpy, vec3 n) {
  float h0 = pfxSample(t, c).r;
  float dhx = (pfxSample(t, c + dcx).r - h0) * dist;
  float dhy = (pfxSample(t, c + dcy).r - h0) * dist;
  vec3 r1 = cross(dpy, n);
  vec3 r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  if (abs(det) < 1e-30) return n;
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  vec3 m = abs(det) * n - g;
  float l = length(m);
  return l > 0.0 ? m / l : n;
}
`;

/** Uniform names of the channels. */
const UNIFORM: Record<MaterialTextureChannel, string> = {
  base_color: 'pfxBaseColor',
  metallic: 'pfxMetallic',
  roughness: 'pfxRoughness',
  normal: 'pfxNormal',
  emission: 'pfxEmission',
  alpha: 'pfxAlpha',
};
const BIT: Record<MaterialTextureChannel, number> = {
  base_color: 1,
  metallic: 2,
  roughness: 4,
  normal: 8,
  emission: 16,
  alpha: 32,
};

/** Value of a `PfxTex` uniform struct (three.js struct uniforms map object keys to members). */
export function proceduralUniformValue(c: CompiledProcedural): Record<string, unknown> {
  return {
    type: c.type,
    mapping: c.mapping,
    mode: [...c.mode],
    basic: [...c.basic],
    ramp: [...c.ramp],
    colorA: [...c.colorA],
    colorB: [...c.colorB],
    offset: [...c.offset],
    k0: [...c.k0],
    k1: [...c.k1],
    k2: [...c.k2],
    seed: c.seed >>> 0,
  };
}

/** Program cache key part for a set of procedural channels (one program per channel set). */
export function proceduralProgramKey(channels: readonly MaterialTextureChannel[]): string {
  return `pfx:${channels.reduce((m, ch) => m | BIT[ch], 0)}`;
}

/** Minimal view of three.js's shader object passed to `onBeforeCompile`. */
export interface ShaderSource {
  vertexShader: string;
  fragmentShader: string;
}

function insertAfter(src: string, anchor: string, code: string): string {
  if (!src.includes(anchor)) throw new Error(`procedural shader: anchor ${anchor} not found`);
  return src.replace(anchor, `${anchor}\n${code}`);
}

/**
 * Injects procedural texture evaluation for `channels` into a MeshStandard/MeshPhysical shader:
 * varyings with the object-space position, the undeformed position and UV, the GLSL library, one
 * `PfxTex` uniform per channel (`pfxBaseColor`, `pfxMetallic`, …) plus `pfxTexMin`/`pfxTexSize`
 * (GENERATED texture space), `pfxHasUv`, `pfxBumpDistance`, `pfxEmissionStrength` and
 * `pfxOrco`/`pfxOrcoWidth`: an RGBA float texture holding the undeformed (orco) position of render
 * vertex i at texel (i mod width, i div width), read with `gl_VertexID` for GENERATED coordinates
 * (width 0: the vertex position is undeformed).
 */
export function injectProceduralShader(
  shader: ShaderSource,
  channels: readonly MaterialTextureChannel[],
): void {
  const has = (ch: MaterialTextureChannel) => channels.includes(ch);
  shader.vertexShader = insertAfter(
    shader.vertexShader,
    '#include <common>',
    [
      'varying vec3 vPfxObj;',
      'varying vec3 vPfxGen;',
      'varying vec2 vPfxUv;',
      'uniform highp sampler2D pfxOrco;',
      'uniform int pfxOrcoWidth;',
    ].join('\n'),
  );
  shader.vertexShader = insertAfter(
    shader.vertexShader,
    '#include <begin_vertex>',
    [
      'vPfxObj = position;',
      'vPfxGen = pfxOrcoWidth > 0 ? texelFetch(pfxOrco, ivec2(gl_VertexID % pfxOrcoWidth, gl_VertexID / pfxOrcoWidth), 0).xyz : position;',
      'vPfxUv = uv;',
    ].join('\n'),
  );
  const uniforms = channels.map((ch) => `uniform PfxTex ${UNIFORM[ch]};`).join('\n');
  const head = /* glsl */ `
varying vec3 vPfxObj;
varying vec3 vPfxGen;
varying vec2 vPfxUv;
uniform vec3 pfxTexMin;
uniform vec3 pfxTexSize;
uniform float pfxHasUv;
uniform float pfxBumpDistance;
uniform float pfxEmissionStrength;
${PROCEDURAL_GLSL_LIB}
${uniforms}
vec3 pfxCoord(int mapping) {
  if (mapping == 2) return vec3(vPfxUv * pfxHasUv, 0.0);
  if (mapping == 1) return vPfxObj;
  // GENERATED: undeformed position in the base mesh bounds (sticks to deforming surfaces)
  return vec3(
    pfxTexSize.x > 1e-12 ? (vPfxGen.x - pfxTexMin.x) / pfxTexSize.x : 0.5,
    pfxTexSize.y > 1e-12 ? (vPfxGen.y - pfxTexMin.y) / pfxTexSize.y : 0.5,
    pfxTexSize.z > 1e-12 ? (vPfxGen.z - pfxTexMin.z) / pfxTexSize.z : 0.5
  );
}
`;
  let fs = insertAfter(shader.fragmentShader, '#include <common>', head);
  if (has('base_color'))
    fs = insertAfter(
      fs,
      '#include <map_fragment>',
      `{ vec4 pc = pfxSample(pfxBaseColor, pfxCoord(pfxBaseColor.mapping)); diffuseColor.rgb = max(pc.rgb, 0.0); diffuseColor.a *= clamp(pc.a, 0.0, 1.0); }`,
    );
  if (has('alpha'))
    fs = insertAfter(
      fs,
      '#include <alphamap_fragment>',
      `diffuseColor.a *= clamp(pfxSample(pfxAlpha, pfxCoord(pfxAlpha.mapping)).r, 0.0, 1.0);`,
    );
  if (has('roughness'))
    fs = insertAfter(
      fs,
      '#include <roughnessmap_fragment>',
      `roughnessFactor = clamp(pfxSample(pfxRoughness, pfxCoord(pfxRoughness.mapping)).r, 0.0, 1.0);`,
    );
  if (has('metallic'))
    fs = insertAfter(
      fs,
      '#include <metalnessmap_fragment>',
      `metalnessFactor = clamp(pfxSample(pfxMetallic, pfxCoord(pfxMetallic.mapping)).r, 0.0, 1.0);`,
    );
  if (has('normal'))
    fs = insertAfter(
      fs,
      '#include <normal_fragment_maps>',
      /* glsl */ `{
  vec3 pfxC = pfxCoord(pfxNormal.mapping);
  vec3 pfxDcx = dFdx(pfxC);
  vec3 pfxDcy = dFdy(pfxC);
  vec3 pfxDpx = dFdx(-vViewPosition);
  vec3 pfxDpy = dFdy(-vViewPosition);
  normal = pfxBump(pfxNormal, pfxBumpDistance, pfxC, pfxDcx, pfxDcy, pfxDpx, pfxDpy, normal);
}`,
    );
  if (has('emission'))
    fs = insertAfter(
      fs,
      '#include <emissivemap_fragment>',
      `totalEmissiveRadiance = max(pfxSample(pfxEmission, pfxCoord(pfxEmission.mapping)).rgb, 0.0) * pfxEmissionStrength;`,
    );
  shader.fragmentShader = fs;
}

/** Uniform name of a channel's `PfxTex`. */
export function proceduralUniformName(channel: MaterialTextureChannel): string {
  return UNIFORM[channel];
}
