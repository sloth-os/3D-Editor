/*
 * A small interpreter of GLSL ES functions, so unit tests can run generated shader code on the CPU
 * (the test environment has no WebGL): it parses function definitions of a shader source and calls
 * them with JavaScript values, uniforms and texture lookups given by the test.
 *
 * Values: float and int are numbers, bool a boolean, vec2–vec4 arrays of numbers, mat2–mat4 arrays
 * of columns (`m[3][2]` is column 3, row 2, like GLSL), samplers whatever the test passes.
 * Supported: functions with `in` parameters; declarations; assignment (also to components and
 * with += -= *= /=); ++ and --; if / else, for, while, break, continue, return; arithmetic,
 * comparison, logical and ternary operators (component-wise on vectors, scalars broadcast);
 * swizzles and indexing; the common built-in functions; #ifdef / #ifndef / #else / #endif and
 * #define of names. Anything else (out parameters, overloads, structs, arrays, matrix products,
 * other preprocessor directives) is an error rather than a guess, and so are type mismatches GLSL
 * rejects (a vec3 assigned to a vec2, a float condition). Integer division is not modelled: GLSL
 * ES has no implicit int-to-float conversion, so shaders divide floats.
 */

type Value = unknown;

interface Token {
  type: 'number' | 'name' | 'punct' | 'end';
  text: string;
}

const TOKEN =
  /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(\d+\.\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|\d+(?:[eE][-+]?\d+)?)|([A-Za-z_]\w*)|(\+\+|--|<=|>=|==|!=|&&|\|\||\^\^|[-+*/]=|[-+*/%<>=!?:.,;()[\]{}])/y;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`GLSL: unexpected '${src.slice(at, at + 24)}'`);
    if (m[1] !== undefined) out.push({ type: 'number', text: m[1] });
    else if (m[2] !== undefined) out.push({ type: 'name', text: m[2] });
    else if (m[3] !== undefined) out.push({ type: 'punct', text: m[3] });
  }
  out.push({ type: 'end', text: '' });
  return out;
}

/** Applies #ifdef / #ifndef / #else / #endif (and #define NAME) to a source. */
function preprocess(src: string, defines: Iterable<string>): string {
  const defined = new Set(defines);
  /** Whether each open conditional block is taken. */
  const conditions: boolean[] = [];
  const active = () => conditions.every(Boolean);
  return src
    .split('\n')
    .map((line) => {
      const d = /^\s*#\s*(\w+)\s*(\w*)/.exec(line);
      if (!d) return active() ? line : '';
      const [, directive, arg] = d;
      const unsupported = () => new Error(`GLSL: '${line.trim()}' is not supported`);
      switch (directive) {
        case 'ifdef':
        case 'ifndef':
          conditions.push(defined.has(arg) === (directive === 'ifdef'));
          break;
        case 'if':
          // its expression is not evaluated: only inside a block that is skipped anyway
          if (active()) throw unsupported();
          conditions.push(false);
          break;
        case 'elif':
          if (conditions.slice(0, -1).every(Boolean)) throw unsupported();
          break;
        case 'else':
          if (!conditions.length) throw new Error('GLSL: #else without #if');
          conditions.push(!conditions.pop());
          break;
        case 'endif':
          if (!conditions.length) throw new Error('GLSL: #endif without #if');
          conditions.pop();
          break;
        case 'define':
          if (!active()) break;
          if (!/^\s*#\s*define\s+\w+\s*(\/\/.*)?$/.test(line)) throw unsupported();
          defined.add(arg);
          break;
        default:
          if (active()) throw unsupported();
      }
      return '';
    })
    .join('\n');
}

type Expr =
  | { k: 'value'; v: number | boolean }
  | { k: 'name'; name: string }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'member'; e: Expr; field: string }
  | { k: 'index'; e: Expr; index: Expr }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'binary'; op: string; a: Expr; b: Expr }
  | { k: 'ternary'; c: Expr; a: Expr; b: Expr }
  | { k: 'assign'; op: string; target: Expr; e: Expr }
  | { k: 'step'; op: string; prefix: boolean; target: Expr };

