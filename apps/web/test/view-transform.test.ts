import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import { VIEW_TRANSFORMS, applyViewTransform } from '@3d-editor/core';
import {
  CURVE_SAMPLES,
  VIEW_TRANSFORM_SHADER,
  ViewTransformPass,
  curveTable,
  viewTransformParams,
  viewTransformPixel,
} from '../src/viewport/view-transform';

/*
 * The output pass of WebGL renders applies the core renderers' colour management (exposure, view
 * transform, sRGB). The shader cannot run without a GPU here; its JavaScript twin
 * (`viewTransformPixel`, same table and formulas) is checked against the core.
 */

const LEVELS = [0, 1e-5, 0.002, 0.01, 0.05, 0.18, 0.4, 0.9, 1.6, 4, 16, 90, 1e4];

describe('view transform pass', () => {
  it('displays every colour as the core renderers do, for every view transform', () => {
    // regression: the WebGL renders used three.js's AgX, ACES and Neutral tone mapping, other curves
    // than the path tracer's and the CPU rasterizer's (AgX renders were about 20 % brighter)
    const core = [0, 0, 0];
    let worst = 0;
    for (const vt of VIEW_TRANSFORMS)
      for (const r of LEVELS)
        for (const g of [0, 0.03, 0.18, 2.5])
          for (const b of [0.001, 0.5, 7]) {
            applyViewTransform(vt, r, g, b, core);
            const ours = viewTransformPixel(vt, r, g, b);
            for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(ours[k] - core[k]));
          }
    // far below one 8-bit step
    expect(worst).toBeLessThan(2e-4);
  });

  it('treats negative and non-finite values as black, like the core', () => {
    for (const vt of VIEW_TRANSFORMS) {
      expect(viewTransformPixel(vt, -1, NaN, Infinity)).toEqual([0, 0, 0]);
      const core = [1, 1, 1];
      applyViewTransform(vt, -1, NaN, Infinity, core);
      expect(core).toEqual([0, 0, 0]);
    }
  });

  it('samples the core curves over the log range the shader decodes', () => {
    for (const vt of ['AGX', 'FILMIC', 'ACES'] as const) {
      const t = curveTable(vt);
      expect(t).toHaveLength(CURVE_SAMPLES);
      expect(t[0]).toBe(0);
      expect(t[CURVE_SAMPLES - 1]).toBeCloseTo(1, 6);
      // monotonic
      for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThanOrEqual(t[i - 1]);
    }
    expect(viewTransformParams('STANDARD').mode).toBe(0);
    expect(viewTransformParams('NEUTRAL').mode).toBe(2);
    expect(viewTransformParams('BOGUS' as never)).toEqual(viewTransformParams('STANDARD'));
  });

  it('sets the shader up for a view transform and an exposure in stops', () => {
    const pass = new ViewTransformPass();
    const u = pass.uniforms as typeof VIEW_TRANSFORM_SHADER.uniforms;
    pass.setTransform('AGX', 2);
    expect(u.exposure.value).toBe(4);
    expect([u.mode.value, u.inset.value, u.outset.value]).toEqual([1, 0.2, 0.15]);
    expect((u.curve.value as THREE.DataTexture | null)?.image.data).toBe(curveTable('AGX'));
    pass.setTransform('STANDARD', -1);
    expect([u.mode.value, u.exposure.value, u.curve.value]).toEqual([0, 0.5, null]);
    pass.setTransform(undefined, NaN);
    expect([u.mode.value, u.exposure.value]).toEqual([0, 1]);
    // the fragment shader declares every uniform the pass sets
    for (const name of Object.keys(VIEW_TRANSFORM_SHADER.uniforms))
      expect(VIEW_TRANSFORM_SHADER.fragmentShader).toMatch(new RegExp(`uniform \\w+ ${name};`));
    pass.dispose();
  });
});
