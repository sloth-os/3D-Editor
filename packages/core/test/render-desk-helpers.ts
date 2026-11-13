/*
 * Scenes shared by the director's desk render tests (render-desk-*.test.ts): a sunlit SKY world set
 * with cubes, spheres and capsule "people" on a ground plane, a spot-lit interior, and a mixed
 * scene covering every shading path (studio world, metals, glass, alpha blending, procedural
 * textures, point/spot/area lights, mist). Everything is deterministic: positions and colours come
 * from a seeded generator, so renders hash the same in every process.
 */
import { createHash } from 'node:crypto';
import {
  SceneDoc,
  createCube,
  createCylinder,
  createPlane,
  createUVSphere,
  defaultProcedural,
  type LightData,
  type MaterialData,
  type MeshData,
  type RenderedImage,
  type RenderView,
  type Vec3,
} from '../src';

/** sha256 (hex, 16 chars) of an image's pixels. */
export function imageHash(img: RenderedImage): string {
  return createHash('sha256').update(img.data).digest('hex').slice(0, 16);
}

/** Pixel (column, row; top row first) where world point `p` appears, or null when off screen or behind. */
export function projectToPixel(
  view: RenderView,
  p: Vec3,
  width: number,
  height: number,
): [number, number] | null {
  const M = view.viewProj;
  const x = M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12];
  const y = M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13];
  const w = M[3] * p[0] + M[7] * p[1] + M[11] * p[2] + M[15];
  if (!(w > 0)) return null;
  const px = Math.floor(((x / w) * 0.5 + 0.5) * width);
  const py = Math.floor((0.5 - (y / w) * 0.5) * height);
  return px >= 0 && py >= 0 && px < width && py < height ? [px, py] : null;
}

/** Distance of `p` in front of the view's camera plane (as the depth pass stores it). */
export function planarDepth(view: RenderView, p: Vec3): number {
  const e = view.eye;
  const f = view.forward;
  return (p[0] - e[0]) * f[0] + (p[1] - e[1]) * f[1] + (p[2] - e[2]) * f[2];
}

/** Rec. 709 luma of an RGBA8 pixel (display values, 0..255). */
export function luma(img: RenderedImage, x: number, y: number): number {
  const o = (y * img.width + x) * 4;
  return 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2];
}

/** Whether two images hold the same RGBA bytes at pixel (x, y). */
export function samePixel(a: RenderedImage, b: RenderedImage, x: number, y: number): boolean {
  const o = (y * a.width + x) * 4;
  return (
    a.data[o] === b.data[o] &&
    a.data[o + 1] === b.data[o + 1] &&
    a.data[o + 2] === b.data[o + 2] &&
    a.data[o + 3] === b.data[o + 3]
  );
}

/** A copy of `mesh` with every face smooth shaded. */
export function smooth(mesh: MeshData): MeshData {
  return { ...mesh, faceSmooth: mesh.faceSmooth.map(() => true) };
}

/** Linear congruential generator in [0, 1) (seeded, the same sequence everywhere). */
export function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32;
}

const deg = (d: number) => (d * Math.PI) / 180;

export interface SceneBuild {
  doc: SceneDoc;
  /** Camera object id. */
  camera: string;
  /** Object ids by name. */
  ids: Record<string, string>;
}

/** Adds a mesh object with one material; returns its id. */
function addMeshObject(
  doc: SceneDoc,
  name: string,
  mesh: string,
  material: Partial<MaterialData>,
  location: Vec3,
  extra: { rotation_euler?: Vec3; scale?: Vec3 } = {},
): string {
  const mat = doc.addMaterial({ name: `${name}Mat`, ...material });
  return doc.addObject({ type: 'MESH', name, data: mesh, material_slots: [mat], location, ...extra });
}

/** Adds a camera at `position` looking at `target` (Z up) and makes it the scene camera. */
export function lookCamera(doc: SceneDoc, position: Vec3, target: Vec3, lens = 35): string {
  const d: Vec3 = [target[0] - position[0], target[1] - position[1], target[2] - position[2]];
  const yaw = Math.atan2(d[1], d[0]) - Math.PI / 2;
  const pitch = Math.atan2(Math.hypot(d[0], d[1]), -d[2]);
  const id = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ lens }),
    location: position,
    rotation_euler: [pitch, 0, yaw],
  });
  doc.updateScene({ camera: id });
  return id;
}

