import type { Vec2 } from '../math/types';
import { difference, intersect, mapShape, polygon, shapeContours, union, type Shape } from './csg2d';

/*
 * The built-in font ("BUILTIN"): an original, monoline geometric sans-serif designed for this
 * editor. Glyphs are constructed from rectangles, strokes, rings and ring sectors that are merged
 * with polygon booleans into clean closed outlines (outer contours counter-clockwise, counters /
 * holes clockwise). Units: 1000 per em, baseline at y = 0, cap height 700, x-height 500,
 * ascenders 740, descenders −220. Covers printable ASCII and common Latin-1 letters and symbols.
 */

export const FONT_UNITS_PER_EM = 1000;
/** Line top above the baseline (font units). */
export const FONT_ASCENT = 750;
/** Line bottom below the baseline (font units). Ascent + descent = one line (1 em). */
export const FONT_DESCENT = 250;
export const FONT_CAP_HEIGHT = 700;
export const FONT_X_HEIGHT = 500;

/** A glyph's outline in font units. */
export interface GlyphOutline {
  /** Horizontal advance (font units). */
  advance: number;
  /** Closed contours: outer boundaries counter-clockwise, holes clockwise. */
  contours: Vec2[][];
}

// ------------------------------------------------------------------ design constants

/** Vertical stem weight. */
const V = 88;
/** Horizontal bar / round top-and-bottom weight (slightly lighter, as usual in geometric types). */
const H = 78;
const CAP = 700;
const XH = 500;
const ASC = 740;
const DESC = -220;
/** Overshoot of round shapes above / below the guides. */
const OV = 12;
const DEG = Math.PI / 180;
const BIG = 5000;

type Pt = [number, number];

/**
 * Point where a line from `p` touches the ellipse (cx, cy, rx, ry): the touching point on the left
 * (`left`) or right of the direction from `p` to the centre (the centre itself if `p` is inside).
 */
