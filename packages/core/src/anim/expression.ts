/*
 * Safe expression language for drivers: a small, sandboxed subset of Python expressions (the
 * language of Blender's "Scripted Expression" drivers). A source is tokenised, parsed into an AST
 * and compiled into closures once (cached by source text). Nothing is ever handed to `eval` or
 * `Function`, and names are only looked up in `Map`s, so object prototypes are unreachable.
 *
 * Grammar, lowest to highest precedence (Python semantics unless noted):
 *
 *   a if cond else b       conditional (right associative); C style `cond ? a : b` also works
 *   a or b, a || b         short-circuit, yields an operand (`0 or 5` = 5)
 *   a and b, a && b        short-circuit, yields an operand
 *   not a                  1 when a == 0, else 0
 *   a < b <= c == d != e   comparisons, chained like Python (`a < b < c` = `a < b and b < c`)
 *   a + b, a - b
 *   a * b, a / b, a // b, a % b   true division, floor division, floored modulo (sign of b)
 *   -a, +a, !a             unary (`!` binds tightly like in C, `not` loosely like in Python)
 *   a ** b                 power, right associative; binds tighter than a unary minus on its left
 *                          (`-2**2` = -4) and accepts one on its right (`2**-1` = 0.5)
 *   number, name, f(args), (expr)
 *
 * Values are IEEE doubles; booleans are numbers (True = 1, False = 0). Like Python, division or
 * modulo by zero and math domain errors (sqrt(-1), log(0), …) raise an error instead of producing
 * NaN/infinity. Errors carry the 0-based character position of the offending token.
 */

/** Longest accepted expression source (characters). */
export const MAX_EXPRESSION_LENGTH = 4096;
/** Deepest accepted nesting of parentheses, calls, unary operators and conditionals. */
export const MAX_EXPRESSION_DEPTH = 64;

/** Syntax or evaluation error of an expression, with the position of the problem. */
export class ExpressionError extends Error {
  constructor(
    message: string,
    /** 0-based character offset of the problem in `source` (-1 when it concerns the whole source). */
    readonly position: number,
    /** The expression source. */
    readonly source: string,
  ) {
    super(message);
    this.name = 'ExpressionError';
  }
}

/**
 * Variable values for an evaluation: a map, or a lookup function returning undefined for unknown
 * names. Names not found here fall back to the built-in constants (pi, tau, e).
 */
export type ExpressionScope = ReadonlyMap<string, number> | ((name: string) => number | undefined);

/** A compiled expression (immutable and safe to share; evaluation is re-entrant). */
export interface CompiledExpression {
  readonly source: string;
  /** Identifiers read as values (variables, `frame`, constants) in order of first use. */
  readonly names: readonly string[];
  /** Built-in functions called, in order of first use. */
  readonly functions: readonly string[];
  /** Evaluates the expression. Throws ExpressionError for unknown names and math errors. */
  evaluate(scope?: ExpressionScope): number;
}

// ---------------------------------------------------------------- deterministic noise and hashing

/** 32-bit avalanche mix of an integer. */
function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

const scratch = new DataView(new ArrayBuffer(8));

/** Folds the IEEE-754 bits of `v` into hash state `h` (-0 hashes like 0, every NaN alike). */
function hashNumber(h: number, v: number): number {
  scratch.setFloat64(0, v === 0 ? 0 : Number.isNaN(v) ? NaN : v, true);
  h = mix32(h ^ scratch.getUint32(0, true));
  return mix32((h + 0x9e3779b9) ^ scratch.getUint32(4, true));
}

/** Deterministic hash of one or more numbers to [0, 1). Identical inputs give identical outputs. */
export function hash01(...values: number[]): number {
  let h = 0x2545f491;
  for (const v of values) h = hashNumber(h, v);
  return h / 4294967296;
}

/** Hash state for a noise seed (0 for the default seed). */
function seedState(seed: number): number {
  return seed === 0 ? 0 : hashNumber(0x6a09e667, seed);
}

/** Pseudo-random gradient in [-1, 1) for integer lattice coordinate `i`. */
function grad1(i: number, s: number): number {
  return mix32(Math.imul(i | 0, 0x27d4eb2d) ^ s ^ 0x165667b1) / 2147483648 - 1;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Lattice offset of {@link noise1}: gradient noise vanishes on its integer lattice, so inputs are
 * shifted by an irrational-looking amount and `noise1(frame)` does not return 0 on every frame.
 */
const NOISE1_OFFSET = 0.3183098861837907;

/**
 * Smooth deterministic 1-D gradient (Perlin) noise in [-1, 1]: about one oscillation per unit of
 * `x`, continuous with a continuous derivative. Different seeds give unrelated curves.
 */
export function noise1(x: number, seed = 0): number {
  const X = x + NOISE1_OFFSET;
  const i = Math.floor(X);
  const t = X - i;
  const s = seedState(seed);
  const a = grad1(i, s) * t;
  const b = grad1(i + 1, s) * (t - 1);
  return 2 * (a + fade(t) * (b - a));
}

/** The 12 edge directions of a cube, the classic gradient set for 3-D gradient noise. */
const GRAD3 = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1,
  0, -1, -1,
];

