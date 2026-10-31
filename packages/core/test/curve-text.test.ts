import { describe, expect, it } from 'vitest';
import {
  FONT_ASCENT,
  FONT_DESCENT,
  SceneDoc,
  SceneEvaluator,
  countInconsistentEdges,
  curveToMesh,
  defaultCurve,
  faceNormalRaw,
  fontCharacters,
  glyphAdvance,
  glyphOutline,
  hasGlyph,
  isClosedManifold,
  layoutText,
  renderItems,
  renderSceneSoftware,
  signedArea,
  textOutline,
  type CurveData,
  type MeshData,
  type Vec2,
} from '../src';

const text = (body: string, extra: Partial<CurveData> = {}): CurveData => ({
  ...defaultCurve('t', 'Text'),
  body,
  dimensions: '2D',
  fill_mode: 'BOTH',
  ...extra,
});

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(a, b, c);
  const d2 = o(a, b, d);
  const d3 = o(c, d, a);
  const d4 = o(c, d, b);
  return (
    ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
    ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
  );
}

/** Proper crossings between any two edges of a glyph's contours. */
function crossings(contours: Vec2[][]): number {
  const edges: [Vec2, Vec2][] = [];
  for (const c of contours) for (let i = 0; i < c.length; i++) edges.push([c[i], c[(i + 1) % c.length]]);
  let n = 0;
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++)
      if (segmentsCross(edges[i][0], edges[i][1], edges[j][0], edges[j][1])) n++;
  return n;
}

const holes = (ch: string) => glyphOutline(ch).contours.filter((c) => signedArea(c) < 0).length;
const outers = (ch: string) => glyphOutline(ch).contours.filter((c) => signedArea(c) > 0).length;

