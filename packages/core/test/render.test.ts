import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import {
  SceneDoc,
  autoFrameView,
  createCube,
  createFCurve,
  createPlane,
  createUVSphere,
  decodePNG,
  encodePNG,
  insertKeyframe,
  renderSceneSoftware,
  type RenderedImage,
} from '../src';
import { cpuMs } from './timing-helpers';

// ---------------------------------------------------------------- helpers

function pixel(img: RenderedImage, x: number, y: number): number[] {
  const o = (y * img.width + x) * 4;
  return [...img.data.subarray(o, o + 4)];
}

/** Pixels that differ from the top-left (background) pixel. */
function mask(
  img: RenderedImage,
  tol = 6,
): { count: number; minX: number; maxX: number; minY: number; maxY: number; cx: number; cy: number } {
  const bg = pixel(img, 0, 0);
  let count = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const p = pixel(img, x, y);
      if (
        Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) + Math.abs(p[3] - bg[3]) <=
        tol
      )
        continue;
      count++;
      sx += x;
      sy += y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  return { count, minX, maxX, minY, maxY, cx: sx / count, cy: sy / count };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  // CRC computed with the encoder's PNG round trip as oracle is circular; use a local CRC-32
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  let crc = 0xffffffff;
  for (const b of body) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return out;
}

function pngFile(ihdr: number[], raw: Uint8Array, extra: Uint8Array[] = []): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    sig,
    chunk('IHDR', new Uint8Array(ihdr)),
    ...extra,
    chunk('IDAT', zlibSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- PNG

describe('PNG codec', () => {
  it('encodes RGBA8 with a valid structure and decodes it back', () => {
    const width = 7;
    const height = 5;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3) * 11) & 0xff;
    const png = encodePNG({ width, height, data });
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(dv.getUint32(8)).toBe(13);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe('IHDR');
    expect(dv.getUint32(16)).toBe(width);
    expect(dv.getUint32(20)).toBe(height);
    expect([...png.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0]);
    expect(new TextDecoder().decode(png.subarray(png.length - 8, png.length - 4))).toBe('IEND');
    const back = decodePNG(png);
    expect(back.width).toBe(width);
    expect(back.height).toBe(height);
    expect([...back.data]).toEqual([...data]);
    // corrupting a byte breaks the CRC check
    const bad = png.slice();
    bad[20] ^= 1;
    expect(() => decodePNG(bad)).toThrow(/CRC/);
  });

  it('decodes grayscale+alpha and palette images with all filter types', () => {
    // 3x2 gray+alpha, rows filtered with Sub (1) and Paeth (4)
    const ga = [10, 255, 20, 128, 30, 0, 40, 255, 50, 255, 60, 255];
    const raw = new Uint8Array(2 * (1 + 6));
    raw[0] = 1;
    for (let i = 0; i < 6; i++) raw[1 + i] = (ga[i] - (i >= 2 ? ga[i - 2] : 0)) & 0xff;
    raw[7] = 4;
    for (let i = 0; i < 6; i++) {
      const a = i >= 2 ? ga[6 + i - 2] : 0;
      const b = ga[i];
      const c = i >= 2 ? ga[i - 2] : 0;
      const p = a + b - c;
      const pr =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      raw[8 + i] = (ga[6 + i] - pr) & 0xff;
    }
    const img = decodePNG(pngFile([0, 0, 0, 3, 0, 0, 0, 2, 8, 4, 0, 0, 0], raw));
    expect(pixel(img, 1, 0)).toEqual([20, 20, 20, 128]);
    expect(pixel(img, 2, 1)).toEqual([60, 60, 60, 255]);
    // 2x1 palette, 1 bit per pixel, with transparency for index 1
    const plte = chunk('PLTE', new Uint8Array([255, 0, 0, 0, 0, 255]));
    const trns = chunk('tRNS', new Uint8Array([255, 0]));
    const pal = decodePNG(
      pngFile([0, 0, 0, 2, 0, 0, 0, 1, 1, 3, 0, 0, 0], new Uint8Array([0, 0b01000000]), [plte, trns]),
    );
    expect(pixel(pal, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(pal, 1, 0)).toEqual([0, 0, 255, 0]);
  });
});

