import { z } from 'zod';
import type { Mat4, Vec3 } from '../math/types';
import type { CollisionShape, Keyframe, ObjectData, RigidBodyData, RigidBodyWorld } from '../doc/types';
import { fcurveKey, type SceneDoc } from '../doc/scene-doc';
import { createFCurve } from '../anim/fcurve';
import { FrameState } from '../eval/frame-state';
import { worldMatrixToTransform } from '../constraints/bake';
import {
  RigidBodySimulator,
  freeRigidBodyCache,
  inspectRigidBodies,
  type RigidBodyHost,
} from '../physics/rigid-body';
import {
  COLLISION_SHAPES,
  MAX_SIMULATED_FRAMES,
  newRigidBody,
  sanitizeRigidBody,
  sanitizeRigidBodyWorld,
  simulatedFrameEnd,
  worldParams,
} from '../physics/settings';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, resolveObjectIds, vec3 } from './helpers';

/*
 * Rigid body physics operators (Blender's rigidbody.*):
 *
 *   rigidbody.object_add            add rigid bodies to objects (or change their type / settings)
 *   rigidbody.object_remove         remove rigid bodies
 *   rigidbody.object_settings_set   change rigid body settings (partial)
 *   rigidbody.world_set             rigid body world, gravity and simulation range settings
 *   rigidbody.bake_to_keyframes     bake simulated motion to keyframes, then remove the bodies
 *   rigidbody.cache_free            drop the simulation cache (re-simulate on next evaluation)
 *   rigidbody.describe              inspect the physics setup and the simulated state (read-only)
 *
 * Settings live on ObjectData.rigid_body and SceneSettings.rigidbody_world / gravity, so they
 * sync and undo like everything else; the simulation itself is a cache (physics/rigid-body.ts).
 */

/** Largest frame range rigidbody.bake_to_keyframes simulates in one run. */
export const MAX_BAKE_FRAMES = MAX_SIMULATED_FRAMES;

const shapeEnum = z.enum(COLLISION_SHAPES as [CollisionShape, ...CollisionShape[]]);

const SHAPE_HELP =
  'Collision shape: BOX, SPHERE, CAPSULE, CYLINDER and CONE are fitted to the object bounds (radius = ' +
  'largest X/Y half extent, height along local Z); CONVEX_HULL wraps the mesh vertices (Blender default ' +
  'for ACTIVE); MESH uses the actual triangles (Blender default for PASSIVE; only for PASSIVE or ' +
  'Animated bodies — ACTIVE bodies fall back to CONVEX_HULL)';

/** Optional rigid body settings shared by object_add and object_settings_set (Blender ranges). */
const settingsShape = {
  collision_shape: shapeEnum.optional().describe(SHAPE_HELP),
  mass: z.number().min(0.001).max(1e9).optional().describe('Mass in kg (ACTIVE bodies; Blender default 1)'),
  friction: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Friction coefficient (default 0.5; 0 = frictionless). A contact uses the product of both bodies' " +
        'values, so two default bodies slide with 0.25',
    ),
  restitution: z
    .number()
    .min(0)
    .max(10)
    .optional()
    .describe(
      "Bounciness (default 0 = no bounce, 1 = elastic). A contact uses the product of both bodies' " +
        'values: the ground needs a non-zero restitution too for anything to bounce on it',
    ),
  collision_margin: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Distance in m within which contacts are detected ahead of touching (default 0.04)'),
  linear_damping: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Fraction of linear velocity lost per second (default 0.04)'),
  angular_damping: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Fraction of angular velocity lost per second (default 0.1)'),
  kinematic: z
    .boolean()
    .optional()
    .describe(
      'Blender "Animated": the body follows its animated / parented / constrained transform instead of the ' +
        'simulation and pushes ACTIVE bodies. PASSIVE bodies only move when this is on (default false)',
    ),
  enabled: z
    .boolean()
    .optional()
    .describe(
      'Blender "Dynamic" (ACTIVE bodies): when false the body is not simulated and stays at its frame_start ' +
        'pose, still colliding (default true)',
    ),
};

const typeEnum = z.enum(['ACTIVE', 'PASSIVE']);
const TYPE_HELP =
  'ACTIVE bodies are simulated (fall, collide, bounce); PASSIVE bodies are static colliders (floors, walls, ' +
  'ramps) that only move when Animated (kinematic)';

const objectsParam = z
  .array(z.string())
  .optional()
  .describe('Object ids or exact names (default: the selected objects)');

