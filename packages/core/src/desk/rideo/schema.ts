import { z } from 'zod';
import { DESK_MOVES, type DeskMove } from '../../doc/types';
import { ACTOR_KINDS } from '../characters/types';

/*
 * rideo's SceneBlocking v1 (rideo packages/shared/src/schemas/blocking.ts, zod 4) mirrored field for
 * field, with the defaults and ranges rideo validates with, so that what the desk exports is what
 * rideo's `PUT …/clips/:clipId/blocking` accepts and what rideo stores parses here. rideo's
 * coordinates: metres, y up, the floor at y = 0, x to the right, z towards the audience; a facing of
 * 0° looks at the audience (+z), 90° to the right (+x). The editor's axes are rideo (x, −z, y).
 *
 * Then the shared rules the import and export follow (markFor, POSE_HEIGHT, the cast palette,
 * landmark colours) and the input of the import: the clip's shots, the cast, the elements, the
 * project settings and the video model's duration limits, in rideo's own field names.
 */

// ---------------------------------------------------------------- ids (rideo packages/shared/src/ids.ts)

/** rideo ids: a 3-letter prefix, '_', 10–32 lower-case base32 characters ('chr_…', 'sht_…', 'ele_…'). */
export const RIDEO_ID_PATTERN = /^[a-z]{3}_[0-9a-z]{10,32}$/;
export const RideoIdSchema = z.string().regex(RIDEO_ID_PATTERN, 'invalid id');
export const RideoIsoDateSchema = z.string().min(10);

/** Whether `v` is a rideo id. */
export const isRideoId = (v: unknown): v is string => typeof v === 'string' && RIDEO_ID_PATTERN.test(v);

// ---------------------------------------------------------------- SceneBlocking v1

export const RIDEO_BLOCKING_POSES = [
  'stand',
  'walk',
  'run',
  'sit',
  'crouch',
  'kneel',
  'lie',
  'reach',
  'point',
  'wave',
] as const;
export const RideoBlockingPoseSchema = z.enum(RIDEO_BLOCKING_POSES);
export type RideoBlockingPose = z.infer<typeof RideoBlockingPoseSchema>;

export const RIDEO_CAMERA_ANGLES = [
  'front',
  'three_quarter_left',
  'three_quarter_right',
  'profile_left',
  'profile_right',
  'back',
  'over_shoulder',
  'pov',
] as const;
export const RideoCameraAngleSchema = z.enum(RIDEO_CAMERA_ANGLES);
export type RideoCameraAngle = z.infer<typeof RideoCameraAngleSchema>;

export const RIDEO_CAMERA_HEIGHTS = ['eye', 'low', 'high', 'overhead'] as const;
export const RideoCameraHeightSchema = z.enum(RIDEO_CAMERA_HEIGHTS);
export type RideoCameraHeight = z.infer<typeof RideoCameraHeightSchema>;

/** The moves a blocked camera's spec names (the desk's move library has 20: DESK_MOVES). */
export const RIDEO_BLOCKING_MOVES = [
  'none',
  'push_in',
  'pull_out',
  'dolly_left',
  'dolly_right',
  'orbit_left',
  'orbit_right',
  'crane_up',
] as const;
export const RideoBlockingMoveSchema = z.enum(RIDEO_BLOCKING_MOVES);
export type RideoBlockingMove = z.infer<typeof RideoBlockingMoveSchema>;

export const RIDEO_LANDMARK_SHAPES = ['box', 'cylinder', 'water', 'wall'] as const;
export const RideoLandmarkShapeSchema = z.enum(RIDEO_LANDMARK_SHAPES);
export type RideoLandmarkShape = z.infer<typeof RideoLandmarkShapeSchema>;

const Coord = z.number().min(-500).max(500);
const Height = z.number().min(-10).max(200);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb colour');

/** How a camera was described: the solver places it from this and the shot's framing and lens. */
export const RideoCameraSpecSchema = z.object({
  /** Character ids it frames (the shot's cast when empty). */
  subjects: z.array(RideoIdSchema).max(8).default([]),
  angle: RideoCameraAngleSchema.default('front'),
  height: RideoCameraHeightSchema.default('eye'),
  move: RideoBlockingMoveSchema.default('none'),
});
export type RideoCameraSpec = z.infer<typeof RideoCameraSpecSchema>;

export const RideoCameraPlacementSchema = z.object({
  x: Coord,
  y: Height,
  z: Coord,
  targetX: Coord,
  targetY: Height,
  targetZ: Coord,
});
export type RideoCameraPlacement = z.infer<typeof RideoCameraPlacementSchema>;

