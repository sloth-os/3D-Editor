import { describe, expect, it } from 'vitest';
import {
  acceptedTokens,
  extractToken,
  isAuthorized,
  redactUrl,
  safeEqual,
  scopeForPath,
} from '../../src/auth';

const both = { authToken: 'master', mcpToken: 'agent' };

describe('auth', () => {
  it('classifies protected paths', () => {
    expect(scopeForPath('/api/projects')).toBe('api');
    expect(scopeForPath('/api')).toBe('api');
    expect(scopeForPath('/sync/abc')).toBe('sync');
    expect(scopeForPath('/mcp')).toBe('mcp');
    expect(scopeForPath('/dav/x/y')).toBe('dav');
    expect(scopeForPath('/otlp/v1/traces')).toBe('otlp');
    expect(scopeForPath('/apiary')).toBeNull();
    expect(scopeForPath('/')).toBeNull();
    expect(scopeForPath('/metrics')).toBeNull();
    expect(scopeForPath('/healthz')).toBeNull();
    expect(scopeForPath('/assets/app.js')).toBeNull();
  });

  it('extracts bearer tokens and ?token=', () => {
    expect(extractToken({ authorization: 'Bearer abc' }, '/api')).toBe('abc');
    expect(extractToken({ authorization: 'bearer   xyz ' }, '/api')).toBe('xyz');
    expect(extractToken({ authorization: 'Basic Zm9vOmJhcg==' }, '/api')).toBeNull();
    expect(extractToken({}, '/sync/p?foo=1&token=t%20k')).toBe('t k');
    expect(extractToken({}, '/sync/p')).toBeNull();
  });

  it('accepts the shared secret everywhere and the MCP token on /mcp only', () => {
    expect(acceptedTokens(both, 'api')).toEqual(['master']);
    expect(acceptedTokens(both, 'mcp')).toEqual(['master', 'agent']);
    expect(acceptedTokens({ authToken: null, mcpToken: 'agent' }, 'api')).toEqual([]);

    expect(isAuthorized(both, '/api/projects', { authorization: 'Bearer master' }, '/api/projects')).toBe(
      true,
    );
    expect(isAuthorized(both, '/api/projects', { authorization: 'Bearer agent' }, '/api/projects')).toBe(
      false,
    );
    expect(isAuthorized(both, '/mcp', { authorization: 'Bearer agent' }, '/mcp')).toBe(true);
    expect(isAuthorized(both, '/mcp', {}, '/mcp?token=master')).toBe(true);
    expect(isAuthorized(both, '/mcp', {}, '/mcp')).toBe(false);
    expect(isAuthorized(both, '/sync/p1', {}, '/sync/p1?token=wrong')).toBe(false);
    expect(isAuthorized(both, '/healthz', {}, '/healthz')).toBe(true);
    expect(isAuthorized(both, '/index.html', {}, '/index.html')).toBe(true);
    // MCP token alone protects only /mcp
    const mcpOnly = { authToken: null, mcpToken: 'agent' };
    expect(isAuthorized(mcpOnly, '/api/projects', {}, '/api/projects')).toBe(true);
    expect(isAuthorized(mcpOnly, '/mcp', {}, '/mcp')).toBe(false);
    // no secrets: open
    expect(isAuthorized({ authToken: null, mcpToken: null }, '/mcp', {}, '/mcp')).toBe(true);
  });

  it('compares in constant time and redacts tokens from URLs', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(redactUrl('/sync/p?token=abc&x=1')).toBe('/sync/p?token=[REDACTED]&x=1');
    expect(redactUrl('/api?x=1&token=abc')).toBe('/api?x=1&token=[REDACTED]');
    expect(redactUrl('/api')).toBe('/api');
  });
});
