import { SceneDoc } from '../src/doc/scene-doc';
import type { ObjectData } from '../src/doc/types';
import type { Mat4, Vec3 } from '../src/math/types';
import { createCube, createPlane, createUVSphere } from '../src/mesh/primitives';
import { createMesh, type MeshData } from '../src/mesh/types';
import { FrameState } from '../src/eval/frame-state';
import { SceneEvaluator } from '../src/eval/evaluate';
import { createEditorState, createOperatorRegistry, type OperatorContext } from '../src/operators';

/** Shared scenes and helpers of the desk physics tests (desk-physics*.test.ts). */

/** A scene with the operator registry, a context that collects warnings, and mesh helpers. */
export function deskScene() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const warnings: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (level, message) => {
      if (level === 'WARNING') warnings.push(message);
    },
  };
  const meshes = new Map<string, string>();
  const mesh = (key: string, make: () => MeshData): string => {
    let id = meshes.get(key);
    if (!id) meshes.set(key, (id = doc.addMesh(key, make())));
    return id;
  };
  /** Runs an operator; throws with its error when it fails. */
  const run = (id: string, params: Record<string, unknown>): any => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id}: ${r.error}`);
    return r.result;
  };
  return {
    doc,
    reg,
    ctx,
    warnings,
    run,
    /** A box (cube mesh scaled by `size`). */
    box: (name: string, location: Vec3, size = 0.5, init: Partial<ObjectData> = {}) =>
      doc.addObject({
        type: 'MESH',
        name,
        data: mesh(`cube${size}`, () => createCube({ size })),
        location,
        ...init,
      }),
    ball: (name: string, location: Vec3, radius = 0.11, init: Partial<ObjectData> = {}) =>
      doc.addObject({
        type: 'MESH',
        name,
        data: mesh(`sphere${radius}`, () => createUVSphere({ radius, segments: 16, ring_count: 8 })),
        location,
        ...init,
      }),
    plane: (name: string, size = 40, init: Partial<ObjectData> = {}) =>
      doc.addObject({ type: 'MESH', name, data: mesh(`plane${size}`, () => createPlane({ size })), ...init }),
    empty: (name: string, location: Vec3, init: Partial<ObjectData> = {}) =>
      doc.addObject({ type: 'EMPTY', name, location, ...init }),
    mesh,
  };
}

/** World matrices of every object at `frame` (rigid bodies simulated). */
export function worldsAt(
  doc: SceneDoc,
  frame: number,
  evaluator = new SceneEvaluator(doc),
): Map<string, Mat4> {
  const out = new Map<string, Mat4>();
  for (const [id, o] of evaluator.evaluate(frame).byId) out.set(id, o.worldMatrix);
  return out;
}

/** The world matrix of `id` at `frame` (rigid bodies simulated). */
export function worldAt(doc: SceneDoc, id: string, frame: number, evaluator = new SceneEvaluator(doc)): Mat4 {
  const m = evaluator.evaluate(frame).byId.get(id)?.worldMatrix;
  if (!m) throw new Error(`${id} not evaluated at ${frame}`);
  return m;
}

/** The animated (keyed, not simulated) transform channels of `id` at `frame`. */
export function channelsAt(doc: SceneDoc, id: string, frame: number) {
  const o = new FrameState(doc, frame).byId.get(id);
  if (!o) throw new Error(`${id} has no frame state at ${frame}`);
  return o;
}

export const originOf = (m: Mat4): Vec3 => [m[12], m[13], m[14]];
export const dist = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const transformPoint = (m: Mat4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/** A flat diamond kite (front −Y, 0.8 m wide, 1 m tall, origin at its middle). */
export function kiteMesh(): MeshData {
  return createMesh({
    positions: [0, 0, 0.6, 0.4, 0, 0, 0, 0, -0.4, -0.4, 0, 0],
    faces: [[0, 1, 2, 3]],
  });
}

/** A wheel: a cylinder about its local X axis (radius `r`). */
export function wheelMesh(r: number): MeshData {
  const n = 16;
  const positions: number[] = [];
  for (const x of [-0.1, 0.1])
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      positions.push(x, Math.cos(a) * r, Math.sin(a) * r);
    }
  const faces: number[][] = [];
  for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + ((i + 1) % n), n + i]);
  faces.push(
    Array.from({ length: n }, (_, i) => n - 1 - i),
    Array.from({ length: n }, (_, i) => n + i),
  );
  return createMesh({ positions, faces });
}

/**
 * A vehicle following the §10 contract: an EMPTY root facing −Y, a body, wheel.FL/FR/BL/BR (radius
 * 0.35, origin at the hub, spinning about local X; the right wheels turned by 180° about Z, as mirrored
 * models have them) and steer.FL/FR pivots over the front wheels.
 */
export function syntheticCar(s: ReturnType<typeof deskScene>, name = 'Car', location: Vec3 = [0, 0, 0]) {
  const { doc } = s;
  const root = doc.addObject({ type: 'EMPTY', name, location });
  doc.addObject({
    type: 'MESH',
    name: 'body',
    data: s.mesh('carbody', () => createCube({ size: 1 })),
    parent: root,
    location: [0, 0, 0.75],
    scale: [1.6, 4, 0.8],
  });
  const wheel = s.mesh('wheel', () => wheelMesh(0.35));
  const ids: Record<string, string> = { root };
  for (const [side, x, y, steer, mirrored] of [
    ['FL', 0.85, -1.3, true, false],
    ['FR', -0.85, -1.3, true, true],
    ['BL', 0.85, 1.3, false, false],
    ['BR', -0.85, 1.3, false, true],
  ] as const) {
    const rotation_euler: Vec3 = mirrored ? [0, 0, Math.PI] : [0, 0, 0];
    if (steer) {
      const pivot = doc.addObject({
        type: 'EMPTY',
        name: `steer.${side}`,
        parent: root,
        location: [x, y, 0.35],
      });
      ids[`steer.${side}`] = pivot;
      ids[`wheel.${side}`] = doc.addObject({
        type: 'MESH',
        name: `wheel.${side}`,
        data: wheel,
        parent: pivot,
        rotation_euler,
      });
    } else
      ids[`wheel.${side}`] = doc.addObject({
        type: 'MESH',
        name: `wheel.${side}`,
        data: wheel,
        parent: root,
        location: [x, y, 0.35],
        rotation_euler,
      });
  }
  return ids;
}
