import type { Vec3, Vec4 } from '../math/types';
import type { SceneDoc } from '../doc/scene-doc';
import { createMesh } from '../mesh/types';
import { srgbToLinear } from '../render/color';
import { DESK_PROPS } from './props';
import { deskProp, rideoSunVector } from './layout';
import { setDeskSettings } from './shots';

/*
 * The set of a scene (spec §4 desk.set_build, §1 sun): rideo's set rebuilt in the editor.
 *
 * - The ground: a plane of width × depth centred on the origin at z = 0, coloured from the ground's
 *   name with rideo's table (groundColor), and around it to the horizon "the world beyond the set"
 *   a little lower and darker (as rideo's camera views draw it).
 * - The sun: rideo's azimuth (0° the front, −Y; 90° the right, +X) and elevation. With `sky` the
 *   world is the procedural SKY whose sun is the one key light (sun_rotation = rad(az) + π,
 *   sun_elevation = rad(el): its direction towards the sun is rideo's sun vector mapped to editor
 *   axes); without, the world keeps its environment (a SKY one becomes STUDIO, whose light is
 *   ambient) and a SUN lamp shining from that direction is the key light.
 * - Interiors: four 3.2 m walls around the set. Each is a single plane facing into the room with a
 *   back-face-culled material, so a camera outside the room sees through the wall between it and
 *   the set (the front, −Y wall for the usual camera), as in rideo's camera views; nothing is
 *   omitted and every wall closes the room for cameras inside it.
 *
 * Everything the builder makes has desk_role 'set' and desk_label ground | wall | sun; building again
 * replaces it (and the materials only it used).
 */

export interface DeskSetOptions {
  width: number;
  depth: number;
  ground: string;
  interior: boolean;
  /** rideo's azimuth: 0° = front (towards the audience, −Y), 90° = right (+X). */
  sun_azimuth_deg: number;
  sun_elevation_deg: number;
  sky: boolean;
}

export interface DeskSetResult {
  ground: string;
  walls: string[];
  /** The SUN lamp (sky off), else null. */
  sun: string | null;
  /** Objects of the previous set that were removed. */
  removed: string[];
}

/** Height of interior walls (m), as rideo's. */
export const WALL_HEIGHT_M = 3.2;
/** Colour of interior walls (sRGB), as rideo's. */
export const WALL_COLOR = '#c9c6bf';

/** rideo's ground colours by what the ground is called, the first match winning (sRGB hex). */
export const GROUND_COLORS: readonly (readonly [RegExp, string])[] = [
  [/snow/, '#eef2f6'],
  [/ice/, '#d6ecf5'],
  [/sand|beach|dune/, '#d9c49a'],
  [/grass|lawn|meadow|field|park/, '#7fae5a'],
  [/water|sea|lake|pool/, '#4f8fc9'],
  [/wood|plank|deck|parquet/, '#a07850'],
  [/carpet|rug/, '#8a6f6a'],
  [/dirt|soil|mud|earth|trail|path/, '#8b6b4a'],
  [/stone|rock|concrete|asphalt|road|street|tile|pavement|marble/, '#8d9096'],
];

/** The ground's colour (sRGB hex) from its name (rideo's groundColor). */
export function groundColor(ground: string, interior: boolean): string {
  const g = ground.toLowerCase();
  for (const [re, hex] of GROUND_COLORS) if (re.test(g)) return hex;
  return interior ? '#9c968c' : '#a3a7ad';
}

/** Linear RGBA of an sRGB hex colour, darkened by `shade`. */
function linearColor(hex: string, shade = 1): Vec4 {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const c = (v: number) => srgbToLinear(((v & 255) / 255) * shade);
  return [c(n >> 16), c(n >> 8), c(n), 1];
}

/** The sun's rotation of an editor SKY world for rideo's azimuth (radians, in [0, 2π)). */
export function skySunRotation(azimuthDeg: number): number {
  const r = (azimuthDeg * Math.PI) / 180 + Math.PI;
  const turn = 2 * Math.PI;
  return ((r % turn) + turn) % turn;
}

const SET_LABELS = new Set(['ground', 'wall', 'sun']);

/**
 * Builds the set: ground, sky or sun lamp, interior walls; replaces the set built before and records
 * the set's size in the desk settings.
 */
