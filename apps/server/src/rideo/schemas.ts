import { z } from 'zod';

/*
 * What the rideo bridge reads from and sends to a rideo server (SPEC §11), checked with zod at the
 * boundary. Only the fields the bridge uses are declared; every object keeps the fields it does not
 * know (rideo's documents carry many more), so a newer rideo with extra fields still validates.
 * Defaults are rideo's own (packages/shared/src/schemas: project.ts, clip.ts, blocking.ts,
 * character.ts, element.ts, resource.ts), so an older document without a newer field reads as rideo
 * reads it.
 */

/** rideo ids: `<3-letter prefix>_<10–32 base32 chars>` (packages/shared/src/ids.ts ID_PATTERN). */
export const RIDEO_ID_PATTERN = /^[a-z]{3}_[0-9a-z]{10,32}$/;
/** rideo project ids (routes.ts IdParam). */
export const RIDEO_PROJECT_ID_PATTERN = /^prj_[0-9a-z]{10,32}$/;

export const rideoIdSchema = z.string().regex(RIDEO_ID_PATTERN, 'a rideo id like clp_0123456789');
export const rideoProjectIdSchema = z
  .string()
  .regex(RIDEO_PROJECT_ID_PATTERN, 'a rideo project id like prj_0123456789');

/** The reference modes rideo knows (clip.ts MotionReferenceSchema); the bridge sends the first three. */
export const RIDEO_REFERENCE_MODES = ['motion', 'pose', 'camera', 'performance'] as const;

/** RFC 9457 problem details of a failed rideo request (errors.ts problemDetails). */
export const problemSchema = z.looseObject({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().optional(),
  detail: z.string().optional(),
  code: z.string().optional(),
  errors: z.array(z.unknown()).optional(),
});
export type RideoProblem = z.infer<typeof problemSchema>;

/** `settings.blocking` (blocking.ts BlockingSettingsSchema): off in the schema, on for new projects. */
const blockingSettingsSchema = z
  .looseObject({
    enabled: z.boolean().default(false),
    layoutImage: z.boolean().default(true),
  })
  .prefault({});

