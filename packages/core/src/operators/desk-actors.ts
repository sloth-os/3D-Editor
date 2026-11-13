import { z } from 'zod';
import { ACTOR_GAITS, ACTOR_KINDS, ACTOR_POSES } from '../desk/characters';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, vec3 } from './helpers';

/*
 * Actor operators of the director's desk (CHARACTERS owns this module; spec §4, §8):
 *
 *   desk.actor_add       add an actor (a segmented mannequin or a quadruped on an armature)
 *   desk.actor_pose      key a pose (blended in, held)
 *   desk.actor_move      walk / run / trot / gallop along a path (gait keys for every cycle)
 *   desk.actor_face      turn to a heading or toward a point or object
 *   desk.actor_look_at   turn the head toward an object (or stop)
 *   desk.actor_hold      take a prop in a hand (and release it)
 *   desk.actor_mount     ride a horse, pony, donkey or cow (and get off)
 *
 * The library is desk/characters. FOUNDATION wrote the ids, schemas and defaults; every operator
 * throws until CHARACTERS implements it. Facings are degrees about +Z, 0 facing the front (−Y), 90
 * facing +X (rideo's facingDeg).
 */

function notImplemented(id: string): () => never {
  return () => {
    throw new OperatorError(`${id} is not implemented yet`, 'FAILED');
  };
}

const actorRef = z.string().describe('Actor (its armature object) id or exact name');
const poseEnum = z
  .enum(ACTOR_POSES)
  .describe(
    "Pose: rideo's stand, walk, run, sit, crouch, kneel, lie, reach, point, wave; also idle, talk, arms_crossed, " +
      'hands_on_hips, carry, throw, kick, jump, look_up, ride, sit_ground; quadrupeds: stand, walk, trot, gallop, ' +
      'sit, lie, eat, look_up',
  );
const frameSchema = z.number().int().describe('Scene frame');
const facingSchema = z
  .number()
  .min(-3600)
  .max(3600)
  .describe('Heading in degrees about +Z: 0 faces the front (−Y), 90 faces +X (rideo facingDeg)');
const blendSchema = z.number().int().min(0).max(1000).describe('Frames to blend into it');

