import { z } from 'zod';
import {
  DESK_ANGLES,
  DESK_CONTINUITIES,
  DESK_FACINGS,
  DESK_FRAMINGS,
  DESK_HEIGHTS,
  DESK_MOVES,
  DESK_SIDES,
} from '../doc/types';
import { ACTOR_KINDS } from '../desk/characters';
import {
  MAX_PRE_ROLL,
  MAX_SHOT_LAYOUT,
  MAX_SHOT_NAME,
  MAX_SHOT_NOTES,
  MAX_SHOT_SECONDS,
  MAX_SHOT_SUBJECTS,
  MAX_SHOTS,
  SHOT_LENS_MAX,
  SHOT_LENS_MIN,
} from '../desk/shots';
import { OperatorError } from './context';
import { defineOperator, type OperatorRegistry } from './registry';
import { pollObjectMode, vec3 } from './helpers';

/*
 * Shot operators of the director's desk (DESK-CORE owns this module; spec §4–§7, §11):
 *
 *   desk.shot_add                 add a shot (and its camera), solved from its framing
 *   desk.shot_update              change a shot (solving its camera again when asked)
 *   desk.shot_remove              remove shots (and their cameras)
 *   desk.shot_move                move a shot in the cut
 *   desk.shot_solve               solve shots' cameras (plan fitting, moves, the 180° line)
 *   desk.check                    continuity checks, blocking lines and layouts (read-only)
 *   desk.set_build                ground, sky and sun (and interior walls) of the set
 *   desk.camera_move              key a camera move over a shot or a range
 *   desk.import_rideo_blocking    a rideo clip's SceneBlocking as a scene and shots (phase 2)
 *   desk.export_rideo_blocking    the scene as a rideo SceneBlocking v1 (phase 2, read-only)
 *
 * Shots live in SceneSettings.shots and are read and written only through desk/shots.ts. FOUNDATION
 * wrote the ids, schemas and defaults; every operator throws until DESK-CORE implements it.
 * Axes: Z up, the front is −Y (rideo +z), facings in degrees about +Z with 0 facing the front.
 */

function notImplemented(id: string): () => never {
  return () => {
    throw new OperatorError(`${id} is not implemented yet`, 'FAILED');
  };
}

const framingEnum = z
  .enum(DESK_FRAMINGS)
  .describe(
    'Framing: extreme_wide, wide, medium, medium_close, close_up, extreme_close_up, over_shoulder, pov or insert ' +
      '(how much of the subjects the frame holds; rideo camera.framing)',
  );
const angleEnum = z
  .enum(DESK_ANGLES)
  .describe(
    'Camera angle around the subjects: front, three_quarter_left/right (±35°), profile_left/right (±90°), back, ' +
      'over_shoulder or pov',
  );
const heightEnum = z
  .enum(DESK_HEIGHTS)
  .describe('Camera height: eye, low, high (1.2 m above the head) or overhead (4 m above the head)');
const moveEnum = z
  .enum(DESK_MOVES)
  .describe(
    'Camera move over the shot (rideo move ids): locked_off, push_in, pull_out, dolly_left/right, pan_left/right, ' +
      'tilt_up/down, tracking_follow, steadicam_walk, orbit_left/right, crane_up/down, whip_pan, handheld, ' +
      'dolly_zoom, drone_flyover or rack_focus',
  );
const lensSchema = z
  .number()
  .min(SHOT_LENS_MIN)
  .max(SHOT_LENS_MAX)
  .describe(
    `Lens focal length in mm on a 36 mm wide sensor, ${SHOT_LENS_MIN}–${SHOT_LENS_MAX} (default: the framing's)`,
  );
const subjectsSchema = z
  .array(z.string().describe('Object id or exact name'))
  .max(MAX_SHOT_SUBJECTS)
  .describe(`The shot's subjects (actors or props), at most ${MAX_SHOT_SUBJECTS}; the first leads`);
