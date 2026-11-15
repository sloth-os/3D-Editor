import { z } from 'zod';
import { MoveSchema, SceneBriefSchema, briefProblems, type SceneBrief } from '@3d-editor/core';

/*
 * The desk embed protocol, version 1 (docs/embedding.md: this repository owns the contract; it is
 * frozen): every message a host and the desk exchange, as zod schemas. The desk validates every
 * message it gets and every message it sends against them, and the tests check them against the
 * contract's fixtures (apps/web/test/fixtures/desk-protocol/).
 *
 * - hello and connect travel on window (desk → parent, parent → desk); everything else on the
 *   MessagePort the connect transfers.
 * - Port messages are plain objects with a `type`; a request that expects a reply carries an `id`
 *   (1–64 characters) and its reply the same `id`. Binary data is an ArrayBuffer, transferred.
 */

/** The protocol's name, in hello and connect. */
export const PROTOCOL = '3d-desk';
/** The protocol versions this desk speaks. */
export const PROTOCOL_VERSIONS = [1] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/** The format and version of the desk state this desk writes and reads. */
export const DESK_STATE_FORMAT = '3d-editor.desk-state';
export const DESK_STATE_VERSION = 1;
/** Bytes a desk state's data may have at most (64 MiB). */
export const MAX_STATE_BYTES = 64 * 1024 * 1024;

/** The contract's Id: 1–100 characters, a letter or digit first, then letters, digits and `_ . : -`. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
export const IdSchema = z.string().regex(ID_PATTERN, 'an id of 1–100 letters, digits and _ . : -');
/** A request's id: 1–64 characters, chosen by its sender. */
export const MessageIdSchema = z.string().min(1).max(64);

export const MODES = ['motion', 'pose', 'camera'] as const;
export type Mode = (typeof MODES)[number];
export const ModeSchema = z.enum(MODES);

/** The modes of a list, each once, in the order the list first names them. */
export const uniqueModes = (modes: readonly Mode[]): Mode[] => [...new Set(modes)];

export const ERROR_CODES = [
  'bad_message',
  'unsupported_version',
  'invalid_scene',
  'busy',
  'export_unavailable',
  'export_failed',
  'out_of_memory',
  'cancelled',
  'not_open',
  'state_unreadable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** An ArrayBuffer (not a view of one, not a SharedArrayBuffer). */
const ArrayBufferSchema = z.custom<ArrayBuffer>(
  (v) => v instanceof ArrayBuffer || Object.prototype.toString.call(v) === '[object ArrayBuffer]',
  'an ArrayBuffer',
);

// ---------------------------------------------------------------- window messages

export const HelloSchema = z.object({
  protocol: z.literal(PROTOCOL),
  type: z.literal('hello'),
  versions: z.array(z.number().int().positive()).min(1),
});
export type Hello = z.infer<typeof HelloSchema>;

export const ConnectSchema = z.object({
  protocol: z.literal(PROTOCOL),
  type: z.literal('connect'),
  version: z.number().int().positive(),
});
export type Connect = z.infer<typeof ConnectSchema>;

// ---------------------------------------------------------------- shared types

/** A desk state as the contract types it (what the desk sends). */
export const DeskStateSchema = z.object({
  format: z.literal(DESK_STATE_FORMAT),
  version: z.literal(DESK_STATE_VERSION),
  data: ArrayBufferSchema.refine((b) => b.byteLength <= MAX_STATE_BYTES, 'at most 64 MiB'),
});
export type DeskState = z.infer<typeof DeskStateSchema>;

/**
 * A desk state as a host gives it back in `open`: any format and version, and the data as an
 * ArrayBuffer or a view of one. One the desk does not read is not applied (state_unreadable), the
 * scene still opens: see readStateArgument.
 */
export const GivenStateSchema = z.object({
  format: z.string(),
  version: z.number(),
  data: z.union([ArrayBufferSchema, z.custom<ArrayBufferView>((v) => ArrayBuffer.isView(v))]),
});
export type GivenState = z.infer<typeof GivenStateSchema>;

/**
 * An open's options. The contract bounds no list: `modes` may repeat a mode (each counts once) and
 * may be empty (the default, ["camera"]); see controller.ts resolveOptions.
 */
export const OpenOptionsSchema = z.object({
  hostName: z.string().max(40).optional(),
  modes: z.array(ModeSchema).optional(),
  defaultMode: ModeSchema.optional(),
  readOnly: z.boolean().optional(),
});
export type OpenOptions = z.infer<typeof OpenOptionsSchema>;

/**
 * The brief's changes as `opened` carries them: the contract's lists and nothing else (the desk's own
 * notes of what else differs stay in its banner: controller.ts contractChanges), so the desk's check
 * of what it sends catches anything more.
 */
export const BriefChangesSchema = z.strictObject({
  added: z.array(IdSchema),
  removed: z.array(IdSchema),
  retimed: z.array(IdSchema),
  recast: z.array(IdSchema),
  cast: z.strictObject({ added: z.array(IdSchema), removed: z.array(IdSchema) }),
});
export type ProtocolBriefChanges = z.infer<typeof BriefChangesSchema>;

export const IssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
});

