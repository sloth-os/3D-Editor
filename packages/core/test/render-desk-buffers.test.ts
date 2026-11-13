import { afterEach, describe, expect, it } from 'vitest';
import {
  estimateRenderBufferBytes,
  renderSceneSoftware,
  releaseRenderBuffers,
  SceneDoc,
  type RenderedImage,
  type SoftwareRenderOptions,
} from '../src';
import { AO_HALF_RES_PIXELS, aoBufferBytes, ambientOcclusion } from '../src/render/ao';
import { pooledBufferBytes, pooledBufferCount, pooledFloat32, pooledUint32 } from '../src/render/buffers';
import { SPOT_SHADOW_MAP_SIZE, SUN_SHADOW_MAP_SIZE } from '../src/render/shadows';
import { viewFromSpec } from '../src/render/view';
import { deskScene, imageHash, lookCamera, mixedScene, spotInteriorScene } from './render-desk-helpers';

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

/** What a render holds when it returns: the working buffers pooled for the next render, the image and the passes. */
function heldBytes(img: RenderedImage): number {
  const a = img.aovs ?? {};
  return (
    pooledBufferBytes() +
    img.data.byteLength +
    (a.depth?.byteLength ?? 0) +
    (a.normal?.byteLength ?? 0) +
    (a.object?.byteLength ?? 0)
  );
}

