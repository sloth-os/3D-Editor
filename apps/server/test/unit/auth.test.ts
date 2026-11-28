import { describe, expect, it } from 'vitest';
import {
  acceptedTokens,
  extractToken,
  isAuthorized,
  redactUrl,
  routedPath,
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

  it('reads the scope from the route that serves a request, else from its path', () => {
    /** A request as the auth hook sees it, routed to `route` (undefined: no route). */
    const routed = (url: string, route: string | undefined, params: Record<string, string> = {}) =>
      routedPath({
        url,
        params,
        is404: route === undefined,
        routeOptions: { url: route } as never,
      });
    // the route's pattern, whatever spelling of the path reached it
    expect(routed('/%61pi/projects/p1', '/api/projects/:id', { id: 'p1' })).toBe('/api/projects/:id');
    expect(routed('/%6dcp', '/mcp')).toBe('/mcp');
    // a wildcard route with what its `*` matched (decoded by the router)
    expect(routed('/%64av/x/y', '/dav/*', { '*': 'x/y' })).toBe('/dav/x/y');
    expect(routed('/%61pi/nothing', '/*', { '*': 'api/nothing' })).toBe('/api/nothing');
    expect(routed('/assets/app.js', '/*', { '*': 'assets/app.js' })).toBe('/assets/app.js');
    expect(routed('/x', '/*')).toBe('/');
    // no route (the not-found handler): the path, without its query
    expect(routed('/api/nothing?x=1', undefined)).toBe('/api/nothing');
    expect(scopeForPath(routed('/%61pi/projects/p1', '/api/projects/:id', { id: 'p1' }))).toBe('api');
    expect(scopeForPath(routed('/%73ync/p1', '/sync/:projectId', { projectId: 'p1' }))).toBe('sync');
    expect(scopeForPath(routed('/%6ftlp/v1/traces', '/otlp/v1/:signal', { signal: 'traces' }))).toBe('otlp');
    expect(scopeForPath(routed('/%64av', '/dav'))).toBe('dav');
    expect(scopeForPath(routed('/healthz', '/healthz'))).toBeNull();
  });

  it('compares in constant time and redacts tokens from URLs', () => {
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
    expect(redactUrl('/sync/p?token=abc&x=1')).toBe('/sync/p?token=[REDACTED]&x=1');
    expect(redactUrl('/api?x=1&token=abc')).toBe('/api?x=1&token=[REDACTED]');
    expect(redactUrl('/api')).toBe('/api');
  });
});
