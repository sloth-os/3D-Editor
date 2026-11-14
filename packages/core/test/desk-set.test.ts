import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import type { SceneDoc } from '../src/doc/scene-doc';
import { SceneDoc as Doc } from '../src/doc/scene-doc';
import { compose4 } from '../src/math/mat4';
import { transformPoint3 as transformPoint } from '../src/math/vec3';
import { srgbToLinear } from '../src/render/color';
import { sunDirection } from '../src/render/sky';
import { DeskScene, rideoSunVector } from '../src/desk/layout';
import { getDeskSettings } from '../src/desk/shots';
import {
  GROUND_COLORS,
  WALL_HEIGHT_M,
  buildSet,
  groundColor,
  skySunRotation,
  type DeskSetOptions,
} from '../src/desk/set';
import { expectNear } from './desk-fixtures';

/*
 * The set builder (desk.set_build): rideo's ground colours, the sky's sun at rideo's azimuth and
 * elevation (one key light), interior walls a camera outside the room sees through, and rebuilding
 * replacing the set built before.
 */

const OPTIONS: DeskSetOptions = {
  width: 12,
  depth: 10,
  ground: 'grass',
  interior: false,
  sun_azimuth_deg: 135,
  sun_elevation_deg: 40,
  sky: true,
};

const setObjects = (doc: SceneDoc, label?: string) =>
  doc
    .listObjects()
    .filter((o) => o.custom_props.desk_role === 'set' && (!label || o.custom_props.desk_label === label));

/** World-space vertices of a mesh object's face `f`. */
function faceCorners(doc: SceneDoc, id: string, f = 0): Vec3[] {
  const o = doc.getObject(id)!;
  const mesh = doc.getMesh(o.data!)!;
  const m = compose4(o.location, o.rotation_euler, o.scale);
  return mesh.faces[f].map((i) =>
    transformPoint(m, [mesh.positions[3 * i], mesh.positions[3 * i + 1], mesh.positions[3 * i + 2]]),
  );
}

function normal(c: Vec3[]): Vec3 {
  const u = c[1].map((x, i) => x - c[0][i]);
  const v = c[2].map((x, i) => x - c[0][i]);
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(...n);
  return [n[0] / l, n[1] / l, n[2] / l];
}

const hexLinear = (hex: string, shade = 1) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((c) => srgbToLinear((c / 255) * shade));
};