export const RideoBlockingCameraSchema = RideoCameraPlacementSchema.extend({
  lensMm: z.number().min(8).max(800),
  /** Where a camera move ends (null: the camera holds). */
  end: RideoCameraPlacementSchema.nullable().default(null),
});
export type RideoBlockingCamera = z.infer<typeof RideoBlockingCameraSchema>;

export const RideoBlockingMarkSchema = z.object({
  x: Coord,
  z: Coord,
  facingDeg: z.number().min(-3600).max(3600).default(0),
  pose: RideoBlockingPoseSchema.default('stand'),
  /** Where the character walks to during the shot. */
  toX: Coord.nullable().default(null),
  toZ: Coord.nullable().default(null),
});
export type RideoBlockingMark = z.infer<typeof RideoBlockingMarkSchema>;

export const RideoBlockingShotSchema = z.object({
  /** Marks of the characters of this shot (by character id); the others keep their opening marks. */
  marks: z.record(z.string(), RideoBlockingMarkSchema).default({}),
  camera: RideoBlockingCameraSchema,
  spec: RideoCameraSpecSchema.nullable().default(null),
});
export type RideoBlockingShot = z.infer<typeof RideoBlockingShotSchema>;

export const RideoBlockingLandmarkSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(80).default(''),
  shape: RideoLandmarkShapeSchema.default('box'),
  x: Coord,
  z: Coord,
  width: z.number().min(0.05).max(500),
  depth: z.number().min(0.05).max(500),
  height: z.number().min(0.01).max(200),
  rotationDeg: z.number().min(-3600).max(3600).default(0),
  color: Color.default('#8a8f98'),
  elementId: RideoIdSchema.nullable().default(null),
});
export type RideoBlockingLandmark = z.infer<typeof RideoBlockingLandmarkSchema>;

export const RideoBlockingActorSchema = z.object({
  id: z.string().min(1).max(40),
  characterId: RideoIdSchema,
  color: Color,
  heightM: z.number().min(0.3).max(4).default(1.7),
  x: Coord,
  z: Coord,
  facingDeg: z.number().min(-3600).max(3600).default(0),
  pose: RideoBlockingPoseSchema.default('stand'),
});
export type RideoBlockingActor = z.infer<typeof RideoBlockingActorSchema>;

export const RideoBlockingPropSchema = z.object({
  id: z.string().min(1).max(40),
  elementId: RideoIdSchema.nullable().default(null),
  label: z.string().max(80).default(''),
  x: Coord,
  z: Coord,
  size: z.number().min(0.05).max(20).default(0.4),
  color: Color.default('#c9a227'),
  /** A character carrying it: it is drawn at their hand. */
  heldBy: RideoIdSchema.nullable().default(null),
});
export type RideoBlockingProp = z.infer<typeof RideoBlockingPropSchema>;

export const RideoBlockingSetSchema = z.object({
  width: z.number().min(2).max(200).default(12),
  depth: z.number().min(2).max(200).default(10),
  ground: z.string().max(80).default('ground'),
  interior: z.boolean().default(false),
  /** Where the key light comes from: 0° the front, 90° the right, 180° the back; and how high. */
  sun: z
    .object({
      azimuthDeg: z.number().min(-3600).max(3600).default(135),
      elevationDeg: z.number().min(2).max(90).default(40),
    })
    .default({ azimuthDeg: 135, elevationDeg: 40 }),
  landmarks: z.array(RideoBlockingLandmarkSchema).max(24).default([]),
});
export type RideoBlockingSet = z.infer<typeof RideoBlockingSetSchema>;

export const RideoSceneBlockingSchema = z.object({
  version: z.literal(1).default(1),
  /** Who placed it last: the AI (`scene.block`) or a person on the desk. */
  source: z.enum(['ai', 'user']).default('user'),
  updatedAt: RideoIsoDateSchema,
  set: RideoBlockingSetSchema.default({
    width: 12,
    depth: 10,
    ground: 'ground',
    interior: false,
    sun: { azimuthDeg: 135, elevationDeg: 40 },
    landmarks: [],
  }),
  actors: z.array(RideoBlockingActorSchema).max(8).default([]),
  props: z.array(RideoBlockingPropSchema).max(16).default([]),
  /** By shot id. */
  shots: z.record(z.string(), RideoBlockingShotSchema).default({}),
});
export type RideoSceneBlocking = z.infer<typeof RideoSceneBlockingSchema>;

/** rideo's limits on a blocking's lists. */
export const RIDEO_MAX_ACTORS = 8;
export const RIDEO_MAX_PROPS = 16;
export const RIDEO_MAX_LANDMARKS = 24;

// ---------------------------------------------------------------- shared rules (rideo blocking/index.ts)