function lattice3(ix: number, iy: number, iz: number, s: number, x: number, y: number, z: number): number {
  const h = mix32(mix32(mix32((ix | 0) ^ s ^ 0x3c6ef372) ^ (iy | 0)) ^ (iz | 0)) % 12;
  return GRAD3[h * 3] * x + GRAD3[h * 3 + 1] * y + GRAD3[h * 3 + 2] * z;
}

/** Deterministic 3-D gradient (Perlin) noise, roughly in [-1, 1] and 0 on the integer lattice. */
export function gradientNoise3(x: number, y: number, z: number, seed = 0): number {
  const s = seedState(seed);
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const lerp = (a: number, b: number, t: number) => a + t * (b - a);
  const x00 = lerp(lattice3(ix, iy, iz, s, fx, fy, fz), lattice3(ix + 1, iy, iz, s, fx - 1, fy, fz), u);
  const x10 = lerp(
    lattice3(ix, iy + 1, iz, s, fx, fy - 1, fz),
    lattice3(ix + 1, iy + 1, iz, s, fx - 1, fy - 1, fz),
    u,
  );
  const x01 = lerp(
    lattice3(ix, iy, iz + 1, s, fx, fy, fz - 1),
    lattice3(ix + 1, iy, iz + 1, s, fx - 1, fy, fz - 1),
    u,
  );
  const x11 = lerp(
    lattice3(ix, iy + 1, iz + 1, s, fx, fy - 1, fz - 1),
    lattice3(ix + 1, iy + 1, iz + 1, s, fx - 1, fy - 1, fz - 1),
    u,
  );
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

// ---------------------------------------------------------------- built-ins

type Fail = (message: string) => never;

interface FunctionDef {
  name: string;
  /** Call signature for documentation, e.g. 'clamp(x[, lo, hi])'. */
  signature: string;
  description: string;
  /** Allowed argument counts; for variadic functions the single entry is the minimum. */
  arity: readonly number[];
  variadic?: boolean;
  impl(args: number[], fail: Fail): number;
}

/** Public description of a built-in function. */
export interface ExpressionFunctionInfo {
  name: string;
  signature: string;
  description: string;
}

/** Python 3 rounding: halves go to the even neighbour (round(2.5) = 2, round(3.5) = 4). */
function roundHalfEven(x: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

function pythonRound(x: number, ndigits: number | undefined, fail: Fail): number {
  if (ndigits === undefined) return roundHalfEven(x);
  if (!Number.isInteger(ndigits)) fail('round() ndigits must be an integer');
  if (!Number.isFinite(x) || ndigits > 300) return x;
  if (ndigits < -308) return 0 * x;
  const p = 10 ** Math.abs(ndigits);
  return ndigits >= 0 ? roundHalfEven(x * p) / p : roundHalfEven(x / p) * p;
}

/** Floored modulo with the sign of the divisor (Python `%`). */
function floorMod(a: number, b: number): number {
  const r = a % b;
  if (r === 0) return b < 0 ? -0 : 0;
  return r < 0 !== b < 0 ? r + b : r;
}

function checkedPow(a: number, b: number, fail: Fail): number {
  if (a === 1) return 1;
  if (a === 0 && b < 0) fail('0 cannot be raised to a negative power');
  if (a < 0 && Number.isFinite(b) && !Number.isInteger(b))
    fail('a negative number cannot be raised to a fractional power');
  return Math.pow(a, b);
}

const unary = (name: string, description: string, f: (x: number, fail: Fail) => number): FunctionDef => ({
  name,
  signature: `${name}(x)`,
  description,
  arity: [1],
  impl: (a, fail) => f(a[0], fail),
});

const FUNCTION_DEFS: FunctionDef[] = [
  unary('sin', 'Sine of x (radians)', Math.sin),
  unary('cos', 'Cosine of x (radians)', Math.cos),
  unary('tan', 'Tangent of x (radians)', Math.tan),
  unary('asin', 'Arc sine in radians (x in [-1, 1])', (x, fail) =>
    x < -1 || x > 1 ? fail('math domain error: asin() needs -1 <= x <= 1') : Math.asin(x),
  ),
  unary('acos', 'Arc cosine in radians (x in [-1, 1])', (x, fail) =>
    x < -1 || x > 1 ? fail('math domain error: acos() needs -1 <= x <= 1') : Math.acos(x),
  ),
  unary('atan', 'Arc tangent in radians', Math.atan),
  {
    name: 'atan2',
    signature: 'atan2(y, x)',
    description: 'Angle of the vector (x, y) in radians, -pi..pi',
    arity: [2],
    impl: (a) => Math.atan2(a[0], a[1]),
  },
  unary('sinh', 'Hyperbolic sine', Math.sinh),
  unary('cosh', 'Hyperbolic cosine', Math.cosh),
  unary('tanh', 'Hyperbolic tangent', Math.tanh),
  unary('sqrt', 'Square root (x >= 0)', (x, fail) =>
    x < 0 ? fail('math domain error: sqrt() of a negative number') : Math.sqrt(x),
  ),
  unary('abs', 'Absolute value', Math.abs),
  unary('fabs', 'Absolute value (same as abs)', Math.abs),
  unary('exp', 'e raised to the power x', Math.exp),
  {
    name: 'log',
    signature: 'log(x[, base])',
    description: 'Natural logarithm of x (> 0), or the logarithm to the given base',
    arity: [1, 2],
    impl: (a, fail) => {
      if (!(a[0] > 0)) fail('math domain error: log() needs x > 0');
      if (a.length === 1) return Math.log(a[0]);
      if (!(a[1] > 0) || a[1] === 1) fail('math domain error: log() base must be > 0 and != 1');
      return Math.log(a[0]) / Math.log(a[1]);
    },
  },
  unary('log10', 'Base-10 logarithm (x > 0)', (x, fail) =>
    x > 0 ? Math.log10(x) : fail('math domain error: log10() needs x > 0'),
  ),
  {
    name: 'pow',
    signature: 'pow(x, y)',
    description: 'x raised to the power y (same as x ** y)',
    arity: [2],
    impl: (a, fail) => checkedPow(a[0], a[1], fail),
  },
  {
    name: 'hypot',
    signature: 'hypot(x, y, ...)',
    description: 'Euclidean length sqrt(x*x + y*y + ...)',
    arity: [1],
    variadic: true,
    impl: (a) => Math.hypot(...a),
  },
  unary('floor', 'Largest integer <= x', Math.floor),
  unary('ceil', 'Smallest integer >= x', Math.ceil),
  {
    name: 'round',
    signature: 'round(x[, ndigits])',
    description:
      'Round to the nearest integer (or to ndigits decimals); halves go to the even neighbour, like Python',
    arity: [1, 2],
    impl: (a, fail) => pythonRound(a[0], a[1], fail),
  },
  unary('trunc', 'Integer part of x (rounds toward zero)', Math.trunc),
  unary('int', 'Integer part of x (rounds toward zero), like Python int()', Math.trunc),
  unary('fract', 'Fractional part x - floor(x), in [0, 1)', (x) => x - Math.floor(x)),
  unary('sign', 'Sign of x: -1, 0 or 1', (x) => (x > 0 ? 1 : x < 0 ? -1 : x === 0 ? 0 : NaN)),
  {
    name: 'mod',
    signature: 'mod(a, b)',
    description: 'Floored modulo, result has the sign of b (same as a % b)',
    arity: [2],
    impl: (a, fail) => (a[1] === 0 ? fail('mod() by zero') : floorMod(a[0], a[1])),
  },
  {
    name: 'fmod',
    signature: 'fmod(a, b)',
    description: 'Truncated modulo, result has the sign of a (C fmod)',
    arity: [2],
    impl: (a, fail) => (a[1] === 0 ? fail('fmod() by zero') : a[0] % a[1]),
  },
  {
    name: 'min',
    signature: 'min(a, b, ...)',
    description: 'Smallest argument',
    arity: [1],
    variadic: true,
    impl: (a) => Math.min(...a),
  },
  {
    name: 'max',
    signature: 'max(a, b, ...)',
    description: 'Largest argument',
    arity: [1],
    variadic: true,
    impl: (a) => Math.max(...a),
  },
  {
    name: 'clamp',
    signature: 'clamp(x[, lo, hi])',
    description: 'x limited to [lo, hi] (default [0, 1])',
    arity: [1, 3],
    impl: (a) => {
      const lo = a.length === 3 ? a[1] : 0;
      const hi = a.length === 3 ? a[2] : 1;
      return a[0] < lo ? lo : a[0] > hi ? hi : a[0];
    },
  },
  {
    name: 'lerp',
    signature: 'lerp(a, b, t)',
    description: 'Linear interpolation a*(1-t) + b*t',
    arity: [3],
    impl: (a) => a[0] * (1 - a[2]) + a[1] * a[2],
  },
  {
    name: 'smoothstep',
    signature: 'smoothstep(edge0, edge1, x)',
    description: 'Smooth Hermite step: 0 for x <= edge0, 1 for x >= edge1',
    arity: [3],
    impl: ([e0, e1, x]) => {
      if (e0 === e1) return x < e0 ? 0 : 1;
      let t = (x - e0) / (e1 - e0);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return t * t * (3 - 2 * t);
    },
  },
  unary('radians', 'Degrees to radians', (x) => (x * Math.PI) / 180),
  unary('degrees', 'Radians to degrees', (x) => (x * 180) / Math.PI),
  {
    name: 'noise',
    signature: 'noise(x[, seed])',
    description:
      'Smooth deterministic 1-D gradient noise in [-1, 1], about one wiggle per unit of x (e.g. noise(frame / 10))',
    arity: [1, 2],
    impl: (a) => noise1(a[0], a[1] ?? 0),
  },
  {
    name: 'hash',
    signature: 'hash(x[, y])',
    description: 'Deterministic pseudo-random value in [0, 1) for the given number(s)',
    arity: [1, 2],
    impl: (a) => hash01(...a),
  },
  {
    name: 'random',
    signature: 'random(seed[, lo, hi])',
    description:
      'Deterministic uniform random value in [0, 1) (or [lo, hi)) for a seed, e.g. random(floor(frame / 5))',
    arity: [1, 3],
    impl: (a) => {
      const r = hash01(a[0], 0x5eed);
      return a.length === 3 ? a[1] + (a[2] - a[1]) * r : r;
    },
  },
];

const FUNCTIONS = new Map<string, FunctionDef>(FUNCTION_DEFS.map((f) => [f.name, f]));

const CONSTANTS = new Map<string, number>([
  ['pi', Math.PI],
  ['tau', 2 * Math.PI],
  ['e', Math.E],
]);

/** Built-in functions (for documentation and agent help). */
export const EXPRESSION_FUNCTIONS: readonly ExpressionFunctionInfo[] = FUNCTION_DEFS.map((f) => ({
  name: f.name,
  signature: f.signature,
  description: f.description,
}));

/** Built-in constants (a driver variable of the same name would shadow them, but is rejected). */
export const EXPRESSION_CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
  True: 1,
  False: 0,
});