/**
 * The desk bench scene: a 40 m ground plane, 10 cubes, 10 spheres and `people` capsule figures
 * (cylinder body + sphere head, smooth shaded) under a SKY world whose sun stands at
 * `sunElevation` degrees (azimuth `sunRotation`), seen by a 35 mm camera from the south east.
 * About 10k triangles with the default sphere resolution.
 */
export function deskScene(
  opts: {
    sunElevation?: number;
    sunRotation?: number;
    people?: number;
    segments?: number;
    showBackground?: boolean;
  } = {},
): SceneBuild {
  const rnd = seeded(12345);
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({
    environment: 'SKY',
    sun_elevation: deg(opts.sunElevation ?? 40),
    sun_rotation: deg(opts.sunRotation ?? 200),
    show_environment_background: opts.showBackground ?? true,
  });
  doc.updateRender({ engine: 'RASTER', view_transform: 'AGX' });
  const ids: Record<string, string> = {};
  ids.Ground = addMeshObject(
    doc,
    'Ground',
    doc.addMesh('Ground', createPlane({ size: 40 })),
    { base_color: [0.42, 0.45, 0.36, 1], roughness: 0.85 },
    [0, 0, 0],
  );
  const cube = doc.addMesh('Cube', createCube({ size: 1 }));
  const seg = opts.segments ?? 32;
  const sphere = doc.addMesh(
    'Sphere',
    smooth(createUVSphere({ segments: seg, ring_count: seg / 2, radius: 0.6 })),
  );
  for (let i = 0; i < 20; i++) {
    const name = `${i % 2 ? 'Sphere' : 'Cube'}${i}`;
    const color: [number, number, number, number] = [
      0.2 + 0.7 * rnd(),
      0.2 + 0.7 * rnd(),
      0.2 + 0.7 * rnd(),
      1,
    ];
    ids[name] = addMeshObject(
      doc,
      name,
      i % 2 ? sphere : cube,
      { base_color: color, roughness: 0.55 },
      [(i % 5) * 2.5 - 5, Math.floor(i / 5) * 2.5 - 5, i % 2 ? 0.6 : 0.5],
      { rotation_euler: [0, 0, rnd() * Math.PI] },
    );
  }
  const body = doc.addMesh('Body', smooth(createCylinder({ vertices: 24, radius: 0.22, depth: 1.2 })));
  const head = doc.addMesh('Head', smooth(createUVSphere({ segments: 24, ring_count: 12, radius: 0.13 })));
  const people = opts.people ?? 3;
  for (let p = 0; p < people; p++) {
    const x = -6.2 + p * 1.1;
    const y = -1 + p * 1.7;
    const color: [number, number, number, number] = [
      0.3 + 0.6 * rnd(),
      0.3 + 0.5 * rnd(),
      0.3 + 0.4 * rnd(),
      1,
    ];
    ids[`Person${p}`] = addMeshObject(doc, `Person${p}`, body, { base_color: color, roughness: 0.6 }, [
      x,
      y,
      0.6,
    ]);
    ids[`Head${p}`] = addMeshObject(doc, `Head${p}`, head, { base_color: [0.8, 0.62, 0.5, 1] }, [x, y, 1.35]);
  }
  const camera = lookCamera(doc, [9, -12.5, 6.2], [-1, 0, 0.5]);
  return { doc, camera, ids };
}

/**
 * A spot-lit interior: a 6 × 5 m floor with three walls and a ceiling-less room (dim world), a
 * spot light (cone `spotSize` degrees, default 75; radius `softSize` m) above the camera side aimed
 * at the table, a table (box), a sphere on it, a standing capsule figure and a chair-sized box;
 * camera at eye height.
 */