/** How tall a figure is in each pose, as a share of its standing height (rideo's POSE_HEIGHT). */
export const RIDEO_POSE_HEIGHT: Readonly<Record<RideoBlockingPose, number>> = {
  stand: 1,
  walk: 1,
  run: 0.97,
  sit: 0.72,
  crouch: 0.62,
  kneel: 0.74,
  lie: 0.22,
  reach: 1,
  point: 1,
  wave: 1,
};

/** rideo's cast palette in cast order, with the names its prompts give the colours (BLOCKING_PALETTE). */
export const RIDEO_BLOCKING_PALETTE = [
  { color: '#ff8a3d', name: 'orange' },
  { color: '#3d8bff', name: 'blue' },
  { color: '#3dbe6b', name: 'green' },
  { color: '#a35bff', name: 'purple' },
  { color: '#f2c230', name: 'yellow' },
  { color: '#ff5fa2', name: 'pink' },
  { color: '#2ec4c4', name: 'teal' },
  { color: '#e5484d', name: 'red' },
] as const;

/** Colours of rideo's AI landmarks by what their label names, the first match winning (landmarkColor). */
const LANDMARK_COLORS: readonly (readonly [RegExp, string])[] = [
  [/water|sea|lake|pond|river|pool|stream/, '#3f7fc0'],
  [/hay|straw|bale/, '#d8b54a'],
  [/barn/, '#b5413a'],
  [/fence|gate|rail|picket|post/, '#eceae4'],
  [/tree|bush|hedge|forest|shrub/, '#4f7a3a'],
  [/hill|grass|lawn|meadow|field|paddock|pasture/, '#7fae5a'],
  [/lane|path|road|track|gravel|trail|drive/, '#cdb58c'],
  [/sand|beach|dune/, '#d9c49a'],
  [/rock|stone|boulder|cliff|wall/, '#8d9096'],
  [/house|stable|shed|cottage|lodge|building|cabin|hut/, '#d8cbb0'],
];

/** A landmark's colour from its label, else from its shape (rideo's landmarkColor). */
export function rideoLandmarkColor(label: string, shape: RideoLandmarkShape): string {
  const l = label.toLowerCase();
  for (const [re, hex] of LANDMARK_COLORS) if (re.test(l)) return hex;
  return shape === 'water' ? '#3f7fc0' : shape === 'cylinder' ? '#5e7f4a' : '#8a8f98';
}

/** A character's mark in a shot: its own, else the scene's opening mark (rideo's markFor); null when not cast. */
export function rideoMarkFor(
  blocking: Pick<RideoSceneBlocking, 'shots' | 'actors'>,
  shotId: string,
  characterId: string,
): RideoBlockingMark | null {
  const own = blocking.shots[shotId]?.marks[characterId];
  if (own) return own;
  const actor = blocking.actors.find((a) => a.characterId === characterId);
  return actor
    ? { x: actor.x, z: actor.z, facingDeg: actor.facingDeg, pose: actor.pose, toX: null, toZ: null }
    : null;
}

// ---------------------------------------------------------------- the clip, the cast, the settings

/** rideo's shot framings (clip.ts CameraSchema.framing; the desk's DeskFraming). */
export const RIDEO_FRAMINGS = [
  'extreme_wide',
  'wide',
  'medium',
  'medium_close',
  'close_up',
  'extreme_close_up',
  'over_shoulder',
  'pov',
  'insert',
] as const;

/** rideo's shot movements (clip.ts CameraSchema.movement), the plan's words when a shot has no move. */
export const RIDEO_MOVEMENTS = [
  'static',
  'pan',
  'tilt',
  'dolly_in',
  'dolly_out',
  'tracking',
  'handheld',
  'crane',
  'zoom',
  'orbit',
] as const;
export type RideoMovement = (typeof RIDEO_MOVEMENTS)[number];

/** rideo's camera move library ids (directing/index.ts CAMERA_MOVES): the desk's DeskMove, one for one. */
export const RIDEO_CAMERA_MOVE_IDS: readonly DeskMove[] = DESK_MOVES;

/** Where the shot planner puts a character in the frame (clip.ts PlannedPlacement). */
export const RideoPlannedPlacementSchema = z.object({
  characterId: RideoIdSchema,
  side: z.enum(['left', 'centre', 'right']),
  facing: z.enum(['left', 'right', 'camera', 'away']),
});
export type RideoPlannedPlacement = z.infer<typeof RideoPlannedPlacementSchema>;

