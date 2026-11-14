import type { SceneDoc } from '../doc/scene-doc';
import { MeshMemoryError } from '../mesh/memory';
import {
  RELEASE_TRACKED_STEPS,
  delayedStartFrame,
  motionMode,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  simulatedFrameEnd,
  worldParams,
} from './settings';

/*
 * The memory of a rigid body simulation's frame cache (simulation.ts), and the check a host can run
 * before a simulation steps.
 *
 * A simulation records the pose of every simulated body for every frame it steps (7 numbers: its
 * centre of mass and orientation) and the matrices of its animated bodies (16 numbers each), so that
 * going back in time is a lookup. Each frame is a Float64Array: up to 8 numbers V8 keeps in the
 * JavaScript heap, longer ones in ArrayBuffers outside it, which the process holds all the same. The
 * server simulates in its own process for its inspection tools (get_scene, get_object at a frame
 * after the world's frame_start), the bake operators and renders without render processes: 1,000
 * bodies simulated to frame 20,000 (MAX_SIMULATED_FRAMES) would keep about 1.1 GB. The server
 * therefore installs a check (`setSimulationMemoryCheck`): before a simulation steps, it is asked with
 * what the frames still to simulate will keep, and a refused simulation throws a MeshMemoryError
 * (code OUT_OF_MEMORY) with its reason: an evaluation reports it as the rigid body world's problem
 * (its objects at their unsimulated transforms), an operator fails with it. Without a check (the
 * browser, the server's render processes) simulations run as before. The frames a document's cache
 * holds stay until its inputs change, rigidbody.cache_free drops them or the document is destroyed
 * (rigid-body.ts rigidBodyCacheBytes, rigidBodyCachesBytes count them), so the server counts them
 * with the project that holds them and against its heap.
 */

/**
 * Bytes a simulation keeps per frame besides its numbers: the Float64Array of the frame (its object
 * and its ArrayBuffer) and its slot in the frame list. Measured: 1 body simulated to frame 20,000
 * kept 5.5 MB of heap (275 bytes per frame, its 7 numbers in the heap), 100 bodies to frame 2,000
 * 2.1 MB of heap (1,050 per frame) besides 10.7 MB of ArrayBuffers; rounded up.
 */
export const SIMULATION_FRAME_BYTES = 1_200;

/** Bytes a simulation keeps per frame and simulated body: its pose (7 doubles; 10.7 MB measured for 100 bodies × 2,000 frames). */
export const SIMULATION_BYTES_PER_BODY_FRAME = 56;

/** Bytes a simulation keeps per frame and animated (kinematic) body: the matrix that drove it (16 doubles). */
export const SIMULATION_BYTES_PER_KINEMATIC_FRAME = 128;

/**
 * Longest typed array V8 keeps inside the JavaScript heap (bytes, V8_TYPED_ARRAY_MAX_SIZE_IN_HEAP);
 * the numbers of longer ones live in ArrayBuffers outside it, which its heap statistics do not count.
 */
export const TYPED_ARRAY_MAX_BYTES_IN_HEAP = 64;

/** The bodies a simulation records per frame. */
export interface SimulationBodies {
  /** Bodies the simulation moves (ACTIVE and not animated). */
  simulated: number;
  /** Animated (kinematic) bodies, whose matrices it records too. */
  kinematic: number;
}

/** Bytes a simulation of `bodies` keeps for `frames` frames (see {@link SIMULATION_FRAME_BYTES}). */
export function simulationCacheBytes(bodies: SimulationBodies, frames: number): number {
  const f = Math.max(0, frames);
  return (
    f *
    (SIMULATION_FRAME_BYTES +
      SIMULATION_BYTES_PER_BODY_FRAME * Math.max(0, bodies.simulated) +
      SIMULATION_BYTES_PER_KINEMATIC_FRAME * Math.max(0, bodies.kinematic))
  );
}

/**
 * Bytes of the frames of {@link simulationCacheBytes} that live outside the JavaScript heap: the
 * numbers of the frames whose arrays are longer than {@link TYPED_ARRAY_MAX_BYTES_IN_HEAP} (the poses
 * of two or more simulated bodies, the matrices of any animated body). The heap's statistics count the
 * rest.
 */
export function simulationOutsideHeapBytes(bodies: SimulationBodies, frames: number): number {
  const outside = (bytes: number) => (bytes > TYPED_ARRAY_MAX_BYTES_IN_HEAP ? bytes : 0);
  return (
    Math.max(0, frames) *
    (outside(SIMULATION_BYTES_PER_BODY_FRAME * Math.max(0, bodies.simulated)) +
      outside(SIMULATION_BYTES_PER_KINEMATIC_FRAME * Math.max(0, bodies.kinematic)))
  );
}