/** Python keywords: never valid names. Only and/or/not/if/else/True/False are part of the language. */
const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'if',
  'else',
  'True',
  'False',
  'None',
  'lambda',
  'import',
  'from',
  'as',
  'for',
  'while',
  'in',
  'is',
  'def',
  'class',
  'return',
  'yield',
  'del',
  'global',
  'nonlocal',
  'assert',
  'pass',
  'break',
  'continue',
  'try',
  'except',
  'finally',
  'raise',
  'with',
  'async',
  'await',
  'elif',
]);

/** One-paragraph summary of the expression language (used in operator descriptions). */
export const EXPRESSION_SYNTAX_HELP =
  'Expression syntax (Python subset): numbers, variable names, `frame` (current frame), constants pi tau e ' +
  'True False; operators + - * / // (floor division) % (modulo, sign of divisor) ** (power), comparisons ' +
  '< <= > >= == != (chainable, give 1 or 0), and/or/not (also && || !), conditional `a if cond else b` (also ' +
  '`cond ? a : b`) and parentheses. Functions: ' +
  FUNCTION_DEFS.map((f) => f.signature).join(', ') +
  '. Angles are radians. Division by zero and math domain errors (sqrt of a negative number, log of 0) ' +
  'are errors.';

/** True for names of built-in functions, constants and keywords (not usable as variable names). */
export function isReservedName(name: string): boolean {
  return FUNCTIONS.has(name) || CONSTANTS.has(name) || KEYWORDS.has(name);
}

