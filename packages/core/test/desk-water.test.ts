import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/math/types';
import { SceneDoc } from '../src/doc/scene-doc';
import type { ObjectData } from '../src/doc/types';
import { createFCurve, insertKeyframe } from '../src/anim/fcurve';
import { createCube, createCylinder, createPlane } from '../src/mesh/primitives';
import { createMesh } from '../src/mesh/types';
import { DeskScene } from '../src/desk/layout';
import { DESK_PROPS } from '../src/desk/props';
import {
  WATER_LEVEL_M,
  hasWater,
  inWaterSpans,
  markInWater,
  pathWaterWarnings,
  standsOnWaterWarning,
  waterAlong,
  waterAt,
  waterSurfaces,
} from '../src/desk/water';
import * as core from '../src';
import { deskOperators } from './desk-fixtures';
import { dialogueClip, importClip } from './desk-rideo-fixtures';

/*
 * The water of the desk's scenes (desk/water.ts): footprints exact per polygon (the lake's water,
 * not its sandy shore nor the box around them), each with its surface height (what faces up: a box
 * of water's top), rideo's boxes and cylinders its labels name water; waterAt and waterAlong (the
 * stretches of a path over water, in metres), the level filter that tells a bridge from a ford,
 * moving and hidden pieces (by their own hide_render, as renders read it), the frames an actor
 * belongs in the water (desk_in_water) and the warning texts the operators report.
 */

/** A flat square of water `size` m wide centred at `at` (a mesh whose desk_shape is 'water'). */
function pond(doc: SceneDoc, name: string, at: Vec3, size: number, init: Partial<ObjectData> = {}): string {
  return doc.addObject({
    type: 'MESH',
    name,
    data: doc.addMesh(name, createPlane({ size })),
    location: at,
    custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: name, desk_shape: 'water' },
    ...init,
  });
}

/** The built-in lake (store.add) `width` × `depth` m at `at`. */
function lake(doc: SceneDoc, at: Vec3, width = 10, depth = 7): string {
  const { run } = deskOperators(doc);
  return run<{ root: string }>('store.add', { model: 'lake', location: at, params: { width, depth } }).root;
}