describe('built-in font', () => {
  it('covers printable ASCII and Latin-1 letters with clean closed outlines', () => {
    const ascii = Array.from({ length: 126 - 32 }, (_, i) => String.fromCharCode(33 + i));
    const latin = [...'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝßàáâãäåæçèéêëìíîïñòóôõöøùúûüýÿ°·×÷±¡¿«»©®€£¢§¶µ'];
    for (const ch of [...ascii, ...latin]) {
      expect(hasGlyph(ch), ch).toBe(true);
      const g = glyphOutline(ch);
      expect(g.advance, ch).toBeGreaterThan(100);
      expect(g.contours.length, ch).toBeGreaterThan(0);
      for (const c of g.contours) {
        expect(c.length, ch).toBeGreaterThanOrEqual(3);
        expect(Math.abs(signedArea(c)), ch).toBeGreaterThan(50);
        for (const p of c) expect(Number.isFinite(p[0]) && Number.isFinite(p[1]), ch).toBe(true);
      }
      // outer boundaries are counter-clockwise: the net area is positive
      expect(
        g.contours.reduce((s, c) => s + signedArea(c), 0),
        ch,
      ).toBeGreaterThan(0);
      expect(crossings(g.contours), ch).toBe(0);
    }
    expect(fontCharacters().length).toBeGreaterThan(ascii.length + latin.length);
  });

  it('has proper counters (holes) and separate parts', () => {
    const expected: Record<string, number> = {
      A: 1,
      B: 2,
      D: 1,
      O: 1,
      P: 1,
      Q: 1,
      R: 1,
      a: 1,
      b: 1,
      d: 1,
      e: 1,
      g: 1,
      o: 1,
      p: 1,
      q: 1,
      '0': 1,
      '4': 1,
      '6': 1,
      '8': 2,
      '9': 1,
      '%': 2,
      C: 0,
      E: 0,
      H: 0,
      S: 0,
      s: 0,
      n: 0,
      x: 0,
      '1': 0,
      '7': 0,
    };
    for (const [ch, n] of Object.entries(expected)) expect(holes(ch), ch).toBe(n);
    expect(holes('@')).toBeGreaterThanOrEqual(1);
    // & = loop + bowl counters; § = one middle loop between two open hooks
    expect([outers('&'), holes('&')]).toEqual([1, 2]);
    expect([outers('§'), holes('§')]).toEqual([1, 1]);
    for (const ch of '()~[]{}çÇ') expect(holes(ch), ch).toBe(0);
    expect(holes('ß')).toBe(1);
    for (const ch of '()~çÇ') expect(outers(ch), ch).toBe(1);
    expect(holes('æ')).toBe(2);
    expect(outers('i')).toBe(2);
    expect(outers('j')).toBe(2);
    expect(outers('!')).toBe(2);
    expect(outers(':')).toBe(2);
    expect(outers('"')).toBe(2);
    expect(outers('%')).toBe(3);
    expect(outers('é')).toBe(2);
    expect(outers('ä')).toBe(3);
    expect(holes('Ø')).toBe(2);
  });

  it('uses consistent metrics', () => {
    const box = (ch: string) => {
      let y0 = Infinity;
      let y1 = -Infinity;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const c of glyphOutline(ch).contours)
        for (const p of c) {
          y0 = Math.min(y0, p[1]);
          y1 = Math.max(y1, p[1]);
          x0 = Math.min(x0, p[0]);
          x1 = Math.max(x1, p[0]);
        }
      return { x0, x1, y0, y1 };
    };
    for (const ch of 'EFHIKLMNTVWXYZ') {
      expect(box(ch).y0, ch).toBeCloseTo(0);
      expect(box(ch).y1, ch).toBeCloseTo(700);
    }
    for (const ch of 'OCGQS') expect(box(ch).y1, ch).toBeCloseTo(712);
    for (const ch of 'xvwz') expect(box(ch).y1, ch).toBeCloseTo(500);
    for (const ch of 'bdhkl') expect(box(ch).y1, ch).toBeCloseTo(740);
    for (const ch of 'pq') expect(box(ch).y0, ch).toBeCloseTo(-220);
    // ink stays within the advance (small overhangs allowed for f, j)
    for (const ch of 'ABCDEHKMNOSUVWXZabcdeghkmnopqsuvwxz0123456789') {
      const b = box(ch);
      expect(b.x0, ch).toBeGreaterThanOrEqual(0);
      expect(b.x1, ch).toBeLessThanOrEqual(glyphAdvance(ch));
    }
    // brackets reach below the baseline and above the capitals
    for (const ch of '()[]{}') {
      expect(box(ch).y0, ch).toBeLessThan(-100);
      expect(box(ch).y1, ch).toBeGreaterThan(740);
    }
    // symbols and narrow accented letters keep their ink within the advance
    for (const ch of '&§()~ïÏíÍçÇæ') {
      const b = box(ch);
      expect(b.x0, ch).toBeGreaterThanOrEqual(0);
      expect(b.x1, ch).toBeLessThanOrEqual(glyphAdvance(ch));
    }
    // figures are tabular
    expect(new Set([...'0123456789'].map(glyphAdvance))).toEqual(new Set([600]));
    expect(FONT_ASCENT + FONT_DESCENT).toBe(1000);
  });

  it('keeps every glyph valid with the same topology at any arc resolution', () => {
    const signature = (ch: string, seg: number) => {
      const cs = glyphOutline(ch, seg).contours;
      return `${cs.filter((c) => signedArea(c) > 0).length}/${cs.filter((c) => signedArea(c) < 0).length}`;
    };
    for (const ch of fontCharacters()) {
      if (ch.trim() === '') continue;
      const ref = signature(ch, 12);
      for (const seg of [2, 3, 5, 8, 24, 64]) expect(signature(ch, seg), `${ch} @ ${seg}`).toBe(ref);
      for (const seg of [3, 24]) expect(crossings(glyphOutline(ch, seg).contours), `${ch} @ ${seg}`).toBe(0);
    }
  });

  it('draws missing characters as a box, whitespace as nothing, and follows the resolution', () => {
    const box = glyphOutline('中');
    expect(box.contours).toHaveLength(2);
    expect(hasGlyph('中')).toBe(false);
    expect(glyphOutline(' ').contours).toHaveLength(0);
    expect(glyphAdvance(' ')).toBeGreaterThan(0);
    const coarse = glyphOutline('o', 3).contours[0].length;
    const fine = glyphOutline('o', 24).contours[0].length;
    expect(fine).toBeGreaterThan(coarse * 4);
    // cached and deterministic
    expect(glyphOutline('g', 12)).toBe(glyphOutline('g', 12));
    expect(JSON.stringify(glyphOutline('R', 7))).toBe(JSON.stringify(glyphOutline('R', 7.2)));
  });
});

