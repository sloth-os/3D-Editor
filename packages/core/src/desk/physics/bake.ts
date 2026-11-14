import type { Mat4, Vec3 } from '../../math/types';
import { invert4, multiply4 } from '../../math/mat4';
import { fcurveKey, type SceneDoc } from '../../doc/scene-doc';
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
  descendants,
  keyTransforms,
  modelRootOf,
  parentMatrix,
  removeConstraints,
  rigidFrame,
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
 * keys start. Keys are LINEAR, with compatible eulers and Blender's clean-up of redundant keys; a bake
 * to the end of the simulation replaces the later keys, which the simulation overrode.
 *
 * The keys go on the body's carrier. A body that carries the geometry of a store model (its one mesh,
 * or the main part the presets hang the others from: common.ts modelRootOf) is keyed through the
 * model's root (review F2): the root, which store.add returned and which shots, checks and agents
 * follow, moves as the body moved, root(t) = M(t) · root(from) with M(t) = rigid(body(t)) ·
 * rigid(body(from))⁻¹ the body's rigid motion (its origin and rotation as the simulation decomposes
 * them, so a part turning under a non-uniformly scaled root is not sheared), and the body stays in
 * the model as it was at the bake's start (its own holds go, its channels hold from there). The
 * root's own hold (a hand carrying the model) goes like a held prop's. Any other body is its own
 * carrier.
 *
 * A carrier with a parent is unparented (its children stay with it): keys relative to a parent cannot
 * hold the shear of a rotating body under a non-uniformly scaled parent, nor keep the body where the
 * simulation leaves it while the parent moves on after the bake; its keys then start where anything
 * that moved it under its parent was keyed, so it moves as before there too, and include its scale.
 */

/** Most body frames (bodies × baked frames) one bake writes: 2,000,000 is 12 million keys at most. */
export const DESK_BAKE_MAX_BODY_FRAMES = 2_000_000;