const layoutSchema = z
  .array(
    z.object({
      subject: z.string().describe('Object id or exact name of one of the subjects'),
      side: z.enum(DESK_SIDES).describe('Third of the frame the subject is in: left, centre or right'),
      facing: z
        .enum(DESK_FACINGS)
        .describe('Which way the subject faces on screen: left, right, camera or away'),
    }),
  )
  .max(MAX_SHOT_LAYOUT)
  .describe(
    'Planned screen layout, one entry per subject (rideo shot.layout): the solve keeps the camera whose view agrees ' +
      'with it (front, three-quarters, profiles, back, over the shoulder); plan_mismatch when none does',
  );
const notesSchema = z
  .string()
  .max(MAX_SHOT_NOTES)
  .describe(`Notes (description, action), at most ${MAX_SHOT_NOTES} characters`);
const continuitySchema = z
  .enum(DESK_CONTINUITIES)
  .describe(
    "How the shot follows the one before: 'cut', or 'continuous' (the action carries on; no jump of marks)",
  );
const preRollSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_PRE_ROLL)
  .describe(
    'Frames before frame_start that are animated and simulated but never exported, so holds and physics settle',
  );
const frameStartSchema = z.number().int().describe('First scene frame of the shot');
const frameEndSchema = z
  .number()
  .int()
  .describe('Last scene frame of the shot (inclusive; at least frame_start)');
const durationSchema = z
  .number()
  .positive()
  .max(MAX_SHOT_SECONDS)
  .describe('Length in seconds at the scene frame rate, when frame_end is not given');
const shotRef = z.string().describe('Shot id or exact name');
const shotRefs = z.array(shotRef).describe('Shot ids or exact names (default: every enabled shot)');

