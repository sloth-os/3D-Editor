import { describe, expect, it } from 'vitest';
import {
  EXPRESSION_FUNCTIONS,
  EXPRESSION_SYNTAX_HELP,
  ExpressionError,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_LENGTH,
  compileExpression,
  evaluateExpression,
  gradientNoise3,
  hash01,
  isReservedName,
  noise1,
  tryCompileExpression,
  variableNameError,
} from '../src/anim/expression';

const ev = (src: string, vars?: Record<string, number>) => evaluateExpression(src, vars);

/** The ExpressionError thrown by `fn` (fails the test when nothing or something else is thrown). */
function errorOf(fn: () => unknown): ExpressionError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ExpressionError);
    return e as ExpressionError;
  }
  throw new Error('expected an ExpressionError');
}

describe('expression literals and arithmetic', () => {
  it('parses number literals', () => {
    expect(ev('42')).toBe(42);
    expect(ev('3.25')).toBe(3.25);
    expect(ev('.5')).toBe(0.5);
    expect(ev('2.')).toBe(2);
    expect(ev('1e3')).toBe(1000);
    expect(ev('1.5E-2')).toBe(0.015);
    expect(ev('  7\t\n')).toBe(7);
  });

  it('follows Python operator precedence and associativity', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('10 - 4 - 3')).toBe(3);
    expect(ev('100 / 10 / 5')).toBe(2);
    expect(ev('2 ** 3 ** 2')).toBe(512);
    expect(ev('-2 ** 2')).toBe(-4);
    expect(ev('(-2) ** 2')).toBe(4);
    expect(ev('2 ** -1')).toBe(0.5);
    expect(ev('-x ** 2', { x: 3 })).toBe(-9);
    expect(ev('2 * 3 % 4')).toBe(2);
    expect(ev('--3')).toBe(3);
    expect(ev('+-+3')).toBe(-3);
    expect(ev('1 + 1 == 2')).toBe(1);
    expect(ev('1 + 2 if 0 else 3 + 4')).toBe(7);
  });

  it('uses Python division, floor division and modulo semantics', () => {
    expect(ev('7 / 2')).toBe(3.5);
    expect(ev('7 // 2')).toBe(3);
    expect(ev('-7 // 2')).toBe(-4);
    expect(ev('7 % 3')).toBe(1);
    expect(ev('-7 % 3')).toBe(2);
    expect(ev('7 % -3')).toBe(-2);
    expect(ev('5.5 % 2')).toBe(1.5);
    expect(ev('mod(-1, 4)')).toBe(3);
    expect(ev('fmod(-1, 4)')).toBe(-1);
  });

  it('chains comparisons and returns 1/0', () => {
    expect(ev('1 < 2')).toBe(1);
    expect(ev('2 < 1')).toBe(0);
    expect(ev('1 < 2 < 3')).toBe(1);
    expect(ev('1 < 3 < 2')).toBe(0);
    expect(ev('3 >= 3 > 2 != 5')).toBe(1);
    expect(ev('1 == 1.0')).toBe(1);
    expect(ev('0.1 + 0.2 == 0.3')).toBe(0);
    expect(ev('2 <= 1')).toBe(0);
  });

  it('short-circuits and/or and yields operands like Python', () => {
    expect(ev('0 or 5')).toBe(5);
    expect(ev('3 or 5')).toBe(3);
    expect(ev('0 and 5')).toBe(0);
    expect(ev('2 and 5')).toBe(5);
    expect(ev('0 and 1 / 0')).toBe(0);
    expect(ev('1 or 1 / 0')).toBe(1);
    expect(ev('1 && 0 || 2')).toBe(2);
    expect(ev('not 0')).toBe(1);
    expect(ev('not 3')).toBe(0);
    expect(ev('not 1 == 2')).toBe(1);
    expect(ev('!0 + 1')).toBe(2);
    expect(ev('not 0 and 0')).toBe(0);
    expect(ev('True + True')).toBe(2);
    expect(ev('False or True')).toBe(1);
  });

  it('evaluates Python and C style conditionals', () => {
    expect(ev('1 if 1 else 2')).toBe(1);
    expect(ev('1 if 0 else 2')).toBe(2);
    expect(ev('1 if 0 else 2 if 0 else 3')).toBe(3);
    expect(ev('x > 0 ? 1 : -1', { x: -5 })).toBe(-1);
    expect(ev('x > 0 ? 1 : x < 0 ? -1 : 0', { x: 0 })).toBe(0);
    // the branch not taken is never evaluated
    expect(ev('1 if 1 else 1 / 0')).toBe(1);
  });
});