type Stmt =
  | { k: 'block'; body: Stmt[] }
  | { k: 'decl'; type: string; vars: { name: string; init?: Expr }[] }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; c: Expr; a: Stmt; b?: Stmt }
  | { k: 'for'; init?: Stmt; c?: Expr; step?: Expr; body: Stmt }
  | { k: 'while'; c: Expr; body: Stmt }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'return'; e?: Expr }
  | { k: 'empty' };

interface GlslFunction {
  type: string;
  name: string;
  params: { type: string; name: string }[];
  body: Stmt;
}

const TYPES = new Set([
  'void',
  'bool',
  'int',
  'float',
  'vec2',
  'vec3',
  'vec4',
  'mat2',
  'mat3',
  'mat4',
  'sampler2D',
]);
const QUALIFIERS = new Set(['const', 'in', 'highp', 'mediump', 'lowp']);
/** Binary operators by precedence (higher binds tighter). */
const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '^^': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
};
const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=']);

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.i + ahead, this.tokens.length - 1)];
  }
  private next(): Token {
    const t = this.peek();
    if (t.type !== 'end') this.i++;
    return t;
  }
  private is(text: string): boolean {
    const t = this.peek();
    return t.type !== 'end' && t.type !== 'number' && t.text === text;
  }
  private accept(text: string): boolean {
    if (!this.is(text)) return false;
    this.i++;
    return true;
  }
  private expect(text: string): void {
    if (!this.accept(text)) throw new Error(`GLSL: expected '${text}' before '${this.peek().text}'`);
  }
  private name(): string {
    const t = this.next();
    if (t.type !== 'name') throw new Error(`GLSL: expected a name before '${t.text}'`);
    return t.text;
  }
  private typeName(): string {
    const t = this.next();
    if (!TYPES.has(t.text)) throw new Error(`GLSL: unsupported type '${t.text}'`);
    return t.text;
  }
  private skipQualifiers(): void {
    while (QUALIFIERS.has(this.peek().text)) this.i++;
  }

  program(): GlslFunction[] {
    const out: GlslFunction[] = [];
    while (this.peek().type !== 'end') out.push(this.func());
    return out;
  }

  private func(): GlslFunction {
    const type = this.typeName();
    const name = this.name();
    this.expect('(');
    const params: GlslFunction['params'] = [];
    if (this.is('void') && this.peek(1).text === ')') this.i++;
    if (!this.accept(')')) {
      do {
        this.skipQualifiers();
        if (this.is('out') || this.is('inout')) throw new Error('GLSL: out parameters are not supported');
        this.skipQualifiers();
        params.push({ type: this.typeName(), name: this.name() });
      } while (this.accept(','));
      this.expect(')');
    }
    return { type, name, params, body: this.block() };
  }

  private block(): Stmt {
    this.expect('{');
    const body: Stmt[] = [];
    while (!this.accept('}')) {
      if (this.peek().type === 'end') throw new Error("GLSL: missing '}'");
      body.push(this.statement());
    }
    return { k: 'block', body };
  }

  private statement(): Stmt {
    if (this.is('{')) return this.block();
    if (this.accept(';')) return { k: 'empty' };
    if (this.accept('if')) {
      this.expect('(');
      const c = this.expression();
      this.expect(')');
      const a = this.statement();
      return { k: 'if', c, a, b: this.accept('else') ? this.statement() : undefined };
    }
    if (this.accept('for')) {
      this.expect('(');
      const init = this.accept(';') ? undefined : this.simpleStatement();
      const c = this.is(';') ? undefined : this.expression();
      this.expect(';');
      const step = this.is(')') ? undefined : this.expression();
      this.expect(')');
      return { k: 'for', init, c, step, body: this.statement() };
    }
    if (this.accept('while')) {
      this.expect('(');
      const c = this.expression();
      this.expect(')');
      return { k: 'while', c, body: this.statement() };
    }
    if (this.accept('break') || this.accept('continue')) {
      const k = this.tokens[this.i - 1].text as 'break' | 'continue';
      this.expect(';');
      return { k };
    }
    if (this.accept('return')) {
      const e = this.is(';') ? undefined : this.expression();
      this.expect(';');
      return { k: 'return', e };
    }
    return this.simpleStatement();
  }

  /** A declaration or an expression statement, with its ';'. */
  private simpleStatement(): Stmt {
    let j = 0;
    while (QUALIFIERS.has(this.peek(j).text)) j++;
    if (TYPES.has(this.peek(j).text) && this.peek(j + 1).type === 'name') {
      this.skipQualifiers();
      const type = this.typeName();
      const vars: { name: string; init?: Expr }[] = [];
      do {
        const name = this.name();
        if (this.is('[')) throw new Error('GLSL: arrays are not supported');
        vars.push({ name, init: this.accept('=') ? this.assignment() : undefined });
      } while (this.accept(','));
      this.expect(';');
      return { k: 'decl', type, vars };
    }
    const e = this.expression();
    this.expect(';');
    return { k: 'expr', e };
  }

  private expression(): Expr {
    return this.assignment();
  }

  private assignment(): Expr {
    const target = this.ternary();
    const t = this.peek();
    if (t.type === 'punct' && ASSIGNMENTS.has(t.text)) {
      this.i++;
      return { k: 'assign', op: t.text, target, e: this.assignment() };
    }
    return target;
  }

  private ternary(): Expr {
    const c = this.binary(1);
    if (!this.accept('?')) return c;
    const a = this.assignment();
    this.expect(':');
    return { k: 'ternary', c, a, b: this.assignment() };
  }

  private binary(min: number): Expr {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const prec = t.type === 'punct' ? PRECEDENCE[t.text] : undefined;
      if (prec === undefined || prec < min) return left;
      this.i++;
      left = { k: 'binary', op: t.text, a: left, b: this.binary(prec + 1) };
    }
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.type === 'punct' && (t.text === '-' || t.text === '+' || t.text === '!')) {
      this.i++;
      return { k: 'unary', op: t.text, e: this.unary() };
    }
    if (t.type === 'punct' && (t.text === '++' || t.text === '--')) {
      this.i++;
      return { k: 'step', op: t.text, prefix: true, target: this.unary() };
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.accept('(')) {
        if (e.k !== 'name') throw new Error('GLSL: only named functions can be called');
        const args: Expr[] = [];
        if (!this.accept(')')) {
          do args.push(this.assignment());
          while (this.accept(','));
          this.expect(')');
        }
        e = { k: 'call', name: e.name, args };
      } else if (this.accept('.')) e = { k: 'member', e, field: this.name() };
      else if (this.accept('[')) {
        const index = this.expression();
        this.expect(']');
        e = { k: 'index', e, index };
      } else if (this.is('++') || this.is('--'))
        e = { k: 'step', op: this.next().text, prefix: false, target: e };
      else return e;
    }
  }

  private primary(): Expr {
    const t = this.next();
    if (t.type === 'number') return { k: 'value', v: Number(t.text) };
    if (t.type === 'name') {
      if (t.text === 'true' || t.text === 'false') return { k: 'value', v: t.text === 'true' };
      return { k: 'name', name: t.text };
    }
    if (t.text === '(') {
      const e = this.expression();
      this.expect(')');
      return e;
    }
    throw new Error(`GLSL: unexpected '${t.text || 'end of source'}'`);
  }
}