/**
 * Validates a variable name for use in expressions: an identifier starting with a letter (Blender
 * rejects leading underscores), at most 64 characters, not a keyword, built-in function or
 * constant, and not `frame`. Returns an error message, or null when the name is valid.
 */
export function variableNameError(name: string): string | null {
  if (typeof name !== 'string' || name === '') return 'Variable name is empty';
  if (name.length > 64) return `Variable name '${name.slice(0, 20)}…' is longer than 64 characters`;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
    return `Invalid variable name '${name}': use letters, digits and '_' only, starting with a letter`;
  if (name === 'frame') return "Variable name 'frame' is reserved for the current frame";
  if (KEYWORDS.has(name)) return `Variable name '${name}' is a reserved keyword`;
  if (FUNCTIONS.has(name)) return `Variable name '${name}' is the name of a built-in function`;
  if (CONSTANTS.has(name)) return `Variable name '${name}' is the name of a built-in constant`;
  return null;
}

// ---------------------------------------------------------------- errors

function excerpt(src: string): string {
  const flat = src.replace(/\s+/g, ' ');
  return flat.length <= 80 ? flat : `${flat.slice(0, 77)}…`;
}

function excerptAround(src: string, pos: number): string {
  if (src.length <= 80) return src.replace(/\s/g, ' ');
  const start = Math.max(0, pos - 35);
  const end = Math.min(src.length, pos + 35);
  return `${start > 0 ? '…' : ''}${src.slice(start, end).replace(/\s/g, ' ')}${end < src.length ? '…' : ''}`;
}

function errorAt(src: string, pos: number, message: string, hint?: string): ExpressionError {
  const where = pos >= 0 ? ` at column ${pos + 1} in "${excerptAround(src, pos)}"` : ` in "${excerpt(src)}"`;
  return new ExpressionError(`${message}${where}${hint ? `. ${hint}` : ''}`, pos, src);
}