export function spotInteriorScene(opts: { softSize?: number; spotSize?: number } = {}): SceneBuild {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'NONE', color: [0.02, 0.022, 0.025], strength: 1 });
  doc.updateRender({ engine: 'RASTER', view_transform: 'AGX' });
  const ids: Record<string, string> = {};
  const unit = doc.addMesh('Unit', createCube({ size: 1 }));
  const wall = { base_color: [0.75, 0.72, 0.66, 1] as [number, number, number, number], roughness: 0.9 };
  ids.Floor = addMeshObject(
    doc,
    'Floor',
    doc.addMesh('Floor', createPlane({ size: 1 })),
    {
      base_color: [0.45, 0.33, 0.24, 1],
      roughness: 0.7,
    },
    [0, 0, 0],
    { scale: [6, 5, 1] },
  );
  ids.Back = addMeshObject(doc, 'Back', unit, wall, [0, 2.55, 1.4], { scale: [6, 0.1, 2.8] });
  ids.Left = addMeshObject(doc, 'Left', unit, wall, [-3.05, 0, 1.4], { scale: [0.1, 5, 2.8] });
  ids.Right = addMeshObject(doc, 'Right', unit, wall, [3.05, 0, 1.4], { scale: [0.1, 5, 2.8] });
  ids.Table = addMeshObject(
    doc,
    'Table',
    unit,
    { base_color: [0.5, 0.3, 0.15, 1], roughness: 0.5 },
    [0.6, 0.8, 0.375],
    {
      scale: [1.4, 0.8, 0.75],
    },
  );
  ids.Ball = addMeshObject(
    doc,
    'Ball',
    doc.addMesh('Ball', smooth(createUVSphere({ segments: 32, ring_count: 16, radius: 0.18 }))),
    { base_color: [0.8, 0.15, 0.1, 1], roughness: 0.4 },
    [0.4, 0.75, 0.93],
  );
  ids.Chair = addMeshObject(doc, 'Chair', unit, { base_color: [0.2, 0.35, 0.6, 1] }, [-0.9, 0.2, 0.25], {
    scale: [0.45, 0.45, 0.5],
  });
  ids.Person = addMeshObject(
    doc,
    'Person',
    doc.addMesh('Body', smooth(createCylinder({ vertices: 24, radius: 0.22, depth: 1.5 }))),
    { base_color: [0.25, 0.5, 0.3, 1], roughness: 0.6 },
    [-1.8, 1.2, 0.75],
  );
  const spot = doc.addLight({
    type: 'SPOT',
    energy: 1500,
    spot_size: deg(opts.spotSize ?? 75),
    spot_blend: 0.25,
    shadow_soft_size: opts.softSize ?? 0.1,
  });
  // above the camera side of the room, aimed at the table (−Z of the object is the light direction)
  ids.Spot = doc.addObject({
    type: 'LIGHT',
    name: 'Spot',
    data: spot,
    location: [0.3, -1.6, 2.7],
    rotation_euler: [deg(48), 0, deg(-8)],
  });
  const camera = lookCamera(doc, [0.2, -4.2, 1.6], [0, 0.8, 0.8], 24);
  return { doc, camera, ids };
}

/**
 * A scene touching every RASTER shading path: STUDIO world, a metal and a glossy sphere (the
 * reflection probe), a glass pane (transmission), an alpha-blended plane, a procedural checker,
 * vertex-colour-free cubes, a point, a spot and an area light, and world mist.
 */
