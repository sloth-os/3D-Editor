import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, createCube } from '../src';
import type { ImageResult } from '../src/export/protocol';
import {
  buildPalette,
  contactTileSize,
  downscaleRGBA,
  frameBytes,
  hexColor,
  maskToRGB,
  paletteLut,
  paletteRecord,
  passBytes,
  resultBytes,
  streamsFor,
  toRGBA,
} from '../src/export/passes';

/*
 * The server side of export passes: the job's mask palette (actors in their desk colours, other
 * groups in fixed hashed colours, the same for every frame), the ffmpeg streams per pass, and the
 * per-frame conversions.
 */

/** A scene with two actors (armatures with meshes under them), a prop, a ground and a light. */
function scene(): { doc: SceneDoc; ids: Record<string, string> } {
  const doc = SceneDoc.create({ empty: true });
  const ids: Record<string, string> = {};
  doc.transact(() => {
    const mesh = () => doc.addMesh('m', createCube({ size: 1 }));
    ids.ground = doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: mesh(),
      custom_props: { desk_role: 'set' },
    });
    ids.ball = doc.addObject({
      type: 'MESH',
      name: 'Ball',
      data: mesh(),
      custom_props: { desk_role: 'prop' },
    });
    ids.anna = doc.addObject({
      type: 'ARMATURE',
      name: 'Anna',
      data: doc.addArmature({ name: 'a' }),
      custom_props: { desk_role: 'actor', desk_color: '#3d8bff' },
    });
    ids.annaBody = doc.addObject({ type: 'MESH', name: 'Anna body', data: mesh(), parent: ids.anna });
    ids.ben = doc.addObject({
      type: 'ARMATURE',
      name: 'Ben',
      data: doc.addArmature({ name: 'b' }),
      custom_props: { desk_role: 'actor' },
    });
    ids.benBody = doc.addObject({ type: 'MESH', name: 'Ben body', data: mesh(), parent: ids.ben });
    // a helper mesh tied to Ben without being parented (desk_actor)
    ids.benHat = doc.addObject({
      type: 'MESH',
      name: 'Hat',
      data: mesh(),
      custom_props: { desk_actor: ids.ben },
    });
    ids.lamp = doc.addObject({ type: 'LIGHT', name: 'Lamp', data: doc.addLight({ type: 'SUN' }) });
    ids.tree = doc.addObject({ type: 'MESH', name: 'A tree', data: mesh() });
  });
  return { doc, ids };
}