export function registerDeskActorOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'desk.actor_add',
      label: 'Add Actor',
      description:
        'Add an actor: an ARMATURE with fixed bone names and a low-poly mesh part per bone in the actor colour ' +
        '(darker joints, a nose so the facing reads), standing with its feet at `location`. Phase 1 builds adult, ' +
        'man, woman, child, horse, pony and dog; the other kinds fail with a clear error until they are built. ' +
        'Returns {actor, parts, name}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        kind: z
          .enum(ACTOR_KINDS)
          .describe(
            'Kind: adult, man, woman, child, toddler, elder (humanoids); horse, pony, donkey, cow, dog, small_dog, ' +
              'cat, sheep, pig, deer, bear, duck, bird',
          ),
        name: z.string().min(1).max(64).optional().describe('Name (default: the kind, numbered)'),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Colour '#rrggbb' (default: the next colour of rideo's cast palette)"),
        height_m: z
          .number()
          .min(0.05)
          .max(8)
          .optional()
          .describe('Standing height in metres (default per kind: adult 1.7, child 1.2, toddler 0.9 …)'),
        location: vec3.optional().describe('Where the feet stand, in metres (default: the 3D cursor)'),
        facing_deg: facingSchema
          .optional()
          .describe('Heading in degrees about +Z, 0 facing the front (−Y) (default 0)'),
        pose: poseEnum.optional().describe('Pose to start in (default stand)'),
      }),
      execute: notImplemented('desk.actor_add'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.actor_pose',
      label: 'Pose Actor',
      description:
        "Key a pose on an actor's bones at `frame`, blended in over blend_frames and held for hold_frames. Returns " +
        'the keyed frames.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        actor: actorRef,
        pose: poseEnum,
        frame: frameSchema.optional().describe('Frame the pose is reached (default: the current frame)'),
        blend_frames: blendSchema.default(6),
        hold_frames: z
          .number()
          .int()
          .min(0)
          .max(100_000)
          .optional()
          .describe('Frames the pose is held after `frame` (default: until the next key)'),
      }),
      execute: notImplemented('desk.actor_pose'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.actor_move',
      label: 'Move Actor',
      description:
        "Move an actor along a path from where it stands at frame_start: the armature object's location and heading " +
        'keyed along the path, and a gait keyed for every cycle (stride = speed / cadence, so the feet do not ' +
        'slide). Give speed_mps or frame_end. Returns {frame_end, length_m}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        actor: actorRef,
        points: z
          .array(vec3.describe('Point in metres'))
          .min(1)
          .max(1000)
          .describe('Path points the feet pass through, in metres (the floor is z = 0)'),
        frame_start: frameSchema.describe('Frame the move starts'),
        speed_mps: z
          .number()
          .positive()
          .max(30)
          .optional()
          .describe('Speed in m/s (default by gait: walk 1.3, run 3.5; quadrupeds walk, trot and gallop)'),
        frame_end: frameSchema.optional().describe('Frame the move ends (instead of speed_mps)'),
        gait: z
          .enum(ACTOR_GAITS)
          .default('auto')
          .describe('Gait: walk, run, trot, gallop, or auto (chosen from the speed and the kind)'),
        face_path: z.boolean().default(true).describe('Turn to face along the path'),
        end_pose: poseEnum.optional().describe('Pose to blend into at the end (default stand)'),
      }),
      execute: notImplemented('desk.actor_move'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.actor_face',
      label: 'Turn Actor',
      description:
        'Turn an actor to a heading, or toward a point or object, over turn_frames ending at `frame`. Give ' +
        'facing_deg or target. Returns the heading reached.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        actor: actorRef,
        facing_deg: facingSchema.optional(),
        target: z
          .union([vec3, z.string()])
          .optional()
          .describe('Point in metres, or object id or exact name, to face (instead of facing_deg)'),
        frame: frameSchema.describe('Frame the turn ends'),
        turn_frames: z.number().int().min(0).max(1000).default(8).describe('Frames the turn takes'),
      }),
      execute: notImplemented('desk.actor_face'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.actor_look_at',
      label: 'Actor Look At',
      description:
        "Turn an actor's head toward an object from `frame` (blended in), or back to looking ahead with target null. " +
        'Returns the constraint.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        actor: actorRef,
        target: z
          .string()
          .nullable()
          .describe('Object id or exact name to look at, or null to look ahead again'),
        frame: frameSchema.describe('Frame the look starts'),
        blend_frames: blendSchema.default(6),
      }),
      execute: notImplemented('desk.actor_look_at'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.actor_hold',
      label: 'Hold Prop',
      description:
        "Put a prop in an actor's hand from `frame` (CHILD_OF the hand bone, influence keyed 0→1 there) and let go " +
        'at release_frame (its visual transform keyed; a prop with a rigid body falls or flies from there). Returns ' +
        'the constraint.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        actor: actorRef,
        prop: z.string().describe('Object id or exact name of the prop'),
        hand: z.enum(['right', 'left']).default('right').describe('Hand that holds it'),
        frame: frameSchema.describe('Frame the actor takes the prop'),
        release_frame: frameSchema.optional().describe('Frame the actor lets go (default: never)'),
      }),
      execute: notImplemented('desk.actor_hold'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.actor_mount',
      label: 'Mount',
      description:
        "Seat a rider on a mount's saddle from `frame` (CHILD_OF the saddle bone, the ride pose) until " +
        'dismount_frame. Mounts are horse, pony, donkey and cow. Returns the constraint.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        rider: actorRef.describe('Rider (a humanoid actor) id or exact name'),
        mount: actorRef.describe('Mount (a horse, pony, donkey or cow actor) id or exact name'),
        frame: frameSchema.describe('Frame the rider is in the saddle'),
        dismount_frame: frameSchema.optional().describe('Frame the rider gets off (default: never)'),
      }),
      execute: notImplemented('desk.actor_mount'),
    }),
  );
}
