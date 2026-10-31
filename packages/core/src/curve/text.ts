import type { Vec2 } from '../math/types';
import type { CurveData, TextAlignX, TextAlignY } from '../doc/types';
import { FONT_ASCENT, FONT_DESCENT, FONT_UNITS_PER_EM, glyphAdvance, glyphOutline } from './font';

/*
 * Text layout for FONT objects (Blender's TextCurve semantics, without text boxes):
 *
 * - `body` lines are separated by "\n"; the first baseline is at y = 0 (TOP_BASELINE);
 * - `size` scales the font (1 em = `size` object units); line distance = `space_line` em;
 * - characters advance by their width (spaces × `space_word`) plus 0.5 × (`space_character` − 1) em;
 * - `shear` slants glyphs (x += shear × y above the baseline);
 * - `align_x`: LEFT / CENTER / RIGHT around x = 0; JUSTIFY widens the spaces of every line but the
 *   last, FLUSH widens the gaps between all characters of every line, both to the longest line;
 * - `align_y`: TOP_BASELINE, TOP (line top at 0), CENTER, BOTTOM (last line bottom at 0),
 *   BOTTOM_BASELINE (last baseline at 0);
 * - `offset_x` / `offset_y` move the whole text (object units, not scaled by size).
 *
 * Text lies in the XY plane and faces +Z.
 */

export type TextSettings = Pick<
  CurveData,
  | 'body'
  | 'size'
  | 'space_line'
  | 'space_word'
  | 'space_character'
  | 'shear'
  | 'align_x'
  | 'align_y'
  | 'offset_x'
  | 'offset_y'
>;

export interface PlacedGlyph {
  char: string;
  /** Glyph origin (left end of its baseline) in object space. */
  x: number;
  y: number;
  /** Line number (0 = first). */
  line: number;
  /** Horizontal advance (object units). */
  advance: number;
}

export interface TextLayout {
  glyphs: PlacedGlyph[];
  lineCount: number;
  /** Object units per font unit. */
  scale: number;
  /** Extent of the text's lines from the font metrics (not the ink), object space. */
  bounds: { min: Vec2; max: Vec2 };
}

const ALIGN_X: readonly TextAlignX[] = ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFY', 'FLUSH'];
const ALIGN_Y: readonly TextAlignY[] = ['TOP_BASELINE', 'TOP', 'CENTER', 'BOTTOM', 'BOTTOM_BASELINE'];

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const isSpace = (ch: string) => ch === ' ' || ch === ' ' || ch === '\t';