describe('estimateRenderBufferBytes', () => {
  const lines: SoftwareRenderOptions['lines'] = [{ a: [0, 0, 0], b: [1, 1, 2], width_px: 2, color: [1, 1, 1] }];

  it('is what a render without shadow maps keeps and returns, byte for byte', () => {
    const desk = deskScene({ segments: 8, people: 1 }).doc; // AgX: a row of display film
    const studio = mixedScene().doc; // Standard: no film
    const cases: [SceneDoc, SoftwareRenderOptions][] = [
      [desk, { width: 64, height: 36, samples: 1 }],
      [desk, { width: 64, height: 36, samples: 2, msaa: true }],
      [studio, { width: 64, height: 36, samples: 4 }],
      [desk, { width: 63, height: 35, samples: 4, ao: true }],
      [desk, { width: 64, height: 36, samples: 2, aovs: ['depth'] }],
      [desk, { width: 64, height: 36, samples: 2, aovs: ['object', 'normal'] }],
      [desk, { width: 64, height: 36, samples: 2, lines }],
      [studio, { width: 64, height: 36, samples: 2, ao: true, lines, aovs: ['depth', 'normal', 'object'] }],
      [desk, { width: 64, height: 36, samples: 2, shading: 'SOLID', ao: true, shadows: true }],
      [desk, { width: 64, height: 36, samples: 2, look: 'clay', ao: true }],
    ];
    for (const [doc, o] of cases) {
      releaseRenderBuffers();
      const img = renderSceneSoftware(doc, o);
      expect(estimateRenderBufferBytes(o, doc), JSON.stringify(o)).toBe(heldBytes(img));
    }
  });

  it('follows the occlusion to half resolution from AO_HALF_RES_PIXELS output pixels on', () => {
    // nothing in view: the buffers are the same whatever the scene shows
    const doc = SceneDoc.create({ empty: true });
    lookCamera(doc, [0, -4, 1.6], [0, 0, 0.5]);
    const o: SoftwareRenderOptions = { width: 1600, height: AO_HALF_RES_PIXELS / 1600, samples: 1, ao: true };
    releaseRenderBuffers();
    const img = renderSceneSoftware(doc, o);
    expect(estimateRenderBufferBytes(o, doc)).toBe(heldBytes(img));
    // the occlusion's own buffers on either side of the threshold (a depth given, like the render)
    for (const [w, h] of [
      [1600, AO_HALF_RES_PIXELS / 1600],
      [1600, AO_HALF_RES_PIXELS / 1600 - 1],
      [97, 55],
    ]) {
      const view = viewFromSpec(
        { position: [0, -4, 1.6], target: [0, 0, 0.5], up: [0, 0, 1], fovY: 0.8 },
        w / h,
        null,
      );
      const pix = { width: w, height: h, key: new Float32Array(w * h), normal: new Float32Array(w * h * 3), object: null };
      releaseRenderBuffers();
      ambientOcclusion(pix, view, 0.5, new Float32Array(w * h).fill(Infinity));
      expect(pooledBufferBytes(), `${w} x ${h}`).toBe(aoBufferBytes(w, h));
    }
    expect(aoBufferBytes(1600, AO_HALF_RES_PIXELS / 1600)).toBeLessThan(aoBufferBytes(1600, AO_HALF_RES_PIXELS / 1600 - 1));
  });

  it("counts a spot light's map exactly and a sun's, fitted to what the camera sees, from above", () => {
    const o: SoftwareRenderOptions = { width: 64, height: 36, samples: 2 };
    const spot = spotInteriorScene().doc;
    for (const shadows of [true, 'scene'] as const) {
      releaseRenderBuffers();
      const img = renderSceneSoftware(spot, { ...o, shadows });
      expect(estimateRenderBufferBytes({ ...o, shadows }, spot)).toBe(heldBytes(img));
      expect(estimateRenderBufferBytes({ ...o, shadows }, spot) - estimateRenderBufferBytes(o, spot)).toBe(
        SPOT_SHADOW_MAP_SIZE * SPOT_SHADOW_MAP_SIZE * 4,
      );
    }
    // 'scene' follows the light's use_shadow and the render's use_shadows
    const lamp = spot.listObjects().find((x) => x.type === 'LIGHT')!;
    spot.updateLight(lamp.data!, { use_shadow: false });
    expect(estimateRenderBufferBytes({ ...o, shadows: 'scene' }, spot)).toBe(estimateRenderBufferBytes(o, spot));
    expect(estimateRenderBufferBytes({ ...o, shadows: true }, spot)).toBeGreaterThan(
      estimateRenderBufferBytes(o, spot),
    );
    spot.updateLight(lamp.data!, { use_shadow: true });
    spot.updateRender({ use_shadows: false });
    releaseRenderBuffers();
    const off = renderSceneSoftware(spot, { ...o, shadows: 'scene' });
    expect(estimateRenderBufferBytes({ ...o, shadows: 'scene' }, spot)).toBe(heldBytes(off));
    // hidden lights cast nothing
    spot.updateRender({ use_shadows: true });
    spot.updateObject(lamp.id, { hide_render: true });
    expect(estimateRenderBufferBytes({ ...o, shadows: true }, spot)).toBe(estimateRenderBufferBytes(o, spot));

    // the SKY sun: a map up to SUN_SHADOW_MAP_SIZE on its longer side
    const desk = deskScene({ segments: 8, people: 1 }).doc;
    releaseRenderBuffers();
    const lit = renderSceneSoftware(desk, { ...o, shadows: true });
    const est = estimateRenderBufferBytes({ ...o, shadows: true }, desk);
    const sunMap = SUN_SHADOW_MAP_SIZE * SUN_SHADOW_MAP_SIZE * 4;
    expect(est - estimateRenderBufferBytes(o, desk)).toBe(sunMap);
    expect(est).toBeGreaterThanOrEqual(heldBytes(lit));
    expect(est - heldBytes(lit)).toBeLessThan(sunMap);
    // without the document: one sun's map (and a row of film)
    expect(estimateRenderBufferBytes({ ...o, shadows: true })).toBe(est);
  });

  it('caps the samples like the render does', () => {
    const at = (width: number, height: number, samples: number) =>
      estimateRenderBufferBytes({ width, height, samples });
    // 4096 × 4096 samples at most: 2048² pixels keep 2 × 2, one more column falls back to 1
    expect(at(2048, 2048, 2)).toBeGreaterThan(at(2048, 2048, 1));
    expect(at(2049, 2048, 2)).toBe(at(2049, 2048, 1));
    expect(at(1024, 1024, 4)).toBeGreaterThan(at(1024, 1024, 2));
    expect(at(1025, 1024, 4)).toBe(at(1025, 1024, 2));
    expect(at(0, 1080, 2)).toBe(0);
  });
});