// ---------------------------------------------------------------- tokenizer

type TokenKind = 'number' | 'name' | 'op' | 'end';

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
  value: number;
}

const OPERATORS_2 = new Set(['**', '//', '<=', '>=', '==', '!=', '&&', '||']);
const OPERATORS_1 = new Set(['+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', ',']);

const UNSUPPORTED_2 = new Map<string, string>([
  ['<<', 'Bitwise shifts are not supported'],
  ['>>', 'Bitwise shifts are not supported'],
  ['<>', "'<>' is not supported; use '!='"],
]);

const UNSUPPORTED_1 = new Map<string, string>([
  ['=', "Assignment ('=') is not supported; use '==' to compare"],
  ['^', "'^' is not supported; use '**' (or pow(x, y)) for powers"],
  ['&', "'&' is not supported; use 'and' (or '&&')"],
  ['|', "'|' is not supported; use 'or' (or '||')"],
  ['~', 'Bitwise operators are not supported'],
  ['@', "'@' is not supported"],
  [
    '.',
    "Attribute access ('.') is not supported; call functions directly, e.g. sin(x) instead of math.sin(x)",
  ],
  ['[', "Indexing ('[') is not supported; read each vector channel through its own variable"],
  [']', "Indexing (']') is not supported"],
  ['{', "'{' is not supported"],
  ['}', "'}' is not supported"],
  ['"', 'Strings are not supported'],
  ["'", 'Strings are not supported'],
  [';', 'Only a single expression is allowed'],
  ['#', 'Comments are not supported'],
]);

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isIdentChar = (c: string | undefined): boolean => isIdentStart(c) || isDigit(c);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      while (isDigit(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (isDigit(src[i])) i++;
      }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j++;
        if (isDigit(src[j])) {
          i = j;
          while (isDigit(src[i])) i++;
        }
      }
      if (isIdentChar(src[i]) || src[i] === '.') {
        let j = i;
        while (isIdentChar(src[j]) || src[j] === '.') j++;
        const bad = src.slice(start, j);
        const hint = /^0[xXbBoO]/.test(bad)
          ? 'Hexadecimal, binary and octal literals are not supported'
          : /^\d+(\.\d*)?[A-Za-z_]/.test(bad)
            ? 'Write multiplication explicitly, e.g. 2*x'
            : undefined;
        throw errorAt(src, start, `Invalid number '${bad}'`, hint);
      }
      const text = src.slice(start, i);
      out.push({ kind: 'number', text, pos: start, value: Number(text) });
      continue;
    }
    if (isIdentStart(c)) {
      while (isIdentChar(src[i])) i++;
      out.push({ kind: 'name', text: src.slice(start, i), pos: start, value: 0 });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPERATORS_2.has(two)) {
      out.push({ kind: 'op', text: two, pos: start, value: 0 });
      i += 2;
      continue;
    }
    const unsupported = UNSUPPORTED_2.get(two);
    if (unsupported) throw errorAt(src, start, unsupported);
    if (OPERATORS_1.has(c)) {
      out.push({ kind: 'op', text: c, pos: start, value: 0 });
      i++;
      continue;
    }
    const msg = UNSUPPORTED_1.get(c);
    const code = c.codePointAt(0)!;
    const shown = code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : c;
    throw errorAt(src, start, msg ?? `Unexpected character '${shown}'`);
  }
  out.push({ kind: 'end', text: '', pos: n, value: 0 });
  return out;
}

// ---------------------------------------------------------------- parser

type ArithOp = '+' | '-' | '*' | '/' | '//' | '%';
type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

type Node =
  | { k: 'num'; pos: number; v: number }
  | { k: 'name'; pos: number; name: string }
  | { k: 'neg' | 'not'; pos: number; a: Node }
  | { k: 'arith'; pos: number; first: Node; ops: ArithOp[]; rest: Node[]; opPos: number[] }
  | { k: 'pow'; pos: number; a: Node; b: Node }
  | { k: 'cmp'; pos: number; operands: Node[]; ops: CmpOp[] }
  | { k: 'and' | 'or'; pos: number; operands: Node[] }
  | { k: 'cond'; pos: number; test: Node; then: Node; other: Node }
  | { k: 'call'; pos: number; fn: FunctionDef; args: Node[] };

const CMP_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);

function describe(t: Token): string {
  switch (t.kind) {
    case 'end':
      return 'the end of the expression';
    case 'number':
      return `number '${t.text}'`;
    case 'name':
      return KEYWORDS.has(t.text) ? `keyword '${t.text}'` : `name '${t.text}'`;
    default:
      return `'${t.text}'`;
  }
}

function arityText(def: FunctionDef): string {
  const a = def.arity;
  const plural = (n: number) => `${n} argument${n === 1 ? '' : 's'}`;
  if (def.variadic) return `at least ${plural(a[0])}`;
  if (a.length === 1) return `exactly ${plural(a[0])}`;
  return `${a.slice(0, -1).join(', ')} or ${plural(a[a.length - 1])}`;
}

