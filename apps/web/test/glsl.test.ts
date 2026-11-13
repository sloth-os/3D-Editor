import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { glslFunction, glslProgram } from './glsl';

/*
 * The GLSL interpreter the shader tests run generated code with (glsl.ts): it must compute what a
 * GPU would, or reject what it does not understand, so a shader test can never pass by misreading.
 */

describe('GLSL interpreter', () => {
  it('runs three.js shader functions like the GPU', () => {
    const chunk = THREE.ShaderChunk.transmission_pars_fragment;
    const run = glslProgram(
      ['w0', 'w1', 'w2', 'w3', 'g0', 'h0', 'applyIorToRoughness']
        .map((n) => glslFunction(chunk, n))
        .join('\n'),
    );
    const w0 = (a: number) => (1 / 6) * (a * (a * (-a + 3) - 3) + 1);
    const w1 = (a: number) => (1 / 6) * (a * a * (3 * a - 6) + 4);
    for (const a of [0, 0.25, 0.7, 1]) {
      expect(run('w0', a)).toBeCloseTo(w0(a), 12);
      expect(run('h0', a)).toBeCloseTo(-1 + w1(a) / (w0(a) + w1(a)), 12);
      // the four cubic B-spline weights sum to one
      expect((['w0', 'w1', 'w2', 'w3'] as const).reduce((s, f) => s + (run(f, a) as number), 0)).toBeCloseTo(
        1,
        12,
      );
    }
    expect(run('applyIorToRoughness', 0.5, 1.25)).toBeCloseTo(0.25, 12);
    expect(run('applyIorToRoughness', 0.5, 3)).toBe(0.5);
  });

  it('computes with vectors, swizzles, loops and value semantics', () => {
    const run = glslProgram(`
      vec3 swap( const in vec3 v ) {
        vec3 w = v;
        w.xz = v.zx;
        w.y *= 2.0;
        return w;
      }
      float firstAbove( const in float limit ) {
        float found = -1.0;
        for ( int i = 0; i < 10; i ++ ) {
          if ( i == 2 ) continue;
          if ( float( i ) * 0.5 > limit ) { found = float( i ); break; }
        }
        return found;
      }
      vec4 mixed( vec2 a, float t ) {
        vec2 b = a;
        b.x = 10.0; // a copy: a keeps its value
        int n = 0;
        n += 2;
        float pre = float( ++n );
        return vec4( mix( a, b, t ), pre, t > 0.5 ? length( vec2( 3.0, 4.0 ) ) : -1.0 );
      }
      float matrixColumn( const in mat4 m ) { return length( m[ 3 ].xyz ) + m[ 0 ][ 0 ]; }
    `);
    expect(run('swap', [1, 2, 3])).toEqual([3, 4, 1]);
    expect(run('firstAbove', 0.6)).toBe(3);
    expect(run('firstAbove', 0.4)).toBe(1);
    expect(run('firstAbove', 0.9)).toBe(3);
    expect(run('firstAbove', 9)).toBe(-1);
    expect(run('mixed', [2, 4], 0.75)).toEqual([8, 4, 3, 5]);
    expect(run('mixed', [2, 4], 0.25)).toEqual([4, 4, 3, -1]);
    const m = new THREE.Matrix4().makeTranslation(2, 3, 6);
    const columns = [0, 1, 2, 3].map((c) => m.elements.slice(c * 4, c * 4 + 4));
    expect(run('matrixColumn', columns)).toBe(8);
  });

  it('applies #ifdef, #ifndef, #else and #define', () => {
    const src = `
      float f() {
        #define A
        #ifdef A
          #ifndef B
            return 1.0;
          #else
            return 2.0;
          #endif
        #endif
        return 3.0;
      }`;
    expect(glslProgram(src)('f')).toBe(1);
    expect(glslProgram(src, { defines: ['B'] })('f')).toBe(2);
    // an #if inside a skipped block is skipped with it
    const skipped = `float g() {
      #ifdef C
        #if defined( D )
          return 1.0;
        #endif
      #endif
      return 0.0;
    }`;
    expect(glslProgram(skipped)('g')).toBe(0);
  });

  it('rejects what it does not model instead of guessing', () => {
    const fails =
      (src: string, ...args: unknown[]) =>
      () =>
        glslProgram(src)('f', ...args);
    expect(fails('vec2 f() { vec2 v = vec3( 1.0 ); return v; }')).toThrow(/expected vec2, got vec3/);
    expect(fails('float f( float x ) { if ( x ) return 1.0; return 0.0; }', 1)).toThrow(/must be a bool/);
    expect(fails('float f() { return unknownFunction( 1.0 ); }')).toThrow(/unknown function/);
    expect(fails('float f() { return u; }')).toThrow(/'u' is not declared/);
    expect(fails('void f( out float x ) { x = 1.0; }')).toThrow(/out parameters/);
    expect(fails('float f() {\n#if 1\nreturn 1.0;\n#endif\n}')).toThrow(/not supported/);
    expect(fails('vec2 f() { return vec2( 1.0, 2.0, 3.0 ); }')).toThrow(/too many arguments/);
    expect(
      fails(
        'vec3 f( mat3 m, vec3 v ) { return m * v; }',
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        [1, 2, 3],
      ),
    ).toThrow(/matrix/);
    // uniforms are read-only
    expect(() => glslProgram('void f() { u = 1.0; }', { globals: { u: 0 } })('f')).toThrow(/read-only/);
    // a function that falls off its end without returning
    expect(fails('float f() { }')).toThrow(/without returning/);
  });
});