// ------------------------------------------------------------------ values

const isVector = (v: Value): v is number[] => Array.isArray(v) && typeof v[0] === 'number';
const isMatrix = (v: Value): v is number[][] => Array.isArray(v) && Array.isArray(v[0]);
const clone = <T>(v: T): T => (Array.isArray(v) ? (v.map(clone) as T) : v);

function describe(v: Value): string {
  if (isMatrix(v)) return `mat${v.length}`;
  if (isVector(v)) return `vec${v.length}`;
  return typeof v === 'number' ? 'float' : typeof v === 'boolean' ? 'bool' : typeof v;
}

function scalar(v: Value): number {
  if (typeof v !== 'number') throw new Error(`GLSL: expected a float, got ${describe(v)}`);
  return v;
}

function condition(v: Value): boolean {
  if (typeof v !== 'boolean') throw new Error(`GLSL: a condition must be a bool, got ${describe(v)}`);
  return v;
}

/** Component-wise `f` of two floats or vectors (a float broadcast to a vector). */
function zip(a: Value, b: Value, f: (x: number, y: number) => number): number | number[] {
  if (typeof a === 'number' && typeof b === 'number') return f(a, b);
  if (isVector(a) && typeof b === 'number') return a.map((x) => f(x, b));
  if (typeof a === 'number' && isVector(b)) return b.map((y) => f(a, y));
  if (isVector(a) && isVector(b) && a.length === b.length) return a.map((x, i) => f(x, b[i]));
  throw new Error(`GLSL: cannot combine ${describe(a)} and ${describe(b)}`);
}