/**
 * The bodies a simulation of `doc` would record per frame, counted from the objects' rigid body
 * settings without building it (mesh objects only: others are left out of the simulation).
 */
export function documentSimulationBodies(doc: SceneDoc): SimulationBodies {
  const out: SimulationBodies = { simulated: 0, kinematic: 0 };
  for (const o of doc.listObjects()) {
    if (o.type !== 'MESH') continue;
    const rb = sanitizeRigidBody(o.rigid_body);
    if (!rb) continue;
    const mode = motionMode(rb);
    if (mode === 'DYNAMIC' || mode === 'FROZEN') out.simulated++;
    else if (mode === 'KINEMATIC') out.kinematic++;
  }
  return out;
}

/**
 * Matrices a simulation of `doc` from `frameStart` records for its delayed bodies (an ACTIVE body
 * with a start_frame after frameStart, settings.ts delayedStartFrame) once it has simulated to
 * `frame`: each follows its animated transform, and records it (SIMULATION_BYTES_PER_KINEMATIC_FRAME),
 * on the frames from RELEASE_TRACKED_STEPS before its start to its start (simulation.ts), dormant
 * before; rigid-body.ts rigidBodyCacheBytes counts the same records once they are made.
 */
export function delayedBodyRecords(doc: SceneDoc, frameStart: number, frame: number): number {
  let records = 0;
  for (const o of doc.listObjects()) {
    if (o.type !== 'MESH') continue;
    const rb = sanitizeRigidBody(o.rigid_body);
    const start = rb ? delayedStartFrame(rb, frameStart) : null;
    if (start === null) continue;
    const from = Math.max(frameStart + 1, start - RELEASE_TRACKED_STEPS);
    records += Math.max(0, Math.min(frame, start) - from + 1);
  }
  return records;
}

/**
 * Bytes the simulation of `doc` keeps once it has simulated to `frame` from the world's frame_start
 * (0 when the world is disabled or nothing is simulated at that frame): its frames
 * ({@link simulationCacheBytes}) and the matrices its delayed bodies follow before their start
 * ({@link delayedBodyRecords}); an upper bound, as if nothing were cached yet.
 */
export function documentSimulationBytes(doc: SceneDoc, frame: number): number {
  const scene = doc.getScene();
  if (!sanitizeRigidBodyWorld(scene.rigidbody_world).enabled || !Number.isFinite(frame)) return 0;
  const params = worldParams(scene);
  const bodies = documentSimulationBodies(doc);
  if (!bodies.simulated) return 0;
  const frames = Math.ceil(Math.min(frame, simulatedFrameEnd(params))) - params.frameStart;
  return (
    simulationCacheBytes(bodies, frames) +
    SIMULATION_BYTES_PER_KINEMATIC_FRAME *
      delayedBodyRecords(doc, params.frameStart, params.frameStart + frames)
  );
}

/** What a {@link SimulationMemoryCheck} is asked before a simulation steps. */
export interface SimulationMemoryRequest {
  /** The bodies the simulation records per frame. */
  bodies: SimulationBodies;
  /** The frame it simulates to (the frames before it are stepped first). */
  frame: number;
  /** Frames it will step (and keep) to get there. */
  frames: number;
  /** Bytes those frames keep ({@link simulationCacheBytes}). */
  bytes: number;
  /**
   * The document simulated: its cache keeps the frames already simulated (rigid-body.ts
   * rigidBodyCacheBytes), which the server counts with its project. Absent where the caller has none.
   */
  doc?: SceneDoc;
}

/** Returns null to simulate, or why not (a MeshMemoryError with that message, code OUT_OF_MEMORY). */
export type SimulationMemoryCheck = (req: SimulationMemoryRequest) => string | null;

let installed: SimulationMemoryCheck | null = null;

/** Installs the check simulations run before they step (null removes it). Returns the one installed before. */
export function setSimulationMemoryCheck(check: SimulationMemoryCheck | null): SimulationMemoryCheck | null {
  const before = installed;
  installed = check;
  return before;
}

/** The installed check, if any. */
export function simulationMemoryCheck(): SimulationMemoryCheck | null {
  return installed;
}

/**
 * Asks the installed check before a simulation of `bodies` in `doc` steps `frames` frames to `frame`;
 * throws a MeshMemoryError (code OUT_OF_MEMORY) when it refuses. Nothing to do without a check or
 * frames.
 */
export function checkSimulation(
  bodies: SimulationBodies,
  frame: number,
  frames: number,
  doc?: SceneDoc,
): void {
  const check = installed;
  if (!check || !(frames > 0)) return;
  const reason = check({ bodies, frame, frames, bytes: simulationCacheBytes(bodies, frames), doc });
  if (reason) throw new MeshMemoryError(reason);
}