type SettingsPatch = Partial<Omit<RigidBodyData, 'type'>>;

function pickSettings(p: Record<string, unknown>): SettingsPatch {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(settingsShape)) if (p[k] !== undefined) out[k] = p[k];
  return out as SettingsPatch;
}

/** The scene's rigid body world settings (validated). */
function worldOf(doc: SceneDoc): RigidBodyWorld {
  return sanitizeRigidBodyWorld(doc.getScene().rigidbody_world);
}

/** Reads the scene for the simulator: unsimulated transforms and object meshes. */
export function documentRigidBodyHost(doc: SceneDoc): RigidBodyHost {
  return {
    transformsAt: (frame) => new FrameState(doc, frame).allWorldMatrices(),
    meshOf: (id) => {
      const o = doc.getObject(id);
      return o?.type === 'MESH' && o.data ? doc.getMesh(o.data) : null;
    },
  };
}

function resolveTargets(ctx: OperatorContext, refs: string[] | undefined): ObjectData[] {
  const ids = [...new Set(resolveObjectIds(ctx, refs))];
  if (!ids.length) throw new OperatorError('No objects selected (pass `objects`)', 'POLL_FAILED');
  return ids.map((id) => ctx.doc.getObject(id)!);
}

/** Warnings about settings that will not behave as the user might expect. */
function settingWarnings(ctx: OperatorContext, o: ObjectData, rb: RigidBodyData): void {
  if (rb.type === 'ACTIVE' && !rb.kinematic && rb.collision_shape === 'MESH')
    ctx.report(
      'WARNING',
      `'${o.name}': ACTIVE bodies cannot use the MESH shape; its CONVEX_HULL is simulated`,
    );
  const mesh = o.data ? ctx.doc.getMesh(o.data) : null;
  if (mesh && mesh.positions.length === 0)
    ctx.report('WARNING', `'${o.name}' has no vertices and is left out of the simulation`);
}

function describeSettings(o: ObjectData, rb: RigidBodyData) {
  return { object: o.id, name: o.name, ...rb };
}

/**
 * Location and rotation_euler (closest to `oldRotation`) that reproduce the world matrix `world`
 * for an object whose own scale is `scale`, which stays as it is. The signs of that scale are
 * taken out of the matrix first: decomposing a mirrored matrix on its own negates all three axes,
 * i.e. a 180° turn for an object mirrored along one or two axes.
 */
function keyedTransform(
  world: Readonly<Mat4>,
  parent: Mat4 | null,
  scale: Readonly<Vec3>,
  oldRotation: Vec3 | undefined,
): { location: Vec3; rotation_euler: Vec3 } {
  const m = [...world] as Mat4;
  for (let c = 0; c < 3; c++) if (scale[c] < 0) for (let r = 0; r < 3; r++) m[c * 4 + r] = -m[c * 4 + r];
  const t = worldMatrixToTransform(m, parent, oldRotation);
  return { location: t.location, rotation_euler: t.rotation_euler };
}

/** Blender's bake clean-up: drops keys whose value equals both neighbours within 1e-4. */
function dropRedundantKeys(keys: Keyframe[]): Keyframe[] {
  const out = [...keys];
  let i = 1;
  while (i < out.length - 1) {
    const v = out[i].value;
    if (Math.abs(v - out[i - 1].value) + Math.abs(v - out[i + 1].value) < 1e-4) out.splice(i, 1);
    else i++;
  }
  return out;
}