export const ShotResultSchema = z.object({
  shotId: IdSchema,
  frames: z.number().int().min(1),
  durationSec: z.number().positive(),
  references: z.partialRecord(ModeSchema, z.string().min(1)),
  still: z.string().min(1).nullable(),
  camera: z.object({ lensMm: z.number().int().min(8).max(800), move: MoveSchema.nullable() }),
  line: z.string(),
  moves: z.string().nullable(),
  planAgrees: z.boolean().nullable(),
  issues: z.array(IssueSchema),
});
export type ShotResult = z.infer<typeof ShotResultSchema>;

export const ResultFileSchema = z.object({
  name: z.string().min(1),
  mime: z.enum(['video/mp4', 'image/png']),
  data: ArrayBufferSchema,
});
export type ResultFile = z.infer<typeof ResultFileSchema>;

// ---------------------------------------------------------------- host → desk

/** `open` without its scene checked (the scene is checked on its own: invalid_scene). */
const OpenEnvelopeSchema = z.object({
  type: z.literal('open'),
  scene: z.unknown(),
  state: GivenStateSchema.nullable(),
  options: OpenOptionsSchema.optional(),
});

export const OpenSchema = OpenEnvelopeSchema.extend({ scene: SceneBriefSchema });
export type OpenMessage = Omit<z.infer<typeof OpenSchema>, 'scene'> & { scene: SceneBrief };

/**
 * An export. The contract bounds no list: an empty or missing `shots` names none (every shot of the
 * brief), an empty or missing `modes` asks for the open's; repeats count once.
 */
export const ExportSchema = z.object({
  type: z.literal('export'),
  id: MessageIdSchema,
  shots: z.array(IdSchema).optional(),
  modes: z.array(ModeSchema).optional(),
  still: z.boolean().optional(),
});
export type ExportMessage = z.infer<typeof ExportSchema>;

export const CancelSchema = z.object({ type: z.literal('cancel'), id: MessageIdSchema });
export type CancelMessage = z.infer<typeof CancelSchema>;

export const SaveSchema = z.object({ type: z.literal('save'), id: MessageIdSchema });
export type SaveMessage = z.infer<typeof SaveSchema>;

export const ResultAckSchema = z.object({
  type: z.literal('result-ack'),
  id: MessageIdSchema,
  ok: z.boolean(),
  message: z.string().optional(),
  shots: z.array(z.object({ shotId: IdSchema, ok: z.boolean(), error: z.string().optional() })).optional(),
});
export type ResultAckMessage = z.infer<typeof ResultAckSchema>;

/** The schema of each message type a host sends on the port. */
export const HOST_MESSAGE_SCHEMAS = {
  open: OpenSchema,
  export: ExportSchema,
  cancel: CancelSchema,
  save: SaveSchema,
  'result-ack': ResultAckSchema,
} as const;
export type HostMessageType = keyof typeof HOST_MESSAGE_SCHEMAS;
export type HostMessage = OpenMessage | ExportMessage | CancelMessage | SaveMessage | ResultAckMessage;

// ---------------------------------------------------------------- desk → host

export const ReadySchema = z.object({
  type: z.literal('ready'),
  deskVersion: z.string().min(1),
  protocol: z.literal(1),
  capabilities: z.object({
    export: z.object({
      available: z.boolean(),
      reason: z.string().nullable(),
      container: z.literal('mp4'),
      videoCodec: z.literal('avc1'),
      modes: z.array(ModeSchema),
    }),
    offline: z.boolean(),
  }),
});
export type ReadyMessage = z.infer<typeof ReadySchema>;

export const OpenedSchema = z.object({
  type: z.literal('opened'),
  sceneId: IdSchema,
  source: z.enum(['state', 'local', 'brief']),
  changes: BriefChangesSchema.nullable(),
});
export type OpenedMessage = z.infer<typeof OpenedSchema>;
export type OpenSource = OpenedMessage['source'];

export const StateSchema = z.object({
  type: z.literal('state'),
  id: MessageIdSchema.optional(),
  sceneId: IdSchema,
  state: DeskStateSchema,
  shots: z.number().int().min(0),
});
export type StateMessage = z.infer<typeof StateSchema>;

export const PHASES = ['prepare', 'render', 'encode', 'finish'] as const;
export type Phase = (typeof PHASES)[number];

export const ProgressSchema = z.object({
  type: z.literal('progress'),
  id: MessageIdSchema,
  phase: z.enum(PHASES),
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  shotId: IdSchema.optional(),
});
export type ProgressMessage = z.infer<typeof ProgressSchema>;

