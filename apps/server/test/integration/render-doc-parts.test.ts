import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, createGrid } from '@3d-editor/core';
import { RenderPool, type RenderThread } from '../../src/render/pool';
import type { DocRef, FrameOptions, ImageResult, WorkerRequest } from '../../src/render/protocol';

/*
 * A render process gets a document's state over the IPC channel of `child_process.fork`, whose
 * serializer copies a message whole into the server's memory (outside its JavaScript heap): a
 * project of eight stored grids of a million faces made the server's process grow by 1.4 GB during
 * one software render, and a path traced render copied the state once more for every render
 * process. A state larger than the part size (DOC_PART_BYTES, 8 MB; small here) goes in parts,
 * each sent once the one before was written, and the render process puts them together: the
 * images are those of the whole state, and later requests wait for the parts.
 */

const PART = 4096;
const pools: RenderPool[] = [];
afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

function pool(opts: ConstructorParameters<typeof RenderPool>[0]): RenderPool {
  const p = new RenderPool(opts);
  pools.push(p);
  return p;
}

/** A project of one grid of `n` × `n` quads (turned by `turn` about Z); its state is about 50 bytes per quad. */
function grid(n: number, key: string, turn: number): DocRef {
  const doc = SceneDoc.create({ empty: true });
  doc.transact(() => {
    const mesh = doc.addMesh('Grid', createGrid({ x_subdivisions: n, y_subdivisions: n, size: 2 }));
    doc.addObject({ type: 'MESH', name: 'Grid', data: mesh, rotation_euler: [0.6, 0, turn] });
  });
  return { key, version: 1, update: Y.encodeStateAsUpdate(doc.ydoc) };
}

/** What the server's process sent the render process: the largest state in flight at once. */
function watchSends(thread: RenderThread): { inFlight: number; largestInFlight: number; parts: number } {
  const child = (thread as unknown as { child: ChildProcess }).child;
  const send = child.send.bind(child) as (msg: unknown, cb: (err: Error | null) => void) => boolean;
  const seen = { inFlight: 0, largestInFlight: 0, parts: 0 };
  child.send = ((msg: WorkerRequest, ...rest: unknown[]) => {
    const done = rest.find((a) => typeof a === 'function') as ((err: Error | null) => void) | undefined;
    const bytes =
      msg.type === 'doc-part' ? msg.bytes.byteLength : 'doc' in msg ? (msg.doc.update?.byteLength ?? 0) : 0;
    if (msg.type === 'doc-part') seen.parts++;
    seen.inFlight += bytes;
    seen.largestInFlight = Math.max(seen.largestInFlight, seen.inFlight);
    return send(msg, (err) => {
      seen.inFlight -= bytes;
      done?.(err);
    });
  }) as typeof child.send;
  return seen;
}

const options: FrameOptions = { width: 48, height: 32, frame: 1, engine: 'RASTER' };

describe('document states sent to render processes', () => {
  it('go in parts, one at a time, and render the same images as whole states', async () => {
    const parted = pool({ threads: 1, docPartBytes: PART });
    const lease = await parted.lease(1);
    const thread = lease.threads[0];
    const seen = watchSends(thread);
    const a = grid(30, 'test:a', 0.4);
    const b = grid(24, 'test:b', 1.2);
    expect(a.update!.byteLength).toBeGreaterThan(8 * PART);
    // two documents and a ping, sent back to back: B's parts and the ping wait for A's parts
    const [imageA, imageB, ping] = await Promise.all([
      thread.call<ImageResult>({ type: 'image', doc: a, options, png: true }),
      thread.call<ImageResult>({ type: 'image', doc: b, options, png: true }),
      thread.call({ type: 'ping' }),
    ]);
    lease.release();
    expect(ping).toEqual({ ok: true });
    expect(seen.parts).toBe(Math.ceil(a.update!.byteLength / PART) + Math.ceil(b.update!.byteLength / PART));
    expect(seen.largestInFlight).toBeLessThanOrEqual(PART);

    // the same states, whole, rendered on the main thread
    const whole = pool({ threads: 0 });
    const main = (await whole.lease(1)).threads[0];
    const wholeA = await main.call<ImageResult>({ type: 'image', doc: a, options, png: true });
    const wholeB = await main.call<ImageResult>({ type: 'image', doc: b, options, png: true });
    expect(Buffer.from(imageA.png!).equals(Buffer.from(wholeA.png!))).toBe(true);
    expect(Buffer.from(imageB.png!).equals(Buffer.from(wholeB.png!))).toBe(true);
    expect(Buffer.from(imageA.png!).equals(Buffer.from(imageB.png!))).toBe(false);
  }, 60_000);
});
