import { afterEach, describe, expect, it } from 'vitest';
import { renderSceneSoftware, releaseRenderBuffers } from '../src';
import { pooledBufferCount, pooledFloat32, pooledUint32 } from '../src/render/buffers';
import { deskScene, imageHash } from './render-desk-helpers';

afterEach(() => releaseRenderBuffers());

describe('render buffer pool', () => {
  it('hands out zeroed buffers and reuses one per role and length', () => {
    releaseRenderBuffers();
    const a = pooledFloat32('test:a', 16);
    expect(a).toHaveLength(16);
    expect(a.every((v) => v === 0)).toBe(true);
    a.fill(3);
    const again = pooledFloat32('test:a', 16);
    expect(again).toBe(a);
    expect(again.every((v) => v === 0)).toBe(true);
    // another length replaces the role's buffer; another role has its own
    const longer = pooledFloat32('test:a', 32);
    expect(longer).not.toBe(a);
    expect(longer).toHaveLength(32);
    const b = pooledFloat32('test:b', 32);
    expect(b).not.toBe(longer);
    expect(pooledBufferCount()).toBe(2);
  });

  it('keeps Float32 and Uint32 buffers of one role apart', () => {
    const f = pooledFloat32('test:mixed', 8);
    const u = pooledUint32('test:mixed', 8);
    expect(u).toBeInstanceOf(Uint32Array);
    u[3] = 7;
    const u2 = pooledUint32('test:mixed', 8);
    expect(u2).toBe(u);
    expect(u2[3]).toBe(0);
    // the Float32 one was replaced by the Uint32 one (one buffer per role)
    expect(pooledFloat32('test:mixed', 8)).not.toBe(f);
  });

  it('releaseRenderBuffers drops every pooled buffer', () => {
    pooledFloat32('test:c', 4);
    pooledUint32('test:d', 4);
    expect(pooledBufferCount()).toBeGreaterThanOrEqual(2);
    releaseRenderBuffers();
    expect(pooledBufferCount()).toBe(0);
  });

  it('renders of different sizes and options do not leak into each other', () => {
    const { doc } = deskScene({ segments: 16 });
    const all = { msaa: true, shadows: true, ao: true, aovs: ['depth', 'normal', 'object'] as const };
    const small = () =>
      renderSceneSoftware(doc, { width: 64, height: 36, samples: 2, ...all, aovs: [...all.aovs] });
    const big = () =>
      renderSceneSoftware(doc, { width: 96, height: 54, samples: 2, ...all, aovs: [...all.aovs] });
    releaseRenderBuffers();
    const first = small();
    const firstDepth = Float32Array.from(first.aovs!.depth!);
    big();
    renderSceneSoftware(doc, { width: 64, height: 36, samples: 4 });
    const second = small();
    expect(imageHash(second)).toBe(imageHash(first));
    expect(second.aovs!.depth).toEqual(firstDepth);
    // the returned passes are the caller's own (not pooled buffers a later render overwrites)
    big();
    expect(first.aovs!.depth).toEqual(firstDepth);
    expect(pooledBufferCount()).toBeGreaterThan(0);
  });
});
