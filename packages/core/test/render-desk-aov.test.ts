import { describe, expect, it } from 'vitest';
import {
  EDGE_DEPTH_JUMP,
  SceneDoc,
  createCube,
  createPlane,
  depthToBytes,
  edgesToBytes,
  normalToRGB,
  objectPaletteRGB,
  objectToIndex,
  renderSceneSoftware,
  type Vec3,
} from '../src';
import { boxOverGround, deskScene, lookCamera, planarDepth, projectToPixel } from './render-desk-helpers';

describe('AOV passes of RASTER renders', () => {
  it('depth: the planar distance of the nearest surface, growing up a receding ground plane', () => {
    const doc = SceneDoc.create({ empty: true });
    const mat = doc.addMaterial({ base_color: [0.5, 0.5, 0.5, 1] });
    doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: doc.addMesh('G', createPlane({ size: 60 })),
      material_slots: [mat],
    });
    lookCamera(doc, [0, -6, 2], [0, 10, 0], 35);
    const W = 64;
    const H = 48;
    const img = renderSceneSoftware(doc, { width: W, height: H, samples: 2, aovs: ['depth'] });
    const depth = img.aovs!.depth!;
    const view = img.view!;
    expect(depth).toHaveLength(W * H);
    expect(img.aovs!.normal).toBeUndefined();
    // up the middle column: strictly farther until the plane's far edge / the horizon (empty: ∞)
    const x = W / 2;
    let prev = 0;
    let rows = 0;
    for (let y = H - 1; y >= 0; y--) {
      const d = depth[y * W + x];
      if (d === Infinity) break;
      expect(d).toBeGreaterThan(prev);
      prev = d;
      rows++;
    }
    expect(rows).toBeGreaterThan(H / 3);
    // the value is the distance from the camera plane (not along the ray)
    for (const p of [
      [0, 0, 0],
      [1.5, 6, 0],
      [-2, 2, 0],
    ] as Vec3[]) {
      const px = projectToPixel(view, p, W, H)!;
      expect(depth[px[1] * W + px[0]]).toBeCloseTo(planarDepth(view, p), 0);
    }
  });

  it('object: ids of the drawn objects, 0 for nothing; the table maps indices to object ids', () => {
    const { doc, ids } = deskScene({ segments: 16 });
    const W = 160;
    const H = 90;
    const img = renderSceneSoftware(doc, { width: W, height: H, samples: 2, aovs: ['object'] });
    const { object, objectTable } = img.aovs!;
    expect(object).toHaveLength(W * H);
    expect(objectTable![0]).toBe('');
    // every drawn mesh object once, sorted (stable indices for a scene)
    const meshIds = Object.values(ids).sort();
    expect(objectTable!.slice(1)).toEqual(meshIds);
    // pixels at the centre of objects near the camera name those objects
    const view = img.view!;
    for (const name of ['Sphere3', 'Cube2', 'Cube4']) {
      const o = doc.getObject(ids[name])!;
      const px = projectToPixel(view, o.location as Vec3, W, H)!;
      expect(objectTable![object![px[1] * W + px[0]]]).toBe(ids[name]);
    }
    // the sky above the ground is empty
    expect(object![0]).toBe(0);
    expect([...object!].every((k) => k < objectTable!.length)).toBe(true);
  });

  it('object: collection instances show their source object, never the instancer or an instance id', () => {
    const doc = SceneDoc.create({ empty: true });
    const mat = doc.addMaterial({ base_color: [0.6, 0.4, 0.3, 1] });
    const ground = doc.addObject({
      type: 'MESH',
      name: 'Ground',
      data: doc.addMesh('G', createPlane({ size: 20 })),
      material_slots: [mat],
    });
    // the source crate lives in its own collection, hidden in renders (the usual instancing setup)
    const props = doc.addCollection({ name: 'Props' });
    const crate = doc.addObject({
      type: 'MESH',
      name: 'Crate',
      data: doc.addMesh('Crate', createCube({ size: 1 })),
      material_slots: [mat],
      collection: props,
      location: [0, 0, 0.5],
      hide_render: true,
    });
    const empties = [-1.6, 1.6].map((x, i) =>
      doc.addObject({
        type: 'EMPTY',
        name: `Holder${i}`,
        instance_type: 'COLLECTION',
        instance_collection: props,
        location: [x, 0, 0],
      }),
    );
    lookCamera(doc, [0, -6, 3], [0, 0, 0.4], 35);
    const W = 120;
    const H = 90;
    const img = renderSceneSoftware(doc, { width: W, height: H, samples: 2, aovs: ['object'] });
    const { object, objectTable } = img.aovs!;
    // the table holds the drawn objects' own ids: the ground and the crate the instances show
    expect(objectTable).toEqual(['', ...[ground, crate].sort()]);
    for (const id of empties) expect(objectTable).not.toContain(id);
    const crateIndex = objectTable!.indexOf(crate);
    // both instances' pixels name the crate (the source object is hidden: only instances draw it)
    const view = img.view!;
    for (const x of [-1.6, 1.6]) {
      const px = projectToPixel(view, [x, -0.5, 0.5], W, H)!;
      expect(object![px[1] * W + px[0]]).toBe(crateIndex);
    }
    // nothing at the hidden source's own place but ground
    const mid = projectToPixel(view, [0, -0.5, 0.5], W, H)!;
    expect(objectTable![object![mid[1] * W + mid[0]]]).toBe(ground);
    let cratePixels = 0;
    for (const k of object!) if (k === crateIndex) cratePixels++;
    expect(cratePixels).toBeGreaterThan(200);
  });

  it('normal: unit view-space normals where something is drawn, zero elsewhere', () => {
    const { doc } = deskScene({ segments: 16 });
    const W = 120;
    const H = 68;
    const img = renderSceneSoftware(doc, { width: W, height: H, samples: 2, aovs: ['normal', 'depth'] });
    const n = img.aovs!.normal!;
    const depth = img.aovs!.depth!;
    const view = img.view!;
    let drawn = 0;
    let facing = 0;
    for (let i = 0; i < W * H; i++) {
      const len = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]);
      if (depth[i] === Infinity) expect(len).toBe(0);
      else {
        expect(Math.abs(len - 1)).toBeLessThan(1e-4);
        if (n[i * 3 + 2] > 0) facing++;
        drawn++;
      }
    }
    expect(drawn).toBeGreaterThan((W * H) / 3);
    // facing the camera (z towards the viewer), but for smooth normals along silhouettes
    expect(facing / drawn).toBeGreaterThan(0.98);
    // the ground (world +Z) seen in view space
    const px = projectToPixel(view, [-1, -6, 0], W, H)!;
    const i = px[1] * W + px[0];
    const up = view.up;
    const f = view.forward;
    expect(n[i * 3]).toBeCloseTo(view.right[2], 3);
    expect(n[i * 3 + 1]).toBeCloseTo(up[2], 3);
    expect(n[i * 3 + 2]).toBeCloseTo(-f[2], 3);
  });

  it('the passes do not depend on shading options (shadows, AO, looks, resolve); msaa keeps depth and ids', () => {
    const { doc } = deskScene({ segments: 16 });
    const base = { width: 96, height: 54, samples: 2, aovs: ['depth', 'normal', 'object'] as const };
    const a = renderSceneSoftware(doc, { ...base, aovs: [...base.aovs] });
    const b = renderSceneSoftware(doc, {
      ...base,
      aovs: [...base.aovs],
      shadows: true,
      ao: true,
      look: 'clay',
      resolve: 'tonemap',
      dither: true,
    });
    expect(b.aovs!.depth).toEqual(a.aovs!.depth);
    expect(b.aovs!.normal).toEqual(a.aovs!.normal);
    expect(b.aovs!.object).toEqual(a.aovs!.object);
    expect(b.aovs!.objectTable).toEqual(a.aovs!.objectTable);
    // msaa: the same nearest surfaces; normals are those its shading used (a pixel's first sample
    // on the triangle), within a few degrees of the plain renderer's
    const m = renderSceneSoftware(doc, { ...base, aovs: [...base.aovs], msaa: true });
    expect(m.aovs!.depth).toEqual(a.aovs!.depth);
    expect(m.aovs!.object).toEqual(a.aovs!.object);
    const na = a.aovs!.normal!;
    const nm = m.aovs!.normal!;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < na.length; i += 3) {
      if (na[i] === 0 && na[i + 1] === 0 && na[i + 2] === 0) continue;
      const dot = na[i] * nm[i] + na[i + 1] * nm[i + 1] + na[i + 2] * nm[i + 2];
      // (silhouette pixels of coarse smooth spheres span many degrees)
      expect(dot).toBeGreaterThan(0.9);
      sum += dot;
      count++;
    }
    expect(sum / count).toBeGreaterThan(0.999);
  });

  it('edges: black lines along object and depth boundaries, none inside flat faces', () => {
    const build = boxOverGround([], { camera: [3, -5, 4], target: [0, 0, 0.8] });
    const W = 120;
    const H = 90;
    const img = renderSceneSoftware(build.doc, {
      width: W,
      height: H,
      samples: 2,
      aovs: ['depth', 'normal', 'object'],
    });
    const { depth, normal, object } = img.aovs!;
    const edges = edgesToBytes(object!, depth!, normal!, W, H);
    let black = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (edges[p] === 0) black++;
        else expect(edges[p]).toBe(255);
        // wherever the object changes to the right or below, the pixel is an edge
        if (x + 1 < W && object![p] !== object![p + 1]) expect(edges[p]).toBe(0);
        if (y + 1 < H && object![p] !== object![p + W]) expect(edges[p]).toBe(0);
      }
    expect(black).toBeGreaterThan(40);
    // the open ground and the middle of the cube's faces have no lines
    const view = img.view!;
    for (const p of [
      [2, 2.5, 0],
      [-2.5, -1.5, 0],
      [0.1, -0.5, 1.5],
    ] as Vec3[]) {
      const px = projectToPixel(view, p, W, H)!;
      expect(edges[px[1] * W + px[0]]).toBe(255);
    }
  });
});