export function buildSet(doc: SceneDoc, o: DeskSetOptions): DeskSetResult {
  const width = Math.max(0.01, o.width);
  const depth = Math.max(0.01, o.depth);
  // the previous set (and the materials nothing else uses)
  const old = doc
    .listObjects()
    .filter((x) => deskProp(x, DESK_PROPS.role) === 'set' && SET_LABELS.has(deskProp(x, DESK_PROPS.label)));
  const oldMaterials = new Set(old.flatMap((x) => x.material_slots.filter((m): m is string => !!m)));
  doc.removeObjects(old.map((x) => x.id));
  const used = new Set(doc.listObjects().flatMap((x) => x.material_slots));
  for (const m of oldMaterials) if (!used.has(m)) doc.removeMaterial(m);

  const hex = groundColor(o.ground, o.interior);
  const groundMat = doc.addMaterial({ name: 'Set Ground', base_color: linearColor(hex), roughness: 0.9 });
  const beyondMat = doc.addMaterial({
    name: 'Set Ground Beyond',
    base_color: linearColor(hex, 0.86),
    roughness: 0.95,
  });
  const ground = doc.addObject({
    type: 'MESH',
    name: 'Set Ground',
    data: doc.addMesh('Set Ground', groundMesh(width, depth)),
    material_slots: [groundMat, beyondMat],
    custom_props: { [DESK_PROPS.role]: 'set', [DESK_PROPS.label]: 'ground' },
  });

  const walls: string[] = [];
  if (o.interior) {
    const wallMat = doc.addMaterial({
      name: 'Set Wall',
      base_color: linearColor(WALL_COLOR),
      roughness: 0.85,
      use_backface_culling: true,
    });
    const w = width / 2;
    const d = depth / 2;
    const h = WALL_HEIGHT_M;
    // corners counter-clockwise seen from inside the room: each plane faces the set's centre
    const sides: [string, Vec3[]][] = [
      [
        'Back',
        [
          [-w, d, 0],
          [w, d, 0],
          [w, d, h],
          [-w, d, h],
        ],
      ],
      [
        'Front',
        [
          [w, -d, 0],
          [-w, -d, 0],
          [-w, -d, h],
          [w, -d, h],
        ],
      ],
      [
        'Left',
        [
          [-w, -d, 0],
          [-w, d, 0],
          [-w, d, h],
          [-w, -d, h],
        ],
      ],
      [
        'Right',
        [
          [w, d, 0],
          [w, -d, 0],
          [w, -d, h],
          [w, d, h],
        ],
      ],
    ];
    for (const [side, quad] of sides) {
      const name = `Set Wall ${side}`;
      walls.push(
        doc.addObject({
          type: 'MESH',
          name,
          data: doc.addMesh(name, wallMesh(quad)),
          material_slots: [wallMat],
          custom_props: { [DESK_PROPS.role]: 'set', [DESK_PROPS.label]: 'wall' },
        }),
      );
    }
  }

  let sun: string | null = null;
  const world = doc.getWorld();
  if (o.sky) {
    doc.updateWorld({
      environment: 'SKY',
      show_environment_background: true,
      sun_rotation: skySunRotation(o.sun_azimuth_deg),
      sun_elevation: (Math.max(0, Math.min(90, o.sun_elevation_deg)) * Math.PI) / 180,
    });
  } else {
    if (world.environment === 'SKY') doc.updateWorld({ environment: 'STUDIO' });
    const toward = rideoSunVector(o.sun_azimuth_deg, o.sun_elevation_deg);
    // a sun lamp shines along its −Z: its +Z (Rz(yaw)·Rx(pitch)·Z = (sin yaw sin pitch, −cos yaw sin
    // pitch, cos pitch)) points towards the sun
    const yaw = Math.atan2(toward[0], -toward[1]);
    const pitch = Math.acos(Math.max(-1, Math.min(1, toward[2])));
    const data = doc.addLight({
      name: 'Set Sun',
      type: 'SUN',
      energy: world.sun_intensity || 3,
      use_shadow: true,
    });
    sun = doc.addObject({
      type: 'LIGHT',
      name: 'Set Sun',
      data,
      location: [0, 0, 10],
      rotation_euler: [pitch, 0, yaw],
      custom_props: { [DESK_PROPS.role]: 'set', [DESK_PROPS.label]: 'sun' },
    });
  }
  setDeskSettings(doc, { set_width: width, set_depth: depth, interior: o.interior });
  return { ground, walls, sun, removed: old.map((x) => x.id) };
}

/**
 * The ground: the set's plane (material 0) and around it a ring out to the horizon, 2 cm lower
 * (material 1; rideo draws it 6 × the set's size + 60 m away).
 */
function groundMesh(width: number, depth: number): ReturnType<typeof createMesh> {
  const w = width / 2;
  const d = depth / 2;
  const far = Math.max(width, depth) * 6 + 60;
  const z = -0.02;
  const positions = [
    // the set
    -w,
    -d,
    0,
    w,
    -d,
    0,
    w,
    d,
    0,
    -w,
    d,
    0,
    // the ring: inner corners, then outer corners (counter-clockwise from −X −Y)
    -w,
    -d,
    z,
    w,
    -d,
    z,
    w,
    d,
    z,
    -w,
    d,
    z,
    -far,
    -far,
    z,
    far,
    -far,
    z,
    far,
    far,
    z,
    -far,
    far,
    z,
  ];
  const faces = [
    [0, 1, 2, 3],
    [8, 9, 5, 4],
    [9, 10, 6, 5],
    [10, 11, 7, 6],
    [11, 8, 4, 7],
  ];
  return createMesh({ positions, faces, faceMaterials: [0, 1, 1, 1, 1] });
}

function wallMesh(quad: Vec3[]): ReturnType<typeof createMesh> {
  return createMesh({ positions: quad.flat(), faces: [[0, 1, 2, 3]] });
}
