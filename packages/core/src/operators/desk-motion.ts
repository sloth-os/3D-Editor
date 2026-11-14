import { z } from 'zod';
import type { Vec3 } from '../math/types';
import type { CollisionShape } from '../doc/types';
import {
  DESK_PHYSICS_KINDS,
  TETHER_AFTER,
  deskModelRoot,
  deskPhysicsBake,
  deskPhysicsDrop,
  deskPhysicsPush,
  deskPhysicsSetup,
  deskPhysicsThrow,
  deskTetherFly,
  deskVehicleDrive,
  type DeskWorldRange,
} from '../desk/physics';
import { COLLISION_SHAPES } from '../physics/settings';
import type { OperatorContext } from './context';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, resolveObjectIds, setSelection, vec3 } from './helpers';

/*
 * Physics presets of the director's desk (MOTION owns this module; spec §4):
 *
 *   desk.physics_setup    rigid bodies on objects (and a ground collider)
 *   desk.physics_drop     lift objects and let them fall at a frame
 *   desk.physics_throw    launch an object to land on a point or object after flight_s
 *   desk.physics_push     push an object along a direction at a frame
 *   desk.physics_bake     bake the simulation to keyframes
 *   desk.tether_fly       fly a kite or balloon on a string from an anchor (phase 2)
 *   desk.vehicle_drive    drive a vehicle along a path, wheels spinning, steering (phase 2)
 *
 * Bodies start at their RigidBodyData.start_frame with initial velocities (doc/types.ts); the
 * library is desk/physics. Object references are ids or exact names; results give ids and names.
 */

/** Resolves one object reference (id or exact name) to its id. */
function objectId(ctx: OperatorContext, ref: string): string {
  return resolveObjectIds(ctx, [ref])[0];
}

/** An object as results name it. */
function named(ctx: OperatorContext, id: string): { object: string; name: string } {
  return { object: id, name: ctx.doc.getObject(id)?.name ?? id };
}

/**
 * A rigid body as results name it: the root of the store model whose geometry it carries (what
 * store.add returned, which shots and checks follow) with `part`, the mesh that carries the rigid body;
 * any other body by itself.
 */
function bodyNamed(
  ctx: OperatorContext,
  id: string,
): { object: string; name: string; part?: { object: string; name: string } } {
  const root = deskModelRoot(ctx.doc, id);
  return root ? { ...named(ctx, root.id), part: named(ctx, id) } : named(ctx, id);
}

/** What a model's root stands for in the presets (their descriptions). */
const MODEL_NOTE =
  'A store model (its root) is simulated by its mesh part (its largest, the others hang from it); results name the root, with `part` the mesh that carries the rigid body.';

/** Reports a preset's warnings and returns the world range it left. */
function finish(ctx: OperatorContext, r: { world?: DeskWorldRange | null; warnings: string[] }) {
  for (const w of r.warnings) ctx.report('WARNING', w);
  return r.world ?? null;
}

const round3 = (v: Vec3): Vec3 => v.map((x) => Math.round(x * 1000) / 1000) as Vec3;

const objectRef = z.string().describe('Object id or exact name');
const objectRefs = z.array(objectRef).min(1).describe('Object ids or exact names');
const frameSchema = z.number().int().describe('Scene frame');
const pointOrObject = z
  .union([vec3, z.string()])
  .describe('A point in metres, or an object id or exact name (its origin)');