/** Lays out the text of a FONT datablock (positions of every character, object space). */
export function layoutText(t: TextSettings): TextLayout {
  const size = Math.min(1e4, Math.max(1e-4, Math.abs(finite(t.size, 1))));
  const em = size / FONT_UNITS_PER_EM;
  const spaceWord = Math.max(0, finite(t.space_word, 1));
  const extra = 0.5 * (finite(t.space_character, 1) - 1) * FONT_UNITS_PER_EM;
  const lineDist = finite(t.space_line, 1) * FONT_UNITS_PER_EM;
  const alignX = ALIGN_X.includes(t.align_x) ? t.align_x : 'LEFT';
  const alignY = ALIGN_Y.includes(t.align_y) ? t.align_y : 'TOP_BASELINE';
  const body = typeof t.body === 'string' ? t.body : '';
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  // per line: characters with their advances (font units)
  const rows = lines.map((line) => {
    const chars = [...line].filter((ch) => ch === '\t' || ch >= ' ');
    const adv = chars.map((ch) =>
      ch === '\t' ? 4 * glyphAdvance(' ') * spaceWord : glyphAdvance(ch) * (isSpace(ch) ? spaceWord : 1),
    );
    let width = 0;
    adv.forEach((a, i) => (width += a + (i < adv.length - 1 ? extra : 0)));
    return { chars, adv, width };
  });
  const maxWidth = rows.reduce((m, r) => Math.max(m, r.width), 0);

  let dy = 0;
  const n = rows.length;
  switch (alignY) {
    case 'TOP':
      dy = -FONT_ASCENT;
      break;
    case 'BOTTOM_BASELINE':
      dy = (n - 1) * lineDist;
      break;
    case 'BOTTOM':
      dy = (n - 1) * lineDist + FONT_DESCENT;
      break;
    case 'CENTER':
      dy = -(FONT_ASCENT - (n - 1) * lineDist - FONT_DESCENT) / 2;
      break;
  }
  const ox = finite(t.offset_x, 0);
  const oy = finite(t.offset_y, 0);
  const glyphs: PlacedGlyph[] = [];
  let x0 = Infinity;
  let x1 = -Infinity;
  rows.forEach((row, li) => {
    const count = row.chars.length;
    let start = 0;
    let gapExtra = 0; // added after every character (FLUSH)
    let spaceExtra = 0; // added to every space (JUSTIFY)
    if (alignX === 'CENTER') start = -row.width / 2;
    else if (alignX === 'RIGHT') start = -row.width;
    else if (alignX === 'FLUSH' && count > 1) gapExtra = (maxWidth - row.width) / (count - 1);
    else if (alignX === 'JUSTIFY' && li < n - 1) {
      const spaces = row.chars.slice(0, -1).filter(isSpace).length;
      if (spaces > 0) spaceExtra = (maxWidth - row.width) / spaces;
    }
    const baseline = -li * lineDist + dy;
    let x = start;
    row.chars.forEach((ch, i) => {
      const adv = row.adv[i];
      glyphs.push({ char: ch, x: x * em + ox, y: baseline * em + oy, line: li, advance: adv * em });
      x += adv + extra + gapExtra + (isSpace(ch) && i < count - 1 ? spaceExtra : 0);
    });
    const lineEnd =
      start +
      row.width +
      (count > 1 ? gapExtra * (count - 1) : 0) +
      spaceExtra * row.chars.slice(0, -1).filter(isSpace).length;
    x0 = Math.min(x0, start);
    x1 = Math.max(x1, lineEnd);
  });
  if (!Number.isFinite(x0)) {
    x0 = 0;
    x1 = 0;
  }
  const top = FONT_ASCENT + dy;
  const bottom = -(n - 1) * lineDist + dy - FONT_DESCENT;
  return {
    glyphs,
    lineCount: n,
    scale: em,
    bounds: {
      min: [x0 * em + ox, Math.min(top, bottom) * em + oy],
      max: [x1 * em + ox, Math.max(top, bottom) * em + oy],
    },
  };
}

export interface TextOutline {
  /** Closed glyph contours in object space (outer boundaries counter-clockwise, holes clockwise). */
  contours: Vec2[][];
  /** Index (into the layout's glyphs) of the glyph each contour belongs to. */
  glyph: number[];
  layout: TextLayout;
}

/**
 * Glyph outlines of a FONT datablock's text, laid out and transformed to object space. Arcs use
 * `resolution_u` (`render_resolution_u` when rendering) segments per quarter circle.
 */
export function textOutline(curve: CurveData, forRender = false): TextOutline {
  const layout = layoutText(curve);
  const res = forRender && curve.render_resolution_u > 0 ? curve.render_resolution_u : curve.resolution_u;
  const seg = Math.max(2, Math.min(64, Math.round(finite(res, 12))));
  const shear = finite(curve.shear, 0);
  const em = layout.scale;
  const contours: Vec2[][] = [];
  const glyph: number[] = [];
  layout.glyphs.forEach((g, gi) => {
    if (isSpace(g.char)) return;
    const outline = glyphOutline(g.char, seg);
    for (const c of outline.contours) {
      contours.push(c.map(([x, y]): Vec2 => [g.x + (x + shear * y) * em, g.y + y * em]));
      glyph.push(gi);
    }
  });
  return { contours, glyph, layout };
}