describe('water footprints', () => {
  it("are the lake's water polygon exactly: not its sand bank, not its bounding box", () => {
    const doc = SceneDoc.create({ empty: true });
    const root = lake(doc, [0, 0, 0]);
    const centre = waterAt(doc, [0, 0, 0], 1);
    expect(centre).toMatchObject({ owner: root, label: 'Lake' });
    expect(centre!.surface_z).toBeCloseTo(0.02, 6);
    // just inside the ellipse (rx 5) and on the shore ring outside it
    expect(waterAt(doc, [4.9, 0, 0], 1)).not.toBeNull();
    expect(waterAt(doc, [5.3, 0, 0], 1)).toBeNull();
    expect(waterAt(doc, [0, 3.7, 0], 1)).toBeNull();
    // inside the water's bounding box (±5 × ±3.5) but outside the ellipse: dry
    expect(waterAt(doc, [4.5, 3.2, 0], 1)).toBeNull();
    expect(waterAt(doc, [-4.6, -3.1, 0], 1)).toBeNull();
    // and so are the corners of each of its polygons' boxes that lie outside the ellipse
    const part = doc.listObjects().find((o) => o.parent === root && o.custom_props?.store_part === 'water')!;
    const mesh = doc.getMesh(part.data!)!;
    const corners: Vec3[] = [];
    for (const f of mesh.faces) {
      const xs = f.map((v) => mesh.positions[v * 3]);
      const ys = f.map((v) => mesh.positions[v * 3 + 1]);
      for (const x of [Math.min(...xs), Math.max(...xs)])
        for (const y of [Math.min(...ys), Math.max(...ys)])
          if ((x / 5) ** 2 + (y / 3.5) ** 2 > 1.05) corners.push([x, y, 0]);
    }
    expect(corners.length).toBeGreaterThan(8);
    expect(corners.filter((p) => waterAt(doc, p, 1))).toEqual([]);
    const [s] = waterSurfaces(doc, 1);
    expect(s.label).toBe('Lake');
    expect(s.min[0]).toBeCloseTo(-5, 3);
    expect(s.max[1]).toBeCloseTo(3.5, 2);
  });

  it('follow the scale, rotation and place of the piece, and give its surface height there', () => {
    const doc = SceneDoc.create({ empty: true });
    // 4 × 4 m, turned 45° and lifted: a basin's water 0.6 m up
    pond(doc, 'Basin', [10, 0, 0.6], 2, { scale: [2, 2, 1], rotation_euler: [0, 0, Math.PI / 4] });
    expect(waterAt(doc, [10, 2.7, 0.6], 1)).not.toBeNull();
    // the corner of the unturned square is out of the turned one
    expect(waterAt(doc, [11.9, 1.9, 0.6], 1)).toBeNull();
    expect(waterAt(doc, [10, 0, 0], 1)!.surface_z).toBeCloseTo(0.6, 6);
  });

  it('name water by its part, its desk_shape or the label of a piece (a pond, not a pool table)', () => {
    const doc = SceneDoc.create({ empty: true });
    const mesh = () => doc.addMesh('m', createPlane({ size: 2 }));
    doc.addObject({
      type: 'MESH',
      name: 'Duck pond',
      data: mesh(),
      location: [0, 0, 0.02],
      custom_props: { [DESK_PROPS.role]: 'landmark' },
    });
    doc.addObject({
      type: 'MESH',
      name: 'Pool table',
      data: mesh(),
      location: [5, 0, 0.8],
      custom_props: { [DESK_PROPS.role]: 'prop' },
    });
    // not a desk piece: an untagged mesh named like water is scenery
    doc.addObject({ type: 'MESH', name: 'Pond', data: mesh(), location: [10, 0, 0.02] });
    expect(waterAt(doc, [0, 0, 0], 1)?.label).toBe('Duck pond');
    expect(waterAt(doc, [5, 0, 0.8], 1)).toBeNull();
    expect(waterAt(doc, [10, 0, 0], 1)).toBeNull();
  });

  it('leave out pieces hidden from renders, and scenes without water have none', () => {
    const doc = SceneDoc.create({ empty: true });
    expect(hasWater(doc)).toBe(false);
    const id = pond(doc, 'Pond', [0, 0, 0.02], 4);
    expect(hasWater(doc)).toBe(true);
    doc.updateObject(id, { hide_render: true });
    expect(hasWater(doc)).toBe(false);
    expect(waterAt(doc, [0, 0, 0], 1)).toBeNull();
  });

  it("keep a model's water when its root is hidden from renders (renders draw its parts by their own)", () => {
    const doc = SceneDoc.create({ empty: true });
    const root = lake(doc, [0, 0, 0]);
    doc.updateObject(root, { hide_render: true });
    expect(waterAt(doc, [0, 0, 0], 1)?.owner).toBe(root);
  });

  it("are a box of water's top over all of its footprint, and a sheet's that faces down", () => {
    const doc = SceneDoc.create({ empty: true });
    // a tank of water 2 m square and 0.5 m deep (its mesh closed: a top, a bottom and sides)
    pond(doc, 'Tank', [0, 0, 0.25], 2, {
      data: doc.addMesh('Tank', createCube({ size: 1 })),
      scale: [2, 2, 0.5],
    });
    for (const p of [
      [0, 0, 0],
      [0.95, 0.95, 0.1],
      [-0.95, 0.5, 0.6],
    ] as Vec3[])
      expect(waterAt(doc, p, 1)!.surface_z).toBeCloseTo(0.5, 6);
    // a sheet of water modelled facing down (turned over): still water at its height
    pond(doc, 'Sheet', [10, 0, 0.3], 2, { rotation_euler: [Math.PI, 0, 0] });
    expect(waterAt(doc, [10.9, -0.9, 0], 1)?.surface_z).toBeCloseTo(0.3, 6);
  });

  it("name rideo's boxes and cylinders water by their label: the top of the river, the pond's ellipse", () => {
    const doc = SceneDoc.create({ empty: true });
    /** rideo's solid landmark (desk_shape box or cylinder) of footprint w × d m, h m high, on the floor. */
    const solid = (label: string, shape: string, at: Vec3, [w, d, h]: Vec3) => {
      const mesh = shape === 'box' ? createCube({ size: 1 }) : createCylinder({ radius: 0.5, depth: 1 });
      return doc.addObject({
        type: 'MESH',
        name: label,
        data: doc.addMesh(label, mesh),
        location: [at[0], at[1], h / 2],
        scale: [w, d, h],
        custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: label, desk_shape: shape },
      });
    };
    solid('River', 'box', [0, 0, 0], [4, 2, 0.1]);
    solid('Duck pond', 'cylinder', [10, 0, 0], [3, 2, 0.1]);
    solid('Boat house', 'box', [20, 0, 0], [4, 3, 3]);
    // the river's top up to the corners of its footprint
    expect(waterAt(doc, [1.95, 0.95, 0], 1)).toMatchObject({
      label: 'River',
      surface_z: expect.closeTo(0.1, 6),
    });
    expect(waterAt(doc, [2.05, 0, 0], 1)).toBeNull();
    // the pond's ellipse, not the corners of its bounds
    expect(waterAt(doc, [11.4, 0, 0], 1)?.label).toBe('Duck pond');
    expect(waterAt(doc, [11.4, 0.9, 0], 1)).toBeNull();
    // a box whose label names no water is solid
    expect(waterAt(doc, [20, 0, 0], 1)).toBeNull();
  });

  it("build rideo's boxes of water as primitives whose top is water over their whole footprint", () => {
    const input = dialogueClip();
    // rideo's 'pond' box, 3 × 2 m at rideo (4, 2) (editor x 2.5–5.5, y −3 to −1), and its 'lake' box
    // 4 × 2 m at rideo (−4, 2) (editor x −6 to −2): not the lake model, whose shore takes their edges
    (input.blocking as { set: { landmarks: object[] } }).set.landmarks.push(
      { id: 'pd', label: 'pond', shape: 'box', x: 4, z: 2, width: 3, depth: 2, height: 0.1 },
      { id: 'lk', label: 'lake', shape: 'box', x: -4, z: 2, width: 4, depth: 2, height: 0.1 },
    );
    const doc = SceneDoc.create({ empty: true });
    importClip(doc, input);
    for (const [label, cx, w] of [
      ['pond', 4, 3],
      ['lake', -4, 4],
    ] as const) {
      const at = (dx: number, dy: number) => waterAt(doc, [cx + dx * (w / 2 - 0.1), -2 + dy * 0.9, 0], 1);
      for (const [dx, dy] of [
        [0, 0],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ])
        expect(at(dx, dy)?.label).toBe(label);
      expect(waterAt(doc, [cx + w / 2 + 0.2, -2, 0], 1)).toBeNull();
    }
  });

  it('move with keys: a piece placed per frame, read the same from a DeskScene', () => {
    const doc = SceneDoc.create({ empty: true });
    const id = pond(doc, 'Puddle', [0, 0, 0.02], 2);
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 0 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    doc.setFCurve(fc);
    expect(waterAt(doc, [0, 0, 0], 1)).not.toBeNull();
    expect(waterAt(doc, [0, 0, 0], 11)).toBeNull();
    expect(waterAt(doc, [10, 0, 0], 11)).not.toBeNull();
    const scene = new DeskScene(doc);
    expect(waterAt(scene, [5, 0, 0], 6)).not.toBeNull();
    expect(waterAt(scene, [5, 0, 0], 1)).toBeNull();
  });

  it('a surface far above or below the point is not at its level (a bridge over a stream)', () => {
    const doc = SceneDoc.create({ empty: true });
    pond(doc, 'Stream', [0, 0, 0.02], 4);
    // standing on a footbridge deck 0.3 m above the water
    expect(waterAt(doc, [0, 0, 0.32], 1)).not.toBeNull();
    expect(waterAt(doc, [0, 0, 0.32], 1, { level: WATER_LEVEL_M })).toBeNull();
    expect(waterAt(doc, [0, 0, 0.05], 1, { level: WATER_LEVEL_M })).not.toBeNull();
  });

  it('stacked surfaces: the one nearest the point (a fountain bowl over its basin)', () => {
    const doc = SceneDoc.create({ empty: true });
    const basin = pond(doc, 'Basin', [0, 0, 0.4], 4);
    const bowl = pond(doc, 'Bowl', [0, 0, 1.2], 1);
    expect(waterAt(doc, [0, 0, 0.3], 1)?.id).toBe(basin);
    expect(waterAt(doc, [0, 0, 1.1], 1)?.id).toBe(bowl);
    // under the bowl's rim but outside it: the basin
    expect(waterAt(doc, [1, 0, 1.1], 1)?.id).toBe(basin);
  });
});

