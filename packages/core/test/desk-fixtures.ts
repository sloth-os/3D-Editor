import * as Y from 'yjs';
import { expect } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import type { Vec3 } from '../src/math/types';
import { createCube } from '../src/mesh/primitives';
import { createEditorState, type OperatorContext } from '../src/operators/context';
import { createOperatorRegistry } from '../src/operators';
import { DESK_PROPS } from '../src/desk/props';
import { setDeskSettings } from '../src/desk/shots';

/*
 * Scenes of the director's desk tests, laid out in rideo's coordinates (x right, y up, z toward the
 * audience; facing in degrees, 0 toward the audience, 90 toward +x) so that they read like the rideo
 * blockings their golden values come from. The editor's axes are rideo's (x, −z, y).
 *
 * Actors are stand-ins: an EMPTY with desk_role 'actor' and desk_height_m (the posed height) and a
 * box part, measured from their origin, height and −Y facing (the solver's fallback when
 * CHARACTERS' actorInfo cannot measure an actor).
 */

/** rideo (x, y, z) → editor. */
export const ed = (x: number, y: number, z: number): Vec3 => [x, -z, y];

/** An editor point in rideo coordinates, rounded to the millimetre (as rideo's golden values are). */
export const rideo = (v: Readonly<Vec3>): number[] =>
  [v[0], v[2], -v[1]].map((n) => Math.round(n * 1000) / 1000 + 0);

/** An empty scene framed at `aspect` (the desk's aspect; the render at 1920 × 1080 or 1080 × 1920). */
export function deskDoc(aspect = 16 / 9): SceneDoc {
  const doc = SceneDoc.create({ empty: true });
  doc.updateRender(
    aspect >= 1 ? { resolution_x: 1920, resolution_y: 1080 } : { resolution_x: 1080, resolution_y: 1920 },
  );
  setDeskSettings(doc, { aspect });
  return doc;
}

/** A stand-in actor at rideo (x, z) facing rideo's `facingDeg`, `height` metres tall as posed. */
export function standIn(
  doc: SceneDoc,
  name: string,
  x: number,
  z: number,
  facingDeg = 0,
  height = 1.7,
): string {
  const id = doc.addObject({
    type: 'EMPTY',
    name,
    location: ed(x, 0, z),
    rotation_euler: [0, 0, (facingDeg * Math.PI) / 180],
    custom_props: { [DESK_PROPS.role]: 'actor', [DESK_PROPS.heightM]: height },
  });
  doc.addObject({
    type: 'MESH',
    name: `${name} body`,
    data: doc.addMesh(`${name} body`, createCube({ size: 0.4 })),
    parent: id,
    location: [0, 0, 0.2],
  });
  return id;
}

/** A box landmark (rideo's set landmark: centre x, z on the floor, width along x, depth along z). */
export function landmark(
  doc: SceneDoc,
  label: string,
  x: number,
  z: number,
  width: number,
  depth: number,
  height: number,
): string {
  return doc.addObject({
    type: 'MESH',
    name: label,
    data: doc.addMesh(label, createCube({ size: 1 })),
    location: ed(x, height / 2, z),
    scale: [width, depth, height],
    custom_props: { [DESK_PROPS.role]: 'landmark', [DESK_PROPS.label]: label },
  });
}

/** A cube prop of edge `size` standing on the floor at rideo (x, z). */
export function prop(doc: SceneDoc, label: string, x: number, z: number, size: number): string {
  return doc.addObject({
    type: 'MESH',
    name: label,
    data: doc.addMesh(label, createCube({ size })),
    location: ed(x, size / 2, z),
    custom_props: { [DESK_PROPS.role]: 'prop', [DESK_PROPS.label]: label },
  });
}

/** A camera at rideo `pos` looking at rideo `target` with `lens` mm on a 36 mm wide sensor. */
export function rideoCamera(
  doc: SceneDoc,
  name: string,
  pos: readonly number[],
  target: readonly number[],
  lens: number,
): string {
  const p = ed(pos[0], pos[1], pos[2]);
  const t = ed(target[0], target[1], target[2]);
  const d: Vec3 = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
  const flat = Math.hypot(d[0], d[1]);
  // −Z along d, +Y up: pitch about X from looking down, then heading about Z
  const pitch = Math.atan2(flat, -d[2]);
  const yaw = Math.atan2(-d[0], d[1]);
  return doc.addObject({
    type: 'CAMERA',
    name,
    data: doc.addCamera({ name, lens, sensor_fit: 'HORIZONTAL', sensor_width: 36 }),
    location: p,
    rotation_euler: [pitch, 0, yaw],
  });
}

/** Expects `actual` to be `expected` within `tol` (each component). */
export function expectNear(
  actual: readonly number[],
  expected: readonly number[],
  tol = 1.5e-3,
  what = '',
): void {
  expect(actual.length, what).toBe(expected.length);
  for (let i = 0; i < expected.length; i++)
    expect(
      Math.abs(actual[i] - expected[i]),
      `${what}[${i}]: ${actual[i]} vs ${expected[i]}`,
    ).toBeLessThanOrEqual(tol);
}

/** An operator context and registry for `doc`, with an undo manager over its operator steps. */
export function deskOperators(doc: SceneDoc) {
  const reg = createOperatorRegistry();
  const reports: { level: string; message: string }[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => reports.push({ level, message }),
  };
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const run = <T = Record<string, unknown>>(id: string, params: Record<string, unknown> = {}): T => {
    const r = reg.run<T>(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed (${r.code}): ${r.error}`);
    return r.result as T;
  };
  return { reg, ctx, reports, undo, run };
}