describe('expression functions and constants', () => {
  it('provides the math library', () => {
    expect(ev('sin(pi / 2)')).toBeCloseTo(1, 12);
    expect(ev('cos(0)')).toBe(1);
    expect(ev('tan(pi / 4)')).toBeCloseTo(1, 12);
    expect(ev('asin(1)')).toBeCloseTo(Math.PI / 2, 12);
    expect(ev('acos(1)')).toBe(0);
    expect(ev('atan(1)')).toBeCloseTo(Math.PI / 4, 12);
    expect(ev('atan2(1, -1)')).toBeCloseTo((3 * Math.PI) / 4, 12);
    expect(ev('sqrt(16)')).toBe(4);
    expect(ev('abs(-3)')).toBe(3);
    expect(ev('min(3, 1, 2)')).toBe(1);
    expect(ev('max(3, 1, 2)')).toBe(3);
    expect(ev('min(4)')).toBe(4);
    expect(ev('pow(2, 10)')).toBe(1024);
    expect(ev('exp(0)')).toBe(1);
    expect(ev('log(e)')).toBeCloseTo(1, 12);
    expect(ev('log(8, 2)')).toBeCloseTo(3, 12);
    expect(ev('log10(1000)')).toBeCloseTo(3, 12);
    expect(ev('floor(-1.5)')).toBe(-2);
    expect(ev('ceil(1.2)')).toBe(2);
    expect(ev('trunc(-1.7)')).toBe(-1);
    expect(ev('hypot(3, 4)')).toBe(5);
    expect(ev('sign(-3) + sign(0) + sign(9)')).toBe(0);
    expect(ev('fract(1.25)')).toBe(0.25);
    expect(ev('fract(-0.25)')).toBe(0.75);
    expect(ev('radians(180)')).toBeCloseTo(Math.PI, 12);
    expect(ev('degrees(pi)')).toBeCloseTo(180, 12);
    expect(ev('tau')).toBeCloseTo(2 * Math.PI, 12);
    expect(ev('e')).toBe(Math.E);
  });

  it('rounds half to even like Python', () => {
    expect(ev('round(2.5)')).toBe(2);
    expect(ev('round(3.5)')).toBe(4);
    expect(ev('round(-2.5)')).toBe(-2);
    expect(ev('round(2.6)')).toBe(3);
    expect(ev('round(1.2345, 2)')).toBeCloseTo(1.23, 12);
    expect(ev('round(1234, -2)')).toBe(1200);
  });

  it('clamps, interpolates and steps', () => {
    expect(ev('clamp(1.5)')).toBe(1);
    expect(ev('clamp(-0.5)')).toBe(0);
    expect(ev('clamp(-1, 0, 2)')).toBe(0);
    expect(ev('clamp(5, 0, 2)')).toBe(2);
    expect(ev('clamp(1.5, 0, 2)')).toBe(1.5);
    expect(ev('lerp(0, 10, 0.25)')).toBe(2.5);
    expect(ev('lerp(2, 4, 1.5)')).toBe(5);
    expect(ev('smoothstep(0, 1, 0.5)')).toBe(0.5);
    expect(ev('smoothstep(0, 1, -1)')).toBe(0);
    expect(ev('smoothstep(0, 1, 2)')).toBe(1);
    expect(ev('smoothstep(0, 2, 0.5)')).toBeCloseTo(0.15625, 12);
    expect(ev('smoothstep(1, 1, 0.5)')).toBe(0);
    expect(ev('smoothstep(1, 1, 1)')).toBe(1);
  });

  it('has deterministic smooth noise and hash/random', () => {
    const a = ev('noise(frame / 10)', { frame: 17 });
    expect(a).toBe(ev('noise(frame / 10)', { frame: 17 }));
    expect(a).toBe(noise1(1.7));
    // smooth: neighbouring samples are close, different seeds differ
    expect(Math.abs(noise1(3.001) - noise1(3))).toBeLessThan(0.01);
    expect(noise1(3.3, 1)).not.toBe(noise1(3.3, 2));
    let lo = Infinity;
    let hi = -Infinity;
    let nonZero = 0;
    for (let i = 0; i < 2000; i++) {
      const v = noise1(i * 0.37);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      if (Math.abs(noise1(i)) > 1e-3) nonZero++;
    }
    expect(lo).toBeGreaterThanOrEqual(-1);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hi - lo).toBeGreaterThan(0.8);
    // gradient noise vanishes on its lattice: integer frames must not all give 0
    expect(nonZero).toBeGreaterThan(1900);

    const h = ev('hash(3)');
    expect(h).toBe(hash01(3));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(1);
    expect(ev('hash(3, 4)')).not.toBe(ev('hash(4, 3)'));
    expect(ev('hash(0)')).toBe(ev('hash(-0)'));
    const r = ev('random(5, 10, 20)');
    expect(r).toBeGreaterThanOrEqual(10);
    expect(r).toBeLessThan(20);
    expect(ev('random(5)')).toBe(ev('random(5)'));
    // roughly uniform
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += ev('random(s)', { s: i });
    expect(sum / 4000).toBeCloseTo(0.5, 1);
    expect(Math.abs(gradientNoise3(1, 2, 3))).toBeLessThan(1e-12);
    expect(gradientNoise3(1.5, 2.25, 3.75, 7)).toBe(gradientNoise3(1.5, 2.25, 3.75, 7));
  });

  it('documents every function in the syntax help', () => {
    for (const f of EXPRESSION_FUNCTIONS) expect(EXPRESSION_SYNTAX_HELP).toContain(f.signature);
    for (const name of ['sin', 'noise', 'random', 'hash', 'smoothstep', 'lerp', 'clamp', 'atan2'])
      expect(EXPRESSION_FUNCTIONS.some((f) => f.name === name)).toBe(true);
  });
});