export function registerPhysicsOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'rigidbody.object_add',
      label: 'Add Rigid Body',
      description:
        'Add rigid body physics to mesh objects (Blender Object > Rigid Body > Add Active / Add Passive). ' +
        "ACTIVE bodies fall under gravity and collide once the timeline plays past the rigid body world's " +
        'frame_start (default frame 1); PASSIVE bodies are colliders such as floors. New bodies get ' +
        "Blender's defaults (mass 1 kg, friction 0.5, restitution 0, margin 0.04 m, CONVEX_HULL for ACTIVE, " +
        'MESH for PASSIVE) unless settings are passed. Objects that already have a rigid body keep their ' +
        'settings, take the new type and the settings passed (switching to ACTIVE turns "Dynamic" on). ' +
        'Non-mesh objects are skipped with a warning. Returns the resulting settings per object.',
      category: 'Physics',
      poll: pollObjectMode,
      schema: z.object({
        objects: objectsParam,
        type: typeEnum.default('ACTIVE').describe(TYPE_HELP),
        ...settingsShape,
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const patch = pickSettings(p);
        const objects: ReturnType<typeof describeSettings>[] = [];
        const skipped: { object: string; name: string; reason: string }[] = [];
        let created = 0;
        for (const o of resolveTargets(ctx, p.objects)) {
          if (o.type !== 'MESH' || !o.data) {
            const reason = `${o.type} objects cannot be rigid bodies (only meshes)`;
            skipped.push({ object: o.id, name: o.name, reason });
            ctx.report('WARNING', `Skipped '${o.name}': ${reason}`);
            continue;
          }
          const existing = sanitizeRigidBody(o.rigid_body);
          const base = existing ? { ...existing, type: p.type } : newRigidBody(p.type);
          if (existing && existing.type !== 'ACTIVE' && p.type === 'ACTIVE' && patch.enabled === undefined)
            base.enabled = true;
          const rb: RigidBodyData = { ...base, ...patch };
          doc.updateObject(o.id, { rigid_body: rb });
          if (!existing) created++;
          settingWarnings(ctx, o, rb);
          objects.push(describeSettings(o, rb));
        }
        if (!objects.length)
          throw new OperatorError(
            `No mesh objects to add rigid bodies to (${skipped.map((s) => `'${s.name}'`).join(', ')})`,
          );
        const world = worldOf(doc);
        if (!world.enabled)
          ctx.report(
            'WARNING',
            'The rigid body world is disabled: enable it with rigidbody.world_set (enabled: true)',
          );
        return { objects, created, skipped, world };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'rigidbody.object_remove',
      label: 'Remove Rigid Body',
      description:
        'Remove rigid body physics from objects (Blender Object > Rigid Body > Remove); they go back to their ' +
        'own (animated) transforms. Objects without a rigid body are ignored; fails when none of them has one. ' +
        'Returns the objects whose rigid body was removed.',
      category: 'Physics',
      poll: pollObjectMode,
      schema: z.object({ objects: objectsParam }),
      execute(ctx, p) {
        const removed: { object: string; name: string }[] = [];
        for (const o of resolveTargets(ctx, p.objects)) {
          if (!o.rigid_body) continue;
          ctx.doc.updateObject(o.id, { rigid_body: null });
          removed.push({ object: o.id, name: o.name });
        }
        if (!removed.length) throw new OperatorError('None of the objects has a rigid body', 'POLL_FAILED');
        return { removed };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'rigidbody.object_settings_set',
      label: 'Rigid Body Settings',
      description:
        'Change rigid body settings of objects that have a rigid body (only the settings passed change; ' +
        'Blender Physics properties > Rigid Body). Switching the type to ACTIVE turns "Dynamic" (enabled) on ' +
        'unless `enabled` is passed. Any change resets the simulation cache. Fails for objects without a ' +
        'rigid body (add one with rigidbody.object_add). Returns the resulting settings per object.',
      category: 'Physics',
      schema: z.object({
        objects: objectsParam,
        type: typeEnum.optional().describe(`${TYPE_HELP} (default: unchanged)`),
        ...settingsShape,
      }),
      execute(ctx, p) {
        const patch = pickSettings(p);
        const targets = resolveTargets(ctx, p.objects);
        const missing = targets.filter((o) => !sanitizeRigidBody(o.rigid_body));
        if (missing.length)
          throw new OperatorError(
            `${missing.map((o) => `'${o.name}'`).join(', ')} ha${missing.length > 1 ? 've' : 's'} no rigid body ` +
              '(add one with rigidbody.object_add)',
            'POLL_FAILED',
          );
        const objects = targets.map((o) => {
          const rb: RigidBodyData = { ...sanitizeRigidBody(o.rigid_body)!, ...patch };
          if (p.type) {
            if (p.type === 'ACTIVE' && rb.type !== 'ACTIVE' && patch.enabled === undefined) rb.enabled = true;
            rb.type = p.type;
          }
          ctx.doc.updateObject(o.id, { rigid_body: rb });
          settingWarnings(ctx, o, rb);
          return describeSettings(o, rb);
        });
        return { objects };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'rigidbody.world_set',
      label: 'Rigid Body World Settings',
      description:
        "Change the scene's rigid body world (Blender Scene properties > Rigid Body World, Gravity): only the " +
        'settings passed change. The simulation runs from frame_start (objects keep their own transforms up ' +
        'to and including it) to frame_end (later frames hold the last state), in substeps_per_frame steps ' +
        `of time_scale / fps seconds per frame. At most ${MAX_SIMULATED_FRAMES} frames after frame_start are ` +
        'simulated: a longer range is stored but warned about, and frames after frame_start + ' +
        `${MAX_SIMULATED_FRAMES} hold that frame's state. Returns the resulting settings, simulated_frame_end ` +
        '(the last frame actually simulated) and the step length in seconds.',
      category: 'Physics',
      schema: z.object({
        enabled: z.boolean().optional().describe('Simulate rigid bodies at all (default true)'),
        frame_start: z
          .number()
          .int()
          .min(-1048574)
          .max(1048574)
          .optional()
          .describe('First frame of the simulation (Blender default 1)'),
        frame_end: z
          .number()
          .int()
          .min(-1048574)
          .max(1048574)
          .optional()
          .describe(
            `Last simulated frame, ≥ frame_start (Blender default 250); at most frame_start + ${MAX_SIMULATED_FRAMES} ` +
              'is simulated, later frames hold the last simulated state',
          ),
        substeps_per_frame: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(
            'Simulation steps per frame: more = more accurate, fewer tunnelling bodies, slower (default 10)',
          ),
        solver_iterations: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Constraint solver iterations per step: more = stiffer stacks, slower (default 10)'),
        time_scale: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Speed of the simulation: 1 = real time, 0.5 = slow motion, 0 = frozen (default 1)'),
        use_gravity: z.boolean().optional().describe('Apply gravity (scene.use_gravity, default true)'),
        gravity: vec3
          .optional()
          .describe('Gravity acceleration in m/s² (scene.gravity, default [0, 0, -9.81])'),
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const scene = doc.getScene();
        const current = worldOf(doc);
        const world: RigidBodyWorld = { ...current };
        for (const k of [
          'enabled',
          'frame_start',
          'frame_end',
          'substeps_per_frame',
          'solver_iterations',
          'time_scale',
        ] as const)
          if (p[k] !== undefined) (world as unknown as Record<string, unknown>)[k] = p[k];
        if (world.frame_end < world.frame_start)
          throw new OperatorError(
            `frame_end (${world.frame_end}) must not be before frame_start (${world.frame_start})`,
            'INVALID_PARAMS',
          );
        if (p.gravity && !p.gravity.every(Number.isFinite))
          throw new OperatorError('gravity must be three finite numbers', 'INVALID_PARAMS');
        doc.updateScene({
          rigidbody_world: world,
          ...(p.use_gravity !== undefined ? { use_gravity: p.use_gravity } : {}),
          ...(p.gravity ? { gravity: [...p.gravity] as Vec3 } : {}),
        });
        const params = worldParams(doc.getScene());
        const simulatedEnd = simulatedFrameEnd(params);
        if (simulatedEnd < world.frame_end)
          ctx.report(
            'WARNING',
            `Only ${MAX_SIMULATED_FRAMES} frames after frame_start are simulated: frames ${simulatedEnd + 1}` +
              `–${world.frame_end} hold the state of frame ${simulatedEnd}`,
          );
        return {
          rigidbody_world: world,
          simulated_frame_end: simulatedEnd,
          use_gravity: doc.getScene().use_gravity,
          gravity: doc.getScene().gravity,
          fps: params.fps,
          step_seconds: params.timeScale / params.fps / params.substeps,
          scene_frame_range: [scene.frame_start, scene.frame_end],
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'rigidbody.bake_to_keyframes',
      label: 'Bake to Keyframes',
      description:
        'Bake the simulated motion of ACTIVE rigid bodies into location and rotation_euler keyframes ' +
        '(LINEAR) every `step` frames from frame_start to frame_end, then remove their rigid bodies ' +
        '(Blender Object > Rigid Body > Bake to Keyframes): the objects then follow the keys without ' +
        'physics, e.g. to edit the motion or export it. Keys are relative to the parent; keys whose value ' +
        'equals both neighbours (within 1e-4) are dropped; existing keys of those channels inside the range ' +
        'are replaced, and drivers and F-curve modifiers on them are removed so the keys reproduce the ' +
        'simulation. Other rigid bodies stay simulated (without the baked objects). Returns the keyframes ' +
        'written per object.',
      category: 'Physics',
      poll: pollObjectMode,
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe(
            'Object ids or exact names; only ACTIVE rigid bodies are baked (default: the selected objects)',
          ),
        frame_start: z
          .number()
          .int()
          .optional()
          .describe('First baked frame (default: the rigid body world frame_start)'),
        frame_end: z
          .number()
          .int()
          .optional()
          .describe('Last baked frame (default: the rigid body world frame_end)'),
        step: z.number().int().min(1).max(120).default(1).describe('Frames between keys (Blender default 1)'),
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const world = worldOf(doc);
        if (!world.enabled)
          throw new OperatorError(
            'The rigid body world is disabled: enable it with rigidbody.world_set (enabled: true)',
            'POLL_FAILED',
          );
        const start = p.frame_start ?? world.frame_start;
        const end = p.frame_end ?? world.frame_end;
        if (end < start)
          throw new OperatorError(
            `frame_end (${end}) must not be before frame_start (${start})`,
            'INVALID_PARAMS',
          );
        if (end - start + 1 > MAX_BAKE_FRAMES)
          throw new OperatorError(
            `Too many frames to bake (${end - start + 1}, at most ${MAX_BAKE_FRAMES})`,
            'INVALID_PARAMS',
          );
        const targets = resolveTargets(ctx, p.objects).filter((o) => {
          const rb = sanitizeRigidBody(o.rigid_body);
          if (rb?.type === 'ACTIVE') return true;
          ctx.report('WARNING', `Skipped '${o.name}': not an ACTIVE rigid body`);
          return false;
        });
        if (!targets.length) throw new OperatorError('No ACTIVE rigid bodies to bake', 'POLL_FAILED');

        // sample every baked frame before changing anything (the simulation steps through all frames)
        const frames: number[] = [];
        for (let f = start; f <= end; f += p.step) frames.push(f);
        const sim = new RigidBodySimulator();
        const host = documentRigidBodyHost(doc);
        const samples = new Map(
          targets.map((o) => [o.id, { location: [] as Vec3[], rotation_euler: [] as Vec3[] }]),
        );
        const previous = new Map(targets.map((o) => [o.id, o.rotation_euler]));
        for (const frame of frames) {
          const simulated = sim.evaluate(doc, frame, host);
          const fs = new FrameState(doc, frame, simulated);
          for (const o of targets) {
            const worldM: Mat4 = fs.world(o.id) ?? fs.local(o.id);
            const parent = o.parent && fs.byId.has(o.parent) ? fs.parent(o.id) : null;
            // the keys must reproduce the matrix together with the object's (animated) scale there
            const scale = fs.byId.get(o.id)?.scale ?? o.scale;
            const t = keyedTransform(worldM, parent, scale, previous.get(o.id));
            previous.set(o.id, t.rotation_euler);
            samples.get(o.id)!.location.push(t.location);
            samples.get(o.id)!.rotation_euler.push(t.rotation_euler);
          }
        }

        const results: { object: string; name: string; keyframes: number }[] = [];
        let removedDrivers = 0;
        let removedModifiers = 0;
        for (const o of targets) {
          const s = samples.get(o.id)!;
          let keyframes = 0;
          for (const path of ['location', 'rotation_euler'] as const)
            for (let i = 0; i < 3; i++) {
              const ref = { target_type: 'object' as const, target_id: o.id, path, index: i };
              const key = fcurveKey(ref);
              const fc = doc.getFCurve(key) ?? createFCurve(ref);
              const kept = fc.keyframes.filter((k) => k.frame < start - 1e-3 || k.frame > end + 1e-3);
              const baked = dropRedundantKeys(
                frames.map((frame, j): Keyframe => ({
                  frame,
                  value: s[path][j][i],
                  interpolation: 'LINEAR',
                })),
              );
              // F-curve modifiers (noise, cycles, …) would distort the baked motion
              removedModifiers += fc.modifiers?.length ?? 0;
              const curve = { ...fc, keyframes: [...kept, ...baked].sort((a, b) => a.frame - b.frame) };
              delete curve.modifiers;
              doc.setFCurve(curve);
              keyframes += baked.length;
              if (doc.getDriver(key)) {
                doc.removeDriver(key);
                removedDrivers++;
              }
            }
          if (o.constraints?.some((c) => !c.mute))
            ctx.report('WARNING', `'${o.name}' has constraints: they now apply on top of the baked keys`);
          doc.updateObject(o.id, { rigid_body: null });
          results.push({ object: o.id, name: o.name, keyframes });
        }
        if (removedDrivers) ctx.report('WARNING', `Removed ${removedDrivers} driver(s) on baked channels`);
        if (removedModifiers)
          ctx.report('WARNING', `Removed ${removedModifiers} F-curve modifier(s) on baked channels`);
        return {
          objects: results,
          frame_start: start,
          frame_end: end,
          step: p.step,
          frames: frames.length,
          removed_drivers: removedDrivers,
          removed_modifiers: removedModifiers,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'rigidbody.cache_free',
      label: 'Free Rigid Body Cache',
      description:
        'Drop the cached rigid body simulation of this document so the next evaluation re-simulates from the ' +
        'world\'s frame_start (Blender "Delete All Bakes" / cache reset). The cache is also refreshed ' +
        'automatically whenever simulation inputs change; this does not change the document. Returns what ' +
        'was cached (simulated_to: last cached frame), or freed: false when nothing was cached.',
      category: 'Physics',
      undo: false,
      schema: z.object({}),
      execute(ctx) {
        const info = freeRigidBodyCache(ctx.doc);
        return info
          ? {
              freed: true,
              frame_start: info.frame_start,
              simulated_to: info.simulated_to,
              bodies: info.bodies,
              steps: info.steps,
            }
          : { freed: false };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'rigidbody.describe',
      label: 'Describe Rigid Bodies',
      description:
        'Inspect the physics setup (read-only): rigid body world settings (simulated_frame_end: the last ' +
        'frame actually simulated), gravity and every rigid body ' +
        '(settings, the collision shape actually simulated after fallbacks, how it moves: DYNAMIC, ' +
        'KINEMATIC (animated), FROZEN (ACTIVE with Dynamic off) or STATIC, whether it has come to rest ' +
        '(sleeping; null when unknown for that frame)) with its ' +
        'world location / rotation at `frame` (simulated when the simulation drives it), plus problems such as ' +
        'non-mesh objects. Simulates up to `frame` if needed.',
      category: 'Physics',
      undo: false,
      schema: z.object({
        objects: z
          .array(z.string())
          .optional()
          .describe('Object ids or exact names to describe (default: every rigid body)'),
        frame: z.number().optional().describe('Frame to report transforms at (default: the current frame)'),
      }),
      execute(ctx, p) {
        const doc = ctx.doc;
        const frame = p.frame ?? ctx.state.frame;
        const scene = doc.getScene();
        const world = worldOf(doc);
        const host = documentRigidBodyHost(doc);
        let simulated: Map<string, Mat4> | null = null;
        let simError: string | null = null;
        const sim = new RigidBodySimulator();
        try {
          simulated = sim.evaluate(doc, frame, host);
        } catch (e) {
          simError = (e as Error).message;
        }
        const info = inspectRigidBodies(doc, host);
        const motion = new Map(info?.objects.map((b) => [b.object, b]) ?? []);
        const fs = new FrameState(doc, frame, simulated);
        const objects = p.objects
          ? p.objects.map((r) => {
              const o = doc.resolveObject(r);
              if (!o) throw new OperatorError(`Object '${r}' not found`, 'NOT_FOUND');
              return o;
            })
          : doc.listObjects().filter((o) => o.rigid_body);
        const issues = info?.issues ?? [];
        const simulatedEnd = simulatedFrameEnd(worldParams(scene));
        const atFrame = Math.ceil(Math.min(frame, simulatedEnd));
        return {
          frame,
          world,
          simulated_frame_end: simulatedEnd,
          use_gravity: scene.use_gravity,
          gravity: scene.gravity,
          fps: scene.fps,
          simulation_running: !!simulated,
          cache: info
            ? { frame_start: info.frame_start, frame_end: info.frame_end, simulated_to: info.simulated_to }
            : null,
          error: simError,
          objects: objects.map((o) => {
            const rb = sanitizeRigidBody(o.rigid_body);
            const m = fs.world(o.id);
            const t = m
              ? keyedTransform(m, null, fs.byId.get(o.id)?.scale ?? o.scale, o.rotation_euler)
              : null;
            const body = motion.get(o.id);
            return {
              object: o.id,
              name: o.name,
              rigid_body: rb,
              simulated_shape: body?.collision_shape ?? null,
              motion: body?.motion ?? null,
              // sleep state is known for the last simulated frame only
              sleeping: body && info && info.simulated_to === atFrame ? body.sleeping : null,
              simulated: !!simulated?.has(o.id),
              world_location: t?.location ?? null,
              world_rotation_euler: t?.rotation_euler ?? null,
              issues: issues.filter((i) => i.objectId === o.id).map((i) => `${i.level}: ${i.message}`),
            };
          }),
        };
      },
    }),
  );
}
