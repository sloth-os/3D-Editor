/*
 * Working buffers of the CPU rasterizer reused from render to render: the sample buffers of a 720p
 * frame at 2 × 2 samples weigh 74 MB, so an animation or a video export that allocates them anew
 * for every frame spends a good part of each frame on page faults and garbage collection.
 *
 * One buffer per role (the main view's colour, a shadow map's depth, ...), handed out zeroed when
 * the next render asks for the same role and length, replaced (and so left to the garbage
 * collector) when the length differs. Buffers are held through WeakRefs: an idle process does not
 * keep them alive through memory pressure, and nothing a render returns is ever pooled.
 */

const pool = new Map<string, WeakRef<Float32Array | Uint32Array>>();

/** A zeroed Float32Array of `length` for `role`, reusing the role's last one when the length matches. */
export function pooledFloat32(role: string, length: number): Float32Array {
  const old = pool.get(role)?.deref();
  if (old instanceof Float32Array && old.length === length) {
    old.fill(0);
    return old;
  }
  const a = new Float32Array(length);
  pool.set(role, new WeakRef(a));
  return a;
}

/** A zeroed Uint32Array of `length` for `role` (see `pooledFloat32`). */
export function pooledUint32(role: string, length: number): Uint32Array {
  const old = pool.get(role)?.deref();
  if (old instanceof Uint32Array && old.length === length) {
    old.fill(0);
    return old;
  }
  const a = new Uint32Array(length);
  pool.set(role, new WeakRef(a));
  return a;
}

/** Drops every pooled buffer (the next renders allocate afresh). */
export function releaseRenderBuffers(): void {
  pool.clear();
}

/** Number of pooled buffers still alive (tests). */
export function pooledBufferCount(): number {
  let n = 0;
  for (const ref of pool.values()) if (ref.deref()) n++;
  return n;
}
