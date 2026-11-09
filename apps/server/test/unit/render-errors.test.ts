import { describe, expect, it } from 'vitest';
import { renderAnimationParallel } from '../../src/render/animation';
import { pathTraceParallel } from '../../src/render/path-trace';
import type { RenderRequest, RenderThread } from '../../src/render/pool';
import {
  RenderOutOfMemoryError,
  primaryRenderError,
  type DocRef,
  type PreparedInfo,
  type WorkerResult,
} from '../../src/render/protocol';

/*
 * A long render whose render processes ended reports its own failure: when one of its requests ran
 * a process out of memory and others only waited behind another render's request (`shared`), the
 * render gets the out-of-memory error with its advice, not the "run it again" of the others.
 */

const heap = () => new RenderOutOfMemoryError('the render process ran out of memory', 128, 'heap');
const shared = () => new RenderOutOfMemoryError('another render ran it out of memory', 128, 'shared');

/** A render thread whose process ends with `err` after `ms` on the requests `fails` names. */
function thread(
  id: number,
  fails: (req: RenderRequest) => boolean,
  err: () => Error,
  ms: number,
): RenderThread {
  const t = {
    id,
    kind: 'process' as const,
    alive: true,
    pending: 0,
    release: () => undefined,
    call<T extends WorkerResult>(req: RenderRequest): Promise<T> {
      if (!fails(req)) return Promise.resolve(prepared as unknown as T);
      return new Promise<T>((_, reject) =>
        setTimeout(() => {
          t.alive = false;
          reject(err());
        }, ms),
      );
    },
  };
  return t;
}

const prepared: PreparedInfo = {
  width: 8,
  height: 8,
  samples: 4,
  denoise: false,
  timeLimit: 0,
  exposure: 0,
  viewTransform: 'STANDARD',
  displayBackground: null,
  warnings: [],
  prepareMs: 1,
  setupMs: 1,
};
const doc: DocRef = { key: 'k', version: 1 };
const options = { width: 8, height: 8, frame: 1, engine: 'PATHTRACER' as const };

describe('a render whose processes ended', () => {
  it('reports the first error that is not a shared one', () => {
    const own = heap();
    expect(primaryRenderError([shared(), own, shared()])).toBe(own);
    const first = shared();
    expect(primaryRenderError([first, shared()])).toBe(first);
    expect(primaryRenderError(['plain'])?.message).toBe('plain');
    expect(primaryRenderError([])).toBeUndefined();
  });

  it('path traced: its own failure, whether its preparation or its bands failed', async () => {
    const prepare = (r: RenderRequest) => r.type === 'prepare';
    await expect(
      pathTraceParallel([thread(1, prepare, shared, 1), thread(2, prepare, heap, 5)], doc, options),
    ).rejects.toMatchObject({ reason: 'heap' });
    // the bands: the shared error comes last
    const rows = (r: RenderRequest) => r.type === 'rows';
    await expect(
      pathTraceParallel([thread(1, rows, shared, 30), thread(2, rows, heap, 1)], doc, options),
    ).rejects.toMatchObject({ reason: 'heap' });
  });

  it('animations: its own failure, also when the last thread to stop was ended by another render', async () => {
    const image = (r: RenderRequest) => r.type === 'image';
    await expect(
      renderAnimationParallel([thread(1, image, heap, 1), thread(2, image, shared, 30)], doc, {
        format: 'GIF',
        frames: [1, 2],
        width: 8,
        height: 8,
        fps: 24,
        base: { engine: 'RASTER', cameraId: 'camera' },
      }),
    ).rejects.toMatchObject({ reason: 'heap' });
  });
});