describe('text layout', () => {
  const xs = (t: CurveData) => layoutText(t).glyphs.map((g) => g.x);

  it('advances characters by their widths, spaces and character spacing', () => {
    const a = glyphAdvance('A') / 1000;
    const sp = glyphAdvance(' ') / 1000;
    expect(xs(text('AA'))).toEqual([0, a]);
    expect(xs(text('AA', { size: 2 }))).toEqual([0, 2 * a]);
    expect(xs(text('A A', { space_word: 2 }))[2]).toBeCloseTo(a + 2 * sp);
    expect(xs(text('AA', { space_character: 2 }))[1]).toBeCloseTo(a + 0.5);
  });

  it('aligns lines horizontally', () => {
    const w = (glyphAdvance('A') * 2) / 1000;
    expect(xs(text('AA', { align_x: 'CENTER' }))[0]).toBeCloseTo(-w / 2);
    expect(xs(text('AA', { align_x: 'RIGHT' }))[0]).toBeCloseTo(-w);
    const long = 'Wide line here';
    const t = text(`a b\n${long}\nx y`, { align_x: 'JUSTIFY' });
    const l = layoutText(t);
    const lineEnd = (line: number) => {
      const gs = l.glyphs.filter((g) => g.line === line);
      const last = gs[gs.length - 1];
      return last.x + last.advance;
    };
    expect(lineEnd(0)).toBeCloseTo(lineEnd(1));
    expect(lineEnd(2)).toBeLessThan(lineEnd(1) - 0.5); // the last line is not justified
    const flush = layoutText({ ...t, align_x: 'FLUSH' });
    const fe = (line: number) => {
      const gs = flush.glyphs.filter((g) => g.line === line);
      return gs[gs.length - 1].x + gs[gs.length - 1].advance;
    };
    expect(fe(0)).toBeCloseTo(fe(1));
    expect(fe(2)).toBeCloseTo(fe(1));
    expect(l.bounds.max[0] - l.bounds.min[0]).toBeCloseTo(lineEnd(1));
  });

  it('stacks lines and aligns the block vertically', () => {
    const ys = (t: CurveData) => [...new Set(layoutText(t).glyphs.map((g) => g.y))];
    expect(ys(text('A\nB\r\nC'))).toEqual([0, -1, -2]);
    expect(ys(text('A\nB', { space_line: 1.5, size: 2 }))).toEqual([0, -3]);
    expect(ys(text('A\nB', { align_y: 'TOP' }))).toEqual([-0.75, -1.75]);
    expect(ys(text('A\nB', { align_y: 'BOTTOM_BASELINE' }))).toEqual([1, 0]);
    expect(ys(text('A\nB', { align_y: 'BOTTOM' }))).toEqual([1.25, 0.25]);
    const c = layoutText(text('A\nB\nC', { align_y: 'CENTER' }));
    expect(c.bounds.max[1]).toBeCloseTo(-c.bounds.min[1]);
    expect(c.lineCount).toBe(3);
  });

  it('applies offsets in object units and shears glyphs', () => {
    const t = text('I', { offset_x: 2, offset_y: -1, size: 3 });
    expect(layoutText(t).glyphs[0]).toMatchObject({ x: 2, y: -1 });
    const straight = textOutline(text('I')).contours[0];
    const slanted = textOutline(text('I', { shear: 0.5 })).contours[0];
    straight.forEach((p, i) => {
      expect(slanted[i][1]).toBeCloseTo(p[1]);
      expect(slanted[i][0]).toBeCloseTo(p[0] + 0.5 * p[1]);
    });
  });

  it('ignores control characters, expands tabs and survives bad settings', () => {
    expect(layoutText(text('a\u0007b')).glyphs.map((g) => g.char)).toEqual(['a', 'b']);
    expect(layoutText(text('a\tb')).glyphs[1].advance).toBeCloseTo((4 * glyphAdvance(' ')) / 1000);
    const bad = text(undefined as unknown as string, {
      size: NaN,
      space_line: Infinity,
      align_x: 'X' as never,
    });
    expect(() => layoutText(bad)).not.toThrow();
    expect(textOutline(text('')).contours).toEqual([]);
  });
});

