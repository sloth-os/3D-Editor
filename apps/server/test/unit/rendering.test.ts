import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  AUTO_BROWSER_RASTER_TIMEOUT_MS,
  BROWSER_RASTER_TIMEOUT_MS,
  KEEP_ALIVE_MS,
  SLOW_EDITOR_RETRY_MS,
  browserRenderFailure,
  browserRenderTimeout,
  keepAlive,
  slowBrowserRaster,
} from '../../src/mcp/rendering';
import { RpcError, type Room, type RpcAnswer, type SyncConnection } from '../../src/sync/room';
import { MAX_EDITOR_TIMEOUT_MS, MAX_EDITOR_WAIT_MS } from '../../src/mcp/editor-commands';

/*
 * render_image waits for a browser editor's image: long enough for heavy scenes in software WebGL
 * when the browser renderer is asked for (but less than an MCP client's default request timeout),
 * briefly with 'auto' (which then renders on the server), and a timeout says what to do for the
 * render that was asked for. Requests that wait send keep-alive progress notifications.
 */

describe('browser render timeouts', () => {
  it('waits 55 s for RASTER with renderer browser, 15 s with auto, time_limit + 30 s for path tracing', () => {
    expect(BROWSER_RASTER_TIMEOUT_MS).toBe(55_000);
    expect(BROWSER_RASTER_TIMEOUT_MS).toBe(MAX_EDITOR_WAIT_MS);
    expect(AUTO_BROWSER_RASTER_TIMEOUT_MS).toBe(15_000);
    expect(browserRenderTimeout('browser', false, 30)).toBe(55_000);
    expect(browserRenderTimeout('auto', false, 30)).toBe(15_000);
    expect(browserRenderTimeout('browser', true, 7)).toBe(37_000);
  });

  it("answers before an MCP SDK client's default request timeout gives up", () => {
    // the server's error says what to do; a client's "Request timed out" does not
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC - BROWSER_RASTER_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC - MAX_EDITOR_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
  });

  const timeout = new RpcError("editor did not answer 'render' within 55000 ms", 'TIMEOUT');
  const raster = { renderer: 'browser', pathTrace: false, timeoutMs: 55_000, timeLimit: 30 } as const;

  it('says how long the server waited and what to do instead', () => {
    const browser = browserRenderFailure(timeout, raster);
    expect(browser.reason).toBe(
      'browser render failed: the editor did not finish the RASTER image within 55 s',
    );
    expect(browser.advice).toBe(
      'It may still be drawing it, and its next renders and commands wait until it has. A heavy scene takes ' +
        'tens of seconds in an editor without GPU acceleration (software WebGL, e.g. a headless browser): render ' +
        "on the server with renderer 'software' (or 'auto'), render a smaller image, or pass shading 'SOLID' " +
        '(grey clay, faster).',
    );
    const auto = browserRenderFailure(timeout, { ...raster, renderer: 'auto', timeoutMs: 15_000 });
    expect(auto.reason).toBe(
      "browser render failed: the editor did not finish the RASTER image within 15 s (renderer 'auto' waits 15 s " +
        "before it renders on the server; renderer 'browser' waits 55 s); it may still be drawing it, and until " +
        "it has, renderer 'auto' renders on the server without asking it",
    );
    const pt = browserRenderFailure(timeout, {
      ...raster,
      pathTrace: true,
      timeoutMs: 40_000,
      timeLimit: 10,
    });
    expect(pt.reason).toBe(
      'browser render failed: the editor did not finish path tracing within 40 s (time_limit 10 s + 30 s for loading, compiling and denoising)',
    );
    expect(pt.advice).toBe(
      "Its render workers may still be busy with it. Path trace on the server with renderer 'software' or 'auto' " +
        '(all its CPU cores), or lower time_limit or the image size.',
    );
    // other failures keep the editor's message
    const remote = browserRenderFailure(new RpcError('editor has no active viewport', 'REMOTE'), raster);
    expect(remote).toEqual({
      reason: 'browser render failed: editor has no active viewport',
      advice: "Use renderer 'software' to render on the server.",
    });
  });

  it('does not advise SOLID shading for a SOLID render, and names what the editor was still busy with', () => {
    const solid = browserRenderFailure(timeout, { ...raster, shading: 'SOLID' });
    expect(solid.advice).not.toMatch(/SOLID/);
    expect(solid.advice).toMatch(
      /render on the server with renderer 'software' \(or 'auto'\) or render a smaller image\.$/,
    );
    expect(browserRenderFailure(timeout, { ...raster, shading: 'MATERIAL' }).advice).toMatch(
      /pass shading 'SOLID' \(grey clay, faster\)\.$/,
    );
    const busy = browserRenderFailure(timeout, { ...raster, busy: 'a RASTER render sent 20 s ago' });
    expect(busy.reason).toBe(
      'browser render failed: the editor did not finish the RASTER image within 55 s (it was still busy with an ' +
        'earlier request that the server had stopped waiting for: a RASTER render sent 20 s ago)',
    );
  });
});

