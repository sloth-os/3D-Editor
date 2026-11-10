import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  SceneDoc,
  SceneEvaluator,
  createEditorState,
  createOperatorRegistry,
  exportScene,
  type EvaluatedScene,
  type OperatorContext,
} from '@3d-editor/core';
import {
  ANIMATION_OUT_OF_MEMORY_ADVICE,
  AUTO_BROWSER_RASTER_TIMEOUT_MS,
  BROWSER_RASTER_TIMEOUT_MS,
  EXPORT_OUT_OF_MEMORY_ADVICE,
  OUT_OF_MEMORY_ADVICE,
  KEEP_ALIVE_MS,
  SLOW_EDITOR_RETRY_MS,
  browserRenderFailure,
  browserRenderTimeout,
  keepAlive,
  noteBrowserRaster,
  SCALE_UP_MIN_MS,
  slowBrowserRaster,
} from '../../src/mcp/rendering';
import { RpcError, type Room, type RpcAnswer, type SyncConnection } from '../../src/sync/room';
import { MAX_EDITOR_TIMEOUT_MS, MAX_EDITOR_WAIT_MS } from '../../src/mcp/editor-commands';
import { BROWSER_RASTER_SECONDS, measured } from '../../src/mcp/editor-costs';

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
    // what such an editor took for its images (editor-costs.ts), not 'tens of seconds' without a range
    expect(browser.advice).toBe(
      'It may still be drawing it, and its next renders and commands wait until it has. An editor without GPU ' +
        `acceleration (e.g. a headless browser) took ${measured(BROWSER_RASTER_SECONDS)}, and ` +
        "longer for heavier scenes: render on the server with renderer 'software' (or 'auto'), render a smaller " +
        "image, or pass shading 'SOLID' (grey clay, faster).",
    );
    // software WebGL is named once (measured() says where the times were measured)
    expect(browser.advice.match(/software WebGL/g)).toHaveLength(1);
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

  it("ends the editor's reason without its own period, so the error reads as sentences", () => {
    // the editor's refusal of a path trace that would not fit into its tab ends a sentence, and
    // render_image joins reason and advice with '. ' (it read '…RASTER engine.. Use renderer …')
    const refusal = new RpcError(
      'Path tracing was not started: it needs about 4.3 GB of memory with one render thread … Lower the ' +
        'resolution or the triangles (subdivision levels, render visibility), or render with the RASTER engine.',
      'REMOTE',
    );
    const failure = browserRenderFailure(refusal, { ...raster, pathTrace: true });
    expect(failure.reason).toBe(
      'browser render failed: Path tracing was not started: it needs about 4.3 GB of memory with one render ' +
        'thread … Lower the resolution or the triangles (subdivision levels, render visibility), or render with ' +
        'the RASTER engine',
    );
    expect(`${failure.reason}. ${failure.advice}`).toMatch(
      /RASTER engine\. Use renderer 'software' to render on the server\.$/,
    );
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

  it('scales the time of a slow image to the size of the next one (time per pixel)', () => {
    // an editor that answered a 2048 × 2048 image after 32 s (renderer 'auto' had stopped waiting)
    const editor = {} as SyncConnection;
    const sentAt = now - 40_000;
    noteBrowserRaster(editor, 1280, 720, sentAt - 60_000);
    noteBrowserRaster(editor, 2048, 2048, sentAt);
    const slow = room({ '': { tookMs: 32_000, late: true, sentAt } });
    // 1280 × 720 is 22 % of its pixels: about 7 s, which 'auto' waits for
    expect(slowBrowserRaster(slow, editor, undefined, now, 1280 * 720)).toBeNull();
    // 1920 × 1080: about 16 s
    expect(slowBrowserRaster(slow, editor, undefined, now, 1920 * 1080)).toBe(
      "needed 32 s for its last RASTER image (4,194,304 pixels), about 16 s for this image's 2,073,600 pixels, " +
        "longer than renderer 'auto' waits (15 s)",
    );
    // as large or larger: at least as long, as before
    expect(slowBrowserRaster(slow, editor, undefined, now, 2048 * 2048)).toBe(
      'answered its last RASTER image after 32 s, when the server had stopped waiting for it',
    );
    // an image whose size was not noted (asked for by another server, or long ago): as before
    expect(slowBrowserRaster(slow, {} as SyncConnection, undefined, now, 1280 * 720)).toBe(
      'answered its last RASTER image after 32 s, when the server had stopped waiting for it',
    );
    // after a fast image that took a third of what 'auto' waits or more, a larger one scaled up:
    // 12.5 s for 1280 × 720 make about 28 s for 1920 × 1080, and 1280 × 1024 about 18 s
    const fast = {} as SyncConnection;
    noteBrowserRaster(fast, 1280, 720, sentAt);
    const quick = room({ '': { tookMs: 12_500, sentAt } });
    expect(slowBrowserRaster(quick, fast, undefined, now, 1920 * 1080)).toBe(
      "needed 13 s for its last RASTER image (921,600 pixels), about 28 s for this image's 2,073,600 pixels, " +
        "longer than renderer 'auto' waits (15 s)",
    );
    expect(slowBrowserRaster(quick, fast, undefined, now, 1280 * 1024)).toMatch(/^needed 13 s .* about 18 s/);
    // one as large or smaller, or a larger one that 'auto' still waits for: the editor
    expect(slowBrowserRaster(quick, fast, undefined, now, 1280 * 720)).toBeNull();
    expect(slowBrowserRaster(quick, fast, undefined, now, 640 * 360)).toBeNull();
    expect(slowBrowserRaster(quick, fast, undefined, now, 1300 * 720)).toBeNull();
    // an image of under 5 s is mostly fixed costs: not scaled up
    expect(SCALE_UP_MIN_MS).toBe(5000);
    expect(
      slowBrowserRaster(room({ '': { tookMs: 4900, sentAt } }), fast, undefined, now, 2048 * 2048),
    ).toBeNull();
    // render_image notes the size just before it sends the request, whose time the room records:
    // the two may be some milliseconds apart
    const other = {} as SyncConnection;
    noteBrowserRaster(other, 2048, 2048, sentAt - 400);
    expect(
      slowBrowserRaster(
        room({ '': { tookMs: 32_000, late: true, sentAt } }),
        other,
        undefined,
        now,
        1280 * 720,
      ),
    ).toBeNull();
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

describe('out-of-memory advice', () => {
  it('names steps that lower what a server render or export evaluates, not hide_render, objects or apply_modifiers', () => {
    // a 4×4 grid hidden from renders whose Subdivision Surface subdivides only for renders (16 faces,
    // 256 at render level 2), and a cube to export on its own
    const doc = SceneDoc.create({ name: 'Advice', empty: true });
    const registry = createOperatorRegistry();
    const ctx: OperatorContext = {
      doc,
      state: createEditorState(),
      origin: { type: 'test' },
      source: 'test',
      report: () => undefined,
    };
    const run = (id: string, params: Record<string, unknown>) =>
      expect(registry.run(ctx, id, params).ok).toBe(true);
    run('mesh.primitive_grid_add', { x_subdivisions: 4, y_subdivisions: 4, name: 'Hidden' });
    const hidden = ctx.state.activeId!;
    run('object.modifier_add', { type: 'SUBSURF', params: { levels: 0, render_levels: 2 } });
    run('data.set_property', { kind: 'objects', target: 'Hidden', values: { hide_render: true } });
    run('mesh.primitive_cube_add', { name: 'Small' });
    // a server render (render processes evaluate with forRender) evaluates the hidden mesh at render levels
    const scene = new SceneEvaluator(doc).evaluate(1, { forRender: true });
    expect(scene.byId.get(hidden)!.renderVisible).toBe(false);
    expect(scene.byId.get(hidden)!.mesh!.faces.length).toBe(256);
    for (const advice of [OUT_OF_MEMORY_ADVICE, ANIMATION_OUT_OF_MEMORY_ADVICE]) {
      expect(advice).not.toMatch(/hide large meshes|fewer triangles \(hide/);
      expect(advice).toContain(
        'A server render loads and evaluates every mesh of the scene with its modifiers at their render ' +
          'settings, also meshes hidden from renders (hide_render): lower the render levels (render_levels) ' +
          'of Subdivision Surface modifiers',
      );
    }
    // an export of the cube alone, without modifiers, evaluates the hidden mesh at render levels too
    // (every exporter starts from core collectExport, which evaluates the whole scene)
    const evaluate = vi.spyOn(SceneEvaluator.prototype, 'evaluate');
    try {
      const obj = new TextDecoder().decode(
        exportScene(doc, 'obj', { objectIds: ['Small'], applyModifiers: false }).data,
      );
      expect(obj.match(/^o .*/gm)).toEqual(['o Small']);
      const evaluated = evaluate.mock.results.map((r) => r.value as EvaluatedScene);
      expect(evaluated.map((e) => e.byId.get(hidden)?.mesh?.faces.length)).toEqual([256]);
    } finally {
      evaluate.mockRestore();
    }
    expect(EXPORT_OUT_OF_MEMORY_ADVICE).not.toContain('export fewer objects (objects), the meshes without');
    expect(EXPORT_OUT_OF_MEMORY_ADVICE).toContain(
      'An export loads and evaluates every mesh of the scene with its modifiers at their render settings, ' +
        'whichever objects it writes and also with apply_modifiers: false: lower the render levels ' +
        '(render_levels) of Subdivision Surface modifiers',
    );
    // what objects and apply_modifiers: false do lower: what is written
    expect(EXPORT_OUT_OF_MEMORY_ADVICE).toContain(
      'Writing the file needs memory too, less with fewer objects (objects), base meshes (apply_modifiers: false)',
    );
  });
});