export function registerDeskMotionOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'desk.physics_setup',
      label: 'Physics Setup',
      description:
        'Give objects rigid bodies: active (falls and collides), passive (a static collider such as a floor or a ' +
        'wall) or animated (follows its keys and pushes active bodies), with a ground collider at z = 0 when ' +
        'none is under them. The rigid body world covers only the frames the bodies need. ' +
        MODEL_NOTE +
        ' Returns {bodies (with their collision_shape), ground, world: {frame_start, frame_end, settled}}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        objects: objectRefs,
        kind: z
          .enum(DESK_PHYSICS_KINDS)
          .default('active')
          .describe('active: simulated; passive: a static collider; animated: follows its keys and pushes'),
        shape: z
          .enum(COLLISION_SHAPES as [CollisionShape, ...CollisionShape[]])
          .optional()
          .describe(
            'Collision shape (default: SPHERE for balls, BOX for other active and animated bodies, MESH for ' +
              'passive ones; an existing body keeps its shape)',
          ),
        mass: z.number().min(0.001).max(1e9).optional().describe('Mass in kg (default 1)'),
        friction: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Friction coefficient (default 0.5, balls 0.6; the desk ground uses 1)'),
        restitution: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe('Bounciness: 0 none, 1 elastic (default 0, balls 0.6)'),
        ground: z
          .boolean()
          .default(true)
          .describe('Add a passive ground collider at z = 0 when no collider is under the objects'),
      }),
      execute(ctx, p) {
        const ids = [...new Set(resolveObjectIds(ctx, p.objects))];
        const r = deskPhysicsSetup(ctx.doc, ids, {
          kind: p.kind,
          shape: p.shape,
          mass: p.mass,
          friction: p.friction,
          restitution: p.restitution,
          ground: p.ground,
        });
        const world = finish(ctx, r);
        setSelection(ctx, r.bodies);
        return {
          bodies: r.bodies.map((id) => ({
            ...bodyNamed(ctx, id),
            collision_shape: ctx.doc.getObject(id)?.rigid_body?.collision_shape ?? null,
          })),
          ground: r.ground ? named(ctx, r.ground) : null,
          world,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_drop',
      label: 'Drop',
      description:
        'Lift objects by `height` (default: where they are) and let them fall from `frame`: their rigid bodies start ' +
        'there (start_frame), held at their keyed pose before. ' +
        MODEL_NOTE +
        ' Returns {bodies, frame, world}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        objects: objectRefs,
        frame: frameSchema.describe('Frame the objects are let go'),
        height: z
          .number()
          .min(0)
          .max(1000)
          .optional()
          .describe('Metres to lift them before the drop (default 0)'),
      }),
      execute(ctx, p) {
        const ids = [...new Set(resolveObjectIds(ctx, p.objects))];
        const r = deskPhysicsDrop(ctx.doc, ids, { frame: p.frame, height: p.height });
        const world = finish(ctx, r);
        return { bodies: r.bodies.map((id) => bodyNamed(ctx, id)), frame: p.frame, world };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_throw',
      label: 'Throw',
      description:
        'Release an object at `frame` with the launch velocity that lands it on `target` after flight_s seconds ' +
        'under gravity (its rigid body starts there with that velocity and spin). ' +
        MODEL_NOTE +
        ' Returns {body, velocity, speed_mps, landing_frame, world}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        object: objectRef,
        target: pointOrObject.describe('Where it lands: a point in metres, or an object id or exact name'),
        frame: frameSchema.describe('Frame it leaves the hand'),
        flight_s: z.number().positive().max(60).default(1).describe('Seconds in the air'),
        spin: vec3.optional().describe('Spin in radians per second about world X, Y and Z (default none)'),
      }),
      execute(ctx, p) {
        const id = objectId(ctx, p.object);
        const target: Vec3 | string = typeof p.target === 'string' ? objectId(ctx, p.target) : p.target;
        if (target === id) throw new OperatorError('An object cannot be thrown at itself', 'INVALID_PARAMS');
        const r = deskPhysicsThrow(ctx.doc, id, target, {
          frame: p.frame,
          flight_s: p.flight_s,
          spin: p.spin,
        });
        const world = finish(ctx, r);
        return {
          body: bodyNamed(ctx, r.body),
          velocity: round3(r.velocity),
          speed_mps: Math.round(Math.hypot(...r.velocity) * 1000) / 1000,
          landing_frame: Math.round(r.landing_frame * 1000) / 1000,
          world,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_push',
      label: 'Push',
      description:
        'Push an object at `frame`: its rigid body starts there moving along `direction` at speed_mps. ' +
        MODEL_NOTE +
        ' Returns {body, velocity, world}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        object: objectRef,
        direction: vec3.describe('Direction of the push (normalized)'),
        speed_mps: z.number().min(0).max(1000).describe('Speed in m/s'),
        frame: frameSchema.describe('Frame of the push'),
      }),
      execute(ctx, p) {
        const r = deskPhysicsPush(ctx.doc, objectId(ctx, p.object), {
          direction: p.direction,
          speed_mps: p.speed_mps,
          frame: p.frame,
        });
        const world = finish(ctx, r);
        return { body: bodyNamed(ctx, r.body), velocity: round3(r.velocity), world };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_bake',
      label: 'Bake Physics',
      description:
        'Bake the simulation of rigid bodies to keyframes over a frame range (default: the frames the bodies ' +
        "need), so renders and exports need no simulation. A store model's body is keyed through the model's " +
        'root (the root moves as the simulated part did, its parts stay in it); any other body is keyed itself, ' +
        'in world space when it had a parent (it is unparented). The rigid bodies and the hold constraints of ' +
        'held props are removed. Returns {objects (the keyed objects, with `part` the simulated mesh of a ' +
        'model), keyframes, frame_start, frame_end, removed_constraints}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        frame_start: frameSchema.optional().describe('First frame to bake (default: the simulation start)'),
        frame_end: frameSchema.optional().describe('Last frame to bake (default: the simulation end)'),
        objects: z
          .array(objectRef)
          .optional()
          .describe(
            "Bodies to bake, or objects above them such as a store model's root (its bodies): default every " +
              'simulated body',
          ),
      }),
      execute(ctx, p) {
        const objects = p.objects?.length ? [...new Set(resolveObjectIds(ctx, p.objects))] : undefined;
        const r = deskPhysicsBake(ctx.doc, { frame_start: p.frame_start, frame_end: p.frame_end, objects });
        for (const w of r.warnings) ctx.report('WARNING', w);
        return {
          objects: r.objects.map((id, i) =>
            id === r.bodies[i] ? named(ctx, id) : { ...named(ctx, id), part: named(ctx, r.bodies[i]) },
          ),
          keyframes: r.keyframes,
          frame_start: r.frame_start,
          frame_end: r.frame_end,
          removed_constraints: Object.entries(r.removed_constraints).map(([id, names]) => ({
            ...named(ctx, id),
            constraints: names,
          })),
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.tether_fly',
      label: 'Fly on a String',
      description:
        "Fly a kite or balloon on a string tied to an anchor (an actor's hand bone, a post) in the wind (phase 2): " +
        'it rises over launch_frames to the end of the string, then sways, keyed on every frame, with a string ' +
        'from the anchor and a tail that trails. After frame_end (`after`) it stays where the flight ends, is ' +
        'hidden with its tail and string, or (a kite) comes down to lie on the ground. Returns {flyer, kind, ' +
        'string, tail, tail_objects, frame_start, frame_end, after, hidden_from, landed_frame, seed, ' +
        'mean_elevation_deg, keyframes}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        flyer: objectRef.describe('The flying object (kite, balloon) id or exact name'),
        anchor: objectRef.describe('Object the string is tied to (an actor, a post) id or exact name'),
        anchor_bone: z
          .string()
          .optional()
          .describe("Bone of the anchor's armature the string is tied to (an actor's hand.R)"),
        length_m: z.number().min(0.1).max(500).describe('String length in metres'),
        wind_dir_deg: z
          .number()
          .min(-3600)
          .max(3600)
          .describe(
            'Direction the wind blows toward, in degrees about +Z (0 = toward −Y, the front; 90 = +X)',
          ),
        wind_mps: z.number().min(0).max(60).describe('Wind speed in m/s'),
        frame_start: frameSchema.describe('First frame of the flight'),
        frame_end: frameSchema.describe('Last frame of the flight'),
        launch_frames: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe(
            'Frames it takes to rise to the end of the string (default: the string paid out at 2.5 m/s, at ' +
              'least 2 s; 0: already flying on the whole string at frame_start, where the wind holds it)',
          ),
        tail: z.boolean().default(true).describe('Add a tail that trails behind it'),
        string: z.boolean().default(true).describe('Add the string from the anchor'),
        seed: z.number().int().min(0).optional().describe('Seed of the gusts (default: from the flyer)'),
        after: z
          .enum(TETHER_AFTER)
          .default('hold')
          .describe(
            "After frame_end: 'hold' leaves the flyer, its tail and string where the flight ends; 'hide' hides them " +
              'from frame_end + 1 on (their keyed scale shrinks them to nothing: renders, the viewport and the ' +
              "video export show none of them; a later flight shows the flyer again); 'land' brings a kite down " +
              'within 1.5 s to lie on the ground downwind of the anchor, its string hidden (not for balloons)',
          ),
      }),
      execute(ctx, p) {
        const flyer = objectId(ctx, p.flyer);
        const anchor = objectId(ctx, p.anchor);
        const r = deskTetherFly(ctx.doc, { ...p, flyer, anchor });
        for (const w of r.warnings) ctx.report('WARNING', w);
        return {
          flyer: named(ctx, r.flyer),
          kind: r.kind,
          string: r.string ? named(ctx, r.string) : null,
          tail: r.tail ? named(ctx, r.tail) : null,
          tail_objects: r.tail_objects.map((id) => named(ctx, id)),
          frame_start: p.frame_start,
          frame_end: r.frame_end,
          after: r.after,
          hidden_from: r.hidden_from,
          landed_frame: r.landed_frame,
          seed: r.seed,
          mean_elevation_deg: r.mean_elevation_deg,
          keyframes: r.keyframes,
        };
      },
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.vehicle_drive',
      label: 'Drive Vehicle',
      description:
        'Drive a vehicle (a store model with body, wheel.* and steer.* parts) along a path from frame_start (phase ' +
        '2): the vehicle keyed along the path, its wheels spinning with the distance and its front wheels steering ' +
        'into the turns. Give speed_mps or frame_end. Returns {vehicle, frame_start, frame_end, length_m, ' +
        'speed_mps, wheels, steering, keyframes}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        vehicle: objectRef.describe("The vehicle's root object id or exact name"),
        points: z
          .array(vec3.describe('Point in metres'))
          .min(1)
          .max(1000)
          .describe('Path points, in metres (from where the vehicle stands at frame_start)'),
        frame_start: frameSchema.describe('Frame the drive starts'),
        speed_mps: z.number().positive().max(100).optional().describe('Speed in m/s'),
        frame_end: frameSchema.optional().describe('Frame the drive ends (instead of speed_mps)'),
      }),
      execute(ctx, p) {
        if (p.speed_mps !== undefined && p.frame_end !== undefined)
          throw new OperatorError('Give speed_mps or frame_end, not both', 'INVALID_PARAMS');
        const vehicle = objectId(ctx, p.vehicle);
        const r = deskVehicleDrive(ctx.doc, vehicle, p.points, {
          frame_start: p.frame_start,
          speed_mps: p.speed_mps,
          frame_end: p.frame_end,
        });
        for (const w of r.warnings) ctx.report('WARNING', w);
        return {
          vehicle: named(ctx, vehicle),
          frame_start: p.frame_start,
          frame_end: r.frame_end,
          length_m: Math.round(r.length_m * 1000) / 1000,
          speed_mps: Math.round(r.speed_mps * 1000) / 1000,
          wheels: r.wheels.map((w) => ({
            ...named(ctx, w.id),
            radius_m: Math.round(w.radius * 1000) / 1000,
          })),
          steering: r.steering.map((id) => named(ctx, id)),
          keyframes: r.keyframes,
        };
      },
    }),
  );
}
