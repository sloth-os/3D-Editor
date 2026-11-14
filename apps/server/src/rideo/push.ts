import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  FrameState,
  blockingMoves,
  cameraFovY,
  getShots,
  type SceneDoc,
  type ShotData,
} from '@3d-editor/core';
import { ToolError } from '../mcp/agent';
import type { PassName } from '../render/protocol';
import type { ExportFile, ExportPush, VideoExports } from '../video';
import { RideoError, type RideoCameraPatch, type RideoClient, type RideoShotPatch } from './client';
import { MP4_FORMAT_NAME, rideoProbe, type ClipProbe } from './probe';
import type { RideoBlockingView, RideoProbe, RideoProject, RideoShot } from './schemas';
import {
  DEFAULT_PASS,
  defaultMode,
  needsReference,
  shotFeatures,
  type ReferenceMode,
  type ShotFeatures,
} from './shots';

/*
 * rideo_push (SPEC §11): an export's clips go to rideo as reference videos of the shots they were
 * imported from. In order:
 *  1. our staging becomes rideo's: PUT the blocking (desk.export_rideo_blocking) with fix:false, so
 *     rideo's camera view, blocking line and camera move derive from what the clips show (409 for an
 *     approved clip stops the push: the user may push without writing, write_blocking:false); the
 *     blocking line rideo answers for each shot is compared with the one the export's manifest has,
 *     and rideo's plan_mismatch issues are read (rideo then leaves the line and the camera view out
 *     of that shot's prompts);
 *  2. the clip document is read again, and each chosen shot (default: shots with physics, tethers,
 *     held props or a camera move; never one with a 'performance' reference) gets its mode and pass,
 *     its clip is checked against the CURRENT rideo shot (frames = round(durationSec × fps), the
 *     project's fps and size, H.264 MP4) and against the project (a shot whose camera changed since
 *     the export is refused: the blocking written is the project's), uploaded with its probe and a
 *     JPEG poster (unless this very clip, by sha256, went up to the same rideo clip before, from this
 *     export or another) and set as the shot's motionReference together with the camera move we
 *     rendered (with the shot's whole camera: see RideoCameraPatch);
 *  3. the other shots of the clip get our camera move too (rideo sets a blocked move only on a shot
 *     that has none), so that none keeps a move the staging no longer has.
 * What went up is remembered in rideo-push.json next to the export (the VideoExports service has no
 * API to write the job's `push` field yet) and, by content, per rideo clip in the server's data
 * (PushedResources), so pushing again uploads nothing that is already there; a remembered resource
 * rideo no longer has is uploaded again.
 */

/** The file next to an export that remembers its pushes. */
export const PUSH_RECORD_FILE = 'rideo-push.json';
/** Largest clip pushed (bytes): rideo sends references inline to the video model, so they stay small. */
export const MAX_PUSH_BYTES = 256 * 1024 * 1024;

const vec = z.array(z.number());

/** What the push reads of an export's manifest.json (video/manifest.ts, version 1). */
const manifestShotSchema = z.looseObject({
  id: z.string(),
  name: z.string().default(''),
  index: z.number().int().default(0),
  external: z
    .looseObject({
      source: z.string().optional(),
      project: z.string().nullish(),
      clip: z.string().nullish(),
      shot: z.string().nullish(),
    })
    .nullable()
    .default(null),
  move: z.string().nullable().default(null),
  output_frames: z.number().int().nonnegative(),
  /** The scene frames rendered (the shot's frame_start and frame_end then). */
  scene_frames: z.array(z.number()).nullish(),
  camera: z.looseObject({ object: z.string().nullish() }).nullish(),
  blocking_line: z.string().default(''),
  /** rideo's moves sentence of the shot as it was rendered ('' when nobody moves). */
  moves_line: z.string().nullish(),
  camera_track: z
    .array(
      z.looseObject({
        frame: z.number().optional(),
        position: vec,
        rotation_quat: vec,
        fov_deg: z.number().optional(),
      }),
    )
    .default([]),
  rideo: z.looseObject({ camera_move: z.string().nullish() }).nullish(),
});
export type ManifestShot = z.infer<typeof manifestShotSchema>;

