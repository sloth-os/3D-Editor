import { describe, expect, it } from 'vitest';
import { THUMBNAIL_SIZE, THUMBNAIL_VERSION } from '@3d-editor/core';
import { ThumbnailQueue } from '../src/assets/thumbnails/queue';
import { canonicalParams, catalogModelId, thumbnailBuild, thumbnailKey } from '../src/assets/thumbnails/keys';

/*
 * What identifies a browser-made thumbnail (keys.ts): the build (the content hash of the worker
 * bundle that holds the catalog and the renderer, and the app version), the model, its parameters
 * and the size; and the page's queue of thumbnails waiting for a worker (queue.ts): tiles on screen
 * first, first come first served among equals, taken out when nobody waits any more.
 */

describe('thumbnail build ids', () => {
  it("name the worker bundle's content hash in a production build", () => {
    const a = thumbnailBuild('/assets/thumbnail.worker-AbC12_x9.js', '0.1.0');
    expect(a).toBe(`0.1.0/${THUMBNAIL_VERSION}/thumbnail.worker-AbC12_x9.js`);
    // another bundle (the catalog or the renderer changed) or another app version: another build
    expect(thumbnailBuild('/assets/thumbnail.worker-Zz98yy77.js', '0.1.0')).not.toBe(a);
    expect(thumbnailBuild('/assets/thumbnail.worker-AbC12_x9.js', '0.2.0')).not.toBe(a);
    // the same bundle served from elsewhere is the same build
    expect(thumbnailBuild('https://cdn.example/app/assets/thumbnail.worker-AbC12_x9.js?v=1', '0.1.0')).toBe(
      a,
    );
  });

  it('make each page load of the development server a build of its own (its worker has no hash)', () => {
    const url = '/src/assets/thumbnails/thumbnail.worker.ts?worker_file&type=module';
    const a = thumbnailBuild(url, '0.1.0', 1000);
    expect(a).toMatch(/\/dev-/);
    expect(thumbnailBuild(url, '0.1.0', 2000)).not.toBe(a);
  });
});

describe('thumbnail cache keys', () => {
  const B = 'build-1';

  it('name the build, the model, the size and the parameters', () => {
    expect(thumbnailKey(B, { model: 'chair' })).toBe(`${B}|builtin:chair|${THUMBNAIL_SIZE}|`);
    expect(thumbnailKey(B, { model: 'chair', size: 128 })).toBe(`${B}|builtin:chair|128|`);
    expect(thumbnailKey('build-2', { model: 'chair' })).not.toBe(thumbnailKey(B, { model: 'chair' }));
    expect(thumbnailKey(B, { model: 'oak_tree', params: { seed: 3 } })).toBe(
      `${B}|builtin:oak_tree|${THUMBNAIL_SIZE}|{"seed":3}`,
    );
  });

  it("spell a model the catalog's way whatever way it is asked for", () => {
    expect(catalogModelId('builtin:Coffee-Table')).toBe('coffee_table');
    expect(catalogModelId('coffee table')).toBe('coffee_table');
    // a model this build does not know keeps its id (its worker answers NOT_FOUND)
    expect(catalogModelId('builtin:not_in_this_build')).toBe('not_in_this_build');
    expect(thumbnailKey(B, { model: 'builtin:Coffee-Table' })).toBe(
      thumbnailKey(B, { model: 'coffee_table' }),
    );
  });

  it('write parameters in one canonical order, without the empty or unset ones', () => {
    expect(canonicalParams({ b: 1, a: { y: [2, { d: 1, c: 0 }], x: 'q' } })).toBe(
      '{"a":{"x":"q","y":[2,{"c":0,"d":1}]},"b":1}',
    );
    expect(canonicalParams({ a: 1, b: 2 })).toBe(canonicalParams({ b: 2, a: 1 }));
    for (const none of [undefined, {}, { seed: undefined }]) expect(canonicalParams(none)).toBe('');
    expect(thumbnailKey(B, { model: 'chair', params: {} })).toBe(thumbnailKey(B, { model: 'chair' }));
    expect(thumbnailKey(B, { model: 'tree', params: { seed: 1 } })).not.toBe(
      thumbnailKey(B, { model: 'tree', params: { seed: 2 } }),
    );
  });
});

describe('the thumbnail queue', () => {
  it('takes tiles on screen first, then the others, first come first served among equals', () => {
    const q = new ThumbnailQueue<string>();
    q.add('a', 'A', 'near');
    q.add('b', 'B', 'visible');
    q.add('c', 'C', 'near');
    q.add('d', 'D', 'visible');
    expect(q.order()).toEqual(['b', 'd', 'a', 'c']);
    expect(q.take()).toEqual({ key: 'b', value: 'B' });
    expect(q.take()).toEqual({ key: 'd', value: 'D' });
    expect(q.take()).toEqual({ key: 'a', value: 'A' });
    expect(q.size).toBe(1);
    expect(q.take()).toEqual({ key: 'c', value: 'C' });
    expect(q.take()).toBeNull();
  });

  it('moves a tile that comes on screen ahead, keeping its place among its new equals', () => {
    const q = new ThumbnailQueue<string>();
    for (const k of ['a', 'b', 'c']) q.add(k, k, 'near');
    q.add('d', 'd', 'visible');
    expect(q.setPriority('c', 'visible')).toBe(true);
    // c came before d: first among the visible ones
    expect(q.order()).toEqual(['c', 'd', 'a', 'b']);
    expect(q.setPriority('c', 'near')).toBe(true);
    expect(q.order()).toEqual(['d', 'a', 'b', 'c']);
    // adding a queued key again keeps its place and takes the new priority
    q.add('b', 'b2', 'visible');
    expect(q.order()).toEqual(['b', 'd', 'a', 'c']);
    expect(q.take()).toEqual({ key: 'b', value: 'b2' });
    expect(q.setPriority('zz', 'visible')).toBe(false);
    // an interrupted render goes back first among its equals
    q.add('e', 'e', 'near', true);
    expect(q.order()).toEqual(['d', 'e', 'a', 'c']);
  });

  it('lets a tile that leaves take its thumbnail out of the queue', () => {
    const q = new ThumbnailQueue<string>();
    q.add('a', 'A', 'visible');
    q.add('b', 'B', 'near');
    expect(q.remove('a')).toBe(true);
    expect(q.remove('a')).toBe(false);
    expect(q.has('a')).toBe(false);
    expect(q.order()).toEqual(['b']);
    expect(q.clear()).toEqual(['B']);
    expect(q.size).toBe(0);
  });
});