// ---------------------------------------------------------------- renderer

describe('software renderer', () => {
  it('renders the default scene: background corners, lit cube near the center', () => {
    const doc = SceneDoc.create();
    // exact sRGB levels: the Standard view transform (the default AgX rolls values off)
    doc.updateRender({ view_transform: 'STANDARD' });
    const img = renderSceneSoftware(doc, { width: 160, height: 90 });
    expect(img.data.length).toBe(160 * 90 * 4);
    // world color 0.051 (linear) → sRGB ≈ 64
    for (const [x, y] of [
      [0, 0],
      [159, 0],
      [0, 89],
      [159, 89],
    ])
      expect(pixel(img, x, y)).toEqual([64, 64, 64, 255]);
    const m = mask(img);
    expect(m.count).toBeGreaterThan(160 * 90 * 0.1);
    expect(Math.abs(m.cx - 80)).toBeLessThan(10);
    expect(Math.abs(m.cy - 45)).toBeLessThan(10);
    const c = pixel(img, 80, 45);
    expect(c[0]).not.toBe(64);
    // grey material: neutral color
    expect(Math.abs(c[0] - c[1])).toBeLessThanOrEqual(1);
  });

  it('uses the scene camera, an explicit camera or automatic framing', () => {
    const doc = SceneDoc.create();
    const withCamera = renderSceneSoftware(doc, { width: 96, height: 96 });
    const side = doc.addObject({
      type: 'CAMERA',
      name: 'Side',
      data: doc.addCamera({ name: 'Side', lens: 50 }),
      location: [0, -12, 0],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    const fromSide = renderSceneSoftware(doc, { width: 96, height: 96, cameraId: 'Side' });
    expect(Buffer.from(fromSide.data).equals(Buffer.from(withCamera.data))).toBe(false);
    // looking straight at the cube from the side: a centered square
    const s = mask(fromSide);
    expect(Math.abs(s.cx - 47.5)).toBeLessThan(1.5);
    expect(Math.abs(s.cy - 47.5)).toBeLessThan(1.5);
    expect(Math.abs(s.maxX - s.minX - (s.maxY - s.minY))).toBeLessThanOrEqual(1);
    expect(() => renderSceneSoftware(doc, { width: 8, height: 8, cameraId: 'Nope' })).toThrow(/not found/);
    // without a scene camera the view frames all visible objects
    doc.updateScene({ camera: null });
    const auto = renderSceneSoftware(doc, { width: 96, height: 96 });
    const a = mask(auto);
    expect(Math.abs(a.cx - 47.5)).toBeLessThan(6);
    expect(Math.abs(a.cy - 47.5)).toBeLessThan(6);
    expect(a.minX).toBeGreaterThan(0);
    expect(a.maxX).toBeLessThan(95);
    expect(a.maxY - a.minY).toBeGreaterThan(96 * 0.5);
    void side;
  });

  it('autoFrameView fits the bounds from a 3/4 view above +X −Y', () => {
    const v = autoFrameView({ min: [-1, -1, -1], max: [1, 1, 1] }, 1);
    expect(v.target).toEqual([0, 0, 0]);
    expect(v.position[0]).toBeGreaterThan(0);
    expect(v.position[1]).toBeLessThan(0);
    expect(v.position[2]).toBeGreaterThan(0);
    const far = autoFrameView({ min: [-10, -10, -10], max: [10, 10, 10] }, 1);
    expect(Math.hypot(...far.position)).toBeCloseTo(10 * Math.hypot(...v.position), 6);
  });

  it('renders orthographic cameras at a fixed scale', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.addObject({ type: 'MESH', name: 'Cube', data: doc.addMesh('Cube', createCube({ size: 2 })) });
    const cam = doc.addCamera({ name: 'Ortho', type: 'ORTHO', ortho_scale: 4 });
    const id = doc.addObject({
      type: 'CAMERA',
      name: 'Ortho',
      data: cam,
      location: [0, -10, 0],
      rotation_euler: [Math.PI / 2, 0, 0],
    });
    doc.updateScene({ camera: id });
    const near = mask(renderSceneSoftware(doc, { width: 100, height: 100, samples: 1 }));
    expect(near.maxX - near.minX + 1).toBeGreaterThanOrEqual(49);
    expect(near.maxX - near.minX + 1).toBeLessThanOrEqual(51);
    doc.updateObject(id, { location: [0, -50, 0] });
    doc.updateCamera(cam, { clip_end: 100 });
    const far = mask(renderSceneSoftware(doc, { width: 100, height: 100, samples: 1 }));
    expect(far.maxX - far.minX).toBe(near.maxX - near.minX);
  });

  it('renders the world color (or the given background) for an empty scene', () => {
    const doc = SceneDoc.create({ empty: true });
    doc.updateRender({ view_transform: 'STANDARD' });
    doc.updateWorld({ color: [0.2, 0.4, 0.6] });
    const img = renderSceneSoftware(doc, { width: 16, height: 8 });
    expect(new Set(Array.from({ length: 16 * 8 }, (_, i) => pixel(img, i % 16, i >> 4).join(','))).size).toBe(
      1,
    );
    expect(pixel(img, 3, 3)).toEqual([124, 170, 203, 255]);
    const red = renderSceneSoftware(doc, { width: 4, height: 4, background: [1, 0, 0, 1] });
    expect(pixel(red, 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it('supports transparent backgrounds, SOLID shading and a wireframe overlay', () => {
    const doc = SceneDoc.create();
    const img = renderSceneSoftware(doc, { width: 64, height: 48, background: [0, 0, 0, 0] });
    expect(pixel(img, 0, 0)[3]).toBe(0);
    expect(pixel(img, 32, 24)[3]).toBe(255);
    const solid = renderSceneSoftware(doc, { width: 128, height: 96, shading: 'SOLID' });
    const wire = renderSceneSoftware(doc, { width: 128, height: 96, shading: 'SOLID', wireframe: true });
    let darker = 0;
    for (let i = 0; i < solid.data.length; i += 4) if (wire.data[i] < solid.data[i] - 20) darker++;
    expect(darker).toBeGreaterThan(50);
  });

  it('lights with physical units: a 1000 W point light 5 m away lights a surface without clipping', () => {
    const doc = SceneDoc.create({ empty: true });
    // only the lamp (and the dim world colour): no studio environment light
    doc.updateWorld({ environment: 'NONE' });
    doc.addObject({ type: 'MESH', name: 'Floor', data: doc.addMesh('Floor', createPlane({ size: 4 })) });
    const light = doc.addLight({ type: 'POINT', energy: 1000 });
    doc.addObject({ type: 'LIGHT', name: 'Light', data: light, location: [0, 0, 5] });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Top',
      data: doc.addCamera({ type: 'ORTHO', ortho_scale: 8 }),
      location: [0, 0, 10],
    });
    doc.updateScene({ camera: cam });
    const center = () => pixel(renderSceneSoftware(doc, { width: 32, height: 32, samples: 1 }), 16, 16)[0];
    const lit = center();
    expect(lit).toBeGreaterThan(170);
    expect(lit).toBeLessThan(255);
    doc.updateLight(light, { energy: 250 });
    expect(center()).toBeLessThan(lit - 40);
  });

  it('samples PNG base color textures with the editor UV convention (V up)', () => {
    const doc = SceneDoc.create({ empty: true });
    // 2×2 texture, top row first: red, green / blue, white
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const image = doc.addImage({
      name: 'Quad',
      mime: 'image/png',
      width: 2,
      height: 2,
      data: encodePNG({ width: 2, height: 2, data: px }),
    });
    const mat = doc.addMaterial({
      base_color: [1, 1, 1, 1],
      textures: { base_color: { image, scale: [1, 1], offset: [0, 0] } },
    });
    doc.addObject({
      type: 'MESH',
      name: 'Plane',
      data: doc.addMesh('Plane', createPlane({ size: 2 })),
      material_slots: [mat],
    });
    // pure ambient (a uniform world colour, environment NONE): shows the texture color
    doc.updateWorld({ environment: 'NONE', color: [1, 1, 1], strength: 1 });
    doc.updateRender({ view_transform: 'STANDARD' });
    const cam = doc.addObject({
      type: 'CAMERA',
      name: 'Top',
      data: doc.addCamera({ type: 'ORTHO', ortho_scale: 2 }),
      location: [0, 0, 5],
    });
    doc.updateScene({ camera: cam });
    doc.addObject({ type: 'LIGHT', name: 'Off', data: doc.addLight({ type: 'SUN', energy: 0 }) });
    const img = renderSceneSoftware(doc, { width: 40, height: 40, samples: 1 });
    const hue = (x: number, y: number) => {
      const p = pixel(img, x, y);
      return p[0] > 200 && p[1] > 200 && p[2] > 200
        ? 'white'
        : p[0] > 150
          ? 'red'
          : p[1] > 150
            ? 'green'
            : p[2] > 150
              ? 'blue'
              : '?';
    };
    expect([hue(10, 10), hue(30, 10), hue(10, 30), hue(30, 30)]).toEqual(['red', 'green', 'blue', 'white']);
  });

  it('keeps facing and backface culling correct for mirrored objects', () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!;
    doc.updateMaterial(cube.material_slots[0]!, { use_backface_culling: true });
    const normal = renderSceneSoftware(doc, { width: 64, height: 36 });
    doc.updateObject(cube.id, { scale: [-1, 1, 1] }); // same geometry, mirrored transform
    const mirrored = renderSceneSoftware(doc, { width: 64, height: 36 });
    let diff = 0;
    for (let i = 0; i < normal.data.length; i++)
      diff = Math.max(diff, Math.abs(normal.data[i] - mirrored.data[i]));
    expect(diff).toBeLessThanOrEqual(2);
  });

  it('evaluates animation at the requested frame', () => {
    const doc = SceneDoc.create();
    const cube = doc.findObjectByName('Cube')!.id;
    let fc = createFCurve({ target_type: 'object', target_id: cube, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, -2, 'LINEAR');
    fc = insertKeyframe(fc, 10, 2, 'LINEAR');
    doc.setFCurve(fc);
    const a = mask(renderSceneSoftware(doc, { width: 96, height: 54, frame: 1 }));
    const b = mask(renderSceneSoftware(doc, { width: 96, height: 54, frame: 10 }));
    expect(b.cx - a.cx).toBeGreaterThan(10);
  });

  it('renders ~100k triangles at 512×512 quickly', () => {
    const doc = SceneDoc.create({ empty: true });
    const sphere = createUVSphere({ segments: 320, ring_count: 160 });
    sphere.faceSmooth = sphere.faceSmooth.map(() => true);
    doc.addObject({ type: 'MESH', name: 'Dense', data: doc.addMesh('Dense', sphere) });
    const t0 = cpuMs();
    const img = renderSceneSoftware(doc, { width: 512, height: 512 });
    // CPU time: about 0.8 s, 1.4 s under coverage on a busy machine (where the wall-clock time
    // reached 8.4 s)
    expect(cpuMs() - t0).toBeLessThan(6000);
    const m = mask(img);
    expect(Math.abs(m.cx - 255.5)).toBeLessThan(8);
    expect(Math.abs(m.cy - 255.5)).toBeLessThan(8);
    // the 6 s budget above is the performance check; vitest's 5 s default must not pre-empt it
  }, 30_000);
});