function each(v: Value, f: (x: number) => number): number | number[] {
  if (typeof v === 'number') return f(v);
  if (isVector(v)) return v.map(f);
  throw new Error(`GLSL: expected a float or vector, got ${describe(v)}`);
}

const SIZES: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4, mat2: 2, mat3: 3, mat4: 4 };

/** `v` when it is a value of GLSL type `type` (an error otherwise). */
function typed(type: string, v: Value): Value {
  const n = SIZES[type];
  const ok =
    type === 'float'
      ? typeof v === 'number'
      : type === 'int'
        ? Number.isInteger(v)
        : type === 'bool'
          ? typeof v === 'boolean'
          : type.startsWith('vec')
            ? isVector(v) && v.length === n
            : type.startsWith('mat')
              ? isMatrix(v) && v.length === n && v.every((c) => c.length === n)
              : true;
  if (!ok) throw new Error(`GLSL: expected ${type}, got ${describe(v)}`);
  return v;
}

/**
 * A vector constructor: one scalar for all components, or components from scalars and vectors in
 * order (the last argument may have more than are left, no argument may come after it).
 */
function construct(n: number, args: Value[]): number[] {
  const parts: number[] = [];
  for (const a of args) {
    if (parts.length >= n) throw new Error(`GLSL: too many arguments for vec${n}`);
    parts.push(...(typeof a === 'boolean' ? [Number(a)] : isVector(a) ? a : [scalar(a)]));
  }
  if (args.length === 1 && typeof args[0] !== 'object') return Array.from({ length: n }, () => parts[0]);
  if (parts.length < n) throw new Error(`GLSL: vec${n} needs ${n} components, got ${parts.length}`);
  return parts.slice(0, n);
}

/** What a declaration without initializer holds: NaN components, so reading one shows. */
function uninitialized(type: string): Value {
  const n = SIZES[type];
  if (type.startsWith('vec')) return Array.from({ length: n }, () => NaN);
  if (type.startsWith('mat')) return Array.from({ length: n }, () => Array.from({ length: n }, () => NaN));
  return type === 'float' ? NaN : undefined;
}

function length(v: Value): number {
  return typeof v === 'number' ? Math.abs(v) : Math.hypot(...(each(v, (x) => x) as number[]));
}

const unaryMath = (f: (x: number) => number) => (v: Value) => each(v, f);
const binaryMath = (f: (x: number, y: number) => number) => (a: Value, b: Value) => zip(a, b, f);