export const ResultSchema = z.object({
  type: z.literal('result'),
  id: MessageIdSchema,
  sceneId: IdSchema,
  fps: z.number().int().min(1).max(120),
  width: z.number().int().min(16),
  height: z.number().int().min(16),
  shots: z.array(ShotResultSchema),
  files: z.array(ResultFileSchema),
});
export type ResultMessage = z.infer<typeof ResultSchema>;

export const ErrorSchema = z.object({
  type: z.literal('error'),
  id: MessageIdSchema.optional(),
  code: z.enum(ERROR_CODES),
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorSchema>;

export const CloseSchema = z.object({ type: z.literal('close'), reason: z.enum(['done', 'cancel']) });
export type CloseMessage = z.infer<typeof CloseSchema>;

/** The schema of each message type the desk sends on the port. */
export const DESK_MESSAGE_SCHEMAS = {
  ready: ReadySchema,
  opened: OpenedSchema,
  state: StateSchema,
  progress: ProgressSchema,
  result: ResultSchema,
  error: ErrorSchema,
  close: CloseSchema,
} as const;
export type DeskMessageType = keyof typeof DESK_MESSAGE_SCHEMAS;
export type DeskMessage =
  ReadyMessage | OpenedMessage | StateMessage | ProgressMessage | ResultMessage | ErrorMessage | CloseMessage;

// ---------------------------------------------------------------- reading a host's message

/** The first problems of a failed parse, as one line. */
export function problems(error: z.ZodError, max = 5): string {
  return error.issues
    .slice(0, max)
    .map((i) => `${i.path.join('.') || '(message)'}: ${i.message}`)
    .join('; ');
}

/** What a message on the port is. */
export type ParsedHostMessage =
  | { kind: 'ok'; message: HostMessage }
  /** Not an object with a string `type`, or a type this desk does not know: ignored (logged). */
  | { kind: 'unknown'; type: string | null }
  /**
   * A known type that does not validate: answered with `reply` (bad_message with the request's id;
   * for `open`, which has no id, invalid_scene or bad_message without one), or ignored when null.
   */
  | { kind: 'invalid'; type: HostMessageType; reply: ErrorMessage | null; problems: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Validates a message a host sent on the port (see ParsedHostMessage). */
export function parseHostMessage(data: unknown): ParsedHostMessage {
  if (!isRecord(data) || typeof data.type !== 'string') return { kind: 'unknown', type: null };
  const type = data.type;
  if (!Object.prototype.hasOwnProperty.call(HOST_MESSAGE_SCHEMAS, type)) return { kind: 'unknown', type };
  const known = type as HostMessageType;
  if (known === 'open') {
    // the envelope first: an open whose scene alone fails is an invalid scene, not a bad message
    const envelope = OpenEnvelopeSchema.safeParse(data);
    if (!envelope.success) {
      const why = problems(envelope.error);
      return {
        kind: 'invalid',
        type: known,
        problems: why,
        reply: { type: 'error', code: 'bad_message', message: `The open message is not valid: ${why}` },
      };
    }
    const scene = SceneBriefSchema.safeParse(envelope.data.scene);
    if (!scene.success) {
      const why = briefProblems(scene.error);
      return {
        kind: 'invalid',
        type: known,
        problems: why,
        reply: { type: 'error', code: 'invalid_scene', message: `The scene brief is not valid: ${why}` },
      };
    }
    return { kind: 'ok', message: { ...envelope.data, scene: scene.data } as OpenMessage };
  }
  const parsed = HOST_MESSAGE_SCHEMAS[known].safeParse(data);
  if (parsed.success) return { kind: 'ok', message: parsed.data as HostMessage };
  const why = problems(parsed.error);
  const id = MessageIdSchema.safeParse(data.id);
  return {
    kind: 'invalid',
    type: known,
    problems: why,
    reply: id.success
      ? {
          type: 'error',
          id: id.data,
          code: 'bad_message',
          message: `The ${known} message is not valid: ${why}`,
        }
      : null,
  };
}

/** Validates a message the desk sends (null when it validates, else its problems). */
export function deskMessageProblems(message: DeskMessage): string | null {
  const schema = DESK_MESSAGE_SCHEMAS[message.type] as z.ZodType;
  if (!schema) return `unknown message type '${String((message as { type?: unknown }).type)}'`;
  const r = schema.safeParse(message);
  return r.success ? null : problems(r.error);
}

/** The bytes of a given state's data (a copy of a view's bytes; an ArrayBuffer as it is). */
export function stateBytes(state: GivenState): Uint8Array {
  const d = state.data;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  return new Uint8Array(d as ArrayBuffer);
}

/** The frames a brief shot takes: max(1, round(durationSec × fps)), as hosts count them. */
export const briefShotFrames = (durationSec: number, fps: number): number =>
  Math.max(1, Math.round(durationSec * fps));