describe('text geometry', () => {
  const areaZ = (m: MeshData, sign: number) =>
    m.faces.reduce((s, _, f) => {
      const n = faceNormalRaw(m, f);
      return n[2] * sign > 1e-12 ? s + Math.abs(n[2]) / 2 : s;
    }, 0);

  it('fills flat text facing +Z inside the layout bounds', () => {
    const t = text('Hello, World!');
    const r = curveToMesh(t, { forRender: false, isText: true });
    const m = r.mesh!;
    expect(r.lines).toBeNull();
    expect(areaZ(m, -1)).toBe(0);
    expect(areaZ(m, 1)).toBeGreaterThan(0.5);
    const b = layoutText(t).bounds;
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(m.positions[i]).toBeGreaterThanOrEqual(b.min[0] - 1e-9);
      expect(m.positions[i]).toBeLessThanOrEqual(b.max[0] + 0.05);
      expect(m.positions[i + 2]).toBe(0);
    }
  });

  it('extrudes and bevels text into closed solids', () => {
    const m = curveToMesh(text('Ag@8&%', { extrude: 0.1, bevel_depth: 0.02, bevel_resolution: 2 }), {
      forRender: false,
      isText: true,
    }).mesh!;
    expect(isClosedManifold(m)).toBe(true);
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 2; i < m.positions.length; i += 3) {
      z0 = Math.min(z0, m.positions[i]);
      z1 = Math.max(z1, m.positions[i]);
    }
    expect(z1).toBeCloseTo(0.12);
    expect(z0).toBeCloseTo(-0.12);
    // flat front/back caps, smooth walls with sharp corners
    expect(m.faceSmooth.some(Boolean)).toBe(true);
    expect(m.faceSmooth.some((s) => !s)).toBe(true);
    expect(Object.keys(m.edgeAttrs).length).toBeGreaterThan(0);
  });

  it('extrudes every glyph into a watertight solid, also beveled, bolder or thinner', () => {
    const configs: Partial<CurveData>[] = [
      { extrude: 0.05 },
      { extrude: 0.05, bevel_depth: 0.01, bevel_resolution: 2 },
      { extrude: 0.04, offset: -0.008 },
      { extrude: 0.04, bevel_depth: 0.008, bevel_resolution: 1, offset: 0.008 },
    ];
    for (const extra of configs)
      for (const ch of fontCharacters()) {
        if (ch.trim() === '') continue;
        const m = curveToMesh(text(ch, extra), { forRender: false, isText: true }).mesh!;
        const label = `${ch} ${JSON.stringify(extra)}`;
        expect(isClosedManifold(m), label).toBe(true);
        expect(countInconsistentEdges(m), label).toBe(0);
      }
  });

  it('shows outlines only with fill_mode NONE and offsets make text bolder', () => {
    const outline = curveToMesh(text('O', { fill_mode: 'NONE' }), { forRender: false, isText: true });
    expect(outline.mesh).toBeNull();
    expect(outline.lines!.length).toBeGreaterThan(0);
    const area = (offset: number) => {
      const m = curveToMesh(text('I', { offset }), { forRender: false, isText: true }).mesh!;
      return areaZ(m, 1);
    };
    expect(area(0.02)).toBeGreaterThan(area(0));
    expect(area(-0.02)).toBeLessThan(area(0));
  });

  it('evaluates and renders FONT objects', () => {
    const doc = SceneDoc.create({ empty: true });
    const cid = doc.addCurve({ name: 'Sign', body: 'Hi', size: 1, fill_mode: 'BOTH', extrude: 0.05 });
    const id = doc.addObject({ type: 'FONT', name: 'Sign', data: cid });
    const ev = new SceneEvaluator(doc).evaluate(1);
    expect(renderItems(ev).map((i) => i.id)).toEqual([id]);
    expect(isClosedManifold(ev.byId.get(id)!.mesh!)).toBe(true);
    const img = renderSceneSoftware(doc, {
      width: 64,
      height: 32,
      view: { position: [0.5, 0.35, 5], target: [0.5, 0.35, 0], up: [0, 1, 0], fovY: 0.2 },
      background: [1, 1, 1, 1],
      shading: 'SOLID',
      samples: 1,
    });
    let ink = 0;
    for (let i = 0; i < img.data.length; i += 4) if (img.data[i] < 200) ink++;
    expect(ink).toBeGreaterThan(64 * 32 * 0.05);
    expect(ink).toBeLessThan(64 * 32 * 0.8);
  });
});
