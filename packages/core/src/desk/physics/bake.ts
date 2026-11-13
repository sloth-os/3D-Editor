import type { Mat4, Vec3 } from '../../math/types';
import type { SceneDoc } from '../../doc/scene-doc';
import type { ObjectData } from '../../doc/types';
import { worldMatrixToTransform } from '../../constraints/bake';
import { OperatorError } from '../../operators/context';
import { RigidBodySimulator } from '../../physics/rigid-body';
import {
  LATE_RELEASE_RUN_SECONDS,
  MAX_SIMULATED_FRAMES,
  delayedStartFrame,
  motionMode,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  simulatedFrameEnd,
  worldParams,
} from '../../physics/settings';
import {
  RIGID_BODY_BAKED_PROP,
  constraintActiveFrom,
  keyTransforms,
  parentMatrix,
  removeConstraints,
  sceneSampler,
  silenceConstraintFrom,
  transformSamples,
  writeChannel,
  type KeyWriteStats,
  type TransformSamples,
} from './common';

/** `m` with the columns of the negative axes of `signs` negated (a mirrored object's orientation kept). */
function flipColumns(m: Readonly<Mat4>, signs: Readonly<Vec3>): Mat4 {
  const out = [...m] as Mat4;
  for (let c = 0; c < 3; c++) if (signs[c] < 0) for (let r = 0; r < 3; r++) out[c * 4 + r] = -out[c * 4 + r];
  return out;
}

/*
 * desk.physics_bake (review finding 3c): the simulation of rigid bodies written as world-space
 * keyframes that reproduce their motion, so renders and exports need no simulation. A held prop is
 * baked from where its hold (a CHILD_OF constraint, spec §8) starts to act, so the hold can go: the
 * keys carry the hand's motion too, and the constraint and its influence keys are removed instead of
 * transforming the prop a second time on top of the keys. Other constraints stop acting where the
 * keys start. A body with a parent is unparented (its children stay with it): keys relative to a
 * parent cannot hold the shear of a rotating body under a non-uniformly scaled parent (a store model's
 * root sized by width and height), nor keep the body where the simulation leaves it while the parent
 * moves on after the bake; its keys then start where anything that moved it under its parent was
 * keyed, so it moves as before there too. Keys are LINEAR, with compatible eulers and Blender's
 * clean-up of redundant keys; a bake to the end of the simulation replaces the body's later keys,
 * which the simulation overrode.
 */

/** Most body frames (bodies × baked frames) one bake writes: 2,000,000 is 12 million keys at most. */
export const DESK_BAKE_MAX_BODY_FRAMES = 2_000_000;

/** One body of a bake: the frames it is keyed over. */
export interface DeskBakeBody {
  id: string;
  /** First baked frame: the bake's start, or earlier where a hold constraint acts or (unparented) its motion starts. */
  from: number;
  /** Hold (CHILD_OF) constraints removed after the bake. */
  holds: string[];
  /** Whether the body loses its parent (its keys are world space and include its scale). */
  unparent: boolean;
}

export interface DeskBakePlan {
  bodies: DeskBakeBody[];
  /** First frame sampled (the earliest `from`). */
  frame_start: number;
  frame_end: number;
  /** Whether frame_end is the simulation's end (later keys of the bodies are replaced: the simulation held them). */
  to_end: boolean;
  /** Σ baked frames over the bodies (the budget: {@link DESK_BAKE_MAX_BODY_FRAMES}). */
  body_frames: number;
  warnings: string[];
}

/** Whether a rigid body's simulation moves it (an ACTIVE body that is not animated and is Dynamic). */
export function isSimulatedBody(o: ObjectData): boolean {
  const rb = sanitizeRigidBody(o.rigid_body);
  return !!rb && o.type === 'MESH' && motionMode(rb) === 'DYNAMIC';
}

/**
 * The earliest frame at which the unparented world transform of body `o` may differ from its value
 * at `from`, so that baking from there reproduces it: the first key of anything that moves it under
 * its parent (its own channels, its parents', their constraint targets'), or `fallback` (the scene's
 * start) when one of those is driven, cycles, extrapolates or has F-curve modifiers, or when the body
 * has constraints of its own that act before `from` (they would act on the baked keys).
 */