const BUILTINS: Record<string, (...args: Value[]) => Value> = {
  float: (x) => (typeof x === 'boolean' ? Number(x) : scalar(x)),
  int: (x) => Math.trunc(typeof x === 'boolean' ? Number(x) : scalar(x)),
  bool: (x) => (typeof x === 'boolean' ? x : scalar(x) !== 0),
  vec2: (...a) => construct(2, a),
  vec3: (...a) => construct(3, a),
  vec4: (...a) => construct(4, a),
  abs: unaryMath(Math.abs),
  sign: unaryMath(Math.sign),
  floor: unaryMath(Math.floor),
  ceil: unaryMath(Math.ceil),
  fract: unaryMath((x) => x - Math.floor(x)),
  sqrt: unaryMath(Math.sqrt),
  exp: unaryMath(Math.exp),
  exp2: unaryMath((x) => 2 ** x),
  log: unaryMath(Math.log),
  log2: unaryMath(Math.log2),
  sin: unaryMath(Math.sin),
  cos: unaryMath(Math.cos),
  min: binaryMath(Math.min),
  max: binaryMath(Math.max),
  pow: binaryMath(Math.pow),
  mod: binaryMath((x, y) => x - y * Math.floor(x / y)),
  step: binaryMath((edge, x) => (x < edge ? 0 : 1)),
  clamp: (x, lo, hi) => zip(zip(x, lo, Math.max), hi, Math.min),
  mix: (a, b, t) =>
    zip(
      zip(
        a,
        zip(1, t, (one, s) => one - s),
        (x, y) => x * y,
      ),
      zip(b, t, (x, y) => x * y),
      (x, y) => x + y,
    ),
  smoothstep: (e0, e1, x) =>
    zip(
      zip(x, e0, (v, a) => v - a),
      zip(e1, e0, (b, a) => b - a),
      (num, den) => {
        const t = Math.min(1, Math.max(0, num / den));
        return t * t * (3 - 2 * t);
      },
    ),
  length: (v) => length(v),
  distance: (a, b) => length(zip(a, b, (x, y) => x - y)),
  dot: (a, b) => {
    const p = zip(a, b, (x, y) => x * y);
    return typeof p === 'number' ? p : p.reduce((s, x) => s + x, 0);
  },
  normalize: (v) => {
    const l = length(v);
    return each(v, (x) => x / l);
  },
};

// ------------------------------------------------------------------ evaluation

interface Slot {
  type: string;
  value: Value;
  readonly: boolean;
}

class Scope {
  private readonly vars = new Map<string, Slot>();
  constructor(private readonly parent: Scope | null) {}
  declare(name: string, slot: Slot): void {
    if (this.vars.has(name)) throw new Error(`GLSL: '${name}' is declared twice`);
    this.vars.set(name, slot);
  }
  lookup(name: string): Slot {
    const slot = this.vars.get(name) ?? this.parent?.lookup(name);
    if (!slot) throw new Error(`GLSL: '${name}' is not declared`);
    return slot;
  }
}

const SWIZZLES = ['xyzw', 'rgba', 'stpq'];

function swizzle(field: string, size: number): number[] {
  const set = SWIZZLES.find((s) => s.includes(field[0]));
  const out = [...field].map((c) => set?.indexOf(c) ?? -1);
  if (field.length > 4 || out.some((i) => i < 0 || i >= size))
    throw new Error(`GLSL: no component '${field}' in a vec${size}`);
  return out;
}

function indexOf(v: Value, size: number): number {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) >= size)
    throw new Error(`GLSL: index ${String(v)} out of range 0 … ${size - 1}`);
  return v as number;
}

const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;
/** Most iterations of one loop (a runaway loop is an error, not a hang). */
const MAX_ITERATIONS = 1_000_000;

/** Options of {@link glslProgram}. */
export interface GlslOptions {
  /** Uniforms and built-in variables (gl_FragCoord, …) by name; read-only like in a shader. */
  globals?: Record<string, Value>;
  /** Names defined for #ifdef. */
  defines?: Iterable<string>;
  /** Functions implemented in JavaScript (texture lookups); they take precedence over the source's. */
  natives?: Record<string, (...args: any[]) => Value>;
}

/**
 * Parses the GLSL function definitions in `source` and returns a function that calls one of them
 * by name with JavaScript values (see the module comment), returning its result.
 */