describe('expression variables', () => {
  it('reads variables from maps, functions and plain records', () => {
    expect(evaluateExpression('a * 2 + b', new Map([['a', 3], ['b', 1]]))).toBe(7);
    expect(evaluateExpression('frame / 2', (n) => (n === 'frame' ? 10 : undefined))).toBe(5);
    expect(evaluateExpression('x - y', { x: 5, y: 2 })).toBe(3);
    // a variable may shadow a constant
    expect(evaluateExpression('pi', { pi: 3 })).toBe(3);
  });

  it('reports the names and functions an expression uses', () => {
    const c = compileExpression('sin(frame) * amp + max(a, amp, pi)');
    expect(c.names).toEqual(['frame', 'amp', 'a', 'pi']);
    expect(c.functions).toEqual(['sin', 'max']);
  });

  it('fails for unknown names with their position', () => {
    const e = errorOf(() => ev('1 + speed'));
    expect(e.message).toMatch(/Unknown name 'speed' at column 5/);
    expect(e.position).toBe(4);
    expect(e.source).toBe('1 + speed');
  });
});

describe('expression errors', () => {
  const cases: [string, RegExp, number][] = [
    ['1 +', /Unexpected end of the expression/, 3],
    ['(1 + 2', /Expected '\)' to close the '\(' at column 1/, 6],
    ['1 2', /Unexpected number '2'/, 2],
    ['sin(1, 2)', /sin\(\) takes exactly 1 argument \(2 given\)/, 0],
    ['clamp(1, 2)', /clamp\(\) takes 1 or 3 arguments \(2 given\)/, 0],
    ['min()', /min\(\) takes at least 1 argument \(0 given\)/, 0],
    ['foo(1)', /Unknown function 'foo'/, 0],
    ['pi(2)', /'pi' is a constant, not a function/, 0],
    ['a.b', /Attribute access/, 1],
    ['x[0]', /Indexing/, 1],
    ['"text"', /Strings are not supported/, 0],
    ['x = 1', /Assignment/, 2],
    ['2 ^ 3', /use '\*\*'/, 2],
    ['0x10', /Hexadecimal/, 0],
    ['2x', /Write multiplication explicitly/, 0],
    ['1 $ 2', /Unexpected character '\$'/, 2],
    ['1 if 2', /Expected 'else'/, 6],
    ['1 ? 2', /Expected ':'/, 5],
    ['lambda: 1', /'lambda' is not supported/, 0],
    ['None', /'None' is not supported/, 0],
    ['1 << 2', /Bitwise shifts/, 2],
    ['a; b', /single expression/, 1],
    ['sin(1,,)', /Unexpected ','/, 6],
    ['', /Expression is empty/, -1],
    ['   ', /Expression is empty/, -1],
  ];
  for (const [src, re, pos] of cases)
    it(`rejects ${JSON.stringify(src)}`, () => {
      const e = errorOf(() => compileExpression(src));
      expect(e.message).toMatch(re);
      expect(e.position).toBe(pos);
    });

  it('raises math errors at evaluation time with the operator position', () => {
    const div = errorOf(() => ev('1 + 2 / (x - 1)', { x: 1 }));
    expect(div.message).toMatch(/division by zero at column 7/);
    expect(div.position).toBe(6);
    expect(errorOf(() => ev('5 // 0')).message).toMatch(/division by zero/);
    expect(errorOf(() => ev('5 % 0')).message).toMatch(/modulo by zero/);
    expect(errorOf(() => ev('sqrt(-1)')).message).toMatch(/math domain error/);
    expect(errorOf(() => ev('log(0)')).message).toMatch(/math domain error/);
    expect(errorOf(() => ev('asin(2)')).message).toMatch(/math domain error/);
    expect(errorOf(() => ev('0 ** -1')).message).toMatch(/negative power/);
    expect(errorOf(() => ev('(-8) ** (1/3)')).message).toMatch(/fractional power/);
    expect(errorOf(() => ev('mod(1, 0)')).message).toMatch(/mod\(\) by zero/);
    expect(errorOf(() => ev('round(1.5, 0.5)')).message).toMatch(/ndigits must be an integer/);
  });

  it('accepts trailing commas in calls like Python', () => {
    expect(ev('max(1, 2,)')).toBe(2);
  });

  it('bounds the source length and nesting depth', () => {
    const long = '1+'.repeat(MAX_EXPRESSION_LENGTH / 2) + '1';
    expect(errorOf(() => compileExpression(long)).message).toMatch(/too long/);
    const flat = '1+'.repeat(1500) + '1';
    expect(ev(flat)).toBe(1501);
    const ok = '('.repeat(MAX_EXPRESSION_DEPTH - 2) + '1' + ')'.repeat(MAX_EXPRESSION_DEPTH - 2);
    expect(ev(ok)).toBe(1);
    const deep = '('.repeat(MAX_EXPRESSION_DEPTH + 5) + '1' + ')'.repeat(MAX_EXPRESSION_DEPTH + 5);
    expect(errorOf(() => compileExpression(deep)).message).toMatch(/nested too deeply/);
    expect(errorOf(() => compileExpression('-'.repeat(200) + '1')).message).toMatch(/nested too deeply/);
    expect(errorOf(() => compileExpression('2' + '**2'.repeat(200))).message).toMatch(/nested too deeply/);
    expect(errorOf(() => compileExpression('not '.repeat(200) + '1')).message).toMatch(/nested too deeply/);
    expect(errorOf(() => compileExpression('abs('.repeat(100) + '1' + ')'.repeat(100))).message).toMatch(
      /nested too deeply/,
    );
    expect(errorOf(() => compileExpression('1 if 1 else '.repeat(100) + '1')).message).toMatch(
      /nested too deeply/,
    );
  });

  it('rejects non-string sources', () => {
    expect(errorOf(() => compileExpression(42 as unknown as string)).message).toMatch(/must be a string/);
  });
});