describe('waterAlong', () => {
  it('gives the stretches over water in metres from the start of the path', () => {
    const doc = SceneDoc.create({ empty: true });
    pond(doc, 'West', [-5, 0, 0.02], 2);
    pond(doc, 'East', [5, 0, 0.02], 4);
    const spans = waterAlong(
      doc,
      [
        [-10, 0, 0],
        [10, 0, 0],
      ],
      1,
    );
    expect(spans.map((s) => s.label)).toEqual(['West', 'East']);
    expect(spans[0].from_m).toBeCloseTo(4, 6);
    expect(spans[0].to_m).toBeCloseTo(6, 6);
    expect(spans[1].from_m).toBeCloseTo(13, 6);
    expect(spans[1].to_m).toBeCloseTo(17, 6);
    // a path that misses both
    expect(
      waterAlong(
        doc,
        [
          [-10, 5, 0],
          [10, 5, 0],
        ],
        1,
      ),
    ).toEqual([]);
  });

  it('joins the stretches over one piece across the corners of the path', () => {
    const doc = SceneDoc.create({ empty: true });
    pond(doc, 'Pond', [0, 0, 0.02], 4);
    // in from the west, a corner in the middle of the pond, out to the north
    const spans = waterAlong(
      doc,
      [
        [-5, 0, 0],
        [0, 0, 0],
        [0, 5, 0],
      ],
      1,
    );
    expect(spans).toHaveLength(1);
    expect(spans[0].from_m).toBeCloseTo(3, 6);
    expect(spans[0].to_m).toBeCloseTo(7, 6);
    // a single point: a stretch of length 0
    expect(waterAlong(doc, [[1, 1, 0]], 1)).toMatchObject([{ label: 'Pond', from_m: 0, to_m: 0 }]);
  });

  it("follows the lake's ellipse, and leaves out water off the path's level", () => {
    const doc = SceneDoc.create({ empty: true });
    lake(doc, [0, 0, 0]);
    const across = waterAlong(
      doc,
      [
        [0, -10, 0],
        [0, 10, 0],
      ],
      1,
    );
    expect(across).toHaveLength(1);
    expect(across[0].from_m).toBeCloseTo(6.5, 2);
    expect(across[0].to_m).toBeCloseTo(13.5, 2);
    // the same line 2 m up (a bridge deck far above the water)
    const deck = waterAlong(
      doc,
      [
        [0, -10, 2],
        [0, 10, 2],
      ],
      1,
      { level: WATER_LEVEL_M },
    );
    expect(deck).toEqual([]);
  });
});

