import { z } from 'zod';
import type { CollisionShape } from '../doc/types';
import { DESK_PHYSICS_KINDS } from '../desk/physics';
import { COLLISION_SHAPES } from '../physics/settings';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, vec3 } from './helpers';

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
 * library is desk/physics. FOUNDATION wrote the ids, schemas and defaults; every operator throws
 * until MOTION implements it.
 */

function notImplemented(id: string): () => never {
  return () => {
    throw new OperatorError(`${id} is not implemented yet`, 'FAILED');
  };
}

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
        'none is under them. The rigid body world covers only the frames the bodies need. Returns {bodies, ground}.',
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
          .describe('Collision shape (default: CONVEX_HULL for active bodies, MESH for passive ones)'),
        mass: z.number().min(0.001).max(1e9).optional().describe('Mass in kg (default 1)'),
        friction: z.number().min(0).max(100).optional().describe('Friction coefficient (default 0.5)'),
        restitution: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe('Bounciness: 0 none, 1 elastic (default 0)'),
        ground: z
          .boolean()
          .default(true)
          .describe('Add a passive ground collider at z = 0 when no collider is under the objects'),
      }),
      execute: notImplemented('desk.physics_setup'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_drop',
      label: 'Drop',
      description:
        'Lift objects by `height` (default: where they are) and let them fall from `frame`: their rigid bodies start ' +
        'there (start_frame), held at their keyed pose before. Returns the bodies.',
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
      execute: notImplemented('desk.physics_drop'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_throw',
      label: 'Throw',
      description:
        'Release an object at `frame` with the launch velocity that lands it on `target` after flight_s seconds ' +
        'under gravity (its rigid body starts there with that velocity and spin). Returns {velocity, landing_frame}.',
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
      execute: notImplemented('desk.physics_throw'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_push',
      label: 'Push',
      description:
        'Push an object at `frame`: its rigid body starts there moving along `direction` at speed_mps. Returns ' +
        '{velocity}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        object: objectRef,
        direction: vec3.describe('Direction of the push (normalized)'),
        speed_mps: z.number().min(0).max(1000).describe('Speed in m/s'),
        frame: frameSchema.describe('Frame of the push'),
      }),
      execute: notImplemented('desk.physics_push'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.physics_bake',
      label: 'Bake Physics',
      description:
        'Bake the simulation of rigid bodies to world-space keyframes over a frame range (default: the frames the ' +
        'bodies need), so renders and exports need no simulation. Returns {objects, keyframes, frame_start, frame_end}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        frame_start: frameSchema.optional().describe('First frame to bake (default: the simulation start)'),
        frame_end: frameSchema.optional().describe('Last frame to bake (default: the simulation end)'),
        objects: z.array(objectRef).optional().describe('Bodies to bake (default: every simulated body)'),
      }),
      execute: notImplemented('desk.physics_bake'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.tether_fly',
      label: 'Fly on a String',
      description:
        "Fly a kite or balloon on a string tied to an anchor (an actor's hand bone, a post) in the wind (phase 2): " +
        'it rises over launch_frames to the end of the string, then sways, keyed on every frame, with a string ' +
        'from the anchor and a tail that trails. Returns {flyer, string, tail, frame_end}.',
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
          .describe('Frames it takes to rise to the end of the string (default: about 2 s)'),
        tail: z.boolean().default(true).describe('Add a tail that trails behind it'),
        string: z.boolean().default(true).describe('Add the string from the anchor'),
        seed: z.number().int().min(0).optional().describe('Seed of the gusts (default: from the flyer)'),
      }),
      execute: notImplemented('desk.tether_fly'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.vehicle_drive',
      label: 'Drive Vehicle',
      description:
        'Drive a vehicle (a store model with body, wheel.* and steer.* parts) along a path from frame_start (phase ' +
        '2): the vehicle keyed along the path, its wheels spinning with the distance and its front wheels steering ' +
        'into the turns. Give speed_mps or frame_end. Returns {frame_end, length_m}.',
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
      execute: notImplemented('desk.vehicle_drive'),
    }),
  );
}