describe('expression sandbox', () => {
  it('cannot reach object prototypes or globals', () => {
    for (const src of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'globalThis', 'process', 'Math'])
      expect(errorOf(() => ev(src, {})).message).toMatch(/Unknown name/);
    for (const src of ['toString(1)', 'constructor(1)', 'eval(1)', 'Function(1)', 'require(1)'])
      expect(errorOf(() => compileExpression(src)).message).toMatch(/Unknown function/);
    expect(errorOf(() => compileExpression('__proto__')).message).toMatch(/starting with '_'/);
    expect(errorOf(() => compileExpression('_x + 1')).message).toMatch(/starting with '_'/);
    expect(errorOf(() => compileExpression('constructor.constructor')).message).toMatch(/Attribute access/);
    expect(errorOf(() => compileExpression('a["constructor"]')).message).toMatch(/Indexing/);
    expect(errorOf(() => compileExpression('(1).constructor')).message).toMatch(/Attribute access/);
    // plain records only contribute their own properties
    const vars = Object.create({ inherited: 5 }) as Record<string, number>;
    expect(errorOf(() => ev('inherited', vars)).message).toMatch(/Unknown name 'inherited'/);
    expect(ev('pi', Object.create(null) as Record<string, number>)).toBe(Math.PI);
  });
});