function motionStart(
  doc: SceneDoc,
  o: ObjectData,
  from: number,
  holds: readonly string[],
  fallback: number,
): number {
  for (const c of o.constraints) {
    if (c.mute || holds.includes(c.name)) continue;
    const acts = constraintActiveFrom(doc, o, c.name);
    if (acts !== null && acts < from) return Math.min(from, fallback);
  }
  const seen = new Set<string>();
  const queue = [o.id];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const ob = doc.getObject(id);
    if (!ob) continue;
    if (ob.parent) queue.push(ob.parent);
    if (id !== o.id) for (const c of ob.constraints) if (c.target && !c.mute) queue.push(c.target);
  }
  let first = Infinity;
  for (const d of doc.listDrivers())
    if (d.target_type === 'object' && seen.has(d.target_id) && !d.mute) return Math.min(from, fallback);
  for (const fc of doc.listFCurves()) {
    if (fc.target_type !== 'object' || !seen.has(fc.target_id) || fc.mute || !fc.keyframes.length) continue;
    // a hold's influence keys do not move the body once the hold is removed
    if (fc.target_id === o.id && holds.some((h) => fc.path.startsWith(`constraints["${h}"]`))) continue;
    if (fc.extrapolation !== 'CONSTANT' || fc.modifiers?.length) return Math.min(from, fallback);
    for (const k of fc.keyframes) first = Math.min(first, k.frame);
  }
  return Math.min(from, first);
}

/**
 * What desk.physics_bake bakes: the bodies (`objectIds`, default every simulated body), each from the
 * bake's start (default the world's frame_start), from where a hold constraint of it starts to act or,
 * for a body with a parent, from where what moves it starts (see `motionStart`), to `frame_end`
 * (default the simulation's last frame). Throws when nothing can be baked or the bake is over the
 * budget. Reads the document only.
 */
export function deskBakePlan(
  doc: SceneDoc,
  o: { frame_start?: number; frame_end?: number; objects?: readonly string[] },
): DeskBakePlan {
  const scene = doc.getScene();
  const world = sanitizeRigidBodyWorld(scene.rigidbody_world);
  if (!world.enabled)
    throw new OperatorError(
      'The rigid body world is disabled: enable it with rigidbody.world_set (enabled: true)',
      'POLL_FAILED',
    );
  const warnings: string[] = [];
  const params = worldParams(scene);
  const start = o.frame_start ?? world.frame_start;
  const end = o.frame_end ?? deskSimulationEnd(doc, params);
  if (end < start)
    throw new OperatorError(`frame_end (${end}) must not be before frame_start (${start})`, 'INVALID_PARAMS');
  let targets: ObjectData[];
  if (o.objects?.length) {
    targets = [];
    for (const id of new Set(o.objects)) {
      const ob = doc.getObject(id);
      if (!ob) throw new OperatorError(`Object '${id}' not found`, 'NOT_FOUND');
      if (isSimulatedBody(ob)) targets.push(ob);
      else warnings.push(`Skipped '${ob.name}': not a simulated (ACTIVE, Dynamic, not animated) rigid body`);
    }
  } else targets = doc.listObjects().filter(isSimulatedBody);
  if (!targets.length) throw new OperatorError('No simulated rigid bodies to bake', 'POLL_FAILED');
  const bodies: DeskBakeBody[] = targets.map((t) => {
    const holds = t.constraints.filter((c) => c.type === 'CHILD_OF').map((c) => c.name);
    let from = start;
    for (const h of holds) {
      const acts = constraintActiveFrom(doc, t, h);
      if (acts === null) continue;
      from = Math.min(from, Number.isFinite(acts) ? acts : Math.min(start, scene.frame_start));
    }
    const unparent = !!t.parent && !!doc.getObject(t.parent);
    if (unparent) from = motionStart(doc, t, from, holds, Math.min(start, scene.frame_start));
    return { id: t.id, from: Math.min(from, end), holds, unparent };
  });
  const frameStart = Math.min(...bodies.map((b) => b.from));
  const bodyFrames = bodies.reduce((n, b) => n + (end - b.from + 1), 0);
  if (end - frameStart + 1 > MAX_SIMULATED_FRAMES)
    throw new OperatorError(
      `Too many frames to bake (${end - frameStart + 1}, at most ${MAX_SIMULATED_FRAMES}): bake a shorter range ` +
        '(frame_start, frame_end)',
      'INVALID_PARAMS',
    );
  if (bodyFrames > DESK_BAKE_MAX_BODY_FRAMES)
    throw new OperatorError(
      `Baking ${bodies.length} bod${bodies.length === 1 ? 'y' : 'ies'} over frames ${frameStart}–${end} is ` +
        `${bodyFrames} body frames, more than the ${DESK_BAKE_MAX_BODY_FRAMES} one bake writes: bake fewer ` +
        'bodies at a time (objects) or a shorter range (frame_start, frame_end)',
      'INVALID_PARAMS',
    );
  return {
    bodies,
    frame_start: frameStart,
    frame_end: end,
    to_end: o.frame_end === undefined,
    body_frames: bodyFrames,
    warnings,
  };
}

