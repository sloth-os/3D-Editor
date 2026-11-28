import { describe, expect, it } from 'vitest';
import { corsAllowedOrigin } from '../../src/app';

/*
 * The origins a CORS answer allows (CORS_ORIGINS): an Origin header is compared without its trailing
 * slashes, in time linear in its length (a regular expression such as /\/+$/ takes quadratic time on
 * a long run of slashes followed by another character, and the header comes with every request).
 */

describe('corsAllowedOrigin', () => {
  const origins = ['https://app.example.com', 'http://localhost:5173'];

  it('allows the configured origins, with or without trailing slashes, and nothing else', () => {
    expect(corsAllowedOrigin('https://app.example.com', origins)).toBe('https://app.example.com');
    expect(corsAllowedOrigin('https://app.example.com//', origins)).toBe('https://app.example.com//');
    expect(corsAllowedOrigin('http://localhost:5173', origins)).toBe('http://localhost:5173');
    for (const origin of [undefined, '', 'https://evil.example', 'https://app.example.com.evil', 'null'])
      expect(corsAllowedOrigin(origin, origins), String(origin)).toBeNull();
    expect(corsAllowedOrigin('https://app.example.com', [])).toBeNull();
    expect(corsAllowedOrigin('https://anything.example', ['*'])).toBe('*');
  });

  it('reads a long run of slashes in an Origin header in linear time', () => {
    const origin = `https://app.example.com${'/'.repeat(200_000)}x`;
    const start = performance.now();
    const allowed = [
      corsAllowedOrigin(origin, origins),
      corsAllowedOrigin(`${'/'.repeat(200_000)}x`, origins),
    ];
    const ms = performance.now() - start;
    expect(allowed).toEqual([null, null]);
    // about 20 s with /\/+$/ on a laptop, well under a millisecond in one pass
    expect(ms).toBeLessThan(1000);
  });
});
