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
  /** Library units for this open (UnitsOptionSchema), read leniently with acceptUnits: never fails the open. */
  units: z.unknown().optional(),
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

// ---------------------------------------------------------------- library units (additive to v1)
//
// docs/embedding.md "Library units": nothing here is sent unless the desk announced
// ready.capabilities.units AND the host's open carried options.units (acceptUnits). A version of a
// library item is {ref, version, sha256}: the host's item id, its version (an integer from 1, the
// host's) and the SHA-256 of the unit file's exact bytes.

/** The format and version of a unit file (core's UNIT_FORMAT and UNIT_VERSION). */
export const UNIT_DATA_FORMAT = '3d-editor.desk-unit';
export const UNIT_DATA_VERSION = 1;
/** The kinds of unit: a set for the scene's place, a prop, a figure for a cast member. */
export const UNIT_KINDS = ['set', 'prop', 'figure'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];
/** Bytes of one unit file at most (32 MiB). */
export const MAX_UNIT_BYTES = 32 * 1024 * 1024;
/** Bytes of all the units of one open at most (48 MiB): the host stops before it. */
export const MAX_OPEN_UNIT_BYTES = 48 * 1024 * 1024;
/** Units of one open at most: a set, 16 cast members and 64 elements. */
export const MAX_OPEN_UNITS = 81;
/** Bytes of a published unit's thumbnail at most (a PNG of at most 256 px a side). */
export const MAX_THUMBNAIL_BYTES = 64 * 1024;
/** Bytes of a published unit's `meta` at most, as JSON.stringify(meta) in UTF-8. */
export const MAX_UNIT_META_BYTES = 16 * 1024;
/** Rows of state.units at most. */
export const MAX_STATE_UNITS = 128;
/** The codes of a refused publish (unit-ack `code`; a desk reads any string of 1–40 characters). */
export const PUBLISH_REFUSALS = [
  'refused',
  'conflict',
  'too_large',
  'invalid',
  'unavailable',
  'failed',
] as const;
export type PublishRefusal = (typeof PUBLISH_REFUSALS)[number];
/** What a slot's pin is staged as in state.units: its unit, or the words while it waits or was refused. */
export const UNIT_STAGED = ['unit', 'pending', 'refused'] as const;
export type UnitStaged = (typeof UNIT_STAGED)[number];
/** Why a pin waits (`pending`, tried again at the next open). */
export const UNIT_PENDING_REASONS = ['missing', 'mismatch', 'unavailable'] as const;
/** Why a pin was refused (`refused`, tried again only when the pin changes). */
export const UNIT_REFUSED_REASONS = [
  'unreadable',
  'too_new',
  'too_large',
  'wrong_kind',
  'figure_kind',
  'figure_rig',
  'over_budget',
  'set_ground',
] as const;
/** How long the desk waits for a unit-ack: 120 s, and 10 s more per MiB of the unit. */
export const PUBLISH_ACK_BASE_MS = 120_000;
export const PUBLISH_ACK_PER_MIB_MS = 10_000;
export const publishAckTimeoutMs = (unitBytes: number): number =>
  PUBLISH_ACK_BASE_MS + Math.ceil(Math.max(0, unitBytes) / (1024 * 1024)) * PUBLISH_ACK_PER_MIB_MS;

/** A SHA-256: 64 lowercase hex digits. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256: 64 lowercase hex digits');
/** A version of a library item: an integer from 1 to 1e9, the host's. */
export const UnitVersionSchema = z.number().int().min(1).max(1_000_000_000);

/** Bytes as a host gives them (an ArrayBuffer or a view of one), as GivenStateSchema takes a state's. */
const GivenBytesSchema = z.union([
  ArrayBufferSchema,
  z.custom<ArrayBufferView>((v) => ArrayBuffer.isView(v), 'an ArrayBuffer or a view of one'),
]);
const unitBytesInRange = (d: ArrayBuffer | ArrayBufferView) =>
  d.byteLength >= 1 && d.byteLength <= MAX_UNIT_BYTES;
const UNIT_BYTES_RANGE = '1 byte to 32 MiB';

/** ready.capabilities.units: what the desk does with library units (a desk with units always sends it). */
export const UnitsCapabilitySchema = z.object({
  /** The units option versions it reads ([1]). */
  versions: z.array(z.number().int().positive()).min(1),
  /** The kinds it places (hosts read any strings and leave out kinds they do not know). */
  kinds: z.array(z.enum(UNIT_KINDS)).min(1),
  /** Bytes of one unit at most (MAX_UNIT_BYTES). */
  maxBytes: z.number().int().positive(),
  /** Whether it can send unit-publish. */
  publish: z.boolean(),
});
export type UnitsCapability = z.infer<typeof UnitsCapabilitySchema>;

/** open.options.units: the host turns units on for this open; `publish` false: no Save to library. */
export const UnitsOptionSchema = z.object({ version: z.literal(1), publish: z.boolean() });
export type UnitsOption = z.infer<typeof UnitsOptionSchema>;

/**
 * open.options.units read leniently: the units this open takes, or null (units off for this open)
 * when absent, malformed or of a version this desk does not read. Never fails the open.
 */