/** What the import needs of a shot of the clip (rideo clip.ts ShotSchema). */
export const RideoShotInputSchema = z.object({
  id: z.string().min(1).max(200),
  index: z.number().int().min(0),
  durationSec: z.number().positive().max(3600),
  /** The desk's shot name (default "Shot <index + 1>"). */
  name: z.string().max(64).optional(),
  /** The shot's description and action (the desk keeps them as notes; mounts are read from them). */
  description: z.string().max(4000).default(''),
  action: z.string().max(4000).default(''),
  camera: z
    .object({
      framing: z.enum(RIDEO_FRAMINGS).default('medium'),
      movement: z.enum(RIDEO_MOVEMENTS).default('static'),
      lensMm: z.number().min(8).max(800).nullish(),
      move: z.enum(DESK_MOVES).nullish(),
    })
    .default({ framing: 'medium', movement: 'static' }),
  /** How the blocking spec of the shot describes its camera (angle, height), when the clip has none. */
  angle: RideoCameraAngleSchema.nullish(),
  height: RideoCameraHeightSchema.nullish(),
  characterIds: z.array(z.string().min(1).max(200)).max(16).default([]),
  elementIds: z.array(z.string().min(1).max(200)).max(64).default([]),
  layout: z.array(RideoPlannedPlacementSchema).max(16).default([]),
  continuity: z.enum(['cut', 'continuous']).default('cut'),
  /** The state of the shot's first-frame board in rideo (null: none drawn). */
  boardState: z.string().max(40).nullish(),
});
export type RideoShotInput = z.infer<typeof RideoShotInputSchema>;

/** What the import needs of a character (rideo character.ts; identity flattened or as rideo's fields). */
export const RideoCharacterInputSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  summary: z.string().max(4000).default(''),
  identity: z.union([z.string().max(4000), z.record(z.string(), z.string().max(4000).nullish())]).optional(),
  /** Standing height in metres (else the blocking's heightM, else the kind's). */
  heightM: z.number().min(0.1).max(10).nullish(),
  /** The actor kind (overrides the one inferred from the name, summary and identity). */
  kind: z.enum(ACTOR_KINDS).nullish(),
});
export type RideoCharacterInput = z.infer<typeof RideoCharacterInputSchema>;

/** What the import needs of an element (rideo element.ts): its name chooses a prop's or landmark's model. */
export const RideoElementInputSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().max(200),
  kind: z.enum(['location', 'prop', 'style']).nullish(),
  label: z.string().max(80).nullish(),
  description: z.string().max(4000).default(''),
});
export type RideoElementInput = z.infer<typeof RideoElementInputSchema>;

/** rideo's project settings the import applies (project.ts ProjectSettingsSchema). */
export const RideoSettingsInputSchema = z.object({
  fps: z.number().int().min(1).max(240),
  width: z.number().int().min(16).max(16_384),
  height: z.number().int().min(16).max(16_384),
  aspectRatio: z.string().max(10).nullish(),
});
export type RideoSettingsInput = z.infer<typeof RideoSettingsInputSchema>;

/** The video model's duration limits (gateway ModelLimits min/max_duration_seconds). */
export const RideoModelLimitsSchema = z.object({
  minSeconds: z.number().positive().max(3600).nullish(),
  maxSeconds: z.number().positive().max(3600).nullish(),
});
export type RideoModelLimits = z.infer<typeof RideoModelLimitsSchema>;

/** rideo's blocking states (blockingState): no blocking, one that misses shots or characters, complete. */
export const RIDEO_BLOCKING_STATES = ['missing', 'incomplete', 'ready'] as const;
export type RideoBlockingState = (typeof RIDEO_BLOCKING_STATES)[number];

/** Everything an import reads: the blocking (the route's draft) and the clip around it. */
export const RideoImportInputSchema = z.object({
  blocking: z.unknown(),
  state: z.enum(RIDEO_BLOCKING_STATES).nullish(),
  shots: z.array(RideoShotInputSchema).max(512),
  characters: z.array(RideoCharacterInputSchema).max(64).default([]),
  elements: z.array(RideoElementInputSchema).max(256).default([]),
  settings: RideoSettingsInputSchema.nullish(),
  modelLimits: RideoModelLimitsSchema.nullish(),
  /** Actor kinds by character id (win over everything else). */
  castOverrides: z.record(z.string(), z.enum(ACTOR_KINDS)).default({}),
  project: z.string().max(200).nullish(),
  clip: z.string().max(200).nullish(),
  /** Frames of the gap before a cut where marks jump (animated and simulated, never exported). */
  preRollFrames: z.number().int().min(0).max(1000).default(12),
  /** Update a scene imported from the same clip in place (false: add everything anew). */
  update: z.boolean().default(true),
});
export type RideoImportInput = z.infer<typeof RideoImportInputSchema>;