export function glslProgram(
  source: string,
  options: GlslOptions = {},
): (name: string, ...args: Value[]) => Value {
  const functions = new Map<string, GlslFunction>();
  for (const f of new Parser(tokenize(preprocess(source, options.defines ?? []))).program()) {
    if (functions.has(f.name)) throw new Error(`GLSL: overloads of '${f.name}' are not supported`);
    functions.set(f.name, f);
  }
  const globals = new Scope(null);
  for (const [name, value] of Object.entries(options.globals ?? {}))
    globals.declare(name, { type: 'global', value, readonly: true });
  const natives = options.natives ?? {};

  const call = (name: string, args: Value[]): Value => {
    const native = natives[name];
    if (native) return native(...args);
    const f = functions.get(name);
    if (!f) {
      const builtin = BUILTINS[name];
      if (!builtin) throw new Error(`GLSL: unknown function '${name}'`);
      return builtin(...args);
    }
    if (args.length !== f.params.length)
      throw new Error(`GLSL: ${name} takes ${f.params.length} arguments, got ${args.length}`);
    const scope = new Scope(globals);
    f.params.forEach((p, i) =>
      scope.declare(p.name, { type: p.type, value: typed(p.type, clone(args[i])), readonly: false }),
    );
    const frame: { value?: Value } = {};
    const end = exec(f.body, scope, frame);
    if (f.type === 'void') return undefined;
    if (end !== RETURN) throw new Error(`GLSL: ${name} ends without returning a value`);
    return typed(f.type, frame.value);
  };

  const evaluate = (e: Expr, scope: Scope): Value => {
    switch (e.k) {
      case 'value':
        return e.v;
      case 'name':
        return scope.lookup(e.name).value;
      case 'call':
        return call(
          e.name,
          e.args.map((a) => evaluate(a, scope)),
        );
      case 'member': {
        const v = evaluate(e.e, scope);
        if (!isVector(v)) throw new Error(`GLSL: .${e.field} of ${describe(v)}`);
        const idx = swizzle(e.field, v.length);
        return idx.length === 1 ? v[idx[0]] : idx.map((i) => v[i]);
      }
      case 'index': {
        const v = evaluate(e.e, scope);
        if (!Array.isArray(v)) throw new Error(`GLSL: cannot index ${describe(v)}`);
        return clone(v[indexOf(evaluate(e.index, scope), v.length)]);
      }
      case 'unary': {
        const v = evaluate(e.e, scope);
        if (e.op === '!') return !condition(v);
        return e.op === '-' ? each(v, (x) => -x) : each(v, (x) => x);
      }
      case 'binary':
        return binary(e.op, e.a, e.b, scope);
      case 'ternary':
        return condition(evaluate(e.c, scope)) ? evaluate(e.a, scope) : evaluate(e.b, scope);
      case 'assign': {
        const v =
          e.op === '='
            ? evaluate(e.e, scope)
            : arithmetic(e.op[0], evaluate(e.target, scope), evaluate(e.e, scope));
        store(e.target, v, scope);
        return v;
      }
      case 'step': {
        const old = scalar(evaluate(e.target, scope));
        const now = e.op === '++' ? old + 1 : old - 1;
        store(e.target, now, scope);
        return e.prefix ? now : old;
      }
    }
  };

  const binary = (op: string, a: Expr, b: Expr, scope: Scope): Value => {
    if (op === '&&') return condition(evaluate(a, scope)) && condition(evaluate(b, scope));
    if (op === '||') return condition(evaluate(a, scope)) || condition(evaluate(b, scope));
    const x = evaluate(a, scope);
    const y = evaluate(b, scope);
    switch (op) {
      case '^^':
        return condition(x) !== condition(y);
      case '==':
      case '!=': {
        if (describe(x) !== describe(y)) throw new Error(`GLSL: ${describe(x)} ${op} ${describe(y)}`);
        const same = JSON.stringify(x) === JSON.stringify(y);
        return op === '==' ? same : !same;
      }
      case '<':
        return scalar(x) < scalar(y);
      case '>':
        return scalar(x) > scalar(y);
      case '<=':
        return scalar(x) <= scalar(y);
      case '>=':
        return scalar(x) >= scalar(y);
    }
    return arithmetic(op, x, y);
  };

  const arithmetic = (op: string, x: Value, y: Value): Value => {
    if (isMatrix(x) || isMatrix(y)) throw new Error('GLSL: matrix arithmetic is not supported');
    switch (op) {
      case '+':
        return zip(x, y, (p, q) => p + q);
      case '-':
        return zip(x, y, (p, q) => p - q);
      case '*':
        return zip(x, y, (p, q) => p * q);
      case '/':
        return zip(x, y, (p, q) => p / q);
    }
    throw new Error(`GLSL: operator '${op}' is not supported`);
  };

  /** The array a variable (or a matrix column of it) holds, to change components of in place. */
  const reference = (e: Expr, scope: Scope): number[] | number[][] => {
    if (e.k === 'name') {
      const slot = scope.lookup(e.name);
      if (slot.readonly) throw new Error(`GLSL: '${e.name}' is read-only`);
      if (!Array.isArray(slot.value)) throw new Error(`GLSL: '${e.name}' is a ${describe(slot.value)}`);
      return slot.value as number[] | number[][];
    }
    if (e.k === 'index') {
      const m = reference(e.e, scope);
      if (!isMatrix(m)) throw new Error('GLSL: only matrix columns can be indexed for writing');
      return m[indexOf(evaluate(e.index, scope), m.length)];
    }
    throw new Error('GLSL: not assignable');
  };

  const store = (target: Expr, v: Value, scope: Scope): void => {
    if (target.k === 'name') {
      const slot = scope.lookup(target.name);
      if (slot.readonly) throw new Error(`GLSL: '${target.name}' is read-only`);
      slot.value = typed(slot.type, clone(v));
      return;
    }
    if (target.k === 'member') {
      const vec = reference(target.e, scope);
      if (isMatrix(vec)) throw new Error(`GLSL: .${target.field} of a matrix`);
      const idx = swizzle(target.field, vec.length);
      const parts = idx.length === 1 ? [scalar(v)] : (typed(`vec${idx.length}`, v) as number[]);
      if (new Set(idx).size !== idx.length) throw new Error(`GLSL: .${target.field} repeats a component`);
      idx.forEach((i, j) => (vec[i] = parts[j]));
      return;
    }
    if (target.k === 'index') {
      const arr = reference(target.e, scope);
      const i = indexOf(evaluate(target.index, scope), arr.length);
      if (isMatrix(arr)) arr[i] = typed(`vec${arr.length}`, clone(v)) as number[];
      else (arr as number[])[i] = scalar(v);
      return;
    }
    throw new Error('GLSL: not assignable');
  };

  const exec = (s: Stmt, scope: Scope, frame: { value?: Value }): number => {
    switch (s.k) {
      case 'block': {
        const inner = new Scope(scope);
        for (const st of s.body) {
          const end = exec(st, inner, frame);
          if (end) return end;
        }
        return 0;
      }
      case 'decl':
        for (const v of s.vars)
          scope.declare(v.name, {
            type: s.type,
            value: v.init ? typed(s.type, clone(evaluate(v.init, scope))) : uninitialized(s.type),
            readonly: false,
          });
        return 0;
      case 'expr':
        evaluate(s.e, scope);
        return 0;
      case 'if':
        if (condition(evaluate(s.c, scope))) return exec(s.a, scope, frame);
        return s.b ? exec(s.b, scope, frame) : 0;
      case 'for':
      case 'while': {
        const loop = new Scope(scope);
        if (s.k === 'for' && s.init) exec(s.init, loop, frame);
        for (let n = 0; ; n++) {
          if (n > MAX_ITERATIONS) throw new Error('GLSL: runaway loop');
          if (s.c && !condition(evaluate(s.c, loop))) return 0;
          const end = exec(s.body, loop, frame);
          if (end === BREAK) return 0;
          if (end === RETURN) return end;
          if (s.k === 'for' && s.step) evaluate(s.step, loop);
        }
      }
      case 'break':
        return BREAK;
      case 'continue':
        return CONTINUE;
      case 'return':
        frame.value = s.e ? evaluate(s.e, scope) : undefined;
        return RETURN;
      case 'empty':
        return 0;
    }
  };

  return (name, ...args) => call(name, args);
}

/**
 * The definition of the function `name` in a shader source, from its return type to its closing
 * brace (to run with {@link glslProgram}).
 */
export function glslFunction(source: string, name: string): string {
  const head = new RegExp(`\\b(?:void|bool|int|float|vec[234]|mat[234])\\s+${name}\\s*\\(`).exec(source);
  if (!head) throw new Error(`GLSL: no function '${name}' in the source`);
  let depth = 0;
  for (let i = source.indexOf('{', head.index); i >= 0 && i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(head.index, i + 1);
  }
  throw new Error(`GLSL: unterminated function '${name}'`);
}
