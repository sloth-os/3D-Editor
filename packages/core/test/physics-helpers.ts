import { SceneDoc } from '../src/doc/scene-doc';
import type { ObjectData, RigidBodyData } from '../src/doc/types';
import type { Mat4, Vec3 } from '../src/math/types';
import { decompose4 } from '../src/math/mat4';
import { createCube, createPlane, createUVSphere } from '../src/mesh/primitives';
import type { MeshData } from '../src/mesh/types';
import { FrameState } from '../src/eval/frame-state';
import { RigidBodySimulator, freeRigidBodyCache, type RigidBodyHost } from '../src/physics/rigid-body';
import { newRigidBody, worldParams } from '../src/physics/settings';
import { Simulation, type BodyInput } from '../src/physics/simulation';

/** Shared helpers for the physics tests. */

export const G = 9.81;

export function rb(type: 'ACTIVE' | 'PASSIVE', patch: Partial<RigidBodyData> = {}): RigidBodyData {
  return { ...newRigidBody(type), ...patch };
}

export function hostOf(doc: SceneDoc): RigidBodyHost {
  return {
    transformsAt: (f) => new FrameState(doc, f).allWorldMatrices(),
    meshOf: (id) => {
      const o = doc.getObject(id);
      return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    },
  };
}

/** A scene builder with a few shared meshes. */
export function physicsScene() {
  const doc = SceneDoc.create({ empty: true });
  const meshes = new Map<string, string>();
  const mesh = (key: string, make: () => MeshData): string => {
    let id = meshes.get(key);
    if (!id) meshes.set(key, (id = doc.addMesh(key, make())));
    return id;
  };
  const add = (
    name: string,
    data: string,
    body: RigidBodyData | null,
    init: Partial<Pick<ObjectData, 'location' | 'rotation_euler' | 'scale' | 'parent'>> = {},
  ): string => doc.addObject({ type: 'MESH', name, data, rigid_body: body, ...init });
  return {
    doc,
    /** Cube mesh with edge length `size`. */
    cube: (size = 1) => mesh(`cube${size}`, () => createCube({ size })),
    plane: (size = 20) => mesh(`plane${size}`, () => createPlane({ size })),
    sphere: (radius = 0.5) =>
      mesh(`sphere${radius}`, () => createUVSphere({ radius, segments: 24, ring_count: 12 })),
    mesh,
    add,
    /** A passive ground plane at z = 0. */
    ground: (patch: Partial<RigidBodyData> = {}, size = 20) =>
      add(
        'Ground',
        mesh(`plane${size}`, () => createPlane({ size })),
        rb('PASSIVE', patch),
      ),
    setWorld: (patch: Partial<ReturnType<SceneDoc['getScene']>['rigidbody_world']>) =>
      doc.updateScene({ rigidbody_world: { ...doc.getScene().rigidbody_world, ...patch } }),
  };
}

/** Simulates frames (in order) with a fresh cache; returns the simulated matrices per frame. */
export function simulate(doc: SceneDoc, frames: number[]): Map<number, Map<string, Mat4> | null> {
  freeRigidBodyCache(doc);
  const sim = new RigidBodySimulator();
  const host = hostOf(doc);
  const out = new Map<number, Map<string, Mat4> | null>();
  for (const f of frames) out.set(f, sim.evaluate(doc, f, host));
  return out;
}

export const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const loc = (m: Mat4): Vec3 => [m[12], m[13], m[14]];

export const euler = (m: Mat4): Vec3 => decompose4(m).rotation;

/** Angle (rad) of the rotation between the rotation parts of two matrices (scale removed). */
export function rotationAngle(a: Mat4, b: Mat4): number {
  const col = (m: Mat4, c: number): Vec3 => {
    const v: Vec3 = [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
    const l = Math.hypot(...v) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  // trace(Aᵀ B) = 1 + 2 cos θ
  let tr = 0;
  for (let c = 0; c < 3; c++) {
    const x = col(a, c);
    const y = col(b, c);
    tr += x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  }
  return Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2)));
}

/** World-space Z of the up axis (local +Z) of a matrix: 1 = upright, 0 = lying on its side. */
export const upZ = (m: Mat4): number => m[10] / (Math.hypot(m[8], m[9], m[10]) || 1);

/** A Simulation built straight from the scene (no cache), e.g. to switch sleeping off. */
export function directSimulation(doc: SceneDoc, opts: { sleeping?: boolean } = {}): Simulation {
  const params = worldParams(doc.getScene());
  const host = hostOf(doc);
  const tf = host.transformsAt(params.frameStart);
  const inputs: BodyInput[] = doc
    .listObjects()
    .filter((o) => o.rigid_body)
    .map((o) => ({
      id: o.id,
      name: o.name,
      rb: o.rigid_body!,
      matrix: tf.get(o.id) ?? null,
      mesh: host.meshOf(o.id),
    }));
  return new Simulation(inputs, params, opts);
}