export function acceptUnits(raw: unknown): UnitsOption | null {
  const r = UnitsOptionSchema.safeParse(raw);
  return r.success ? { version: 1, publish: r.data.publish } : null;
}

/** A unit's file as a host gives it in open.units (its format and version read by the desk later). */
export const GivenUnitDataSchema = z.object({
  format: z.string().min(1).max(64),
  version: z.number().int().positive(),
  data: GivenBytesSchema.refine(unitBytesInRange, UNIT_BYTES_RANGE),
});

/** One entry of open.units: the unit of a pinned ref@version (transferred). */
export const OpenUnitSchema = z.object({
  ref: IdSchema,
  version: UnitVersionSchema,
  sha256: Sha256Schema,
  unit: GivenUnitDataSchema,
});
export type OpenUnit = z.infer<typeof OpenUnitSchema>;

/**
 * open.units read entry by entry: the entries that validate (at most MAX_OPEN_UNITS), and the others
 * by index with their problems (index -1: `units` is not a list). A bad entry is left out and its pin
 * counts as not sent; it never fails the open. Absent: no units.
 */
export function parseOpenUnits(raw: unknown): {
  units: OpenUnit[];
  dropped: { index: number; problem: string }[];
} {
  const units: OpenUnit[] = [];
  const dropped: { index: number; problem: string }[] = [];
  if (raw === undefined) return { units, dropped };
  if (!Array.isArray(raw)) return { units, dropped: [{ index: -1, problem: 'units: not a list' }] };
  raw.forEach((entry, index) => {
    if (index >= MAX_OPEN_UNITS) {
      dropped.push({ index, problem: `more than ${MAX_OPEN_UNITS} units: left out` });
      return;
    }
    const r = OpenUnitSchema.safeParse(entry);
    if (r.success) units.push(r.data);
    else dropped.push({ index, problem: problems(r.error) });
  });
  return { units, dropped };
}

/** The bytes of an open unit's data (a copy of a view's bytes; an ArrayBuffer as it is). */
export function openUnitBytes(u: OpenUnit): Uint8Array {
  const d = u.unit.data;
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
  return new Uint8Array(d as ArrayBuffer);
}

/** The slot a pin is for: the brief's set, a cast member (`cast:<id>`) or an element (`el:<id>`). */
export const UNIT_SLOT_PATTERN = /^(set|cast:[A-Za-z0-9_.:-]{1,100}|el:[A-Za-z0-9_.:-]{1,100})$/;

/** UTF-8 bytes of a text. */
const utf8Length = (s: string): number => new TextEncoder().encode(s).byteLength;

/** The brief slot a published unit came from: exactly one of a cast member, an element, the set. */
export const UnitFromSchema = z
  .object({ castId: IdSchema.nullable(), elementId: IdSchema.nullable(), set: z.boolean() })
  .refine(
    (f) => [f.castId !== null, f.elementId !== null, f.set].filter(Boolean).length === 1,
    'exactly one of castId, elementId, set',
  );

/** A published unit's facts (core's unitMeta): at most 16 KiB as JSON in UTF-8. */
export const UnitMetaSchema = z
  .object({
    dimensionsM: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]),
    objects: z.number().int().min(0),
    triangles: z.number().int().min(0),
    actor: z.object({ kind: z.string().min(1).max(60), heightM: z.number().positive().max(8) }).nullable(),
    credits: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          author: z.string().max(200).nullable(),
          license: z.string().min(1).max(64),
        }),
      )
      .max(32),
    deskVersion: z.string().min(1).max(64),
    /** The unit header's digest of its body (informational: the file's sha256 is what travels). */
    digest: Sha256Schema,
  })
  .refine((m) => utf8Length(JSON.stringify(m)) <= MAX_UNIT_META_BYTES, 'at most 16 KiB as JSON');
export type UnitMeta = z.infer<typeof UnitMetaSchema>;

/** A row of state.units: a brief slot whose record has a pin, and what the scene holds for it. */
export const StateUnitSchema = z
  .strictObject({
    slot: z.string().regex(UNIT_SLOT_PATTERN, "'set', 'cast:<id>' or 'el:<id>'"),
    ref: IdSchema,
    version: UnitVersionSchema,
    sha256: Sha256Schema,
    staged: z.enum(UNIT_STAGED),
    /** Staged 'unit' but the slot no longer holds a linked instance (made local). */
    local: z.boolean(),
    /** Why the pin waits or was refused (UNIT_PENDING_REASONS, UNIT_REFUSED_REASONS). */
    why: z.string().max(40).optional(),
  })
  .superRefine((u, ctx) => {
    const reasons: readonly string[] | null =
      u.staged === 'pending' ? UNIT_PENDING_REASONS : u.staged === 'refused' ? UNIT_REFUSED_REASONS : null;
    if (reasons ? !reasons.includes(u.why ?? '') : u.why !== undefined)
      ctx.addIssue({
        code: 'custom',
        path: ['why'],
        message: reasons ? `one of ${reasons.join(', ')}` : "no reason for a pin staged 'unit'",
      });
    if (u.local && u.staged !== 'unit')
      ctx.addIssue({ code: 'custom', path: ['local'], message: "only a pin staged 'unit' is local" });
  });