function arityOk(def: FunctionDef, n: number): boolean {
  return def.variadic ? n >= def.arity[0] : def.arity.includes(n);
}

class Parser {
  private i = 0;
  private depth = 0;
  readonly names: string[] = [];
  readonly functions: string[] = [];

  constructor(
    private readonly src: string,
    private readonly toks: Token[],
  ) {}

  private peek(): Token {
    return this.toks[this.i];
  }

  private next(): Token {
    const t = this.toks[this.i];
    if (t.kind !== 'end') this.i++;
    return t;
  }

  private isOp(text: string): boolean {
    const t = this.toks[this.i];
    return t.kind === 'op' && t.text === text;
  }

  private isKw(word: string): boolean {
    const t = this.toks[this.i];
    return t.kind === 'name' && t.text === word;
  }

  private fail(t: Token, message: string, hint?: string): never {
    throw errorAt(this.src, t.pos, message, hint);
  }

  private enter(t: Token): void {
    if (++this.depth > MAX_EXPRESSION_DEPTH)
      this.fail(t, `Expression is nested too deeply (more than ${MAX_EXPRESSION_DEPTH} levels)`);
  }

  parse(): Node {
    const node = this.expression();
    const t = this.peek();
    if (t.kind !== 'end')
      this.fail(t, `Unexpected ${describe(t)}; expected an operator or the end of the expression`);
    return node;
  }

  /** conditional: or_test ['if' or_test 'else' expression] | or_test '?' expression ':' expression */
  private expression(): Node {
    const start = this.peek();
    this.enter(start);
    let node = this.or();
    if (this.isKw('if')) {
      const ifTok = this.next();
      const test = this.or();
      if (!this.isKw('else'))
        this.fail(
          this.peek(),
          `Expected 'else' after the condition of the 'if' at column ${ifTok.pos + 1}, found ${describe(this.peek())}`,
        );
      this.next();
      const other = this.expression();
      node = { k: 'cond', pos: ifTok.pos, test, then: node, other };
    } else if (this.isOp('?')) {
      const q = this.next();
      const then = this.expression();
      if (!this.isOp(':'))
        this.fail(
          this.peek(),
          `Expected ':' after the '?' branch at column ${q.pos + 1}, found ${describe(this.peek())}`,
        );
      this.next();
      const other = this.expression();
      node = { k: 'cond', pos: q.pos, test: node, then, other };
    }
    this.depth--;
    return node;
  }

  private or(): Node {
    const first = this.and();
    if (!this.isKw('or') && !this.isOp('||')) return first;
    const operands = [first];
    const pos = this.peek().pos;
    while (this.isKw('or') || this.isOp('||')) {
      this.next();
      operands.push(this.and());
    }
    return { k: 'or', pos, operands };
  }

  private and(): Node {
    const first = this.not();
    if (!this.isKw('and') && !this.isOp('&&')) return first;
    const operands = [first];
    const pos = this.peek().pos;
    while (this.isKw('and') || this.isOp('&&')) {
      this.next();
      operands.push(this.not());
    }
    return { k: 'and', pos, operands };
  }

  private not(): Node {
    if (!this.isKw('not')) return this.comparison();
    const t = this.next();
    this.enter(t);
    const a = this.not();
    this.depth--;
    return { k: 'not', pos: t.pos, a };
  }

  private comparison(): Node {
    const first = this.additive();
    let t = this.peek();
    if (t.kind !== 'op' || !CMP_OPS.has(t.text)) return first;
    const operands = [first];
    const ops: CmpOp[] = [];
    const pos = t.pos;
    while (t.kind === 'op' && CMP_OPS.has(t.text)) {
      this.next();
      ops.push(t.text as CmpOp);
      operands.push(this.additive());
      t = this.peek();
    }
    return { k: 'cmp', pos, operands, ops };
  }

  private chain(sub: () => Node, accept: ReadonlySet<string>): Node {
    const first = sub();
    let t = this.peek();
    if (t.kind !== 'op' || !accept.has(t.text)) return first;
    const ops: ArithOp[] = [];
    const rest: Node[] = [];
    const opPos: number[] = [];
    while (t.kind === 'op' && accept.has(t.text)) {
      this.next();
      ops.push(t.text as ArithOp);
      opPos.push(t.pos);
      rest.push(sub());
      t = this.peek();
    }
    return { k: 'arith', pos: opPos[0], first, ops, rest, opPos };
  }

  private additive(): Node {
    return this.chain(() => this.term(), ADDITIVE);
  }

  private term(): Node {
    return this.chain(() => this.unary(), MULTIPLICATIVE);
  }