/**
 * The last frame the simulation can run to: frame_end, or later when bodies are released at or after
 * it (they keep the world running until they rest, physics/simulation.ts runLimit).
 */
export function deskSimulationEnd(doc: SceneDoc, params: ReturnType<typeof worldParams>): number {
  const end = simulatedFrameEnd(params);
  let last = -Infinity;
  for (const ob of doc.listObjects()) {
    const rb = ob.type === 'MESH' ? sanitizeRigidBody(ob.rigid_body) : null;
    const start = rb ? delayedStartFrame(rb, params.frameStart) : null;
    if (start !== null && start >= end) last = Math.max(last, start);
  }
  if (last === -Infinity) return end;
  return Math.max(
    end,
    Math.min(
      params.frameStart + MAX_SIMULATED_FRAMES,
      last + Math.ceil(LATE_RELEASE_RUN_SECONDS * params.fps),
    ),
  );
}

export interface DeskBakeResult {
  objects: string[];
  keyframes: number;
  frame_start: number;
  frame_end: number;
  /** Hold constraints removed, per object id. */
  removed_constraints: Record<string, string[]>;
  removed_drivers: number;
  removed_modifiers: number;
  warnings: string[];
}

/** The sign of each axis an object's world matrix keeps in its scale channel (mirrored objects). */
function scaleSigns(o: ObjectData, world: Readonly<Mat4>): Vec3 {
  const signs: Vec3 = [o.scale[0] < 0 ? -1 : 1, o.scale[1] < 0 ? -1 : 1, o.scale[2] < 0 ? -1 : 1];
  const det =
    world[0] * (world[5] * world[10] - world[6] * world[9]) -
    world[4] * (world[1] * world[10] - world[2] * world[9]) +
    world[8] * (world[1] * world[6] - world[2] * world[5]);
  // a mirrored parent mirrors the world matrix: one more negative axis
  if (det < 0 !== signs[0] * signs[1] * signs[2] < 0) signs[0] = -signs[0];
  return signs;
}