describe('slowBrowserRaster', () => {
  const conn = {} as SyncConnection;
  const now = 1_000_000;
  /** A room whose editor gave these answers to RASTER renders (by shading: '' for none). */
  function room(answers: Record<string, Partial<RpcAnswer>>): Room {
    return {
      lastAnswer: (_c: SyncConnection, kind: { shading?: string }) => {
        const a = answers[kind.shading ?? ''];
        return a
          ? ({
              method: 'render',
              engine: 'RASTER',
              sentAt: now - 30_000,
              tookMs: 1000,
              late: false,
              ...a,
            } as RpcAnswer)
          : null;
      },
    } as unknown as Room;
  }

  it('skips an editor whose last RASTER image came late or took longer than auto waits', () => {
    expect(slowBrowserRaster(room({ '': { tookMs: 21_000, late: true } }), conn, undefined, now)).toBe(
      'answered its last RASTER image after 21 s, when the server had stopped waiting for it',
    );
    expect(slowBrowserRaster(room({ MATERIAL: { tookMs: 20_000 } }), conn, 'MATERIAL', now)).toBe(
      "needed 20 s for its last RASTER image, longer than renderer 'auto' waits (15 s)",
    );
    // without a shading and with MATERIAL the editor draws the same: the more recent answer counts
    expect(
      slowBrowserRaster(
        room({ '': { tookMs: 20_000, sentAt: now - 60_000 }, MATERIAL: { tookMs: 900, sentAt: now - 5000 } }),
        conn,
        undefined,
        now,
      ),
    ).toBeNull();
  });

  it('asks a fast editor, and a slow one again after a while; SOLID is judged on its own', () => {
    expect(slowBrowserRaster(room({ '': { tookMs: 14_000 } }), conn, undefined, now)).toBeNull();
    expect(slowBrowserRaster(room({}), conn, undefined, now)).toBeNull();
    const old = { tookMs: 21_000, late: true, sentAt: now - SLOW_EDITOR_RETRY_MS - 21_000 };
    expect(slowBrowserRaster(room({ '': old }), conn, undefined, now)).toBeNull();
    expect(slowBrowserRaster(room({ '': { tookMs: 21_000, late: true } }), conn, 'SOLID', now)).toBeNull();
    expect(slowBrowserRaster(room({ SOLID: { tookMs: 16_000 } }), conn, 'SOLID', now)).toMatch(
      /^needed 16 s/,
    );
  });
});

describe('keepAlive', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The `extra` of a tool call, with or without a progress token. */
  function extra(progressToken?: number) {
    const sent: { progress: number; total?: number; message?: string }[] = [];
    return {
      sent,
      extra: {
        _meta: progressToken === undefined ? {} : { progressToken },
        sendNotification: vi.fn(
          async (n: { params: { progress: number; total?: number; message?: string } }) => {
            const { progress, total, message } = n.params;
            sent.push({ progress, total, message });
          },
        ),
      } as unknown as Parameters<typeof keepAlive>[0],
    };
  }

  it('sends a progress notification every interval until stopped', () => {
    vi.useFakeTimers();
    const { sent, extra: ex } = extra(7);
    const stop = keepAlive(ex, (s) => ({ progress: s, total: 60, message: `waiting: ${s} s` }));
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 2 + 100);
    expect(sent).toEqual([
      { progress: 5, total: 60, message: 'waiting: 5 s' },
      { progress: 10, total: 60, message: 'waiting: 10 s' },
    ]);
    stop();
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(sent).toHaveLength(2);
  });

  it('sends nothing to a request without a progress token', () => {
    vi.useFakeTimers();
    const { sent, extra: ex } = extra();
    const stop = keepAlive(ex, (s) => ({ progress: s, total: 60, message: 'x' }));
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    stop();
    expect(sent).toEqual([]);
  });
});