/** project.json (project.ts ProjectSchema): what the bridge reads of it. */
export const rideoProjectSchema = z.looseObject({
  id: z.string(),
  title: z.string().default(''),
  kind: z.string().optional(),
  settings: z
    .looseObject({
      aspectRatio: z.string().default('16:9'),
      resolution: z
        .looseObject({
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .prefault({ width: 1280, height: 720 }),
      fps: z.number().positive().default(24),
      blocking: blockingSettingsSchema,
      /** The models the project generates with ('auto': the gateway's first of the modality). */
      models: z.looseObject({ video: z.string().default('auto') }).prefault({}),
    })
    .prefault({}),
});
export type RideoProject = z.infer<typeof rideoProjectSchema>;

/** A video model's limits (gateway.ts ModelLimitsSchema): what its takes may last. */
const modelLimitsSchema = z.looseObject({
  min_duration_seconds: z.number().optional(),
  max_duration_seconds: z.number().optional(),
});

/**
 * GET /api/config (http/app.ts): what the bridge reads of it, the gateway's video models with their
 * limits (ModelLimitsEntrySchema); empty when rideo has no gateway.
 */
export const rideoConfigSchema = z.looseObject({
  models: z
    .looseObject({
      video: z
        .array(z.looseObject({ id: z.string(), limits: modelLimitsSchema.nullish() }))
        .catch([])
        .default([]),
    })
    .prefault({}),
});
export type RideoConfig = z.infer<typeof rideoConfigSchema>;

/** A shot's planned screen position of a character (clip.ts PlannedPlacementSchema). */
export const plannedPlacementSchema = z.looseObject({
  characterId: z.string(),
  side: z.enum(['left', 'centre', 'right']),
  facing: z.enum(['left', 'right', 'camera', 'away']),
});

export const motionReferenceSchema = z.looseObject({
  resourceId: z.string(),
  mode: z.string().default('motion'),
});
export type RideoMotionReference = z.infer<typeof motionReferenceSchema>;

/** The approved or drawn first frame of a shot (clip.ts ShotBoardSchema): what the bridge reads of it. */
const shotBoardSchema = z.looseObject({
  createdAt: z.string().optional(),
  promptHash: z.string().optional(),
  approved: z.boolean().default(false),
  approvedAt: z.string().nullable().optional(),
});

/** A shot of a clip document (clip.ts ShotSchema). */
export const rideoShotSchema = z.looseObject({
  id: z.string(),
  index: z.number().int().nonnegative(),
  description: z.string().default(''),
  action: z.string().default(''),
  camera: z
    .looseObject({
      framing: z.string().default('medium'),
      movement: z.string().default('static'),
      lensMm: z.number().nullish(),
      move: z.string().nullish(),
    })
    .prefault({}),
  characterIds: z.array(z.string()).default([]),
  elementIds: z.array(z.string()).default([]),
  durationSec: z.number().positive(),
  continuity: z.enum(['cut', 'continuous']).default('cut'),
  layout: z.array(plannedPlacementSchema).default([]),
  startFrame: z
    .looseObject({ mode: z.string().default('auto'), resourceId: z.string().nullable().default(null) })
    .prefault({}),
  motionReference: motionReferenceSchema.nullable().default(null),
  board: shotBoardSchema.nullable().default(null),
  status: z.string().optional(),
});
export type RideoShot = z.infer<typeof rideoShotSchema>;

/** clips/<id>.json (clip.ts ClipSchema): the scene's shots, status and stored blocking. */
export const rideoClipSchema = z.looseObject({
  id: z.string(),
  index: z.number().int().nonnegative().default(0),
  title: z.string().default(''),
  status: z.string().default('planned'),
  shots: z.array(rideoShotSchema).default([]),
  blocking: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type RideoClip = z.infer<typeof rideoClipSchema>;

/** A blocking actor of a draft (blocking.ts BlockingActorSchema): its character and height. */
const blockingActorSchema = z.looseObject({
  id: z.string().optional(),
  characterId: z.string(),
  heightM: z.number().positive().default(1.7),
});

/** A SceneBlocking v1 as the bridge reads it (blocking.ts SceneBlockingSchema); passed on whole. */
export const sceneBlockingSchema = z.looseObject({
  version: z.number().optional(),
  actors: z.array(blockingActorSchema).default([]),
  props: z.array(z.looseObject({ elementId: z.string().nullable().optional() })).default([]),
  set: z
    .looseObject({
      landmarks: z.array(z.looseObject({ elementId: z.string().nullable().optional() })).default([]),
    })
    .prefault({}),
  shots: z.record(z.string(), z.unknown()).default({}),
});
export type RideoSceneBlocking = z.infer<typeof sceneBlockingSchema>;

/** One issue rideo finds in a blocking (blocking.ts BlockingIssueSchema). */
export const blockingIssueSchema = z.looseObject({
  code: z.string(),
  severity: z.string(),
  shotId: z.string().nullable().default(null),
  characterId: z.string().nullable().default(null),
  message: z.string(),
});

/**
 * GET / PUT /clips/:clipId/blocking (blocking/view.ts BlockingView): the stored blocking, its state,
 * the completed draft the desk edits, its issues and each shot's blocking line.
 */
export const blockingViewSchema = z.looseObject({
  blocking: z.record(z.string(), z.unknown()).nullable(),
  state: z.enum(['missing', 'incomplete', 'ready']),
  draft: sceneBlockingSchema,
  issues: z.array(blockingIssueSchema).default([]),
  lines: z.record(z.string(), z.string().nullable()).default({}),
});
export type RideoBlockingView = z.infer<typeof blockingViewSchema>;

/** characters/<id>.json (character.ts CharacterSchema): name, summary and identity text. */
export const rideoCharacterSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  role: z.string().optional(),
  summary: z.string().default(''),
  identity: z.record(z.string(), z.unknown()).default({}),
});
export type RideoCharacter = z.infer<typeof rideoCharacterSchema>;

/** elements/<id>.json (element.ts ElementSchema): a location, prop or style. */
export const rideoElementSchema = z.looseObject({
  id: z.string(),
  kind: z.string().default('prop'),
  name: z.string(),
  description: z.string().default(''),
  aliases: z.array(z.string()).default([]),
});
export type RideoElement = z.infer<typeof rideoElementSchema>;

/** What rideo stores of an uploaded file (resource.ts ResourceSchema, common.ts MediaRefSchema). */
export const rideoResourceSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  role: z.string(),
  name: z.string(),
  status: z.string().default('ready'),
  media: z.looseObject({
    path: z.string(),
    hash: z.string().optional(),
    mime: z.string(),
    size: z.number().optional(),
  }),
});
export type RideoResource = z.infer<typeof rideoResourceSchema>;

/**
 * The probe of an uploaded video (common.ts ProbeSchema): with it rideo makes the resource ready at
 * once instead of waiting for a studio tab to probe it (domain/story.ts addResource).
 */
export const probeSchema = z.object({
  formatName: z.string().max(200),
  durationSec: z.number().nonnegative(),
  hasVideo: z.boolean(),
  hasAudio: z.boolean(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().max(1000).optional(),
  videoCodec: z.string().max(50).optional(),
});
export type RideoProbe = z.infer<typeof probeSchema>;