function tangentPoint(cx: number, cy: number, rx: number, ry: number, p: Pt, left: boolean): Pt {
  const f = (t: number) => {
    const ex = cx + rx * Math.cos(t) - p[0];
    const ey = cy + ry * Math.sin(t) - p[1];
    return ex * ry * Math.cos(t) + ey * rx * Math.sin(t);
  };
  const N = 720;
  let best: Pt | null = null;
  for (let i = 0; i < N; i++) {
    let a = (i / N) * Math.PI * 2;
    let b = ((i + 1) / N) * Math.PI * 2;
    if (f(a) * f(b) > 0) continue;
    for (let it = 0; it < 60; it++) {
      const m = (a + b) / 2;
      if (f(a) * f(m) <= 0) b = m;
      else a = m;
    }
    const e: Pt = [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    const side = (cx - p[0]) * (e[1] - p[1]) - (cy - p[1]) * (e[0] - p[0]);
    if (side > 0 === left) best = e;
  }
  return best ?? [cx, cy];
}

/** Construction kit bound to an arc resolution (segments per quarter circle). */
class Kit {
  constructor(readonly seg: number) {}

  rect(x0: number, y0: number, x1: number, y1: number): Shape {
    return polygon([
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]);
  }

  poly(...pts: Pt[]): Shape {
    return polygon(pts.map((p): Vec2 => [p[0], p[1]]));
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): Shape {
    const n = this.seg * 4;
    const pts: Vec2[] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const q = k % this.seg === 0 ? (k / this.seg) % 4 : -1;
      // exact values on the axes keep cuts at 0/90/180/270° exact
      const c = q === 0 ? 1 : q === 2 ? -1 : q === 1 || q === 3 ? 0 : Math.cos(a);
      const s = q === 1 ? 1 : q === 3 ? -1 : q === 0 || q === 2 ? 0 : Math.sin(a);
      pts.push([cx + rx * c, cy + ry * s]);
    }
    return polygon(pts);
  }

  dot(cx: number, cy: number, r = 52): Shape {
    return this.ellipse(cx, cy, r, r);
  }

  /** Elliptical ring: `wx` thick at the left/right extremes, `wy` at the top/bottom. */
  ring(cx: number, cy: number, rx: number, ry: number, wx = V, wy = H): Shape {
    return difference(this.ellipse(cx, cy, rx, ry), this.ellipse(cx, cy, rx - wx, ry - wy));
  }

  /** Region swept counter-clockwise from angle a0 to a1 (degrees) around (cx, cy). */
  wedge(cx: number, cy: number, a0: number, a1: number): Shape {
    const pts: Pt[] = [[cx, cy]];
    const steps = Math.max(1, Math.ceil((a1 - a0) / 45));
    for (let i = 0; i <= steps; i++) {
      const a = (a0 + ((a1 - a0) * i) / steps) * DEG;
      pts.push([cx + BIG * Math.cos(a), cy + BIG * Math.sin(a)]);
    }
    return this.poly(...pts);
  }

  /** Ring sector from a0 to a1 degrees (counter-clockwise), cut radially. */
  arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, wx = V, wy = H): Shape {
    return intersect(this.ring(cx, cy, rx, ry, wx, wy), this.wedge(cx, cy, a0, a1));
  }

  /**
   * Monoline wave (tilde): a stroke of width w centred on y = cy + amp·sin(t) for t from t0 to t1
   * (radians), spread over x0..x1, with ends cut square to the stroke.
   */
  wave(
    x0: number,
    x1: number,
    cy: number,
    amp: number,
    w: number,
    t0 = -0.3 * Math.PI,
    t1 = 2.3 * Math.PI,
  ): Shape {
    const n = Math.max(8, this.seg * 4);
    const sx = (x1 - x0) / (t1 - t0);
    const left: Vec2[] = [];
    const right: Vec2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const px = x0 + (t - t0) * sx;
      const py = cy + amp * Math.sin(t);
      const dx = sx;
      const dy = amp * Math.cos(t);
      const l = Math.hypot(dx, dy) || 1;
      const nx = (-dy / l) * (w / 2);
      const ny = (dx / l) * (w / 2);
      left.push([px + nx, py + ny]);
      right.push([px - nx, py - ny]);
    }
    return polygon([...right, ...left.reverse()]);
  }

  /** Straight stroke of width w along a centre line, extended by `ext` beyond both ends. */
  stroke(x0: number, y0: number, x1: number, y1: number, w = V, ext = 0): Shape {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const nx = (-uy * w) / 2;
    const ny = (ux * w) / 2;
    const ax = x0 - ux * ext;
    const ay = y0 - uy * ext;
    const bx = x1 + ux * ext;
    const by = y1 + uy * ext;
    return this.poly([ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]);
  }

  /** Diagonal stroke through two centre points, long enough to be cut flat by `clip`. */
  leg(x0: number, y0: number, x1: number, y1: number, w = V): Shape {
    return this.stroke(x0, y0, x1, y1, w, 400);
  }

  /** Half plane to the left of the directed line a → b. */
  half(a: Pt, b: Pt): Shape {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    const ux = (dx / l) * BIG;
    const uy = (dy / l) * BIG;
    return this.poly(
      [a[0] - ux, a[1] - uy],
      [a[0] + ux, a[1] + uy],
      [a[0] + ux - uy, a[1] + uy + ux],
      [a[0] - ux - uy, a[1] - uy + ux],
    );
  }

  /**
   * Chevron whose arms run from `tip` through `a` and `b`, extended far beyond them (cut with
   * `clip`/`band`).
   */
  fork(tip: Pt, a: Pt, b: Pt, w = V): Shape {
    const far = (p: Pt): Pt => {
      const dx = p[0] - tip[0];
      const dy = p[1] - tip[1];
      const l = Math.hypot(dx, dy) || 1;
      return [tip[0] + (dx / l) * (l + 400), tip[1] + (dy / l) * (l + 400)];
    };
    return this.chevron(tip, far(a), far(b), w);
  }

  /**
   * Stroke of width w whose outer edge runs from `p` to the point where it touches the ellipse
   * (cx, cy, rx, ry) — the tangent on the given side of the line p → centre. The stroke extends far
   * beyond `p` (cut it with `clip`) and ends square at the touching point; it lies on the ellipse's
   * side of the tangent line.
   */
  tangentStroke(cx: number, cy: number, rx: number, ry: number, p: Pt, left: boolean, w = V): Shape {
    const e = tangentPoint(cx, cy, rx, ry, p, left);
    const dx = e[0] - p[0];
    const dy = e[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    // inner normal: towards the centre
    let nx = -uy;
    let ny = ux;
    if ((cx - e[0]) * nx + (cy - e[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const far: Pt = [p[0] - ux * 400, p[1] - uy * 400];
    return this.poly(far, e, [e[0] + nx * w, e[1] + ny * w], [far[0] + nx * w, far[1] + ny * w]);
  }

  clip(s: Shape, x0: number, y0: number, x1: number, y1: number): Shape {
    return intersect(s, this.rect(x0, y0, x1, y1));
  }

  /** Keeps the part of `s` between two heights. */
  band(s: Shape, y0: number, y1: number): Shape {
    return this.clip(s, -BIG, y0, BIG, y1);
  }

  /**
   * Chevron with mitred tip: arms of width w from `tip` to `a` and to `b` (butt ends).
   */
  chevron(tip: Pt, a: Pt, b: Pt, w = V): Shape {
    const off = (p: Pt, q: Pt, s: number): [Pt, Pt] => {
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = (-dy / l) * (w / 2) * s;
      const ny = (dx / l) * (w / 2) * s;
      return [
        [p[0] + nx, p[1] + ny],
        [q[0] + nx, q[1] + ny],
      ];
    };
    const meet = (l1: [Pt, Pt], l2: [Pt, Pt]): Pt => {
      const [p, p2] = l1;
      const [q, q2] = l2;
      const rx = p2[0] - p[0];
      const ry = p2[1] - p[1];
      const sx = q2[0] - q[0];
      const sy = q2[1] - q[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-9) return p;
      const t = ((q[0] - p[0]) * sy - (q[1] - p[1]) * sx) / den;
      return [p[0] + rx * t, p[1] + ry * t];
    };
    // side +1 of arm a faces arm b's side −1 when the turn tip→a→… is consistent; pick by geometry
    const cross = (a[0] - tip[0]) * (b[1] - tip[1]) - (a[1] - tip[1]) * (b[0] - tip[0]);
    const s = cross > 0 ? 1 : -1;
    const aIn = off(tip, a, s);
    const aOut = off(tip, a, -s);
    const bIn = off(tip, b, -s);
    const bOut = off(tip, b, s);
    const inner = meet(aIn, bIn);
    const outer = meet(aOut, bOut);
    return this.poly(outer, aOut[1], aIn[1], inner, bIn[1], bOut[1]);
  }

  /**
   * "D" shaped ring (bowls of B, D, P, R): straight on the left at x0, a half ellipse on the right
   * reaching x1, between heights y0 and y1.
   */
  dRing(x0: number, y0: number, x1: number, y1: number, wx = V, wy = H): Shape {
    const ry = (y1 - y0) / 2;
    const cy = (y0 + y1) / 2;
    const rx = Math.min(ry, x1 - x0);
    const cx = x1 - rx;
    const outer = this.clip(
      union(this.rect(x0, y0, cx, y1), this.ellipse(cx, cy, rx, ry)),
      x0,
      y0 - 1,
      x1 + 1,
      y1 + 1,
    );
    const inner = union(this.rect(x0 - 50, y0 + wy, cx, y1 - wy), this.ellipse(cx, cy, rx - wx, ry - wy));
    return difference(outer, inner);
  }
}

const mirrorX = (s: Shape, axis: number) => mapShape(s, ([x, y]) => [2 * axis - x, y]);
const rotate180 = (s: Shape, cx: number, cy: number) => mapShape(s, ([x, y]) => [2 * cx - x, 2 * cy - y]);

interface GlyphDef {
  adv: number;
  draw?: (k: Kit) => Shape;
}

// ------------------------------------------------------------------ shared letter parts

/** Lowercase bowl (o-shape) centred at cx. */
const BOWL_RX = 236;
const BOWL_RY = 250 + OV;
const bowl = (k: Kit, cx: number) => k.ring(cx, 250, BOWL_RX, BOWL_RY);

/** Geometric S between heights (top, bottom), centred at cx; rt/rb = half widths of the two arcs. */
function sShape(
  k: Kit,
  cx: number,
  bottom: number,
  top: number,
  rt: number,
  rb: number,
  w = V,
  h = H,
): Shape {
  // the two arcs share a horizontal spine: ryTop + ryBot = (height + h) / 2
  const height = top - bottom;
  const ryTop = Math.round(((height + h) / 2) * 0.472);
  const ryBot = (height + h) / 2 - ryTop;
  const cyTop = top - ryTop;
  const cyBot = bottom + ryBot;
  return union(k.arc(cx, cyTop, rt, ryTop, 28, 270, w, h), k.arc(cx, cyBot, rb, ryBot, -148, 90, w, h));
}

/** Arch of n/h/m: half ring from the left stem edge x0 to the right edge x1, top at the x-height. */
function arch(k: Kit, x0: number, x1: number, cy: number): Shape {
  const rx = (x1 - x0) / 2;
  return k.arc(x0 + rx, cy, rx, XH + OV - cy, 0, 180);
}

/** Figure 6: a bowl with a straight stroke touching its left side, rising to the upper right. */
function six(k: Kit): Shape {
  const cy = 240;
  const ry = cy + OV;
  return union(
    k.ring(300, cy, 236, ry),
    difference(
      k.clip(k.tangentStroke(300, cy, 236, ry, [440, CAP], false, V + 4), -BIG, -BIG, BIG, CAP),
      k.ellipse(300, cy, 236 - V, ry - H),
    ),
  );
}

// accents (cx = horizontal centre, base = bottom of the accent)
const acute = (k: Kit, cx: number, base: number) =>
  k.band(k.leg(cx - 45, base - 10, cx + 70, base + 160, 72), base, base + 150);
const grave = (k: Kit, cx: number, base: number) =>
  k.band(k.leg(cx + 45, base - 10, cx - 70, base + 160, 72), base, base + 150);
const circumflex = (k: Kit, cx: number, base: number) =>
  k.chevron([cx, base + 150], [cx - 120, base], [cx + 120, base], 70);
/** Two dots; `narrow` letters (i, I) get closer, smaller dots that stay within their advance. */
const diaeresis = (k: Kit, cx: number, base: number, narrow = false) => {
  const d = narrow ? 76 : 100;
  const r = narrow ? 44 : 50;
  return union(k.dot(cx - d, base + 50, r), k.dot(cx + d, base + 50, r));
};
const ringAccent = (k: Kit, cx: number, base: number) => k.ring(cx, base + 80, 78, 78, 52, 52);
const tildeAccent = (k: Kit, cx: number, base: number) =>
  k.wave(cx - 120, cx + 120, base + 58, 28, 54, -0.2 * Math.PI, 2.2 * Math.PI);
/**
 * Cedilla hanging from the baseline at cx: a short stem turning into a hook that curls back left
 * (the hook's cut end is flush with the stem's right edge).
 */
const cedilla = (k: Kit, cx: number) =>
  union(k.rect(cx - 26, -110, cx + 20, 10), k.arc(cx + 20, -134, 78, 66, -150, 90, 48, 42));

/**
 * Left parenthesis: the left half of a tall elliptical ring, cut flat above the capitals and below
 * the baseline.
 */
const paren = (k: Kit) => k.band(k.clip(k.ring(350, 305, 260, 520, 84, 40), -BIG, -BIG, 350, BIG), -150, 760);

// ------------------------------------------------------------------ glyph table

const G: Record<string, GlyphDef> = {
  ' ': { adv: 260 },
  '\u00a0': { adv: 260 }, // no-break space

  // ---------------------------------------------------------------- uppercase
  A: {
    adv: 680,
    draw: (k) =>
      k.band(
        union(k.leg(88, 0, 340, CAP, V), k.leg(592, 0, 340, CAP, V), k.rect(160, 180, 520, 180 + H)),
        0,
        CAP,
      ),
  },
  B: {
    adv: 620,
    draw: (k) => union(k.rect(80, 0, 80 + V, CAP), k.dRing(80, 311, 510, CAP), k.dRing(80, 0, 550, 389)),
  },
  C: {
    adv: 700,
    draw: (k) => difference(k.ring(375, 350, 325, 350 + OV), k.wedge(375, 350, -42, 42)),
  },
  D: { adv: 690, draw: (k) => union(k.rect(80, 0, 80 + V, CAP), k.dRing(80, 0, 640, CAP)) },
  E: {
    adv: 570,
    draw: (k) =>
      union(
        k.rect(80, 0, 80 + V, CAP),
        k.rect(80, CAP - H, 520, CAP),
        k.rect(80, 311, 480, 389),
        k.rect(80, 0, 520, H),
      ),
  },
  F: {
    adv: 540,
    draw: (k) => union(k.rect(80, 0, 80 + V, CAP), k.rect(80, CAP - H, 510, CAP), k.rect(80, 311, 470, 389)),
  },
  G: {
    adv: 740,
    draw: (k) =>
      union(
        difference(k.ring(380, 350, 325, 350 + OV), k.wedge(380, 350, 0, 44)),
        // the bar ends flush with the round outline
        intersect(k.rect(400, 350 - H, 705, 350), k.ellipse(380, 350, 325, 350 + OV)),
      ),
  },
  H: {
    adv: 690,
    draw: (k) => union(k.rect(80, 0, 80 + V, CAP), k.rect(522, 0, 610, CAP), k.rect(120, 311, 570, 389)),
  },
  I: { adv: 248, draw: (k) => k.rect(80, 0, 80 + V, CAP) },
  J: {
    adv: 480,
    draw: (k) => union(k.rect(320, 240, 408, CAP), k.arc(214, 240, 194, 240 + OV, 195, 360)),
  },
  K: {
    adv: 630,
    draw: (k) =>
      union(
        k.rect(80, 0, 80 + V, CAP),
        k.clip(k.fork([126, 300], [550, CAP], [530, 0], V + 2), 80, 0, BIG, CAP),
      ),
  },
  L: { adv: 530, draw: (k) => union(k.rect(80, 0, 80 + V, CAP), k.rect(80, 0, 500, H)) },
  M: {
    adv: 830,
    draw: (k) =>
      k.band(
        union(
          k.rect(80, 0, 80 + V, CAP),
          k.rect(662, 0, 750, CAP),
          k.leg(130, CAP, 415, 0, V),
          k.leg(700, CAP, 415, 0, V),
        ),
        0,
        CAP,
      ),
  },
  N: {
    adv: 690,
    draw: (k) =>
      k.band(
        union(k.rect(80, 0, 80 + V, CAP), k.rect(522, 0, 610, CAP), k.leg(132, CAP, 558, 0, V + 6)),
        0,
        CAP,
      ),
  },
  O: { adv: 770, draw: (k) => k.ring(385, 350, 335, 350 + OV) },
  P: { adv: 600, draw: (k) => union(k.rect(80, 0, 80 + V, CAP), k.dRing(80, 290, 550, CAP)) },
  Q: {
    adv: 770,
    draw: (k) =>
      union(k.ring(385, 350, 335, 350 + OV), k.clip(k.stroke(470, 196, 760, -110, V), -BIG, -50, BIG, BIG)),
  },
  R: {
    adv: 630,
    draw: (k) =>
      union(
        k.rect(80, 0, 80 + V, CAP),
        k.dRing(80, 290, 550, CAP),
        k.band(k.leg(318, 330, 556, 0, V + 4), 0, 326),
      ),
  },
  S: { adv: 590, draw: (k) => sShape(k, 295, -OV, CAP + OV, 190, 212) },
  T: { adv: 580, draw: (k) => union(k.rect(30, CAP - H, 550, CAP), k.rect(246, 0, 334, CAP)) },
  U: {
    adv: 680,
    draw: (k) =>
      union(
        k.rect(80, 260, 80 + V, CAP),
        k.rect(512, 260, 600, CAP),
        k.arc(340, 260, 260, 260 + OV, 180, 360),
      ),
  },
  V: { adv: 660, draw: (k) => k.band(union(k.leg(86, CAP, 330, 0, V), k.leg(574, CAP, 330, 0, V)), 0, CAP) },
  W: {
    adv: 950,
    draw: (k) =>
      k.band(
        union(
          k.leg(76, CAP, 255, 0, V),
          k.leg(475, CAP, 255, 0, V),
          k.leg(475, CAP, 695, 0, V),
          k.leg(874, CAP, 695, 0, V),
        ),
        0,
        CAP,
      ),
  },
  X: { adv: 640, draw: (k) => k.band(union(k.leg(94, CAP, 546, 0, V), k.leg(546, CAP, 94, 0, V)), 0, CAP) },
  Y: {
    adv: 630,
    draw: (k) =>
      union(k.band(k.fork([315, 330], [86, CAP], [544, CAP], V), 290, CAP), k.rect(271, 0, 359, 320)),
  },
  Z: {
    adv: 610,
    draw: (k) =>
      union(
        k.rect(60, CAP - H, 545, CAP),
        k.rect(50, 0, 555, H),
        k.clip(k.leg(510, CAP - H / 2, 95, H / 2, V + 8), 50, 0, 555, CAP),
      ),
  },

  // ---------------------------------------------------------------- lowercase
  a: { adv: 586, draw: (k) => union(bowl(k, 278), k.rect(278 + BOWL_RX - V, 0, 278 + BOWL_RX, XH)) },
  b: { adv: 586, draw: (k) => union(bowl(k, 308), k.rect(308 - BOWL_RX, 0, 308 - BOWL_RX + V, ASC)) },
  c: { adv: 540, draw: (k) => difference(bowl(k, 286), k.wedge(286, 250, -48, 48)) },
  d: { adv: 586, draw: (k) => union(bowl(k, 278), k.rect(278 + BOWL_RX - V, 0, 278 + BOWL_RX, ASC)) },
  e: {
    adv: 566,
    draw: (k) => {
      const cx = 283;
      const yb = 250 - H / 2;
      const cut = intersect(k.wedge(cx, 250, -44, 0), k.rect(-BIG, -BIG, BIG, yb));
      return union(difference(bowl(k, cx), cut), k.rect(cx - BOWL_RX + 20, yb, cx + BOWL_RX - 10, yb + H));
    },
  },
  f: {
    adv: 340,
    draw: (k) =>
      union(
        k.rect(80, 0, 80 + V, 600),
        k.arc(230, 600, 150, ASC + OV - 600, 38, 180),
        k.rect(24, XH - H, 300, XH),
      ),
  },
  g: {
    adv: 586,
    draw: (k) =>
      union(
        bowl(k, 278),
        k.rect(278 + BOWL_RX - V, -60, 278 + BOWL_RX, XH),
        k.arc(278, -60, BOWL_RX, -60 - DESC + OV, 200, 360),
      ),
  },
  h: {
    adv: 570,
    draw: (k) => union(k.rect(76, 0, 76 + V, ASC), arch(k, 76, 496, 280), k.rect(496 - V, 0, 496, 280)),
  },
  i: { adv: 240, draw: (k) => union(k.rect(76, 0, 76 + V, XH), k.dot(120, 650)) },
  j: {
    adv: 240,
    draw: (k) =>
      union(k.rect(76, -80, 76 + V, XH), k.arc(-10, -80, 174, 140 + OV, 245, 360), k.dot(120, 650)),
  },
  k: {
    adv: 520,
    draw: (k) =>
      union(
        k.rect(76, 0, 76 + V, ASC),
        k.clip(k.fork([120, 214], [440, XH], [426, 0], V + 2), 76, 0, BIG, XH),
      ),
  },
  l: { adv: 240, draw: (k) => k.rect(76, 0, 76 + V, ASC) },
  m: {
    adv: 880,
    draw: (k) =>
      union(
        k.rect(76, 0, 76 + V, XH),
        arch(k, 76, 476, 290),
        k.rect(476 - V, 0, 476, 290),
        arch(k, 476 - V, 876 - V, 290),
        k.rect(876 - 2 * V, 0, 876 - V, 290),
      ),
  },
  n: {
    adv: 570,
    draw: (k) => union(k.rect(76, 0, 76 + V, XH), arch(k, 76, 496, 280), k.rect(496 - V, 0, 496, 280)),
  },
  o: { adv: 566, draw: (k) => bowl(k, 283) },
  p: { adv: 586, draw: (k) => union(bowl(k, 308), k.rect(308 - BOWL_RX, DESC, 308 - BOWL_RX + V, XH)) },
  q: { adv: 586, draw: (k) => union(bowl(k, 278), k.rect(278 + BOWL_RX - V, DESC, 278 + BOWL_RX, XH)) },
  r: { adv: 370, draw: (k) => union(k.rect(76, 0, 76 + V, XH), k.arc(286, 250, 210, 250 + OV, 72, 180)) },
  s: { adv: 470, draw: (k) => sShape(k, 235, -OV, XH + OV, 150, 168, 82, 72) },
  t: { adv: 350, draw: (k) => union(k.rect(110, 0, 110 + V, 650), k.rect(30, XH - H, 320, XH)) },
  u: {
    adv: 570,
    draw: (k) =>
      union(
        k.rect(496 - V, 0, 496, XH),
        k.rect(76, 220, 76 + V, XH),
        k.arc(286, 220, 210, 220 + OV, 180, 360),
      ),
  },
  v: { adv: 530, draw: (k) => k.band(union(k.leg(84, XH, 265, 0, V), k.leg(446, XH, 265, 0, V)), 0, XH) },
  w: {
    adv: 800,
    draw: (k) =>
      k.band(
        union(
          k.leg(72, XH, 220, 0, V),
          k.leg(400, XH, 220, 0, V),
          k.leg(400, XH, 580, 0, V),
          k.leg(728, XH, 580, 0, V),
        ),
        0,
        XH,
      ),
  },
  x: { adv: 520, draw: (k) => k.band(union(k.leg(88, XH, 432, 0, V), k.leg(432, XH, 88, 0, V)), 0, XH) },
  y: {
    adv: 530,
    draw: (k) =>
      k.band(
        union(
          intersect(k.leg(84, XH, 266, 10, V), k.half([136, DESC], [446, XH])),
          k.leg(446, XH, 136, DESC, V),
        ),
        DESC,
        XH,
      ),
  },
  z: {
    adv: 500,
    draw: (k) =>
      union(
        k.rect(56, XH - H, 444, XH),
        k.rect(46, 0, 454, H),
        k.clip(k.leg(415, XH - H / 2, 86, H / 2, V + 8), 46, 0, 454, XH),
      ),
  },

  // ---------------------------------------------------------------- figures (tabular, 600 wide)
  '0': { adv: 600, draw: (k) => k.ring(300, 350, 240, 350 + OV) },
  '1': {
    adv: 600,
    draw: (k) =>
      union(k.rect(300, 0, 388, CAP), k.clip(k.stroke(340, CAP - 20, 156, 548, V, 0), -BIG, -BIG, 388, CAP)),
  },
  '2': {
    adv: 600,
    draw: (k) => {
      const ry = CAP + OV - 512;
      return union(
        k.arc(300, 512, 222, ry, -60, 168),
        difference(
          k.clip(k.tangentStroke(300, 512, 222, ry, [70, 0], false, V + 6), 74, 0, BIG, CAP),
          k.ellipse(300, 512, 222 - V, ry - H),
        ),
        k.rect(74, 0, 530, H),
      );
    },
  },
  '3': {
    adv: 600,
    draw: (k) => union(k.arc(296, 525, 204, CAP + OV - 525, -90, 152), k.arc(296, 202, 226, 214, -152, 90)),
  },
  '4': {
    adv: 600,
    draw: (k) =>
      union(
        k.rect(400, 0, 488, CAP),
        k.rect(50, 170, 560, 170 + H),
        k.clip(k.leg(452, CAP, 74, 210, V + 4), 50, 170, 488, CAP),
      ),
  },
  '5': {
    adv: 600,
    draw: (k) =>
      union(
        k.rect(150, CAP - H, 520, CAP),
        // the stem's foot follows the bowl's outline so the junction has no step
        intersect(
          k.rect(150, 340, 150 + V, CAP),
          union(k.rect(-BIG, 418, BIG, BIG), k.ellipse(300, 232, 232, 232 + OV)),
        ),
        k.arc(300, 232, 232, 232 + OV, -146, 130),
      ),
  },
  '6': { adv: 600, draw: (k) => six(k) },
  '7': {
    adv: 600,
    draw: (k) =>
      union(k.rect(60, CAP - H, 540, CAP), k.clip(k.leg(500, CAP - 40, 186, 0, V + 8), -BIG, 0, 540, CAP)),
  },
  '8': {
    adv: 600,
    draw: (k) => union(k.ring(300, 527, 196, CAP + OV - 527), k.ring(300, 200, 224, 200 + OV)),
  },
  '9': { adv: 600, draw: (k) => rotate180(six(k), 300, 350) },

  // ---------------------------------------------------------------- punctuation and symbols
  '!': { adv: 260, draw: (k) => union(k.rect(86, 220, 86 + V, CAP), k.dot(130, 52)) },
  '"': { adv: 380, draw: (k) => union(k.rect(80, 470, 160, CAP), k.rect(220, 470, 300, CAP)) },
  '#': {
    adv: 680,
    draw: (k) =>
      k.clip(
        union(
          k.leg(240, 0, 300, CAP, 78),
          k.leg(420, 0, 480, CAP, 78),
          k.rect(80, 210, 620, 210 + 76),
          k.rect(100, 420, 640, 420 + 76),
        ),
        40,
        0,
        680,
        CAP,
      ),
  },
  $: { adv: 590, draw: (k) => union(sShape(k, 295, -OV, CAP + OV, 190, 212), k.rect(256, -90, 334, 790)) },
  '%': {
    adv: 820,
    draw: (k) =>
      union(
        k.ring(190, 540, 128, 160, 72, 66),
        k.ring(630, 160, 128, 160, 72, 66),
        k.band(k.leg(170, 0, 650, CAP, 80), 0, CAP),
      ),
  },
  '&': {
    adv: 720,
    draw: (k) => {
      // a loop on top, a leg leaving the loop's lower left tangentially for the baseline, and a bowl
      // whose upper end joins the leg and which curls round to a tail on the right
      const lx = 284;
      const ly = 552;
      const lrx = 118;
      const lry = CAP + OV - ly;
      const p: Pt = [590, 0];
      const w = V + 4;
      const e = tangentPoint(lx, ly, lrx, lry, p, true);
      const ul = Math.hypot(e[0] - p[0], e[1] - p[1]) || 1;
      let nx = -(e[1] - p[1]) / ul;
      let ny = (e[0] - p[0]) / ul;
      if ((lx - e[0]) * nx + (ly - e[1]) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      // signed distance from the leg's centre line
      const dist = (q: Pt) => (q[0] - p[0] - (nx * w) / 2) * nx + (q[1] - p[1] - (ny * w) / 2) * ny;
      const bx = 298;
      const by = 212;
      const brx = 226;
      const bry = by + OV;
      const mid = (a: number): Pt => [
        bx + (brx - V / 2) * Math.cos(a * DEG),
        by + (bry - H / 2) * Math.sin(a * DEG),
      ];
      // the bowl's upper end is centred on the leg (first crossing going up its left side), so the
      // cut end is hidden inside the leg
      let a1 = 180;
      while (a1 > 30 && dist(mid(a1 - 2)) * dist(mid(180)) > 0) a1 -= 2;
      let a0 = a1 - 2;
      for (let i = 0; i < 30; i++) {
        const m = (a0 + a1) / 2;
        if (dist(mid(a0)) * dist(mid(m)) <= 0) a1 = m;
        else a0 = m;
      }
      const leg = difference(
        k.clip(k.tangentStroke(lx, ly, lrx, lry, p, true, w), -BIG, 0, BIG, BIG),
        k.ellipse(lx, ly, lrx - 78, lry - 72),
      );
      return union(k.ring(lx, ly, lrx, lry, 78, 72), leg, k.arc(bx, by, brx, bry, (a0 + a1) / 2, 394));
    },
  },
  "'": { adv: 220, draw: (k) => k.rect(70, 470, 150, CAP) },
  '(': { adv: 330, draw: (k) => paren(k) },
  ')': { adv: 330, draw: (k) => mirrorX(paren(k), 165) },
  '*': {
    adv: 500,
    draw: (k) =>
      union(
        k.stroke(250, 430, 250, 690, 72),
        k.stroke(250 - 112.6, 495, 250 + 112.6, 625, 72),
        k.stroke(250 - 112.6, 625, 250 + 112.6, 495, 72),
      ),
  },
  '+': { adv: 600, draw: (k) => union(k.rect(261, 130, 339, 530), k.rect(100, 291, 500, 369)) },
  ',': { adv: 250, draw: (k) => k.poly([82, 104], [182, 104], [112, -130], [40, -130]) },
  '-': { adv: 380, draw: (k) => k.rect(60, 222, 320, 300) },
  '.': { adv: 250, draw: (k) => k.dot(125, 52) },
  '/': { adv: 430, draw: (k) => k.band(k.leg(45, -120, 385, 780, 80), -120, 780) },
  ':': { adv: 250, draw: (k) => union(k.dot(125, 52), k.dot(125, 448)) },
  ';': {
    adv: 250,
    draw: (k) => union(k.dot(125, 448), k.poly([82, 104], [182, 104], [112, -130], [40, -130])),
  },
  '<': { adv: 600, draw: (k) => k.chevron([96, 330], [510, 560], [510, 100], 82) },
  '=': { adv: 600, draw: (k) => union(k.rect(100, 200, 500, 278), k.rect(100, 382, 500, 460)) },
  '>': { adv: 600, draw: (k) => k.chevron([504, 330], [90, 100], [90, 560], 82) },
  '?': {
    adv: 520,
    draw: (k) =>
      union(
        k.arc(260, 520, 204, CAP + OV - 520, -90, 162),
        k.rect(260 - V, 220, 260, 520 - (CAP + OV - 520) + H),
        k.dot(216, 52),
      ),
  },
  '@': {
    adv: 960,
    draw: (k) =>
      union(
        k.ring(455, 320, 160, 170, 76, 70),
        k.rect(455 + 160 - 76, 150, 455 + 160, 490),
        k.arc(680, 150, 140, 150, 180, 360, 76, 70),
        k.arc(480, 300, 420, 430, 0, 300, 76, 70),
        k.arc(480, 300, 420, 430, -60, 0, 76, 70),
      ),
  },
  '[': {
    adv: 330,
    draw: (k) => union(k.rect(96, -150, 176, 770), k.rect(96, -150, 270, -72), k.rect(96, 692, 270, 770)),
  },
  '\\': { adv: 430, draw: (k) => k.band(k.leg(385, -120, 45, 780, 80), -120, 780) },
  ']': {
    adv: 330,
    draw: (k) =>
      mirrorX(union(k.rect(96, -150, 176, 770), k.rect(96, -150, 270, -72), k.rect(96, 692, 270, 770)), 165),
  },
  '^': { adv: 560, draw: (k) => k.chevron([280, CAP], [64, 380], [496, 380], 80) },
  _: { adv: 520, draw: (k) => k.rect(0, -170, 520, -92) },
  '`': { adv: 320, draw: (k) => grave(k, 160, 580) },
  '{': {
    adv: 350,
    draw: (k) =>
      union(
        k.arc(286, 650, 110, 120, 90, 180, 80, 80),
        k.rect(176, 392, 256, 650),
        k.arc(76, 392, 180, 90, 270, 360, 80, 74),
        k.arc(76, 228, 180, 90, 0, 90, 80, 74),
        k.rect(176, -30, 256, 228),
        k.arc(286, -30, 110, 120, 180, 270, 80, 80),
      ),
  },
  '|': { adv: 280, draw: (k) => k.rect(101, -200, 179, 780) },
  '}': {
    adv: 350,
    draw: (k) =>
      mirrorX(
        union(
          k.arc(286, 650, 110, 120, 90, 180, 80, 80),
          k.rect(176, 392, 256, 650),
          k.arc(76, 392, 180, 90, 270, 360, 80, 74),
          k.arc(76, 228, 180, 90, 0, 90, 80, 74),
          k.rect(176, -30, 256, 228),
          k.arc(286, -30, 110, 120, 180, 270, 80, 80),
        ),
        175,
      ),
  },
  '~': { adv: 600, draw: (k) => k.wave(90, 510, 310, 46, 72, -0.2 * Math.PI, 2.2 * Math.PI) },
};

// ------------------------------------------------------------------ Latin-1 additions

const LOWER_ACCENT = 570;
const UPPER_ACCENT = 765;
type AccentFn = (k: Kit, cx: number, base: number, narrow?: boolean) => Shape;
const ACCENTS: Record<string, AccentFn> = {
  grave,
  acute,
  circumflex,
  tilde: tildeAccent,
  diaeresis,
  ring: ringAccent,
};

/** Base letter, accent and accent centre (x) of the accented letters. */
const COMPOSITES: Record<string, [string, string, number]> = {
  À: ['A', 'grave', 340],
  Á: ['A', 'acute', 340],
  Â: ['A', 'circumflex', 340],
  Ã: ['A', 'tilde', 340],
  Ä: ['A', 'diaeresis', 340],
  Å: ['A', 'ring', 340],
  È: ['E', 'grave', 300],
  É: ['E', 'acute', 300],
  Ê: ['E', 'circumflex', 300],
  Ë: ['E', 'diaeresis', 300],
  Ì: ['I', 'grave', 124],
  Í: ['I', 'acute', 124],
  Î: ['I', 'circumflex', 124],
  Ï: ['I', 'diaeresis', 124],
  Ñ: ['N', 'tilde', 345],
  Ò: ['O', 'grave', 385],
  Ó: ['O', 'acute', 385],
  Ô: ['O', 'circumflex', 385],
  Õ: ['O', 'tilde', 385],
  Ö: ['O', 'diaeresis', 385],
  Ù: ['U', 'grave', 340],
  Ú: ['U', 'acute', 340],
  Û: ['U', 'circumflex', 340],
  Ü: ['U', 'diaeresis', 340],
  Ý: ['Y', 'acute', 315],
  à: ['a', 'grave', 278],
  á: ['a', 'acute', 278],
  â: ['a', 'circumflex', 278],
  ã: ['a', 'tilde', 278],
  ä: ['a', 'diaeresis', 278],
  å: ['a', 'ring', 278],
  è: ['e', 'grave', 283],
  é: ['e', 'acute', 283],
  ê: ['e', 'circumflex', 283],
  ë: ['e', 'diaeresis', 283],
  ì: ['ı', 'grave', 120],
  í: ['ı', 'acute', 120],
  î: ['ı', 'circumflex', 120],
  ï: ['ı', 'diaeresis', 120],
  ñ: ['n', 'tilde', 286],
  ò: ['o', 'grave', 283],
  ó: ['o', 'acute', 283],
  ô: ['o', 'circumflex', 283],
  õ: ['o', 'tilde', 283],
  ö: ['o', 'diaeresis', 283],
  ù: ['u', 'grave', 286],
  ú: ['u', 'acute', 286],
  û: ['u', 'circumflex', 286],
  ü: ['u', 'diaeresis', 286],
  ý: ['y', 'acute', 265],
  ÿ: ['y', 'diaeresis', 265],
};

Object.assign(G, {
  ı: { adv: 240, draw: (k: Kit) => k.rect(76, 0, 76 + V, XH) },
  Ç: { adv: 700, draw: (k: Kit) => union(G.C.draw!(k), cedilla(k, 375)) },
  ç: { adv: 540, draw: (k: Kit) => union(G.c.draw!(k), cedilla(k, 286)) },
  ß: {
    adv: 600,
    draw: (k: Kit) =>
      union(
        k.rect(76, 0, 76 + V, 560),
        k.arc(262, 560, 186, ASC + OV - 560, -90, 180),
        k.arc(262, 217, 240, 229, -136, 90),
      ),
  },
  Ø: {
    adv: 770,
    draw: (k: Kit) => union(k.ring(385, 350, 335, 350 + OV), k.band(k.leg(120, -40, 650, 740, 76), -40, 740)),
  },
  ø: { adv: 566, draw: (k: Kit) => union(bowl(k, 283), k.band(k.leg(70, -40, 496, 540, 70), -40, 540)) },
  Æ: {
    adv: 940,
    draw: (k: Kit) =>
      union(
        k.band(union(k.leg(88, 0, 470, CAP, V), k.rect(170, 180, 520, 180 + H)), 0, CAP),
        k.rect(440, 0, 440 + V, CAP),
        k.rect(440, CAP - H, 890, CAP),
        k.rect(440, 311, 850, 389),
        k.rect(440, 0, 890, H),
      ),
  },
  æ: {
    adv: 900,
    draw: (k: Kit) => {
      const cx = 617;
      const yb = 250 - H / 2;
      const cut = intersect(k.wedge(cx, 250, -44, 0), k.rect(-BIG, -BIG, BIG, yb));
      return union(
        bowl(k, 278),
        k.rect(278 + BOWL_RX - V, 0, 278 + BOWL_RX, XH),
        difference(bowl(k, cx), cut, k.rect(-BIG, -BIG, 470, BIG)),
        k.rect(cx - BOWL_RX + 20, yb, cx + BOWL_RX - 10, yb + H),
      );
    },
  },
  '°': { adv: 360, draw: (k: Kit) => k.ring(180, 590, 104, 104, 62, 62) },
  '·': { adv: 250, draw: (k: Kit) => k.dot(125, 330) },
  '×': {
    adv: 600,
    draw: (k: Kit) => union(k.stroke(160, 190, 440, 470, 76), k.stroke(160, 470, 440, 190, 76)),
  },
  '÷': {
    adv: 600,
    draw: (k: Kit) => union(k.rect(100, 291, 500, 369), k.dot(300, 160, 50), k.dot(300, 500, 50)),
  },
  '±': {
    adv: 600,
    draw: (k: Kit) =>
      union(k.rect(261, 210, 339, 590), k.rect(100, 361, 500, 439), k.rect(100, 40, 500, 118)),
  },
  '¡': { adv: 260, draw: (k: Kit) => rotate180(G['!'].draw!(k), 130, 250) },
  '¿': { adv: 520, draw: (k: Kit) => rotate180(G['?'].draw!(k), 260, 250) },
  '«': {
    adv: 560,
    draw: (k: Kit) =>
      union(
        k.chevron([60, 260], [250, 440], [250, 80], 74),
        k.chevron([280, 260], [470, 440], [470, 80], 74),
      ),
  },
  '»': {
    adv: 560,
    draw: (k: Kit) =>
      union(k.chevron([500, 260], [310, 80], [310, 440], 74), k.chevron([280, 260], [90, 80], [90, 440], 74)),
  },
  '©': {
    adv: 860,
    draw: (k: Kit) =>
      union(
        k.ring(430, 350, 380, 380, 62, 62),
        difference(k.ring(440, 350, 190, 200, 70, 64), k.wedge(440, 350, -45, 45)),
      ),
  },
  '®': {
    adv: 860,
    draw: (k: Kit) =>
      union(
        k.ring(430, 350, 380, 380, 62, 62),
        k.rect(300, 170, 368, 540),
        k.dRing(300, 330, 560, 540, 68, 62),
        k.band(k.leg(440, 340, 560, 170, 70), 170, 380),
      ),
  },
  '€': {
    adv: 680,
    draw: (k: Kit) =>
      union(
        difference(k.ring(400, 350, 300, 350 + OV), k.wedge(400, 350, -40, 40)),
        k.rect(40, 400, 480, 470),
        k.rect(40, 240, 450, 310),
      ),
  },
  '£': {
    adv: 620,
    draw: (k: Kit) =>
      union(
        k.arc(340, 520, 190, CAP + OV - 520, 0, 180),
        k.rect(150, 90, 238, 520),
        k.rect(60, 300, 420, 370),
        k.rect(60, 0, 560, H),
        k.clip(k.leg(194, 80, 120, 0, V), 60, 0, BIG, 120),
      ),
  },
  '¢': {
    adv: 540,
    draw: (k: Kit) =>
      union(difference(bowl(k, 286), k.wedge(286, 250, -48, 48)), k.rect(250, -100, 322, 600)),
  },
  '§': {
    adv: 560,
    draw: (k: Kit) => {
      // a middle loop with an S-like hook above (open to the lower right) and its 180° turn below; the
      // hooks' cut ends lie inside the loop's stroke
      const hook = k.arc(280, 566, 150, CAP + OV - 566, -35, 270, 76, 60);
      return union(k.ring(280, 330, 165, 155, 76, 68), hook, rotate180(hook, 280, 330));
    },
  },
  '¶': {
    adv: 600,
    draw: (k: Kit) =>
      union(
        k.ellipse(280, 520, 180, 180),
        k.rect(280, 340, 460, 700),
        k.rect(380, -100, 456, 700),
        k.rect(500, -100, 576, 700),
      ),
  },
  µ: {
    adv: 586,
    draw: (k: Kit) =>
      union(
        k.rect(496 - V, 0, 496, XH),
        k.rect(76, DESC, 76 + V, XH),
        k.arc(286, 220, 210, 220 + OV, 180, 360),
      ),
  },
});

for (const [ch, [base, accent, cx]] of Object.entries(COMPOSITES)) {
  const upper = base === base.toUpperCase() && base !== 'ı';
  G[ch] = {
    adv: G[base].adv,
    draw: (k) =>
      union(G[base].draw!(k), ACCENTS[accent](k, cx, upper ? UPPER_ACCENT : LOWER_ACCENT, G[base].adv < 300)),
  };
}

/** The "missing glyph" box. */
const NOTDEF: GlyphDef = {
  adv: 560,
  draw: (k) => difference(k.rect(70, 0, 490, CAP), k.rect(70 + 70, 70, 490 - 70, CAP - 70)),
};

// ------------------------------------------------------------------ public API

const cache = new Map<string, GlyphOutline>();

/** Whether the built-in font has a glyph (or a blank advance, like the space) for a character. */
export function hasGlyph(ch: string): boolean {
  return ch in G;
}

/** Characters with a glyph in the built-in font. */
export function fontCharacters(): string[] {
  return Object.keys(G);
}

/** Horizontal advance of a character (font units); missing characters use the box's advance. */
export function glyphAdvance(ch: string): number {
  return (G[ch] ?? NOTDEF).adv;
}

/**
 * Outline of a character at an arc resolution of `segments` per quarter circle (2..64). Missing
 * printable characters give a hollow box; whitespace has no contours. Results are cached.
 */
export function glyphOutline(ch: string, segments = 12): GlyphOutline {
  const seg = Math.max(2, Math.min(64, Math.round(Number.isFinite(segments) ? segments : 12)));
  const key = `${ch}\u0000${seg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const def = G[ch] ?? NOTDEF;
  let contours: Vec2[][] = [];
  if (def.draw) {
    try {
      contours = shapeContours(def.draw(new Kit(seg)));
    } catch {
      contours = [];
    }
  }
  const out: GlyphOutline = { advance: def.adv, contours };
  if (cache.size > 4000) cache.clear();
  cache.set(key, out);
  return out;
}