  private unary(): Node {
    const t = this.peek();
    if (t.kind === 'op' && (t.text === '-' || t.text === '+' || t.text === '!')) {
      this.next();
      this.enter(t);
      const a = this.unary();
      this.depth--;
      if (t.text === '+') return a;
      if (t.text === '-' && a.k === 'num') return { k: 'num', pos: t.pos, v: -a.v };
      return { k: t.text === '-' ? 'neg' : 'not', pos: t.pos, a };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (!this.isOp('**')) return base;
    const t = this.next();
    this.enter(t);
    const exp = this.unary();
    this.depth--;
    return { k: 'pow', pos: t.pos, a: base, b: exp };
  }

  private primary(): Node {
    const t = this.next();
    if (t.kind === 'number') return { k: 'num', pos: t.pos, v: t.value };
    if (t.kind === 'name') {
      const name = t.text;
      if (name === 'True' || name === 'False') return { k: 'num', pos: t.pos, v: name === 'True' ? 1 : 0 };
      if (KEYWORDS.has(name)) {
        if (name === 'None') this.fail(t, "'None' is not supported; use a number");
        if (['and', 'or', 'not', 'if', 'else', 'in', 'is'].includes(name))
          this.fail(t, `Unexpected keyword '${name}'; expected a number, name or '('`);
        this.fail(t, `'${name}' is not supported in expressions`);
      }
      if (name.startsWith('_')) this.fail(t, `Names starting with '_' are not allowed ('${name}')`);
      if (this.isOp('(')) return this.call(t);
      if (!this.names.includes(name)) this.names.push(name);
      return { k: 'name', pos: t.pos, name };
    }
    if (t.kind === 'op' && t.text === '(') {
      const inner = this.expression();
      if (!this.isOp(')'))
        this.fail(
          this.peek(),
          `Expected ')' to close the '(' at column ${t.pos + 1}, found ${describe(this.peek())}`,
        );
      this.next();
      return inner;
    }
    if (t.kind === 'end') this.fail(t, "Unexpected end of the expression; expected a number, name or '('");
    return this.fail(t, `Unexpected ${describe(t)}; expected a number, name or '('`);
  }

  private call(nameTok: Token): Node {
    const name = nameTok.text;
    const def = FUNCTIONS.get(name);
    if (!def) {
      const hint = CONSTANTS.has(name)
        ? `'${name}' is a constant, not a function`
        : `Available functions: ${[...FUNCTIONS.keys()].join(', ')}`;
      this.fail(nameTok, `Unknown function '${name}'`, hint);
    }
    const open = this.next(); // '('
    this.enter(open);
    const args: Node[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.expression());
        if (this.isOp(',')) {
          this.next();
          if (this.isOp(')')) break; // trailing comma, like Python
          continue;
        }
        if (this.isOp(')')) break;
        this.fail(
          this.peek(),
          `Expected ',' or ')' in the arguments of ${name}() opened at column ${open.pos + 1}, found ${describe(this.peek())}`,
        );
      }
    }
    this.next(); // ')'
    this.depth--;
    if (!arityOk(def, args.length))
      this.fail(
        nameTok,
        `${name}() takes ${arityText(def)} (${args.length} given)`,
        `Usage: ${def.signature}`,
      );
    if (!this.functions.includes(name)) this.functions.push(name);
    return { k: 'call', pos: nameTok.pos, fn: def, args };
  }
}

const ADDITIVE: ReadonlySet<string> = new Set(['+', '-']);
const MULTIPLICATIVE: ReadonlySet<string> = new Set(['*', '/', '//', '%']);

// ---------------------------------------------------------------- compiler

type Lookup = (name: string) => number | undefined;
type Evaluator = (lookup: Lookup) => number;

