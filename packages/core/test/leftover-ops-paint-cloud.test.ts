import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  faceIslands,
  type OperatorContext,
} from '../src';
import { generateCloud } from '../src/generate/blob';

// Regression tests for two lighthouse-cove issues:
// - no operator set vertex colours from data (exact per-vertex colours needed one brush dab per
//   vertex): paint.vertex_color_set_data;
// - object.generate_cloud with a flat aspect ratio silently returned a few tiny fragments.

/** Vertex colours are stored as float32: compare to 6 decimals. */
const rgba = (c: readonly number[], i: number) =>
  c.slice(i * 4, i * 4 + 4).map((v) => Math.round(v * 1e6) / 1e6);

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'mcp',
    report: (level, message) => reports.push({ level, message }),
  };
  const run = (id: string, params?: unknown) => reg.run<any>(ctx, id, params);
  const ok = (id: string, params?: unknown) => {
    const r = run(id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
    return r.result;
  };
  return { doc, ctx, run, ok, reports };
}

describe('paint.vertex_color_set_data', () => {
  function cube() {
    const t = setup();
    t.ok('mesh.primitive_cube_add', { name: 'Box' });
    const colors = () => t.doc.getMesh(t.doc.findObjectByName('Box')!.data!)!.colors;
    const n = t.doc.getMesh(t.doc.findObjectByName('Box')!.data!)!.positions.length / 3;
    return { ...t, colors, n };
  }

  it('writes one exact colour per vertex in one call (RGB gets alpha 1)', () => {
    const { ok, colors, n } = cube();
    expect(colors()).toBeNull();
    const data = Array.from({ length: n }, (_, i) => [i / n, 1 - i / n, 0.25, 0.5 + i / (4 * n)]);
    data[3] = [0.1, 0.2, 0.3]; // RGB → alpha 1
    const r = ok('paint.vertex_color_set_data', { object: 'Box', colors: data });
    expect(r).toEqual({ object: 'Box', vertices: n, set: n });
    const c = colors()!;
    expect(c).toHaveLength(n * 4);
    for (let i = 0; i < n; i++) {
      const want = i === 3 ? [0.1, 0.2, 0.3, 1] : data[i];
      expect(rgba(c, i)).toEqual(want.map((v) => Math.round(v * 1e6) / 1e6));
    }
  });

  it('indices, start and ranges change only those vertices (a new layer starts white)', () => {
    const { ok, colors, n } = cube();
    let r = ok('paint.vertex_color_set_data', { object: 'Box', indices: [1, 5], colors: [[1, 0, 0, 1]] });
    expect(r.set).toBe(2);
    let c = colors()!;
    for (let i = 0; i < n; i++) expect(rgba(c, i)).toEqual(i === 1 || i === 5 ? [1, 0, 0, 1] : [1, 1, 1, 1]);
    ok('paint.vertex_color_set_data', {
      object: 'Box',
      indices: [0, 2],
      colors: [
        [0, 1, 0, 1],
        [0, 0, 1, 1],
      ],
    });
    ok('paint.vertex_color_set_data', {
      object: 'Box',
      start: 6,
      colors: [
        [0.5, 0.5, 0.5, 1],
        [0.2, 0.2, 0.2],
      ],
    });
    c = colors()!;
    expect(rgba(c, 0)).toEqual([0, 1, 0, 1]);
    expect(rgba(c, 2)).toEqual([0, 0, 1, 1]);
    expect(rgba(c, 1)).toEqual([1, 0, 0, 1]); // kept
    expect(rgba(c, 6)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(rgba(c, 7)).toEqual([0.2, 0.2, 0.2, 1]);
    r = ok('paint.vertex_color_set_data', {
      object: 'Box',
      ranges: [
        { start: 0, count: 4, color: [0.9, 0.8, 0.7, 1] },
        { start: 4, count: n - 4, color: [0.1, 0.1, 0.1, 1] },
      ],
    });
    expect(r.set).toBe(n);
    c = colors()!;
    for (let i = 0; i < n; i++) expect(rgba(c, i)).toEqual(i < 4 ? [0.9, 0.8, 0.7, 1] : [0.1, 0.1, 0.1, 1]);
  });

  it('defaults to the active object', () => {
    const { ok, ctx, doc, colors, n } = cube();
    ctx.state.activeId = doc.findObjectByName('Box')!.id;
    ok('paint.vertex_color_set_data', { colors: Array.from({ length: n }, () => [0.3, 0.3, 0.3, 1]) });
    for (let i = 0; i < n; i++) expect(rgba(colors()!, i)).toEqual([0.3, 0.3, 0.3, 1]);
  });

  it('rejects wrong counts, out-of-range indices, 0..255 values and mixed forms with clear errors', () => {
    const { run, n } = cube();
    const err = (params: object) => {
      const r = run('paint.vertex_color_set_data', { object: 'Box', ...params });
      expect(r.ok).toBe(false);
      expect(r.code).toBe('INVALID_PARAMS');
      return r.error as string;
    };
    expect(err({ colors: [[1, 1, 1, 1]] })).toContain(`colors has 1 entries but 'Box' has ${n} vertices`);
    expect(err({ indices: [n], colors: [[1, 1, 1, 1]] })).toContain(`has ${n} vertices (0 … ${n - 1})`);
    expect(
      err({
        start: n - 1,
        colors: [
          [1, 1, 1],
          [1, 1, 1],
        ],
      }),
    ).toContain('out of range');
    expect(
      err({
        indices: [0, 1, 2],
        colors: [
          [1, 1, 1],
          [1, 1, 1],
        ],
      }),
    ).toContain('2 entries for 3 indices');
    expect(err({ colors: Array.from({ length: n }, () => [200, 120, 40, 255]) })).toContain(
      'divide 0..255 values by 255',
    );
    expect(err({ ranges: [{ start: 0, count: 1, color: [1, 1, 1] }], colors: [[1, 1, 1]] })).toContain(
      'not both',
    );
    expect(err({})).toContain('Nothing to set');
    const notMesh = setup();
    notMesh.ok('object.empty_add', { name: 'E' });
    const r = notMesh.run('paint.vertex_color_set_data', { object: 'E', colors: [[1, 1, 1]] });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('need a mesh');
  });
});

describe('object.generate_cloud: flat and long clouds are one connected piece', () => {
  it('the lighthouse-cove stratus streak (520 × 110 × 12 m) is a continuous cloud, not a few specks', () => {
    const r = generateCloud({ size: [520, 110, 12], puffs: 24, smoothness: 0.35, resolution: 56, seed: 3 });
    expect(faceIslands(r.mesh).count).toBe(1);
    expect(r.mesh.positions.length / 3).toBeGreaterThan(1000);
    expect(r.warnings ?? []).toEqual([]);
    const P = r.mesh.positions;
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3)
      for (let c = 0; c < 3; c++) {
        lo[c] = Math.min(lo[c], P[i + c]);
        hi[c] = Math.max(hi[c], P[i + c]);
      }
    expect(hi.map((h, c) => h - lo[c])).toEqual([520, 110, 12].map((v) => expect.closeTo(v, 6)));
    // the streak covers its footprint: a vertical ray at the middle and at ±40 % of its length hits it
    for (const x of [-0.4 * 520, 0, 0.4 * 520]) {
      let hit = false;
      for (const f of r.mesh.faces) {
        const xs = f.map((v) => P[v * 3]);
        const ys = f.map((v) => P[v * 3 + 1]);
        if (Math.min(...xs) <= x && x <= Math.max(...xs) && Math.min(...ys) <= 0 && 0 <= Math.max(...ys)) {
          hit = true;
          break;
        }
      }
      expect(hit).toBe(true);
    }
  });

  it('stays connected for any proportions, puff count and seed', () => {
    const sizes: [number, number, number][] = [
      [4, 2.5, 1.5],
      [100, 100, 5],
      [300, 40, 30],
      [1000, 10, 5],
      [60, 6, 10],
      [2, 2, 20],
    ];
    for (const size of sizes)
      for (const puffs of [3, 14, 40])
        for (const seed of [0, 1]) {
          const r = generateCloud({ size, puffs, seed, resolution: 24 });
          expect(faceIslands(r.mesh).count, `${JSON.stringify(size)} puffs ${puffs} seed ${seed}`).toBe(1);
        }
  });

  it('the operator result and reports for the issue repro', () => {
    const { ok, reports } = setup();
    const r = ok('object.generate_cloud', {
      name: 'Flat',
      size: [520, 110, 12],
      puffs: 24,
      smoothness: 0.35,
      resolution: 56,
      seed: 3,
      location: [0, 0, 50],
    });
    expect(r.vertices).toBeGreaterThan(1000);
    expect(r.dimensions).toEqual([520, 110, 12].map((v) => expect.closeTo(v, 4)));
    expect(reports.filter((x) => x.level === 'WARNING')).toEqual([]);
  });
});