export type StateUnit = z.infer<typeof StateUnitSchema>;

// ---------------------------------------------------------------- host → desk

/**
 * `open` without its scene checked (the scene is checked on its own: invalid_scene). `units`, the
 * units of the brief's pins (OpenUnitSchema, transferred), is read entry by entry with
 * parseOpenUnits: never fails the open.
 */
const OpenEnvelopeSchema = z.object({
  type: z.literal('open'),
  scene: z.unknown(),
  state: GivenStateSchema.nullable(),
  options: OpenOptionsSchema.optional(),
  units: z.unknown().optional(),
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

/**
 * The host's answer to a unit-publish (the same `id`): `ok` with the item's `ref`, the `version` it
 * made and whether it `linked` it to the entity `from` names (decision of the host: see
 * docs/embedding.md), or not ok with a `code` (PUBLISH_REFUSALS, read leniently) and a `message`.
 */
export const UnitAckSchema = z
  .object({
    type: z.literal('unit-ack'),
    id: MessageIdSchema,
    ok: z.boolean(),
    ref: IdSchema.optional(),
    version: UnitVersionSchema.optional(),
    linked: z.boolean().optional(),
    code: z.string().min(1).max(40).optional(),
    message: z.string().max(2000).optional(),
  })
  .superRefine((m, ctx) => {
    if (!m.ok) return;
    for (const key of ['ref', 'version', 'linked'] as const)
      if (m[key] === undefined)
        ctx.addIssue({ code: 'custom', path: [key], message: `required when ok is true` });
  });
export type UnitAckMessage = z.infer<typeof UnitAckSchema>;

/** The schema of each message type a host sends on the port. */
export const HOST_MESSAGE_SCHEMAS = {
  open: OpenSchema,
  export: ExportSchema,
  cancel: CancelSchema,
  save: SaveSchema,
  'result-ack': ResultAckSchema,
  'unit-ack': UnitAckSchema,
} as const;
export type HostMessageType = keyof typeof HOST_MESSAGE_SCHEMAS;
export type HostMessage =
  OpenMessage | ExportMessage | CancelMessage | SaveMessage | ResultAckMessage | UnitAckMessage;

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
    /** Library units (absent: a desk without them; hosts read it leniently). */
    units: UnitsCapabilitySchema.optional(),
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
  /**
   * Only after an open with units: one row per brief slot whose record has a pin, sorted by slot
   * (plain string order), each slot once.
   */
  units: z
    .array(StateUnitSchema)
    .max(MAX_STATE_UNITS)
    .superRefine((rows, ctx) => {
      rows.forEach((r, i) => {
        if (i > 0 && !(rows[i - 1].slot < r.slot))
          ctx.addIssue({
            code: 'custom',
            path: [i, 'slot'],
            message: `rows sorted by slot, each once ('${r.slot}' after '${rows[i - 1].slot}')`,
          });
      });
    })
    .optional(),
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

/**
 * Save to library (only after an open whose options.units.publish was true): a unit file of the scene
 * for the host's library, a new item or a new version of `newVersionOf` (its base version), from the
 * brief slot `from` names. The host answers unit-ack with the same `id`. `unit.data` and
 * `thumbnail.data` are transferred.
 */
export const UnitPublishSchema = z.object({
  type: z.literal('unit-publish'),
  id: MessageIdSchema,
  kind: z.enum(UNIT_KINDS),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  newVersionOf: z.object({ ref: IdSchema, version: UnitVersionSchema }).optional(),
  from: UnitFromSchema.optional(),
  unit: z.object({
    format: z.literal(UNIT_DATA_FORMAT),
    version: z.literal(UNIT_DATA_VERSION),
    data: ArrayBufferSchema.refine(unitBytesInRange, UNIT_BYTES_RANGE),
  }),
  /** The SHA-256 of unit.data. */
  sha256: Sha256Schema,
  thumbnail: z
    .object({
      mime: z.literal('image/png'),
      data: ArrayBufferSchema.refine(
        (b) => b.byteLength >= 1 && b.byteLength <= MAX_THUMBNAIL_BYTES,
        '1 byte to 64 KiB',
      ),
    })
    .nullable(),
  meta: UnitMetaSchema,
});
export type UnitPublishMessage = z.infer<typeof UnitPublishSchema>;

/** The schema of each message type the desk sends on the port. */
export const DESK_MESSAGE_SCHEMAS = {
  ready: ReadySchema,
  opened: OpenedSchema,
  state: StateSchema,
  progress: ProgressSchema,
  result: ResultSchema,
  error: ErrorSchema,
  close: CloseSchema,
  'unit-publish': UnitPublishSchema,
} as const;
export type DeskMessageType = keyof typeof DESK_MESSAGE_SCHEMAS;
export type DeskMessage =
  | ReadyMessage
  | OpenedMessage
  | StateMessage
  | ProgressMessage
  | ResultMessage
  | ErrorMessage
  | CloseMessage
  | UnitPublishMessage;

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