describe('desk set builder', () => {
  it("colours the ground from its name with rideo's table, the first match winning", () => {
    expect(groundColor('Grass', false)).toBe('#7fae5a');
    expect(groundColor('wooden floor', true)).toBe('#a07850');
    expect(groundColor('sand dunes', false)).toBe('#d9c49a');
    expect(groundColor('ice rink', false)).toBe('#d6ecf5');
    // snow before sand: the first match wins
    expect(groundColor('snowy beach', false)).toBe('#eef2f6');
    expect(groundColor('marble tiles', true)).toBe('#8d9096');
    expect(groundColor('moon dust', false)).toBe('#a3a7ad');
    expect(groundColor('moon dust', true)).toBe('#9c968c');
    expect(GROUND_COLORS.length).toBe(9);
    const doc = Doc.create({ empty: true });
    const r = buildSet(doc, { ...OPTIONS, ground: 'park lawn' });
    const ground = doc.getObject(r.ground)!;
    expect(ground).toMatchObject({
      name: 'Set Ground',
      custom_props: { desk_role: 'set', desk_label: 'ground' },
    });
    const [set, beyond] = ground.material_slots.map((id) => doc.getMaterial(id!)!);
    expectNear(set.base_color.slice(0, 3), hexLinear('#7fae5a'), 1e-9, 'set colour');
    expectNear(beyond.base_color.slice(0, 3), hexLinear('#7fae5a', 0.86), 1e-9, 'beyond the set');
  });

  it('lays the ground out width × depth at z 0, with the world beyond a little lower', () => {
    const doc = Doc.create({ empty: true });
    const r = buildSet(doc, { ...OPTIONS, width: 8, depth: 6 });
    const mesh = doc.getMesh(doc.getObject(r.ground)!.data!)!;
    expect(mesh.faces).toHaveLength(5);
    expect(mesh.faceMaterials).toEqual([0, 1, 1, 1, 1]);
    const corners = faceCorners(doc, r.ground, 0);
    expect(corners).toEqual([
      [-4, -3, 0],
      [4, -3, 0],
      [4, 3, 0],
      [-4, 3, 0],
    ]);
    expect(normal(corners)).toEqual([0, 0, 1]);
    for (let f = 1; f < 5; f++) expect(normal(faceCorners(doc, r.ground, f))[2]).toBeCloseTo(1, 9);
    const zs = mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(-0.02, 6); // meshes store 32-bit floats
    expect(Math.max(...mesh.positions.filter((_, i) => i % 3 === 0))).toBe(8 * 6 + 60);
    expect(getDeskSettings(doc)).toMatchObject({ set_width: 8, set_depth: 6, interior: false });
  });

  it("puts the sky's sun at rideo's azimuth and elevation, the only key light", () => {
    for (const az of [0, 45, 90, 135, 180, 270, -90, 450]) {
      const doc = Doc.create({ empty: true });
      const r = buildSet(doc, { ...OPTIONS, sun_azimuth_deg: az, sun_elevation_deg: 30 });
      const world = doc.getWorld();
      expect(world).toMatchObject({ environment: 'SKY', show_environment_background: true });
      expect(world.sun_rotation).toBeGreaterThanOrEqual(0);
      expect(world.sun_rotation).toBeLessThan(2 * Math.PI);
      expect(world.sun_rotation).toBeCloseTo(skySunRotation(az), 12);
      expect(world.sun_elevation).toBeCloseTo((30 * Math.PI) / 180, 12);
      expectNear(sunDirection(world), rideoSunVector(az, 30), 1e-12, `azimuth ${az}`);
      expect(r.sun).toBeNull();
      expect(doc.listObjects().filter((o) => o.type === 'LIGHT')).toEqual([]);
    }
    // rideo's default: 135° (front right), 40° up
    expect(skySunRotation(135)).toBeCloseTo((315 * Math.PI) / 180, 12);
  });

  it('lights the set with one sun lamp shining from that direction without a sky', () => {
    const doc = Doc.create({ empty: true });
    doc.updateWorld({ environment: 'SKY' });
    const r = buildSet(doc, { ...OPTIONS, sky: false, sun_azimuth_deg: 200, sun_elevation_deg: 25 });
    expect(doc.getWorld().environment).toBe('STUDIO');
    const lamp = doc.getObject(r.sun!)!;
    expect(doc.getLight(lamp.data!)).toMatchObject({ type: 'SUN' });
    expect(lamp.custom_props).toMatchObject({ desk_role: 'set', desk_label: 'sun' });
    // the lamp's +Z points at the sun (it shines along its −Z)
    const m = compose4([0, 0, 0], lamp.rotation_euler, [1, 1, 1]);
    expectNear(transformPoint(m, [0, 0, 1]), rideoSunVector(200, 25), 1e-12, 'towards the sun');
    // the desk reads the lamp as the set's sun
    expectNear(new DeskScene(doc).sun(1), rideoSunVector(200, 25), 1e-9, 'scene sun');
  });

  it('closes an interior with four 3.2 m walls that face into the room and cull their backs', () => {
    const doc = Doc.create({ empty: true });
    const r = buildSet(doc, { ...OPTIONS, interior: true, ground: 'carpet', width: 6, depth: 4 });
    expect(r.walls).toHaveLength(4);
    expect(r.walls.map((id) => doc.getObject(id)!.name)).toEqual([
      'Set Wall Back',
      'Set Wall Front',
      'Set Wall Left',
      'Set Wall Right',
    ]);
    for (const id of r.walls) {
      const o = doc.getObject(id)!;
      expect(o.custom_props).toMatchObject({ desk_role: 'set', desk_label: 'wall' });
      expect(doc.getMaterial(o.material_slots[0]!)).toMatchObject({ use_backface_culling: true });
      const c = faceCorners(doc, id);
      const zs = c.map((p) => p[2]);
      expect(Math.min(...zs)).toBe(0);
      expect(Math.max(...zs)).toBeCloseTo(WALL_HEIGHT_M, 6);
      // the wall faces the middle of the room
      const mid = [0, 1, 2].map((i) => c.reduce((sum, p) => sum + p[i] / 4, 0));
      const n = normal(c);
      expect(n[2]).toBeCloseTo(0, 12);
      expect(n[0] * -mid[0] + n[1] * -mid[1]).toBeGreaterThan(0);
    }
    // a camera in front of the set sees the front wall's back: culled, so it looks into the room
    const front = faceCorners(doc, r.walls[1]);
    expect(normal(front)[1]).toBeCloseTo(1, 12);
    expect(getDeskSettings(doc)).toMatchObject({ interior: true, set_width: 6, set_depth: 4 });
    expect(groundColor('carpet', true)).toBe('#8a6f6a');
  });

  it('replaces the set built before and the materials only it used', () => {
    const doc = Doc.create({ empty: true });
    const first = buildSet(doc, { ...OPTIONS, interior: true, sky: false });
    const materials = doc.listMaterials().length;
    const keep = doc.addObject({ type: 'EMPTY', name: 'Not the set' });
    const second = buildSet(doc, { ...OPTIONS, ground: 'sand' });
    expect(second.removed.sort()).toEqual([first.ground, ...first.walls, first.sun!].sort());
    expect(setObjects(doc).map((o) => o.id)).toEqual([second.ground]);
    expect(doc.getObject(keep)).not.toBeNull();
    // the walls' material went with them; the ground's two were replaced by new ones
    expect(doc.listMaterials().length).toBe(materials - 1);
    expect(
      doc
        .listMaterials()
        .map((m) => m.name)
        .sort(),
    ).toEqual(['Set Ground', 'Set Ground Beyond']);
    // the sun lamp's light datablock went with it
    expect(doc.listLights()).toEqual([]);
  });
});