/** One body of a bake: the object its motion is keyed on and the frames it is keyed over. */
export interface DeskBakeBody {
  /** The simulated body. */
  id: string;
  /**
   * The object keyed with the body's motion: the body itself, or the root of the store model whose
   * geometry it carries (common.ts modelRootOf), which then moves as the body moved with its parts in it.
   */
  carrier: string;
  /** First baked frame: the bake's start, or earlier where a hold constraint acts or (unparented) its motion starts. */
  from: number;
  /** Hold (CHILD_OF) constraints of the carrier, removed after the bake. */
  holds: string[];
  /** Hold constraints of the body itself when a model's root carries it, removed too (else none). */
  body_holds: string[];
  /** Whether the carrier loses its parent (its keys are world space and include its scale). */
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
 * The earliest frame at which the unparented world transform of carrier `o` may differ from its value
 * at `from`, so that baking from there reproduces it: the first key of anything that moves it under
 * its parent (its own channels, its parents', their constraint targets'), or `fallback` (the scene's
 * start) when one of those is driven, cycles, extrapolates or has F-curve modifiers, or when the
 * carrier has constraints of its own that act before `from` (they would act on the baked keys).
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
 * What desk.physics_bake bakes: the bodies (`objects`: bodies, or anything above bodies such as a
 * store model's root, for the bodies under it; default every simulated body), each keyed on its
 * carrier (a store model's root or itself, see the module comment) from the bake's start (default the
 * world's frame_start), from where a hold constraint of the carrier (or of the body a root carries)
 * starts to act or, for a carrier with a parent, from where what moves it starts (see `motionStart`),
 * to `frame_end` (default the simulation's last frame). Throws when nothing can be baked or the bake
 * is over the budget. Reads the document only.
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
    // a body, or anything above bodies (a store model's root, a group): the simulated bodies under it
    const found = new Map<string, ObjectData>();
    for (const id of new Set(o.objects)) {
      const ob = doc.getObject(id);
      if (!ob) throw new OperatorError(`Object '${id}' not found`, 'NOT_FOUND');
      const under = isSimulatedBody(ob) ? [ob] : descendants(doc, ob.id).filter(isSimulatedBody);
      if (!under.length)
        warnings.push(
          `Skipped '${ob.name}': not a simulated (ACTIVE, Dynamic, not animated) rigid body, and none is under it`,
        );
      for (const t of under) found.set(t.id, t);
    }
    targets = [...found.values()];
  } else targets = doc.listObjects().filter(isSimulatedBody);
  if (!targets.length) throw new OperatorError('No simulated rigid bodies to bake', 'POLL_FAILED');
  const holdsOf = (ob: ObjectData) => ob.constraints.filter((c) => c.type === 'CHILD_OF').map((c) => c.name);
  const bodies: DeskBakeBody[] = targets.map((t) => {
    const root = modelRootOf(doc, t.id);
    const carrier = root ?? t;
    const holds = holdsOf(carrier);
    const bodyHolds = root ? holdsOf(t) : [];
    let from = start;
    const heldFrom = (ob: ObjectData, names: readonly string[]) => {
      for (const h of names) {
        const acts = constraintActiveFrom(doc, ob, h);
        if (acts === null) continue;
        from = Math.min(from, Number.isFinite(acts) ? acts : Math.min(start, scene.frame_start));
      }
    };
    heldFrom(carrier, holds);
    heldFrom(t, bodyHolds);
    const unparent = !!carrier.parent && !!doc.getObject(carrier.parent);
    if (unparent) from = motionStart(doc, carrier, from, holds, Math.min(start, scene.frame_start));
    return {
      id: t.id,
      carrier: carrier.id,
      from: Math.min(from, end),
      holds,
      body_holds: bodyHolds,
      unparent,
    };
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
  /** The objects keyed (the carriers: a store model's root, or the body itself), one per body. */
  objects: string[];
  /** The simulated bodies, in the order of `objects`. */
  bodies: string[];
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

/** Whether two scales differ beyond rounding (relative 1e-6). */
const scaleDiffers = (a: Readonly<Vec3>, b: Readonly<Vec3>): boolean =>
  [0, 1, 2].some((k) => Math.abs(a[k] - b[k]) > 1e-6 * Math.max(1, Math.abs(b[k])));

/**
 * Holds object `id`'s transform channels from `from` on at their values in `at` (its animated state
 * at `from`), where keys from there on, a driver, a cycling extrapolation or a modifier would change
 * them: a body its model's root carries stays in the model as it was there.
 */
function holdChannelsFrom(
  doc: SceneDoc,
  id: string,
  from: number,
  at: ObjectData,
  stats: KeyWriteStats,
): void {
  for (const path of ['location', 'rotation_euler', 'scale'] as const)
    for (let i = 0; i < 3; i++) {
      const key = fcurveKey({ target_type: 'object', target_id: id, path, index: i });
      const fc = doc.getFCurve(key);
      const moves =
        !!doc.getDriver(key) ||
        (!!fc &&
          !fc.mute &&
          (fc.keyframes.some((k) => k.frame > from - 1e-3) ||
            fc.extrapolation !== 'CONSTANT' ||
            !!fc.modifiers?.length));
      if (moves) writeChannel(doc, id, path, i, [from], [at[path][i]], { replace: [from, Infinity], stats });
    }
}

/** Samples of a carrier's channels, with its own (animated) scale on each frame. */
type CarrierSamples = TransformSamples & { scale: Vec3[]; own: Vec3[] };

/**
 * Bakes a plan (see {@link deskBakePlan}): samples every frame first, then writes the keys and removes
 * the bodies. Returns the carriers keyed, the bodies, and what was removed.
 */
export function deskBake(doc: SceneDoc, plan: DeskBakePlan): DeskBakeResult {
  const warnings = [...plan.warnings];
  const sampler = sceneSampler(doc);
  const sim = new RigidBodySimulator();
  const samples = new Map<string, CarrierSamples>(
    plan.bodies.map((b) => [b.id, { ...transformSamples(), scale: [], own: [] }]),
  );
  const bodies = new Map(plan.bodies.map((b) => [b.id, doc.getObject(b.id)!]));
  const carriers = new Map(plan.bodies.map((b) => [b.id, doc.getObject(b.carrier)!]));
  const signs = new Map<string, Vec3>();
  const previous = new Map<string, Vec3>();
  // a model root carrier: the inverse of its body's rigid frame and the root's world at the body's
  // first baked frame, and the body's channels there (held from there on)
  const refs = new Map<string, { inverse: Mat4; root: Mat4; channels: ObjectData }>();
  for (let f = plan.frame_start; f <= plan.frame_end; f++) {
    const simulated = sim.evaluate(doc, f, sampler);
    const fs = sampler.at(f, simulated);
    for (const b of plan.bodies) {
      if (f < b.from) continue;
      const c = carriers.get(b.id)!;
      const animated = fs.byId.get(c.id) ?? c;
      let world: Mat4;
      if (b.carrier === b.id) world = fs.world(b.id) ?? fs.local(b.id);
      else {
        let ref = refs.get(b.id);
        if (!ref) {
          // where the body sits in its model without its own simulation (the scene as shown, unless a
          // bake starting after the release finds it simulated already: then the root comes to it),
          // and without its own constraints: a hold on the body is removed and the rest silenced, so
          // the root carries the body as it moved, the body keeping its place in the model
          const plain = simulated?.has(b.id) ? sampler.at(f) : fs;
          ref = {
            inverse: invert4(rigidFrame(multiply4(plain.parent(b.id), plain.local(b.id)))),
            root: plain.world(c.id) ?? plain.local(c.id),
            channels: plain.byId.get(b.id) ?? bodies.get(b.id)!,
          };
          refs.set(b.id, ref);
        }
        world = multiply4(multiply4(rigidFrame(fs.world(b.id) ?? fs.local(b.id)), ref.inverse), ref.root);
      }
      let sign = signs.get(b.id);
      if (!sign) signs.set(b.id, (sign = b.unparent ? scaleSigns(animated, world) : [...animated.scale]));
      const t = worldMatrixToTransform(
        flipColumns(world, sign),
        b.unparent ? null : parentMatrix(fs, c),
        previous.get(b.id) ?? animated.rotation_euler,
      );
      previous.set(b.id, t.rotation_euler);
      const s = samples.get(b.id)!;
      s.frames.push(f);
      s.location.push(t.location);
      s.rotation.push(t.rotation_euler);
      s.scale.push([0, 1, 2].map((k) => (sign[k] < 0 ? -1 : 1) * t.scale[k]) as Vec3);
      s.own.push([...animated.scale]);
    }
  }
  const stats: KeyWriteStats = { keys: 0, drivers: 0, modifiers: 0 };
  const removed: Record<string, string[]> = {};
  const silence = (id: string, from: number) => {
    // other constraints would act on top of the keys: silenced where the keys start
    for (const c of doc.getObject(id)!.constraints)
      if (!c.mute && silenceConstraintFrom(doc, id, c.name, from))
        warnings.push(
          `'${doc.getObject(id)!.name}': constraint '${c.name}' no longer acts from frame ${from}`,
        );
  };
  for (const b of plan.bodies) {
    const s = samples.get(b.id)!;
    const c = carriers.get(b.id)!;
    const parentName = b.unparent ? (doc.getObject(c.parent ?? '')?.name ?? '?') : '';
    // the simulation held the body after its end whatever its keys said there: its later keys go
    // (and an unparented carrier's keys anywhere were relative to its parent)
    const replace: [number, number] = [b.from, plan.to_end || b.unparent ? Infinity : plan.frame_end];
    keyTransforms(doc, c.id, s, { clean: true, replace, stats });
    // world-space keys include the scale; a root keyed in its own space only where its world scale
    // is not its own (a hold that scaled it)
    if (b.unparent || (b.carrier !== b.id && s.scale.some((v, i) => scaleDiffers(v, s.own[i]))))
      for (let k = 0; k < 3; k++)
        writeChannel(
          doc,
          c.id,
          'scale',
          k,
          s.frames,
          s.scale.map((v) => v[k]),
          { clean: true, replace, stats },
        );
    if (b.unparent)
      // world space from here: no parent; its children stay its children, so they follow its keys
      doc.updateObject(c.id, {
        parent: null,
        parent_type: 'OBJECT',
        parent_bone: '',
        ...(s.frames.length
          ? { location: s.location[0], rotation_euler: s.rotation[0], scale: s.scale[0] }
          : {}),
      });
    const gone = removeConstraints(doc, c.id, b.holds);
    if (gone.length) removed[c.id] = gone;
    silence(c.id, b.from);
    if (b.carrier !== b.id) {
      // the body stays in its model as it was where the keys start
      const ref = refs.get(b.id);
      const goneBody = removeConstraints(doc, b.id, b.body_holds);
      if (goneBody.length) removed[b.id] = goneBody;
      silence(b.id, b.from);
      if (ref) holdChannelsFrom(doc, b.id, b.from, ref.channels, stats);
    }
    if (b.unparent)
      warnings.push(
        `'${c.name}' was unparented from '${parentName}' and keyed in world space from frame ${b.from}`,
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
    objects: plan.bodies.map((b) => b.carrier),
    bodies: plan.bodies.map((b) => b.id),
    keyframes: stats.keys,
    frame_start: plan.frame_start,
    frame_end: plan.frame_end,
    removed_constraints: removed,
    removed_drivers: stats.drivers,
    removed_modifiers: stats.modifiers,
    warnings,
  };
}