export function mixedScene(): SceneBuild {
  const doc = SceneDoc.create({ empty: true });
  doc.updateWorld({ environment: 'STUDIO', show_environment_background: true, mist_density: 0.02 });
  doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
  const ids: Record<string, string> = {};
  const unit = doc.addMesh('Unit', createCube({ size: 1 }));
  const ball = doc.addMesh('Ball', smooth(createUVSphere({ segments: 24, ring_count: 12, radius: 0.5 })));
  ids.Floor = addMeshObject(
    doc,
    'Floor',
    doc.addMesh('Floor', createPlane({ size: 12 })),
    {
      base_color: [0.6, 0.6, 0.6, 1],
      roughness: 0.6,
      textures: {
        base_color: {
          image: '',
          scale: [1, 1],
          offset: [0, 0],
          procedural: defaultProcedural('CHECKER', {
            scale: 6,
            color_a: [0.7, 0.7, 0.7, 1],
            color_b: [0.25, 0.25, 0.3, 1],
          }),
        },
      },
    },
    [0, 0, 0],
  );
  ids.Metal = addMeshObject(
    doc,
    'Metal',
    ball,
    { base_color: [0.95, 0.8, 0.5, 1], metallic: 1, roughness: 0.2 },
    [-1.2, 0.5, 0.5],
  );
  ids.Glossy = addMeshObject(
    doc,
    'Glossy',
    ball,
    { base_color: [0.1, 0.3, 0.8, 1], roughness: 0.1 },
    [0.3, 1.2, 0.5],
  );
  ids.Box = addMeshObject(doc, 'Box', unit, { base_color: [0.8, 0.2, 0.2, 1] }, [1.4, 0.2, 0.5], {
    rotation_euler: [0, 0, 0.5],
  });
  ids.Glass = addMeshObject(
    doc,
    'Glass',
    unit,
    { base_color: [0.9, 1, 0.95, 1], transmission: 1, roughness: 0.05, ior: 1.5 },
    [0, -0.6, 0.6],
    { scale: [1.6, 0.06, 1.2] },
  );
  ids.Veil = addMeshObject(
    doc,
    'Veil',
    doc.addMesh('Veil', createPlane({ size: 1 })),
    { base_color: [0.2, 0.9, 0.3, 0.45], blend_method: 'BLEND', alpha: 1 },
    [1.2, -1, 0.9],
    { rotation_euler: [deg(80), 0, 0.3] },
  );
  doc.addObject({
    type: 'LIGHT',
    name: 'Point',
    data: doc.addLight({ type: 'POINT', energy: 300, color: [1, 0.85, 0.7] }),
    location: [2, -2, 2.5],
  });
  doc.addObject({
    type: 'LIGHT',
    name: 'Spot',
    data: doc.addLight({ type: 'SPOT', energy: 500, spot_size: deg(50) }),
    location: [-2, -1, 3],
    rotation_euler: [deg(30), 0, deg(-40)],
  });
  doc.addObject({
    type: 'LIGHT',
    name: 'Area',
    data: doc.addLight({ type: 'AREA', energy: 200, size: 1 }),
    location: [0, 2, 3],
    rotation_euler: [deg(-30), 0, 0],
  });
  const camera = lookCamera(doc, [3.2, -4.4, 2.4], [0, 0.3, 0.4], 30);
  return { doc, camera, ids };
}

/** A light of `boxOverGround`: its type, settings, place and rotation (Blender: it shines along −Z). */
export interface TestLight {
  data: Partial<LightData> & { type: LightData['type'] };
  location: Vec3;
  rotation?: Vec3;
}

/**
 * A unit cube floating at (0, 0, 1.5) (bottom face 1 m above the ground) over a 20 m ground plane at
 * z = 0, a dim flat world (no environment), Standard view transform, the given lights and a 35 mm
 * camera at `camera` looking at `target`. `cube` overrides the cube's material.
 */
export function boxOverGround(
  lights: readonly TestLight[],
  opts: { camera?: Vec3; target?: Vec3; cube?: Partial<MaterialData>; world?: number } = {},
): SceneBuild {
  const doc = SceneDoc.create({ empty: true });
  const w = opts.world ?? 0.03;
  doc.updateWorld({ environment: 'NONE', color: [w, w, w], strength: 1 });
  doc.updateRender({ engine: 'RASTER', view_transform: 'STANDARD' });
  const ids: Record<string, string> = {};
  ids.Ground = addMeshObject(
    doc,
    'Ground',
    doc.addMesh('Ground', createPlane({ size: 20 })),
    { base_color: [0.5, 0.5, 0.5, 1], roughness: 0.9 },
    [0, 0, 0],
  );
  ids.Cube = addMeshObject(
    doc,
    'Cube',
    doc.addMesh('Cube', createCube({ size: 1 })),
    { base_color: [0.6, 0.3, 0.2, 1], roughness: 0.7, ...opts.cube },
    [0, 0, 1.5],
  );
  lights.forEach((l, i) => {
    ids[`Light${i}`] = doc.addObject({
      type: 'LIGHT',
      name: `Light${i}`,
      data: doc.addLight(l.data),
      location: l.location,
      rotation_euler: l.rotation ?? [0, 0, 0],
    });
  });
  const camera = lookCamera(doc, opts.camera ?? [3, 6, 4.5], opts.target ?? [0, 0.8, 0.3]);
  return { doc, camera, ids };
}