function compileNode(node: Node, src: string): Evaluator {
  const failAt =
    (pos: number) =>
    (message: string): never => {
      throw errorAt(src, pos, message);
    };
  switch (node.k) {
    case 'num': {
      const v = node.v;
      return () => v;
    }
    case 'name': {
      const { name, pos } = node;
      const constant = CONSTANTS.get(name);
      return (lookup) => {
        const v = lookup(name);
        if (typeof v === 'number') return v;
        if (constant !== undefined) return constant;
        throw errorAt(src, pos, `Unknown name '${name}'`);
      };
    }
    case 'neg': {
      const a = compileNode(node.a, src);
      return (l) => -a(l);
    }
    case 'not': {
      const a = compileNode(node.a, src);
      return (l) => (a(l) === 0 ? 1 : 0);
    }
    case 'pow': {
      const a = compileNode(node.a, src);
      const b = compileNode(node.b, src);
      const fail = failAt(node.pos);
      return (l) => checkedPow(a(l), b(l), fail);
    }
    case 'arith': {
      const first = compileNode(node.first, src);
      const rest = node.rest.map((r) => compileNode(r, src));
      const ops = node.ops;
      const fails = node.opPos.map(failAt);
      return (l) => {
        let acc = first(l);
        for (let i = 0; i < rest.length; i++) {
          const b = rest[i](l);
          switch (ops[i]) {
            case '+':
              acc += b;
              break;
            case '-':
              acc -= b;
              break;
            case '*':
              acc *= b;
              break;
            case '/':
              if (b === 0) fails[i]('division by zero');
              acc /= b;
              break;
            case '//':
              if (b === 0) fails[i]('division by zero');
              acc = Math.floor(acc / b);
              break;
            case '%':
              if (b === 0) fails[i]('modulo by zero');
              acc = floorMod(acc, b);
              break;
          }
        }
        return acc;
      };
    }
    case 'cmp': {
      const operands = node.operands.map((o) => compileNode(o, src));
      const ops = node.ops;
      return (l) => {
        let left = operands[0](l);
        for (let i = 0; i < ops.length; i++) {
          const right = operands[i + 1](l);
          let ok: boolean;
          switch (ops[i]) {
            case '<':
              ok = left < right;
              break;
            case '<=':
              ok = left <= right;
              break;
            case '>':
              ok = left > right;
              break;
            case '>=':
              ok = left >= right;
              break;
            case '==':
              ok = left === right;
              break;
            default:
              ok = left !== right;
          }
          if (!ok) return 0;
          left = right;
        }
        return 1;
      };
    }
    case 'or': {
      const operands = node.operands.map((o) => compileNode(o, src));
      return (l) => {
        let v = 0;
        for (const o of operands) {
          v = o(l);
          if (v !== 0) return v;
        }
        return v;
      };
    }
    case 'and': {
      const operands = node.operands.map((o) => compileNode(o, src));
      return (l) => {
        let v = 1;
        for (const o of operands) {
          v = o(l);
          if (v === 0) return v;
        }
        return v;
      };
    }
    case 'cond': {
      const test = compileNode(node.test, src);
      const then = compileNode(node.then, src);
      const other = compileNode(node.other, src);
      return (l) => (test(l) !== 0 ? then(l) : other(l));
    }
    case 'call': {
      const args = node.args.map((a) => compileNode(a, src));
      const fn = node.fn;
      const fail = failAt(node.pos);
      return (l) => {
        const values = new Array<number>(args.length);
        for (let i = 0; i < args.length; i++) values[i] = args[i](l);
        return fn.impl(values, fail);
      };
    }
  }
}

const NO_VARIABLES: Lookup = () => undefined;

function toLookup(scope: ExpressionScope | undefined): Lookup {
  if (!scope) return NO_VARIABLES;
  if (typeof scope === 'function') return scope;
  return (name) => scope.get(name);
}

function compileUncached(source: string): CompiledExpression {
  if (typeof source !== 'string')
    throw new ExpressionError('Expression must be a string', -1, String(source));
  if (source.length > MAX_EXPRESSION_LENGTH)
    throw new ExpressionError(
      `Expression is too long (${source.length} characters, the maximum is ${MAX_EXPRESSION_LENGTH})`,
      -1,
      source,
    );
  if (source.trim() === '') throw new ExpressionError('Expression is empty', -1, source);
  const parser = new Parser(source, tokenize(source));
  const root = compileNode(parser.parse(), source);
  const names = Object.freeze([...parser.names]);
  const functions = Object.freeze([...parser.functions]);
  return Object.freeze({
    source,
    names,
    functions,
    evaluate: (scope?: ExpressionScope) => root(toLookup(scope)),
  });
}

const cache = new Map<string, CompiledExpression | ExpressionError>();
const CACHE_LIMIT = 2000;

/**
 * Compiles an expression (cached by source text, including failures). Throws ExpressionError with
 * the position of the first syntax error.
 */
export function compileExpression(source: string): CompiledExpression {
  const hit = cache.get(source);
  if (hit) {
    if (hit instanceof ExpressionError) throw hit;
    return hit;
  }
  let result: CompiledExpression | ExpressionError;
  try {
    result = compileUncached(source);
  } catch (e) {
    if (!(e instanceof ExpressionError)) throw e;
    result = e;
  }
  if (typeof source === 'string' && source.length <= MAX_EXPRESSION_LENGTH) {
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(source, result);
  }
  if (result instanceof ExpressionError) throw result;
  return result;
}

/** Compiles without throwing: the compiled expression, or the error. */
export function tryCompileExpression(
  source: string,
): { ok: true; expression: CompiledExpression } | { ok: false; error: ExpressionError } {
  try {
    return { ok: true, expression: compileExpression(source) };
  } catch (e) {
    if (e instanceof ExpressionError) return { ok: false, error: e };
    throw e;
  }
}

/**
 * Compiles (cached) and evaluates an expression. Variables are given as a map, a lookup function or
 * a plain record (only its own properties are used).
 */
export function evaluateExpression(
  source: string,
  variables?: ExpressionScope | Readonly<Record<string, number>>,
): number {
  let scope: ExpressionScope | undefined;
  if (variables === undefined || typeof variables === 'function' || variables instanceof Map)
    scope = variables;
  else scope = new Map(Object.entries(variables as Record<string, number>));
  return compileExpression(source).evaluate(scope);
}