describe('expression compilation cache', () => {
  it('compiles once per source, including failures', () => {
    const a = compileExpression('frame * 2');
    expect(compileExpression('frame * 2')).toBe(a);
    expect(a.evaluate(new Map([['frame', 4]]))).toBe(8);
    expect(a.evaluate(new Map([['frame', 5]]))).toBe(10);
    const e1 = errorOf(() => compileExpression('1 +'));
    const e2 = errorOf(() => compileExpression('1 +'));
    expect(e2).toBe(e1);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('offers a non-throwing compile', () => {
    const ok = tryCompileExpression('1 + 1');
    expect(ok.ok && ok.expression.evaluate()).toBe(2);
    const bad = tryCompileExpression('1 +');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.position).toBe(3);
  });
});

describe('variable names', () => {
  it('validates driver variable names', () => {
    expect(variableNameError('var')).toBeNull();
    expect(variableNameError('loc_x2')).toBeNull();
    expect(variableNameError('')).toMatch(/empty/);
    expect(variableNameError('2a')).toMatch(/Invalid variable name/);
    expect(variableNameError('_a')).toMatch(/Invalid variable name/);
    expect(variableNameError('a-b')).toMatch(/Invalid variable name/);
    expect(variableNameError('frame')).toMatch(/reserved for the current frame/);
    expect(variableNameError('if')).toMatch(/keyword/);
    expect(variableNameError('sin')).toMatch(/built-in function/);
    expect(variableNameError('pi')).toMatch(/built-in constant/);
    expect(variableNameError('x'.repeat(65))).toMatch(/longer than 64/);
    expect(isReservedName('max')).toBe(true);
    expect(isReservedName('speed')).toBe(false);
  });
});