describe('AOV encoders', () => {
  it('depthToBytes: 255 at near, 0 at far, linear in 1/depth, 0 where empty', () => {
    const d = Float32Array.from([1, 2, 4, 0.5, 10, 20, Infinity, 0, NaN, -1]);
    const b = depthToBytes(d, 1, 10);
    expect(b[0]).toBe(255);
    expect(b[3]).toBe(255); // nearer than near
    expect(b[4]).toBe(0);
    expect(b[5]).toBe(0); // beyond far
    expect([b[6], b[7], b[8], b[9]]).toEqual([0, 0, 0, 0]);
    // 1/2 lies (1/2 − 1/10) / (1 − 1/10) = 4/9 of the way
    expect(b[1]).toBe(Math.round((4 / 9) * 255));
    expect(b[1]).toBeGreaterThan(b[2]);
    // near and far given the wrong way round mean the same range
    expect(depthToBytes(d, 10, 1)).toEqual(b);
  });

  it('normalToRGB: (n + 1) / 2 per channel, black where nothing is drawn', () => {
    const n = Float32Array.from([0, 0, 1, 1, 0, 0, 0, 0, 0, 0, -1, 0]);
    expect([...normalToRGB(n)]).toEqual([128, 128, 255, 255, 128, 128, 0, 0, 0, 128, 0, 128]);
  });

  it('objectToIndex: palette positions or explicit indices, 0 for background and unknown ids', () => {
    const table = ['', 'idA', 'idB', 'idC'];
    const obj = Uint32Array.from([0, 1, 2, 3, 9]);
    expect([...objectToIndex(obj, table, ['idC', 'idA'])]).toEqual([0, 2, 0, 1, 0]);
    expect([...objectToIndex(obj, table, { idB: 7, idC: 300, idA: -2 })]).toEqual([0, 0, 7, 255, 0]);
  });

  it('objectPaletteRGB: each object its colour, background and unknown ids the background colour', () => {
    const table = ['', 'idA', 'idB'];
    const obj = Uint32Array.from([0, 1, 2, 5]);
    const rgb = objectPaletteRGB(obj, table, { idA: [1, 0, 0], idB: [0, 0.5, 1] });
    expect([...rgb]).toEqual([0, 0, 0, 255, 0, 0, 0, 128, 255, 0, 0, 0]);
    const withBg = objectPaletteRGB(obj, table, { idA: [1, 0, 0] }, [1, 1, 1]);
    expect([...withBg]).toEqual([255, 255, 255, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  });

  it('edgesToBytes: object changes, depth jumps and creases make edges; smooth receding floors do not', () => {
    const W = 4;
    const H = 1;
    const flat = Float32Array.from([5, 5, 5, 5]);
    const facing = Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect([...edgesToBytes(null, flat, facing, W, H)]).toEqual([255, 255, 255, 255]);
    // an object change between pixels 1 and 2
    expect([...edgesToBytes(Uint32Array.from([1, 1, 2, 2]), flat, facing, W, H)]).toEqual([255, 0, 255, 255]);
    // a depth jump beyond EDGE_DEPTH_JUMP, and one below it
    const jump = Float32Array.from([5, 5, 5 * (1 + 2 * EDGE_DEPTH_JUMP), 5 * (1 + 2 * EDGE_DEPTH_JUMP)]);
    expect([...edgesToBytes(null, jump, facing, W, H)]).toEqual([255, 0, 255, 255]);
    const small = Float32Array.from([5, 5, 5 * (1 + EDGE_DEPTH_JUMP / 2), 5 * (1 + EDGE_DEPTH_JUMP / 2)]);
    expect([...edgesToBytes(null, small, facing, W, H)]).toEqual([255, 255, 255, 255]);
    // drawn next to empty
    expect([...edgesToBytes(null, Float32Array.from([5, Infinity, Infinity, 5]), null, W, H)]).toEqual([
      0, 255, 0, 255,
    ]);
    // a crease: normals 90° apart
    const crease = Float32Array.from([0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0]);
    expect([...edgesToBytes(null, flat, crease, W, H)]).toEqual([255, 0, 255, 255]);
    // a floor seen at a grazing angle: depth steps of 10 % between pixels, normals nearly edge-on
    const grazing = Float32Array.from([10, 11, 12.1, 13.3]);
    const floorN = new Float32Array(12);
    for (let i = 0; i < 4; i++) floorN.set([0, 0.995, 0.0998], i * 3);
    expect([...edgesToBytes(null, grazing, floorN, W, H)]).toEqual([255, 255, 255, 255]);
    // vertical neighbours count too
    expect([...edgesToBytes(Uint32Array.from([1, 2]), Float32Array.from([5, 5]), null, 1, 2)]).toEqual([
      0, 255,
    ]);
  });
});