describe('mask palette', () => {
  it('puts actors first in their colours, then subjects, props, set pieces, others by name', () => {
    const { doc, ids } = scene();
    const palette = buildPalette(doc, [ids.tree]);
    expect(palette.map((e) => e.name)).toEqual(['Anna', 'Ben', 'A tree', 'Ball', 'Ground']);
    expect(palette.map((e) => e.index)).toEqual([1, 2, 3, 4, 5]);
    expect(palette[0].color).toEqual([0x3d, 0x8b, 0xff]);
    // Ben has no desk_color: the actor palette's colour of the second actor (not Anna's)
    expect(palette[1].color).not.toEqual(palette[0].color);
    expect(palette[1].role).toBe('actor');
    // colours are distinct and never black
    const keys = palette.map((e) => e.color.join(','));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('0,0,0');
    // a light draws nothing: not in the palette
    expect(palette.some((e) => e.object === ids.lamp)).toBe(false);
  });

  it('is the same for the same document (job-stable) and keeps colours by object', () => {
    const { doc, ids } = scene();
    const a = buildPalette(doc);
    const b = buildPalette(SceneDoc.fromUpdate(Y_encode(doc)));
    expect(b).toEqual(a);
    // a non-actor keeps its hashed colour when other objects come and go
    const tree = a.find((e) => e.object === ids.tree)!.color;
    doc.transact(() => doc.addObject({ type: 'MESH', name: 'Zebra', data: doc.addMesh('z', createCube()) }));
    expect(buildPalette(doc).find((e) => e.object === ids.tree)!.color).toEqual(tree);
  });

  it('maps object groups to indices and indices to colours', () => {
    const { doc, ids } = scene();
    const palette = buildPalette(doc);
    const record = paletteRecord(palette);
    expect(Object.keys(record)[0]).toBe(ids.anna);
    expect(Object.keys(record)).toHaveLength(palette.length);
    const lut = paletteLut(palette);
    const rgb = maskToRGB(new Uint8Array([0, 1, 2, 200]), lut);
    expect([...rgb.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect([...rgb.subarray(3, 6)]).toEqual(palette[0].color);
    expect([...rgb.subarray(6, 9)]).toEqual(palette[1].color);
    expect([...rgb.subarray(9, 12)]).toEqual([0, 0, 0]);
    expect(hexColor('#FF8000')).toEqual([255, 128, 0]);
    expect(hexColor('red')).toBeNull();
    expect(hexColor(42)).toBeNull();
  });
});

describe('streams and frames', () => {
  it('encodes each pass in the viewing codec and mask/edges also losslessly', () => {
    const s = streamsFor(['beauty', 'depth', 'mask', 'edges', 'pose'], 'h264');
    expect(s.map((x) => `${x.pass}${x.suffix}:${x.codec}:${x.input}`)).toEqual([
      'beauty:h264:rgba',
      'depth.depth:h264:gray',
      'mask.mask:h264:rgb24',
      'mask.mask:lossless:rgb24',
      'edges.edges:h264:gray',
      'edges.edges:lossless:gray',
      'pose.pose:h264:rgb24',
    ]);
    expect(streamsFor(['normal'], 'vp9')).toEqual([
      { pass: 'normal', codec: 'vp9', input: 'rgb24', suffix: '.normal', lossless: false },
    ]);
  });

  it('counts the bytes of frames and results', () => {
    expect(frameBytes('rgba', 10, 10)).toBe(400);
    expect(frameBytes('rgb24', 10, 10)).toBe(300);
    expect(frameBytes('gray', 10, 10)).toBe(100);
    // beauty 4 + depth 1 + mask 1 (+3 coloured on the server) + normal 3
    expect(resultBytes(['beauty', 'depth', 'mask', 'normal'], 10, 10)).toBe(1200 + 64 * 1024);
  });

  it('takes the bytes of each pass from a result, refusing missing ones', () => {
    const img: ImageResult = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]),
      passes: { depth: new Uint8Array([9, 10]) },
    };
    expect([...passBytes(img, 'beauty', null)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...passBytes(img, 'depth', null)]).toEqual([9, 10]);
    expect([...passBytes(img, 'mask', new Uint8Array([1, 1, 1, 2, 2, 2]))]).toEqual([1, 1, 1, 2, 2, 2]);
    expect(() => passBytes(img, 'normal', null)).toThrow(/normal pass/);
    expect(() => passBytes(img, 'mask', null)).toThrow(/mask pass/);
    expect(() => passBytes({ width: 1, height: 1 }, 'beauty', null)).toThrow(/beauty/);
  });

  it('converts passes to RGBA and scales tiles down', () => {
    expect([...toRGBA(new Uint8Array([7, 200]), 'gray', 2, 1)]).toEqual([7, 7, 7, 255, 200, 200, 200, 255]);
    expect([...toRGBA(new Uint8Array([1, 2, 3]), 'rgb24', 1, 1)]).toEqual([1, 2, 3, 255]);
    const rgba = new Uint8Array([10, 20, 30, 255]);
    expect(toRGBA(rgba, 'rgba', 1, 1)).toBe(rgba);
    // 2×2 → 1×1: the average
    const src = new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 100, 100, 100, 255]);
    expect([...downscaleRGBA(src, 2, 2, 1, 1)]).toEqual([100, 100, 100, 255]);
    expect(contactTileSize(4, 1920, 1080)).toEqual({ width: 320, height: 180 });
    expect(contactTileSize(4, 160, 90)).toEqual({ width: 160, height: 90 });
    // many tiles: smaller, within 16 megapixels
    const t = contactTileSize(2000, 1920, 1080);
    expect(t.width).toBeLessThan(320);
    expect(t.width * t.height * 2000).toBeLessThanOrEqual(1 << 24);
  });
});

function Y_encode(doc: SceneDoc): Uint8Array {
  return Y.encodeStateAsUpdate(doc.ydoc);
}