export function registerDeskShotOperators(reg: OperatorRegistry): void {
  reg.register(
    defineOperator({
      id: 'desk.shot_add',
      label: 'Add Shot',
      description:
        'Add a shot to the cut: a camera over a range of scene frames with what it should show. Without `camera` a ' +
        'new camera named after the shot is added; with `solve` and subjects or a framing the camera is solved ' +
        "(rideo's framing table: coverage, lens and look-at height per framing; angle and height around the " +
        'subjects; fitted to `layout` when given; the move keyed over the shot). The range defaults to ' +
        "duration_s (5 s) after the last shot's end and extends the scene's frame_end. Returns {shot: {id, name, " +
        'camera, frame_start, frame_end}}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        name: z
          .string()
          .min(1)
          .max(MAX_SHOT_NAME)
          .optional()
          .describe(
            `Shot name, at most ${MAX_SHOT_NAME} characters (default "Shot N"); also names a new camera`,
          ),
        camera: z
          .string()
          .optional()
          .describe(
            'CAMERA object id or exact name to shoot with (default: a new camera named after the shot)',
          ),
        frame_start: frameStartSchema
          .optional()
          .describe(
            "First scene frame (default: the frame after the last shot's end, or the scene's frame_start)",
          ),
        frame_end: frameEndSchema
          .optional()
          .describe('Last scene frame, inclusive (default: from duration_s)'),
        duration_s: durationSchema
          .optional()
          .describe('Length in seconds when frame_end is not given (default 5)'),
        framing: framingEnum.optional(),
        angle: angleEnum.optional(),
        height: heightEnum.optional(),
        move: moveEnum.optional(),
        lens_mm: lensSchema.optional(),
        subjects: subjectsSchema.optional(),
        layout: layoutSchema.optional(),
        notes: notesSchema.optional(),
        continuity: continuitySchema.default('cut'),
        pre_roll: preRollSchema.default(0),
        solve: z
          .boolean()
          .default(true)
          .describe('Solve the camera from framing, angle, height, subjects and lens (when they allow it)'),
        from_view: z
          .object({
            position: vec3.describe('Camera position in metres'),
            target: vec3.describe('Point the camera looks at, in metres'),
            lens_mm: lensSchema.describe('Lens focal length in mm'),
          })
          .optional()
          .describe("Place the camera at this view (such as the viewport's) instead of solving it"),
        index: z
          .number()
          .int()
          .min(0)
          .max(MAX_SHOTS)
          .optional()
          .describe('Position in the cut, 0 = first (default: last)'),
      }),
      execute: notImplemented('desk.shot_add'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_update',
      label: 'Update Shot',
      description:
        'Change a shot: only the fields passed change (null clears framing, angle, height, move, lens_mm or the ' +
        'camera). The camera is solved again when `resolve` is true (default: when framing, angle, height, move, ' +
        'lens_mm, subjects or layout change). Returns the shot.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        shot: shotRef,
        name: z.string().min(1).max(MAX_SHOT_NAME).optional().describe('New name'),
        enabled: z
          .boolean()
          .optional()
          .describe('Disabled shots stay in the list but are left out of the cut'),
        camera: z.string().nullable().optional().describe('CAMERA object id or exact name, or null for none'),
        frame_start: frameStartSchema.optional(),
        frame_end: frameEndSchema.optional(),
        duration_s: durationSchema.optional(),
        framing: framingEnum.nullable().optional(),
        angle: angleEnum.nullable().optional(),
        height: heightEnum.nullable().optional(),
        move: moveEnum.nullable().optional(),
        lens_mm: lensSchema.nullable().optional(),
        subjects: subjectsSchema.optional(),
        layout: layoutSchema.optional(),
        notes: notesSchema.optional(),
        continuity: continuitySchema.optional(),
        pre_roll: preRollSchema.optional(),
        resolve: z
          .boolean()
          .optional()
          .describe(
            "true: solve the camera again from the shot's new spec; false: keep it where it is (default: solve " +
              'again when framing, angle, height, move, lens_mm, subjects or layout change)',
          ),
      }),
      execute: notImplemented('desk.shot_update'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_remove',
      label: 'Remove Shots',
      description:
        'Remove shots from the cut; with delete_cameras their cameras too (a camera another shot uses stays). ' +
        'Returns the removed shots.',
      category: 'Desk',
      poll: pollObjectMode,
      schema: z.object({
        shots: z.array(shotRef).min(1).describe('Shot ids or exact names'),
        delete_cameras: z.boolean().default(false).describe("Also delete the shots' cameras"),
      }),
      execute: notImplemented('desk.shot_remove'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_move',
      label: 'Move Shot',
      description:
        'Move a shot to another place in the cut (the cut order is the list order). Returns the new order.',
      category: 'Desk',
      poll: pollObjectMode,
      schema: z.object({
        shot: shotRef,
        index: z.number().int().min(0).max(MAX_SHOTS).describe('New position, 0 = first'),
      }),
      execute: notImplemented('desk.shot_move'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.shot_solve',
      label: 'Solve Shot Cameras',
      description:
        "Solve the cameras of shots from their framing, angle, height, subjects and lens (rideo's solver), fit them " +
        "to each shot's planned layout, key each shot's move, and keep the cameras on one side of the 180° line " +
        '(the plan wins over the line). Returns the solved shots and the issues found.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        shots: shotRefs.optional(),
        enforce_line: z
          .boolean()
          .default(true)
          .describe('Mirror cameras that crossed the line of action of the main pair (orbits exempt)'),
        fit_plan: z
          .boolean()
          .default(true)
          .describe("Fit each camera to the shot's planned layout when it has one"),
        keep_lens: z
          .boolean()
          .default(false)
          .describe("Keep each camera's current lens instead of the framing's"),
        only_missing: z.boolean().default(false).describe('Solve only shots that have no camera yet'),
      }),
      execute: notImplemented('desk.shot_solve'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.check',
      label: 'Check Shots',
      description:
        'Continuity checks of the shots (read-only): line_crossed, subject_out_of_frame, camera_inside, ' +
        'missing_camera (errors); plan_mismatch, screen_direction, jump_cut, absent_in_frame, actors_overlap, ' +
        'outside_set, empty_shot, duration_clamped (warnings); physics_unbaked, shot_gap (info). Returns {issues, ' +
        "lines: [{shot, line}] (rideo's blocking sentence), layouts: [{shot, layout}], summary}.",
      category: 'Desk',
      undo: false,
      schema: z.object({ shots: shotRefs.optional() }),
      execute: notImplemented('desk.check'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.set_build',
      label: 'Build Set',
      description:
        "Build the set (rideo's set): a ground plane of width × depth coloured from the ground's name, a SKY world " +
        'with the sun at the given azimuth and elevation (one key light), and walls when interior. Rebuilding ' +
        'replaces the set it built before. Returns {ground, walls}.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        width: z
          .number()
          .min(1)
          .max(10_000)
          .default(12)
          .describe('Set width in metres along X (rideo default 12)'),
        depth: z
          .number()
          .min(1)
          .max(10_000)
          .default(10)
          .describe('Set depth in metres along Y (rideo default 10)'),
        ground: z
          .string()
          .max(80)
          .default('grass')
          .describe(
            "What the ground is (grass, sand, road, wooden floor …): names its colour, as rideo's set.ground",
          ),
        interior: z.boolean().default(false).describe('Add 3.2 m walls around the set'),
        sun_azimuth_deg: z
          .number()
          .min(-3600)
          .max(3600)
          .default(135)
          .describe(
            'Direction toward the sun in degrees about +Z: 0 = in front of the set (−Y), 90 = to its right (+X), ' +
              '180 = behind it (rideo azimuthDeg; default 135)',
          ),
        sun_elevation_deg: z
          .number()
          .min(2)
          .max(90)
          .default(40)
          .describe('Sun height above the horizon in degrees (rideo elevationDeg; default 40)'),
        sky: z.boolean().default(true).describe('Use a SKY world lit by the sun'),
      }),
      execute: notImplemented('desk.set_build'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.camera_move',
      label: 'Camera Move',
      description:
        "Key a camera move over a shot's range (or frame_start…frame_end): push/pull/dolly/crane eased, orbits along " +
        'their arc, pans and tilts by rotation, whip_pan a fast 90° turn mid-shot, handheld a NOISE modifier, ' +
        'dolly_zoom the lens against the distance, rack_focus the focus distance, tracking_follow and ' +
        'steadicam_walk following the first subject. Give `camera` or `shot`. Returns the keyed range.',
      category: 'Desk',
      poll: pollObjectMode,
      redoable: true,
      schema: z.object({
        camera: z.string().optional().describe("CAMERA object id or exact name (default: the shot's camera)"),
        shot: shotRef.optional().describe('Shot whose camera and range the move uses'),
        move: moveEnum,
        frame_start: z
          .number()
          .int()
          .optional()
          .describe("First frame of the move (default: the shot's frame_start)"),
        frame_end: z
          .number()
          .int()
          .optional()
          .describe("Last frame of the move (default: the shot's frame_end)"),
        amount: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Strength of the move: 1 = the move library's distance or angle (default 1)"),
      }),
      execute: notImplemented('desk.camera_move'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.import_rideo_blocking',
      label: 'Import rideo Blocking',
      description:
        "Build the scene from a rideo clip's blocking (phase 2; spec §11): the frame rate and resolution from the " +
        'project settings; shots in rideo order, each round(duration_s × fps) frames, a pre-roll gap before cuts ' +
        'where marks jump; actors keyed at each shot start from their marks (walks to toX/toZ); cameras imported as ' +
        'they are (only shots without one are solved; the line is never enforced on import) and fitted to the ' +
        'planned layout; props as store models (kites and balloons on tethers), landmarks as primitives. Updates a ' +
        'scene imported from the same clip in place. Returns the actors, shots and the issues found.',
      category: 'Desk',
      poll: pollObjectMode,
      schema: z.object({
        blocking: z
          .record(z.string(), z.unknown())
          .describe(
            "rideo SceneBlocking v1 (the blocking route's draft, else its blocking): set, actors, props, shots " +
              '(validated by the importer)',
          ),
        shots: z
          .array(
            z.object({
              id: z.string().describe('rideo shot id'),
              index: z.number().int().min(0).describe('Order in the clip (rideo index)'),
              duration_s: durationSchema.describe('Length in seconds (rideo durationSec)'),
              name: z
                .string()
                .max(MAX_SHOT_NAME)
                .optional()
                .describe('Shot name (default "Shot <index + 1>")'),
              framing: framingEnum.nullable().optional(),
              angle: angleEnum.nullable().optional(),
              height: heightEnum.nullable().optional(),
              move: moveEnum
                .nullable()
                .optional()
                .describe('rideo camera.move (the 20 move ids are the same)'),
              movement: z
                .string()
                .max(40)
                .nullable()
                .optional()
                .describe(
                  'rideo camera.movement, used when move is absent: static, dolly_in, dolly_out, tracking, ' +
                    'handheld, crane, orbit, pan, tilt or zoom',
                ),
              lens_mm: lensSchema.nullable().optional(),
              character_ids: z
                .array(z.string().describe('rideo character id'))
                .max(MAX_SHOT_SUBJECTS)
                .default([])
                .describe("The shot's cast (rideo characterIds)"),
              element_ids: z
                .array(z.string().describe('rideo element id'))
                .max(64)
                .default([])
                .describe("The shot's props and landmarks (rideo elementIds)"),
              layout: z
                .array(
                  z.object({
                    character_id: z.string().describe('rideo character id'),
                    side: z.enum(DESK_SIDES).describe('Planned third of the frame'),
                    facing: z.enum(DESK_FACINGS).describe('Planned facing on screen'),
                  }),
                )
                .max(MAX_SHOT_LAYOUT)
                .default([])
                .describe('Planned screen layout (rideo shot.layout)'),
              continuity: continuitySchema.default('cut'),
              notes: notesSchema.optional().describe("The shot's description and action (kept as notes)"),
              board_state: z
                .string()
                .max(40)
                .nullable()
                .optional()
                .describe("State of the shot's first-frame board in rideo, to warn when it must be redrawn"),
            }),
          )
          .max(MAX_SHOTS)
          .describe("The clip's shots (rideo clip document)"),
        characters: z
          .array(
            z.object({
              id: z.string().describe('rideo character id'),
              name: z.string().max(200).describe('Name'),
              summary: z.string().max(4000).optional().describe('Summary (used to tell people from animals)'),
              identity: z.string().max(4000).optional().describe('Identity text (height, species …)'),
              height_m: z.number().min(0.1).max(10).optional().describe('Standing height in metres'),
            }),
          )
          .default([])
          .describe('The cast (rideo character documents)'),
        elements: z
          .array(
            z.object({
              id: z.string().describe('rideo element id'),
              name: z.string().max(200).describe('Name'),
              label: z.string().max(80).optional().describe('Short label (chooses the store model)'),
              summary: z.string().max(4000).optional().describe('Summary'),
            }),
          )
          .default([])
          .describe('Props and landmarks (rideo element documents)'),
        settings: z
          .object({
            fps: z.number().int().min(1).max(240).describe('Frame rate'),
            width: z.number().int().min(16).max(16_384).describe('Width in pixels'),
            height: z.number().int().min(16).max(16_384).describe('Height in pixels'),
          })
          .optional()
          .describe("rideo project settings (default: the scene's own)"),
        cast_overrides: z
          .record(z.string(), z.enum(ACTOR_KINDS))
          .optional()
          .describe(
            'Actor kind by rideo character id (default: humanoid, quadrupeds for mounts and pets by name)',
          ),
        project: z
          .string()
          .max(200)
          .optional()
          .describe('rideo project id (kept on the shots for round trips)'),
        clip: z.string().max(200).optional().describe('rideo clip id (kept on the shots for round trips)'),
        pre_roll_frames: z
          .number()
          .int()
          .min(0)
          .max(MAX_PRE_ROLL)
          .default(12)
          .describe('Frames of the gap before a cut where marks jump (animated, never exported)'),
        update: z
          .boolean()
          .default(true)
          .describe(
            'Update a scene imported from this clip before in place (actors by character id, shots by rideo shot ' +
              'id), keeping what was added since; false: add everything anew',
          ),
      }),
      execute: notImplemented('desk.import_rideo_blocking'),
    }),
  );

  reg.register(
    defineOperator({
      id: 'desk.export_rideo_blocking',
      label: 'Export rideo Blocking',
      description:
        "The scene as a rideo SceneBlocking v1 (phase 2, read-only): opening marks at the first shot's start, " +
        'per-shot marks and walk targets, cameras and their end placement, landmark and prop footprints, riders on ' +
        "their mount's mark. Returns {blocking}.",
      category: 'Desk',
      undo: false,
      schema: z.object({}),
      execute: notImplemented('desk.export_rideo_blocking'),
    }),
  );
}
