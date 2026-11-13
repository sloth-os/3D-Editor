import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  type OperatorContext,
} from '../src';
import { defaultProcedural, sampleProcedural } from '../src/material/procedural';
import type { ProceduralTexture } from '../src/doc/types';

// Documentation regressions from the phase-3 projects: the measured behaviour must match what the
// operator descriptions tell agents.
// - lighthouse-cove: the direction of a positive curve point tilt was undocumented;
// - clockwork-orrery: the MARBLE recipe for thin veins (narrow ramp + EASE) was undocumented.

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: () => {},
  };
  const ok = (id: string, params?: unknown) => {
    const r = reg.run<any>(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  const info = (id: string) => reg.describe().find((d) => d.id === id)!;
  return { doc, ok, info };
}

describe('curve point tilt direction', () => {
  it('a positive tilt raises the left side of the profile (travel along +X: +Y side up), as documented', () => {
    const { doc, ok, info } = setup();
    // the lighthouse-cove repro: a 1.5 m wide flat profile swept along +X with tilt 0.3
    ok('curve.add_from_points', {
      name: 'Profile',
      type: 'POLY',
      cyclic: true,
      points: [
        [-0.75, -0.05, 0],
        [0.75, -0.05, 0],
        [0.75, 0.05, 0],
        [-0.75, 0.05, 0],
      ],
    });
    ok('curve.add_from_points', {
      name: 'Path',
      type: 'BEZIER',
      points: [
        { co: [0, 0, 0], tilt: 0.3 },
        { co: [5, 0, 0], tilt: 0.3 },
      ],
      bevel_mode: 'OBJECT',
      bevel_object: 'Profile',
      twist_mode: 'Z_UP',
    });
    // an extruded ribbon leans its top to the right
    ok('curve.add_from_points', {
      name: 'Ribbon',
      type: 'POLY',
      points: [
        { co: [0, 10, 0], tilt: 0.3 },
        { co: [5, 10, 0], tilt: 0.3 },
      ],
      extrude: 0.5,
      twist_mode: 'Z_UP',
    });
    const ev = new SceneEvaluator(doc).evaluate(1);
    const verts = (name: string) => {
      const P = ev.byId.get(doc.findObjectByName(name)!.id)!.mesh!.positions;
      return Array.from({ length: P.length / 3 }, (_, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]);
    };
    const path = verts('Path');
    const left = path.reduce((a, b) => (b[1] > a[1] ? b : a));
    const right = path.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(left[2]).toBeGreaterThan(0.1);
    expect(right[2]).toBeLessThan(-0.1);
    // w/2 × sin(tilt) for the 1.5 m profile (its 0.1 m thickness adds ± 0.05 × cos(tilt))
    expect(left[2]).toBeCloseTo(0.75 * Math.sin(0.3) - 0.05 * Math.cos(0.3), 2);
    const ribbon = verts('Ribbon');
    const top = ribbon.reduce((a, b) => (b[2] > a[2] ? b : a));
    expect(top[1]).toBeLessThan(10);
    // the documentation says so
    const tilt = JSON.stringify(info('curve.add_from_points').parameters);
    expect(tilt).toContain('RAISES the LEFT side of the profile');
    expect(tilt).toContain('leans the top of an extruded ribbon to the right');
    expect(JSON.stringify(info('curve.spline_set_points').parameters)).toContain('RAISES the LEFT side');
  });
});

describe('MARBLE thin veins recipe', () => {
  /** Shares of near-black stone, pale vein and in-between samples of a dark marble. */
  function shares(tex: ProceduralTexture) {
    let dark = 0;
    let vein = 0;
    let n = 0;
    for (let i = 0; i < 60; i++)
      for (let j = 0; j < 60; j++) {
        const c = sampleProcedural(tex, [i / 30, j / 30, 0.37]);
        const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        n++;
        if (l < 0.03) dark++;
        else if (l > 0.18) vein++;
      }
    return { dark: dark / n, vein: vein / n, mid: 1 - (dark + vein) / n };
  }

  it('narrow ramp + EASE gives thin veins on dark stone; the default ramp a cloudy mix, as documented', () => {
    // the clockwork-orrery plinth: pale color_a veins, near-black color_b stone
    const base: ProceduralTexture = {
      ...defaultProcedural('MARBLE'),
      mapping: 'OBJECT',
      scale: 3.2,
      distortion: 2.6,
      color_a: [0.26, 0.22, 0.17, 1],
      color_b: [0.007, 0.0075, 0.009, 1],
    };
    const cloudy = shares({ ...base, params: { marble_type: 'SHARPER' } });
    const veined = shares({
      ...base,
      ramp_low: 0,
      ramp_high: 0.26,
      params: { marble_type: 'SHARP', ramp_interpolation: 'EASE' },
    });
    // default 0..1 ramp: most of the surface is an in-between grey
    expect(cloudy.mid).toBeGreaterThan(0.4);
    // the recipe: mostly black stone, a small share of veins and their soft edges
    expect(veined.dark).toBeGreaterThan(0.8);
    expect(veined.vein).toBeGreaterThan(0.01);
    expect(veined.mid).toBeLessThan(0.15);
    const { info } = setup();
    const op = info('material.procedural_set');
    expect(op.description).toContain('ramp_high ≈ 0.25');
    expect(op.description).toContain('ramp_interpolation EASE');
    const params = JSON.stringify(op.parameters);
    expect(params).toContain('for thin veins use ramp_low 0, ramp_high ≈ 0.25');
    expect(params).toContain('The vein WIDTH is set by the ramp');
  });
});