export const exportManifestSchema = z.looseObject({
  version: z.number(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  codec: z.string(),
  look: z.string().optional(),
  passes: z.array(z.string()).default([]),
  shots: z.array(manifestShotSchema).default([]),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

/** One pushed shot as rideo-push.json remembers it. */
export interface PushedShot {
  sha256: string;
  resource: string;
  mode: ReferenceMode;
  pass: PassName;
  file: string;
  uploaded_at: string;
  /** When the shot was set to the resource (null: the PATCH did not succeed yet). */
  patched_at: string | null;
}

/** rideo-push.json. */
export interface PushRecord {
  version: 1;
  updated_at: string;
  /** By rideo target (`<url>|<project>|<clip>`) and rideo shot id. */
  targets: Record<string, Record<string, PushedShot>>;
  /** The job record's `push` field (SPEC §9) of the last push. */
  push: ExportPush | null;
}

export type PushShotStatus = 'pushed' | 'unchanged' | 'skipped' | 'failed';

export interface PushShotResult {
  rideo_shot: string;
  /** Our shot id. */
  shot: string;
  name: string;
  status: PushShotStatus;
  mode: ReferenceMode | null;
  pass: PassName | null;
  /** Why this mode (or why the shot was left out). */
  why: string | null;
  /** The export file pushed. */
  file: string | null;
  sha256: string | null;
  resource: string | null;
  /** No upload: this clip went up for the shot before, its resource was set again. */
  reused: boolean;
  /** The camera move sent with the reference (null: none sent). */
  camera_move: string | null;
  /** What props in motion or camera move the shot shows (the default selection reads them). */
  found: string[];
  error: string | null;
  warnings: string[];
}

export interface PushResult {
  /** done: every chosen shot pushed (or already there); partial: some failed; failed: none, or the blocking. */
  status: 'done' | 'partial' | 'failed';
  project: string;
  export: string;
  rideo: { url: string; project: string; clip: string };
  blocking: {
    written: boolean;
    /** rideo's state of the clip's blocking (missing, incomplete, ready) after the write. */
    state: string | null;
    error: string | null;
    /** Shots whose blocking line in rideo is not the one the export's manifest has. */
    differences: { rideo_shot: string; shot: string; ours: string; rideo: string | null }[];
    /**
     * Shots of the export whose camera rideo finds at odds with their planned layout (its
     * plan_mismatch issue): rideo leaves our blocking line and camera view out of their prompts, so
     * their first frames are not drawn from our staging.
     */
    plan_mismatch: { rideo_shot: string; shot: string; message: string }[];
  };
  /** Shots chosen by default (props in motion, camera moves) or as given. */
  selection: 'default' | 'given';
  shots: PushShotResult[];
  /**
   * Shots of the export the project changed since it was rendered (the blocking written is the
   * project's): a changed camera or frame range refuses the shot's clip; changed walks make its
   * reference a camera reference.
   */
  stale: { rideo_shot: string; shot: string; changes: string[]; refused: boolean }[];
  /**
   * Camera moves set on the clip's other shots (rideo keeps the move a shot has, so a shot without a
   * pushed reference would keep a move our staging no longer has).
   */
  moves: { rideo_shot: string; from: string | null; to: string; error: string | null }[];
  /** rideo shots whose storyboard frame was drawn before this staging: redraw them in rideo. */
  boards_to_redraw: { rideo_shot: string; index: number; approved: boolean }[];
  warnings: string[];
}

/**
 * Resources uploaded to a rideo clip, by the sha256 of their bytes, whatever export they came from
 * (the server keeps them in its data: fileResources), so that the same clip is never uploaded twice.
 */
export interface PushedResources {
  get(target: string, sha256: string): Promise<string | null>;
  set(target: string, sha256: string, resource: string): Promise<void>;
  /** Forgets a resource rideo no longer has. */
  drop(target: string, sha256: string): Promise<void>;
}

/** Our blocking as desk.export_rideo_blocking gives it. */
export interface OurBlocking {
  blocking: Record<string, unknown>;
  /** What the export left out. */
  warnings: string[];
  /** The camera move of each shot by rideo shot id (rideo's camera.move; null: none). */
  moves?: Record<string, string | null>;
}

/** What a push works with (the bridge builds it; tests pass fakes). */
export interface PushEnvironment {
  client: RideoClient;
  exports: Pick<VideoExports, 'status' | 'file'>;
  /**
   * Our project: its id, its document (the live one, or a copy taken when the export was started)
   * and its blocking as rideo's SceneBlocking v1.
   */
  project: {
    id: string;
    doc: SceneDoc;
    exportBlocking(): OurBlocking;
  };
  /** Uploads remembered per rideo clip across exports (none: only this export's record). */
  resources?: PushedResources;
  /** ffprobe of a clip (null without ffprobe). */
  probe(file: string): Promise<ClipProbe | null>;
  /** The first frame of a clip as JPEG (null when it cannot be made). */
  poster(file: string): Promise<Uint8Array | null>;
  now?: () => Date;
}

export interface PushParams {
  export: string;
  rideo: { project: string; clip: string };
  shots?: string[];
  mode?: ReferenceMode;
  pass?: PassName;
  write_blocking: boolean;
}

/** An export's manifest.json (INVALID_PARAMS when it is not one the push understands). */
export function parseManifest(text: string): ExportManifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ToolError("The export's manifest.json is not JSON", 'FAILED');
  }
  const m = exportManifestSchema.safeParse(json);
  if (!m.success)
    throw new ToolError(
      `The export's manifest.json is not one rideo_push understands: ${m.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      'FAILED',
    );
  return m.data;
}

/** Whether a manifest camera track moves (1 cm, or 0.5° of turn, from its first frame). */
export function trackMoves(track: ManifestShot['camera_track']): boolean {
  const first = track[0];
  if (!first || first.position.length < 3 || first.rotation_quat.length < 4) return false;
  const halfTurn = Math.cos((0.25 * Math.PI) / 180);
  for (const t of track) {
    const p = t.position;
    const q = t.rotation_quat;
    if (Math.hypot(p[0] - first.position[0], p[1] - first.position[1], p[2] - first.position[2]) > 0.01)
      return true;
    const d = Math.abs(
      q[0] * first.rotation_quat[0] +
        q[1] * first.rotation_quat[1] +
        q[2] * first.rotation_quat[2] +
        q[3] * first.rotation_quat[3],
    );
    if (d < halfTurn) return true;
  }
  return false;
}

/** A blocking line compared as rideo writes it (whitespace aside). */
const lineKey = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** The export's shots a list of references names (our id, our name or the rideo shot id), in order. */
export function resolveShotRefs(refs: readonly string[], shots: readonly ManifestShot[]): ManifestShot[] {
  const out: ManifestShot[] = [];
  for (const ref of refs) {
    const r = ref.trim();
    const hit =
      shots.find((s) => s.id === r || s.external?.shot === r) ??
      shots.find((s) => s.name === r) ??
      shots.find((s) => s.name.toLowerCase() === r.toLowerCase());
    if (!hit) {
      const known = shots
        .slice(0, 20)
        .map((s) => `'${s.name}' (${s.id}, rideo ${s.external?.shot})`)
        .join(', ');
      throw new ToolError(
        `The export has no shot '${ref}' from this rideo clip. Its shots: ${known || 'none'}.`,
        'INVALID_PARAMS',
      );
    }
    if (!out.includes(hit)) out.push(hit);
  }
  return out;
}

/**
 * Why rideo's first frame of a shot cannot have been drawn from our staging (null: it can): the
 * desk off, an approved board, an image start, a blocking line of rideo's that is not ours, or
 * rideo's plan_mismatch (`planMismatch`, rideo's message by shot id), which leaves the blocking
 * line and the camera view out of the shot's prompts.
 */
export function firstFrameMismatch(
  project: RideoProject,
  shot: RideoShot,
  lineDiffers: ReadonlySet<string>,
  planMismatch: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (!project.settings.blocking.enabled)
    return "rideo's director's desk is off for this project, so its first frames are not drawn from the staging";
  if (shot.board?.approved) return 'its storyboard frame was approved before this staging';
  if (shot.startFrame.mode === 'resource') return 'it starts from an image resource';
  if (lineDiffers.has(shot.id)) return "rideo's blocking line for it is not ours";
  const plan = planMismatch.get(shot.id);
  if (plan !== undefined)
    return `rideo's plan disagrees with this camera (plan_mismatch), so rideo prompts it without our blocking line and camera view${plan ? `: ${plan}` : ''}`;
  return null;
}

/** rideo's plan_mismatch issues of a blocking view: its message by shot id. */
export function planMismatches(view: Pick<RideoBlockingView, 'issues'>): Map<string, string> {
  const out = new Map<string, string>();
  for (const i of view.issues)
    if (i.code === 'plan_mismatch' && i.shotId && !out.has(i.shotId)) out.set(i.shotId, i.message);
  return out;
}

/** A shot's camera as the PATCH sends it: the whole camera rideo has for it, with `move` (see RideoCameraPatch). */
export function cameraPatch(shot: Pick<RideoShot, 'camera'>, move: string): RideoCameraPatch {
  return { ...shot.camera, move };
}

/** Below these the project's camera of a shot stands, looks and zooms where the export rendered it. */
const STALE_POSITION_M = 0.001;
const STALE_TURN_COS = Math.cos((0.1 * Math.PI) / 180);
const STALE_FOV_DEG = 0.05;

/** The camera's view direction (its −Z axis) of a rotation quaternion [x, y, z, w]. */
function quatForward(q: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q;
  return [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
}

/**
 * What changed in the project since the export rendered a shot (the blocking the push writes is
 * the project's, so a clip of an older staging would disagree with rideo's boards): `camera`, its
 * frames or its camera (another object, or standing, looking or zooming elsewhere at the first,
 * middle or last frame the export recorded), which no reference mode can carry; `moves`, the walks
 * and moves of its cast (rideo's moves sentence), which a camera reference leaves out.
 */
export function stagingChanges(
  doc: SceneDoc,
  shot: ShotData,
  ms: ManifestShot,
  aspect: number,
): { camera: string[]; moves: string | null } {
  const camera: string[] = [];
  const frames = ms.scene_frames;
  if (frames && frames.length === 2 && (frames[0] !== shot.frame_start || frames[1] !== shot.frame_end))
    camera.push(
      `its frames are ${shot.frame_start}–${shot.frame_end}, the export's ${frames[0]}–${frames[1]}`,
    );
  const camId = shot.camera ?? doc.getScene().camera ?? null;
  if (ms.camera?.object && camId && ms.camera.object !== camId) camera.push('its camera is another object');
  else if (camId) {
    const track = ms.camera_track.filter((t) => typeof t.frame === 'number');
    const picks = [...new Set([0, Math.floor((track.length - 1) / 2), track.length - 1])].filter(
      (i) => i >= 0 && i < track.length,
    );
    const camData = doc.getObject(camId)?.data;
    const cam = camData ? doc.getCamera(camData) : null;
    for (const i of picks) {
      const t = track[i];
      const m = new FrameState(doc, t.frame!).world(camId);
      if (!m || t.position.length < 3 || t.rotation_quat.length < 4) continue;
      const moved = Math.hypot(m[12] - t.position[0], m[13] - t.position[1], m[14] - t.position[2]);
      const len = Math.hypot(m[8], m[9], m[10]) || 1;
      const fwd = [-m[8] / len, -m[9] / len, -m[10] / len];
      const was = quatForward(t.rotation_quat);
      const cos = fwd[0] * was[0] + fwd[1] * was[1] + fwd[2] * was[2];
      const fov =
        cam && cam.type !== 'ORTHO' && typeof t.fov_deg === 'number' && t.fov_deg > 0
          ? (cameraFovY(cam, aspect) * 180) / Math.PI
          : null;
      const what: string[] = [];
      if (moved > STALE_POSITION_M) what.push(`stands ${moved.toFixed(3)} m away`);
      if (cos < STALE_TURN_COS)
        what.push(`looks ${((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toFixed(1)}° away`);
      if (fov !== null && Math.abs(fov - t.fov_deg!) > STALE_FOV_DEG)
        what.push(`has a ${fov.toFixed(1)}° field of view, not ${t.fov_deg!.toFixed(1)}°`);
      if (what.length) {
        camera.push(`at frame ${t.frame} its camera ${what.join(' and ')} from where the export rendered it`);
        break;
      }
    }
  }
  let moves: string | null = null;
  if (typeof ms.moves_line === 'string') {
    let now: string;
    try {
      now = blockingMoves(doc, shot);
    } catch {
      now = ms.moves_line;
    }
    if (lineKey(now) !== lineKey(ms.moves_line))
      moves = `its cast moves otherwise than the export shows ("${lineKey(now) || 'nobody moves'}", not "${lineKey(ms.moves_line) || 'nobody moves'}")`;
  }
  return { camera, moves };
}

/** The clip of a shot and pass among an export's files. */
function clipOf(files: readonly ExportFile[], shot: string, pass: PassName): ExportFile | null {
  return files.find((f) => f.kind === 'clip' && f.shot === shot && f.pass === pass) ?? null;
}

/**
 * Why a clip cannot be the reference of a rideo shot (null: it can): rideo sends it as it is, so it
 * must have the shot's frames at the project's rate and size, in H.264.
 */
export function clipMismatch(
  clip: { frames: number; fps: number; width: number; height: number; codec: string; file: string },
  rideo: { durationSec: number; fps: number; width: number; height: number },
): string | null {
  if (clip.codec !== 'h264' || !clip.file.endsWith('.mp4'))
    return `the clip is ${clip.codec} (${clip.file}); rideo takes H.264 MP4 references: export with codec 'h264'`;
  if (Math.abs(clip.fps - rideo.fps) > 1e-3)
    return `the clip runs at ${round3(clip.fps)} fps and the rideo project at ${rideo.fps}: export with fps ${rideo.fps}`;
  if (clip.width !== rideo.width || clip.height !== rideo.height)
    return `the clip is ${clip.width}×${clip.height} and the rideo project ${rideo.width}×${rideo.height}: export with width ${rideo.width} and height ${rideo.height}`;
  const want = Math.round(rideo.durationSec * rideo.fps);
  if (clip.frames !== want)
    return `the clip has ${clip.frames} frames and the rideo shot is ${round3(rideo.durationSec)} s at ${rideo.fps} fps (${want} frames): import the clip again (rideo_import) and export again`;
  return null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** The probe of a clip from the export's own records (when ffprobe is not there). */
export function manifestProbe(m: ExportManifest, f: ExportFile): RideoProbe {
  const frames = f.frames ?? 0;
  return {
    formatName: MP4_FORMAT_NAME,
    durationSec: f.duration_s ?? frames / m.fps,
    hasVideo: true,
    hasAudio: false,
    width: m.width,
    height: m.height,
    fps: m.fps,
    videoCodec: m.codec,
  };
}

const emptyRecord = (): PushRecord => ({ version: 1, updated_at: '', targets: {}, push: null });

/** rideo-push.json of an export folder (an empty record when there is none or it is damaged). */
export async function readPushRecord(dir: string): Promise<PushRecord> {
  try {
    const j = JSON.parse(await readFile(path.join(dir, PUSH_RECORD_FILE), 'utf8')) as Partial<PushRecord>;
    if (j && j.version === 1 && j.targets && typeof j.targets === 'object')
      return { ...emptyRecord(), ...j, targets: j.targets } as PushRecord;
  } catch {
    // none yet, or unreadable: start again (nothing is lost but the skipping of uploads)
  }
  return emptyRecord();
}

let tmpCounter = 0;
/** Writes rideo-push.json atomically (a temporary file renamed over it). */
export async function writePushRecord(dir: string, rec: PushRecord): Promise<void> {
  const tmp = path.join(dir, `.${PUSH_RECORD_FILE}.${process.pid}.${++tmpCounter}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(rec, null, 2));
    await rename(tmp, path.join(dir, PUSH_RECORD_FILE));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const targetKey = (url: string, project: string, clip: string) => `${url}|${project}|${clip}`;

/** Most resources remembered per rideo clip (the oldest are forgotten first). */
export const MAX_PUSHED_RESOURCES = 2000;

/**
 * PushedResources kept as one JSON file per rideo clip in `dir` (the server's data, so that a new
 * export of the same clips, or a previs run again, uploads nothing rideo already has). Reads and
 * writes are queued, and a file is replaced atomically; an unreadable one is started again.
 */
export function fileResources(dir: string): PushedResources {
  type Entry = { resource: string; at: string };
  const fileOf = (target: string) =>
    path.join(dir, `${createHash('sha256').update(target).digest('hex').slice(0, 32)}.json`);
  let queue: Promise<unknown> = Promise.resolve();
  const queued = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const read = async (target: string): Promise<Record<string, Entry>> => {
    try {
      const j = JSON.parse(await readFile(fileOf(target), 'utf8')) as {
        target?: unknown;
        resources?: unknown;
      };
      if (j && j.target === target && j.resources && typeof j.resources === 'object')
        return j.resources as Record<string, Entry>;
    } catch {
      // none yet, or unreadable: nothing remembered
    }
    return {};
  };
  const write = async (target: string, resources: Record<string, Entry>) => {
    const kept = Object.entries(resources)
      .sort((a, b) => (a[1].at < b[1].at ? 1 : -1))
      .slice(0, MAX_PUSHED_RESOURCES);
    await mkdir(dir, { recursive: true });
    const file = fileOf(target);
    const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ target, resources: Object.fromEntries(kept) }));
      await rename(tmp, file);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  };
  return {
    get: (target, sha256) => queued(async () => (await read(target))[sha256]?.resource ?? null),
    set: (target, sha256, resource) =>
      queued(async () => {
        const all = await read(target);
        all[sha256] = { resource, at: new Date().toISOString() };
        await write(target, all);
      }),
    drop: (target, sha256) =>
      queued(async () => {
        const all = await read(target);
        if (!all[sha256]) return;
        delete all[sha256];
        await write(target, all);
      }),
  };
}

/** The default features of a shot that is no longer in the project: its camera move only. */
function featuresFromManifest(ms: ManifestShot): ShotFeatures {
  return {
    camera_move: (!!ms.move && ms.move !== 'locked_off') || trackMoves(ms.camera_track),
    physics: false,
    tether: false,
    held: false,
    characters: false,
    found: [],
  };
}

function whyMode(mode: ReferenceMode, f: ShotFeatures, mismatch: string | null, given: boolean): string {
  if (given) return `mode '${mode}' as asked`;
  if (mismatch) return `camera: ${mismatch}`;
  if (mode === 'motion') return `motion: props in motion (${f.found.join(', ') || 'physics'})`;
  if (mode === 'pose') return 'pose: actors in the shot';
  return 'camera: a camera move without actors or props in motion';
}

/** Pushes an export's clips to rideo (see the module comment). */
export async function pushExport(env: PushEnvironment, p: PushParams): Promise<PushResult> {
  const now = () => (env.now?.() ?? new Date()).toISOString();
  const { client } = env;
  const ours = env.project.id;
  const rp = p.rideo.project;
  const clipId = p.rideo.clip;
  const job = await env.exports.status(p.export, { project: ours });
  if (job.status !== 'done')
    throw new ToolError(
      `Video export '${p.export}' is ${job.status}: push it once it is done (export_status).`,
      job.status === 'failed' || job.status === 'cancelled' ? 'INVALID_PARAMS' : 'POLL_FAILED',
    );
  const manifestRef = await env.exports.file(p.export, 'manifest.json', { project: ours });
  const manifest = parseManifest(await readFile(manifestRef.path, 'utf8'));
  const dir = path.dirname(manifestRef.path);
  if (manifest.codec !== 'h264')
    throw new ToolError(
      `Video export '${p.export}' is ${manifest.codec}; rideo takes H.264 MP4 references: export with codec 'h264'.`,
      'INVALID_PARAMS',
    );
  const imported = manifest.shots.filter(
    (s) => s.external?.shot && (s.external.source ?? 'rideo') === 'rideo',
  );
  if (!imported.length)
    throw new ToolError(
      `None of the shots of video export '${p.export}' comes from rideo: import the clip with rideo_import, then export its shots.`,
      'INVALID_PARAMS',
    );
  const ofClip = imported.filter((s) => !s.external!.clip || s.external!.clip === clipId);
  if (!ofClip.length)
    throw new ToolError(
      `The shots of video export '${p.export}' come from rideo clip ${imported[0].external!.clip}, not ${clipId}.`,
      'INVALID_PARAMS',
    );
  // a bad shot name fails before anything is written to rideo
  const given = p.shots?.length ? resolveShotRefs(p.shots, ofClip) : null;

  const result: PushResult = {
    status: 'done',
    project: ours,
    export: p.export,
    rideo: { url: client.baseUrl, project: rp, clip: clipId },
    blocking: { written: false, state: null, error: null, differences: [], plan_mismatch: [] },
    selection: given ? 'given' : 'default',
    shots: [],
    stale: [],
    moves: [],
    boards_to_redraw: [],
    warnings: [],
  };
  const warn = (w: string) => {
    if (!result.warnings.includes(w)) result.warnings.push(w);
  };
  const others = imported.length - ofClip.length;
  if (others) warn(`${others} shot(s) of the export come from another rideo clip and were left out`);
  const otherProject = ofClip.find((s) => s.external!.project && s.external!.project !== rp);
  if (otherProject)
    warn(
      `shot '${otherProject.name}' was imported from rideo project ${otherProject.external!.project}, not ${rp}`,
    );

  const project = await client.project(rp);
  // (1) our staging becomes rideo's
  let view: RideoBlockingView;
  let ourMoves: Record<string, string | null> = {};
  if (p.write_blocking) {
    const { blocking, warnings, moves } = env.project.exportBlocking();
    for (const w of warnings) warn(`our blocking: ${w}`);
    ourMoves = moves ?? {};
    try {
      view = await client.putBlocking(rp, clipId, blocking, { fix: false });
      result.blocking.written = true;
    } catch (err) {
      if (!(err instanceof RideoError) || err.status !== 409) throw err;
      result.blocking.error =
        `${err.message}. No reference was pushed: rideo would keep its own staging while the clips show ours. ` +
        'Unapprove the clip in rideo, or pass write_blocking: false to push the references without the blocking.';
      result.status = 'failed';
      return result;
    }
  } else view = await client.blocking(rp, clipId);
  result.blocking.state = view.state;
  const differs = new Set<string>();
  for (const s of ofClip) {
    const rs = s.external!.shot!;
    if (!Object.hasOwn(view.lines, rs)) continue;
    const theirs = view.lines[rs] ?? null;
    if (lineKey(theirs) === lineKey(s.blocking_line)) continue;
    differs.add(rs);
    result.blocking.differences.push({ rideo_shot: rs, shot: s.id, ours: s.blocking_line, rideo: theirs });
  }
  if (result.blocking.differences.length)
    warn(
      `rideo's blocking line differs from ours for ${result.blocking.differences.length} shot(s): their references default to mode 'camera'`,
    );
  // rideo's plan agreement: a shot whose camera disagrees with its plan is prompted without our
  // blocking line and camera view, so its first frame is not drawn from our staging
  const planMismatch = planMismatches(view);
  for (const s of ofClip) {
    const rs = s.external!.shot!;
    const message = planMismatch.get(rs);
    if (message !== undefined) result.blocking.plan_mismatch.push({ rideo_shot: rs, shot: s.id, message });
  }
  if (result.blocking.plan_mismatch.length)
    warn(
      `rideo finds the camera of ${result.blocking.plan_mismatch.length} shot(s) at odds with their planned layout (plan_mismatch: ${result.blocking.plan_mismatch
        .map((x) => x.rideo_shot)
        .join(
          ', ',
        )}): rideo prompts them without our blocking line and camera view, so their references default to mode 'camera'; fit their cameras to the plan (desk.shot_solve with fit_plan) or change the plan in rideo, then redraw their boards`,
    );

  // (2) the clip as rideo has it now (the PUT may have changed lenses and moves)
  let clip = await client.clip(rp, clipId);
  let rideoShots = new Map(clip.shots.map((s) => [s.id, s]));
  if (!project.settings.blocking.enabled)
    warn(
      "rideo's director's desk is off for this project (settings.blocking.enabled): its first frames are not drawn from the staging, so every reference defaults to mode 'camera'",
    );
  else if (!project.settings.blocking.layoutImage)
    warn("rideo does not show its image model the desk's camera view (settings.blocking.layoutImage is off)");
  if (project.settings.blocking.enabled)
    result.boards_to_redraw = clip.shots
      .filter((s) => s.board)
      .map((s) => ({ rideo_shot: s.id, index: s.index, approved: !!s.board?.approved }));

  const live = new Map(getShots(env.project.doc).map((s) => [s.id, s]));
  const aspect = manifest.width / manifest.height;
  const record = await readPushRecord(dir);
  const key = targetKey(client.baseUrl, rp, clipId);
  const pushed = (record.targets[key] ??= {});
  const save = async () => {
    record.updated_at = now();
    await writePushRecord(dir, record);
  };
  const resolution = project.settings.resolution;
  let fatal: string | null = null;
  /** rideo shots whose camera.move this push set (with a reference or after them). */
  const moveSet = new Set<string>();

  for (const ms of given ?? ofClip) {
    const rsId = ms.external!.shot!;
    const r: PushShotResult = {
      rideo_shot: rsId,
      shot: ms.id,
      name: ms.name,
      status: 'skipped',
      mode: null,
      pass: null,
      why: null,
      file: null,
      sha256: null,
      resource: null,
      reused: false,
      camera_move: null,
      found: [],
      error: null,
      warnings: [],
    };
    result.shots.push(r);
    if (fatal) {
      r.error = `not tried: ${fatal}`;
      continue;
    }
    const rs = rideoShots.get(rsId);
    if (!rs) {
      r.status = given ? 'failed' : 'skipped';
      r.error = `rideo's clip has no shot ${rsId} any more: import the clip again (rideo_import)`;
      continue;
    }
    const liveShot = live.get(ms.id);
    const features = liveShot ? shotFeatures(env.project.doc, liveShot, aspect) : featuresFromManifest(ms);
    features.camera_move ||= trackMoves(ms.camera_track);
    r.found = [...features.found, ...(features.camera_move ? ['camera move'] : [])];
    if (!liveShot) r.warnings.push('the shot is no longer in the project: chosen by its camera move only');
    if (!given && !needsReference(features)) {
      r.why = 'no physics, tether, held prop or camera move in view: rideo renders it in its own groups';
      continue;
    }
    if (rs.motionReference?.mode === 'performance') {
      r.why = "it has a 'performance' reference, which rideo_push never replaces";
      continue;
    }
    // the clip against the project whose staging the blocking carries
    const changed = liveShot ? stagingChanges(env.project.doc, liveShot, ms, aspect) : null;
    if (changed && (changed.camera.length || changed.moves))
      result.stale.push({
        rideo_shot: rsId,
        shot: ms.id,
        changes: [...changed.camera, ...(changed.moves ? [changed.moves] : [])],
        refused: changed.camera.length > 0,
      });
    if (changed?.camera.length) {
      r.status = 'failed';
      r.error = `refused: the project changed since export '${p.export}' was made (${changed.camera.join('; ')}): export the shot again, then push that export`;
      continue;
    }
    const mismatch =
      firstFrameMismatch(project, rs, differs, planMismatch) ??
      (changed?.moves ? `${changed.moves} since the export` : null);
    const mode = p.mode ?? defaultMode(features, mismatch === null);
    r.mode = mode;
    r.why = whyMode(mode, features, mismatch, !!p.mode);
    if (p.mode && mismatch && mode !== 'camera')
      r.warnings.push(`mode '${mode}' as asked, although ${mismatch}`);
    let pass: PassName = p.pass ?? DEFAULT_PASS[mode];
    let file = clipOf(job.files, ms.id, pass);
    if (!file && pass !== 'beauty') {
      const beauty = clipOf(job.files, ms.id, 'beauty');
      if (beauty) {
        r.warnings.push(`the export has no ${pass} clip of this shot: the beauty clip was pushed instead`);
        pass = 'beauty';
        file = beauty;
      }
    }
    r.pass = pass;
    if (!file) {
      r.status = 'failed';
      r.error = `the export has no ${pass} clip of this shot (export it with outputs.clips and passes ['${pass}'])`;
      continue;
    }
    r.file = file.name;
    r.sha256 = file.sha256;
    try {
      const ref = await env.exports.file(p.export, file.name, { project: ours });
      const probe = await env.probe(ref.path);
      if (!probe)
        r.warnings.push("ffprobe is not available: the clip's probe comes from the export's records");
      const mismatchReason = clipMismatch(
        {
          frames: probe?.frames ?? file.frames ?? ms.output_frames,
          fps: probe?.fps ?? manifest.fps,
          width: probe?.width ?? manifest.width,
          height: probe?.height ?? manifest.height,
          codec: probe?.codec ?? manifest.codec,
          file: file.name,
        },
        {
          durationSec: rs.durationSec,
          fps: project.settings.fps,
          width: resolution.width,
          height: resolution.height,
        },
      );
      if (mismatchReason) {
        r.status = 'failed';
        r.error = `refused: ${mismatchReason}`;
        continue;
      }
      if (ref.bytes > MAX_PUSH_BYTES) {
        r.status = 'failed';
        r.error = `the clip is ${Math.round(ref.bytes / 1048576)} MB; rideo sends references inline, so they must stay under ${MAX_PUSH_BYTES / 1048576} MB (export at a lower quality or size)`;
        continue;
      }
      const sha = file.sha256;
      const fileRef = ref;
      const fileName = file.name;
      /** Uploads the clip as a new resource and remembers it. */
      const upload = async (): Promise<string> => {
        const bytes = await readFile(fileRef.path);
        const poster = await env.poster(fileRef.path);
        if (!poster && !r.warnings.includes('no poster could be made: rideo shows the resource without one'))
          r.warnings.push('no poster could be made: rideo shows the resource without one');
        const res = await client.upload(rp, {
          file: bytes,
          filename: fileName,
          poster,
          name: `3D previs: ${ms.name || rsId} (${mode})`,
          probe: probe ? rideoProbe(probe) : manifestProbe(manifest, file!),
        });
        if (res.status !== 'ready')
          r.warnings.push(`rideo keeps the resource ${res.status}: the shot may refuse it until it is ready`);
        pushed[rsId] = {
          sha256: sha,
          resource: res.id,
          mode,
          pass,
          file: fileName,
          uploaded_at: now(),
          patched_at: null,
        };
        await save();
        await env.resources?.set(key, sha, res.id).catch(() => undefined);
        return res.id;
      };
      // this very clip went up to this rideo clip before (from this export, or from another)
      const prev = pushed[rsId];
      let resource: string | null = prev && prev.sha256 === sha && prev.resource ? prev.resource : null;
      if (!resource) resource = (await env.resources?.get(key, sha).catch(() => null)) ?? null;
      if (resource) {
        r.reused = true;
        if (!(prev && prev.sha256 === sha && prev.resource === resource)) {
          pushed[rsId] = {
            sha256: sha,
            resource,
            mode,
            pass,
            file: fileName,
            uploaded_at: prev?.sha256 === sha ? prev.uploaded_at : now(),
            patched_at: null,
          };
          await save();
        }
      } else resource = await upload();
      r.resource = resource;
      const move = ms.rideo?.camera_move ?? ms.move ?? (trackMoves(ms.camera_track) ? null : 'locked_off');
      if (!move)
        r.warnings.push(
          'its camera moves without a move of the library: rideo keeps the move it has for the shot',
        );
      r.camera_move = move;
      const current = rs.motionReference;
      if (
        r.reused &&
        current?.resourceId === resource &&
        current.mode === mode &&
        pushed[rsId]?.patched_at &&
        (move === null || rs.camera.move === move)
      ) {
        r.status = 'unchanged';
        if (move) moveSet.add(rsId);
        continue;
      }
      const patchWith = (id: string): RideoShotPatch => ({
        motionReference: { resourceId: id, mode },
        // the shot's whole camera: a camera of {move} alone would reset its framing and movement
        ...(move ? { camera: cameraPatch(rs, move) } : {}),
      });
      let updated;
      try {
        updated = await client.patchShot(rp, clipId, rsId, patchWith(resource));
      } catch (err) {
        // a remembered resource rideo no longer has (deleted, or never ready): upload it once again
        if (!(r.reused && err instanceof RideoError && (err.status === 404 || err.status === 422))) throw err;
        await env.resources?.drop(key, sha).catch(() => undefined);
        r.warnings.push(
          `rideo refused the resource ${resource} uploaded before (${err.status}): the clip was uploaded again`,
        );
        r.reused = false;
        resource = await upload();
        r.resource = resource;
        updated = await client.patchShot(rp, clipId, rsId, patchWith(resource));
      }
      clip = updated;
      rideoShots = new Map(clip.shots.map((s) => [s.id, s]));
      const after = updated.shots.find((s) => s.id === rsId)?.motionReference;
      if (after?.resourceId !== resource)
        r.warnings.push("rideo's answer does not show the reference on the shot: check the shot in rideo");
      pushed[rsId] = { ...pushed[rsId]!, mode, pass, patched_at: now() };
      await save();
      if (move) moveSet.add(rsId);
      r.status = 'pushed';
    } catch (err) {
      r.status = 'failed';
      r.error = err instanceof Error ? err.message : String(err);
      // a refused token or role fails every other request the same way
      if (err instanceof RideoError && (err.status === 401 || err.status === 403)) fatal = err.message;
    }
  }

  // (3) our camera moves on the clip's other shots: rideo sets a blocked move only on a shot without
  // one, so a shot pushed without a reference (or before) would keep a move the staging no longer has
  if (result.blocking.written && !fatal)
    for (const rs of [...clip.shots].sort((a, b) => a.index - b.index)) {
      const to = ourMoves[rs.id];
      if (!to || moveSet.has(rs.id)) continue;
      const from = rideoShots.get(rs.id)?.camera.move ?? null;
      if (from === to) continue;
      const entry = { rideo_shot: rs.id, from, to, error: null as string | null };
      result.moves.push(entry);
      try {
        const updated = await client.patchShot(rp, clipId, rs.id, {
          camera: cameraPatch(rideoShots.get(rs.id) ?? rs, to),
        });
        rideoShots = new Map(updated.shots.map((s) => [s.id, s]));
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
        if (err instanceof RideoError && (err.status === 401 || err.status === 403)) break;
      }
    }
  const setMoves = result.moves.filter((m) => !m.error);
  if (setMoves.length)
    warn(
      `rideo's camera move of ${setMoves.length} shot(s) without a reference pushed now is ours: ${setMoves
        .map((m) => `${m.rideo_shot} ${m.from ?? 'none'} → ${m.to}`)
        .join(', ')}`,
    );
  const failedMoves = result.moves.filter((m) => m.error);
  if (failedMoves.length)
    warn(
      `rideo kept its camera move of ${failedMoves.length} shot(s): ${failedMoves.map((m) => `${m.rideo_shot} (${m.error})`).join('; ')}`,
    );
  if (result.stale.length)
    warn(
      `the project changed since export '${p.export}' for ${result.stale.length} shot(s) (${result.stale
        .map((x) => x.rideo_shot)
        .join(
          ', ',
        )}): a changed camera refuses the clip, changed walks make it a camera reference; export them again to push their new staging`,
    );

  const tried = result.shots.filter((s) => s.status !== 'skipped' || s.error?.startsWith('not tried'));
  const failed = result.shots.filter((s) => s.status === 'failed').length;
  result.status = fatal || (failed > 0 && failed === tried.length) ? 'failed' : failed ? 'partial' : 'done';
  if (!result.shots.some((s) => s.status === 'pushed' || s.status === 'unchanged' || s.status === 'failed'))
    warn(
      'no shot needed a reference (no physics, tether, held prop or camera move): pass shots to push some anyway',
    );
  record.push = {
    status: result.status === 'done' ? 'done' : 'failed',
    shots: result.shots
      .filter((s) => s.status !== 'skipped')
      .map((s) => ({ rideo_shot: s.rideo_shot, resource: s.resource, error: s.error })),
  };
  await save().catch(() =>
    warn('rideo-push.json could not be written: a later push uploads these clips again'),
  );
  return result;
}