describe('the water warnings of the operators', () => {
  it('name the water, where an actor stands on it, and where along a path and when', () => {
    const doc = SceneDoc.create({ empty: true });
    pond(doc, 'Pond', [5, 0, 0.02], 4);
    expect(standsOnWaterWarning(doc, 'Pip', [0, 0, 0], 1)).toBeNull();
    expect(standsOnWaterWarning(doc, 'Pip', [5, 1, 0], 1)).toBe(
      "'Pip' stands on the water of Pond at [5, 1, 0] as if it were solid ground (desk.check reports " +
        'walks_on_water while it is filmed there): put it on dry ground, or, for a swimmer or a wader, add ' +
        'it with desk.actor_add {in_water: true}',
    );
    const path: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    // 10 m from frame 1 to frame 101: 10 frames a metre
    const [w] = pathWaterWarnings(doc, 'Ada', path, 1, (m) => 1 + 10 * m);
    expect(w).toBe(
      "The path of 'Ada' crosses the water of Pond from 3 m to 7 m along it (about frames 31–71): Ada would " +
        'walk on the water as if it were solid ground (desk.check reports walks_on_water). Route the move ' +
        "around it with more desk.actor_move points (or raise them onto a bridge's deck), or move the mark; " +
        'for a swimmer or a wader, move it with in_water: true',
    );
    expect(pathWaterWarnings(doc, 'Ada', [path[0], [0, 10, 0]], 1, (m) => m)).toEqual([]);
  });

  it('desk.actor_add, desk.actor_move and store.add (people and animals) report them', () => {
    const doc = SceneDoc.create({ empty: true });
    pond(doc, 'Pond', [5, 0, 0.02], 4);
    const { run, reports } = deskOperators(doc);
    const warnings = () => reports.splice(0).map((r) => r.message);
    run('desk.actor_add', { kind: 'dog', name: 'Pip', location: [5, 0, 0] });
    expect(warnings()).toEqual([expect.stringMatching(/^'Pip' stands on the water of Pond at \[5, 0, 0\]/)]);
    run('desk.actor_add', { kind: 'adult', name: 'Ada', location: [0, 0, 0] });
    expect(warnings()).toEqual([]);
    run('desk.actor_move', { actor: 'Ada', points: [[10, 0, 0]], frame_start: 1, speed_mps: 1.3 });
    expect(warnings()).toEqual([
      expect.stringMatching(
        /^The path of 'Ada' crosses the water of Pond from 3 m to 7 m along it \(about frames/,
      ),
    ]);
    // around the pond: no warning
    run('desk.actor_move', {
      actor: 'Ada',
      points: [
        [10, 4, 0],
        [0, 4, 0],
      ],
      frame_start: 400,
    });
    expect(warnings()).toEqual([]);
    const horse = run<{ warnings: string[] }>('store.add', { model: 'horse', location: [5, 1, 0] });
    expect(horse.warnings).toEqual([expect.stringMatching(/^'Horse' stands on the water of Pond/)]);
    expect(warnings()).toEqual(horse.warnings);
    // a bench is no actor: it does not stand on the water as one
    run('store.add', { model: 'park_bench', location: [5, 1, 0] });
    expect(warnings()).toEqual([]);
  });
});

describe('actors in the water (desk_in_water)', () => {
  it('reads every frame, spans and single frames with open ends; markInWater adds and takes frames out', () => {
    const o = (v?: string | boolean): Pick<ObjectData, 'custom_props'> => ({
      custom_props: v === undefined ? {} : { [DESK_PROPS.inWater]: v },
    });
    expect(inWaterSpans(o())).toEqual([]);
    expect(inWaterSpans(o(false))).toEqual([]);
    expect(inWaterSpans(o(true))).toEqual([[-Infinity, Infinity]]);
    expect(inWaterSpans(o('..9, 20..30, 25..40, 41, 50..'))).toEqual([
      [-Infinity, 9],
      [20, 41],
      [50, Infinity],
    ]);
    expect(inWaterSpans(o('soon, 7, 9..3'))).toEqual([[7, 7]]);
    const doc = SceneDoc.create({ empty: true });
    const id = doc.addObject({ type: 'EMPTY', name: 'Swimmer' });
    const value = () => doc.getObject(id)!.custom_props[DESK_PROPS.inWater];
    // the whole frames a move touches
    markInWater(doc, id, 10, 20.5, true);
    expect(value()).toBe('10..21');
    markInWater(doc, id, 30, 40, true);
    markInWater(doc, id, 15, 35, false);
    expect(value()).toBe('10..14, 36..40');
    markInWater(doc, id, -Infinity, Infinity, true);
    expect(value()).toBe(true);
    markInWater(doc, id, 0, 100, false);
    expect(value()).toBe('..-1, 101..');
    markInWater(doc, id, -Infinity, Infinity, false);
    expect(DESK_PROPS.inWater in doc.getObject(id)!.custom_props).toBe(false);
  });

  it('desk.actor_add and desk.actor_move with in_water: no warning, the frames marked; false takes them out', () => {
    const doc = SceneDoc.create({ empty: true });
    pond(doc, 'Pond', [5, 0, 0.02], 4);
    const { run, reports } = deskOperators(doc);
    const warnings = () => reports.splice(0).map((r) => r.message);
    // a swimmer added in the pond belongs in the water at every frame: her swims are no walks
    const swimmer = run<{ actor: string }>('desk.actor_add', {
      kind: 'adult',
      name: 'Swimmer',
      location: [5, 0, 0],
      in_water: true,
    }).actor;
    expect(warnings()).toEqual([]);
    expect(doc.getObject(swimmer)!.custom_props[DESK_PROPS.inWater]).toBe(true);
    run('desk.actor_move', { actor: 'Swimmer', points: [[5, 1.5, 0]], frame_start: 1 });
    expect(warnings()).toEqual([]);
    // Ada wades across the pond
    const ada = run<{ actor: string }>('desk.actor_add', {
      kind: 'adult',
      name: 'Ada',
      location: [0, 0, 0],
    }).actor;
    const wade = { actor: 'Ada', points: [[10, 0, 0]], frame_start: 1, speed_mps: 1.3 };
    const r = run<{ frame_end: number }>('desk.actor_move', { ...wade, in_water: true });
    expect(warnings()).toEqual([]);
    // the whole frames it touches (its end is between two)
    expect(inWaterSpans(doc.getObject(ada))).toEqual([[1, Math.ceil(r.frame_end)]]);
    // the same move on land again: warned, its frames out of the water
    run('desk.actor_move', { ...wade, in_water: false });
    expect(warnings()).toEqual([
      expect.stringMatching(/^The path of 'Ada' crosses the water of Pond from 3 m to 7 m along it/),
    ]);
    expect(inWaterSpans(doc.getObject(ada))).toEqual([]);
  });
});

describe('waterAt', () => {
  it('reads a footprint in well under a millisecond (cached per state of the document)', () => {
    const doc = SceneDoc.create({ empty: true });
    lake(doc, [0, 0, 0]);
    // a mesh of many polygons
    const n = 60;
    const positions: number[] = [];
    const faces: number[][] = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) positions.push(i / 3 + 20, j / 3, 0.02);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j;
        faces.push([a, a + n + 1, a + n + 2, a + 1]);
      }
    doc.addObject({
      type: 'MESH',
      name: 'Marsh',
      data: doc.addMesh('marsh', createMesh({ positions, faces })),
      custom_props: { [DESK_PROPS.role]: 'landmark', desk_shape: 'water' },
    });
    expect(waterAt(doc, [25, 5, 0], 1)?.label).toBe('Marsh');
    const t0 = performance.now();
    let hits = 0;
    for (let k = 0; k < 20_000; k++) if (waterAt(doc, [(k % 400) / 10 - 5, (k % 97) / 10, 0], 1)) hits++;
    expect(hits).toBeGreaterThan(0);
    // about 1 µs a call on a quiet machine; 50 µs leaves room for a busy one
    expect((performance.now() - t0) / 20_000).toBeLessThan(0.05);
  });

  it('is exported from the core index with the rest of the water module', () => {
    expect([core.waterAt, core.waterAlong, core.waterSurfaces, core.hasWater]).toEqual([
      waterAt,
      waterAlong,
      waterSurfaces,
      hasWater,
    ]);
    expect([core.standsOnWaterWarning, core.pathWaterWarnings, core.WATER_LEVEL_M]).toEqual([
      standsOnWaterWarning,
      pathWaterWarnings,
      WATER_LEVEL_M,
    ]);
  });
});