/** Bakes a plan (see {@link deskBakePlan}): samples every frame first, then writes the keys and removes the bodies. */
export function deskBake(doc: SceneDoc, plan: DeskBakePlan): DeskBakeResult {
  const warnings = [...plan.warnings];
  const sampler = sceneSampler(doc);
  const sim = new RigidBodySimulator();
  const samples = new Map<string, TransformSamples & { scale: Vec3[] }>(
    plan.bodies.map((b) => [b.id, { ...transformSamples(), scale: [] }]),
  );
  const objects = new Map(plan.bodies.map((b) => [b.id, doc.getObject(b.id)!]));
  const signs = new Map<string, Vec3>();
  const previous = new Map<string, Vec3>();
  for (let f = plan.frame_start; f <= plan.frame_end; f++) {
    const fs = sampler.at(f, sim.evaluate(doc, f, sampler));
    for (const b of plan.bodies) {
      if (f < b.from) continue;
      const o = objects.get(b.id)!;
      const animated = fs.byId.get(b.id) ?? o;
      const world: Mat4 = fs.world(b.id) ?? fs.local(b.id);
      let sign = signs.get(b.id);
      if (!sign) signs.set(b.id, (sign = b.unparent ? scaleSigns(animated, world) : [...animated.scale]));
      const t = worldMatrixToTransform(
        flipColumns(world, sign),
        b.unparent ? null : parentMatrix(fs, o),
        previous.get(b.id) ?? animated.rotation_euler,
      );
      previous.set(b.id, t.rotation_euler);
      const s = samples.get(b.id)!;
      s.frames.push(f);
      s.location.push(t.location);
      s.rotation.push(t.rotation_euler);
      s.scale.push([0, 1, 2].map((k) => (sign[k] < 0 ? -1 : 1) * t.scale[k]) as Vec3);
    }
  }
  const stats: KeyWriteStats = { keys: 0, drivers: 0, modifiers: 0 };
  const removed: Record<string, string[]> = {};
  for (const b of plan.bodies) {
    const s = samples.get(b.id)!;
    // the simulation held the body after its end whatever its keys said there: its later keys go
    // (and an unparented body's keys anywhere were relative to its parent)
    const replace: [number, number] = [b.from, plan.to_end || b.unparent ? Infinity : plan.frame_end];
    keyTransforms(doc, b.id, s, { clean: true, replace, stats });
    if (b.unparent) {
      for (let k = 0; k < 3; k++)
        writeChannel(
          doc,
          b.id,
          'scale',
          k,
          s.frames,
          s.scale.map((v) => v[k]),
          { clean: true, replace, stats },
        );
      // world space from here: no parent; its children stay its children, so they follow its keys
      const first = s.frames.length ? 0 : -1;
      doc.updateObject(b.id, {
        parent: null,
        parent_type: 'OBJECT',
        parent_bone: '',
        ...(first === 0 ? { location: s.location[0], rotation_euler: s.rotation[0], scale: s.scale[0] } : {}),
      });
    }
    const gone = removeConstraints(doc, b.id, b.holds);
    if (gone.length) removed[b.id] = gone;
    // other constraints would act on top of the keys: silenced where the keys start
    for (const c of doc.getObject(b.id)!.constraints)
      if (!c.mute && silenceConstraintFrom(doc, b.id, c.name, b.from))
        warnings.push(
          `'${objects.get(b.id)!.name}': constraint '${c.name}' no longer acts from frame ${b.from}`,
        );
    if (b.unparent)
      warnings.push(
        `'${objects.get(b.id)!.name}' was unparented from '${doc.getObject(objects.get(b.id)!.parent ?? '')?.name ?? '?'}' ` +
          `and keyed in world space from frame ${b.from}`,
      );
    const o = doc.getObject(b.id)!;
    doc.updateObject(b.id, {
      rigid_body: null,
      custom_props: {
        ...o.custom_props,
        [RIGID_BODY_BAKED_PROP]: `frames ${b.from}-${plan.frame_end} step 1`,
      },
    });
  }
  const left = doc.listObjects().filter(isSimulatedBody);
  if (left.length)
    warnings.push(
      `${left.length} rigid bod${left.length === 1 ? 'y stays' : 'ies stay'} simulated without the baked ones ` +
        `(${left
          .slice(0, 5)
          .map((o) => `'${o.name}'`)
          .join(', ')}${left.length > 5 ? ', …' : ''}): bake them together when they collide`,
    );
  if (stats.drivers) warnings.push(`Removed ${stats.drivers} driver(s) on baked channels`);
  if (stats.modifiers) warnings.push(`Removed ${stats.modifiers} F-curve modifier(s) on baked channels`);
  return {
    objects: plan.bodies.map((b) => b.id),
    keyframes: stats.keys,
    frame_start: plan.frame_start,
    frame_end: plan.frame_end,
    removed_constraints: removed,
    removed_drivers: stats.drivers,
    removed_modifiers: stats.modifiers,
    warnings,
  };
}
