import {
  DESK_PROPS,
  blockingLine,
  blockingMoves,
  checkShots,
  shotLayout,
  type DeskIssue,
  type SceneDoc,
  type ShotData,
  type ShotExternalRef,
} from '@3d-editor/core';
import type { FrameMeta, PassName } from '../render/protocol';
import type { ExportPlan, PlannedShot } from './plan';
import type { PaletteEntry } from './passes';

/*
 * manifest.json of a video export (SPEC §9, version 1): what was rendered and where to find it,
 * per shot the camera track and subject boxes of every output frame, the blocking sentences rideo
 * compares with its own, and the store models' credits. Built from the export's snapshot (never the
 * live project). Coordinates are the editor's (metres, Z up); quaternions are [x, y, z, w]; screen
 * boxes are pixels of the output frame (top-left origin); timecodes are HH:MM:SS:FF at the output
 * rate rounded to whole frames per second, timecode_out being the frame after the shot (the
 * convention of edit decision lists).
 */

export const MANIFEST_VERSION = 1;

export interface CameraTrackEntry {
  /** The scene frame shown. */
  frame: number;
  position: [number, number, number];
  rotation_quat: [number, number, number, number];
  /** Vertical field of view in degrees (0 for orthographic cameras). */
  fov_deg: number;
}

export interface SubjectTrackEntry {
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/** What the frames of one shot reported (filled while the frames are written, in order). */
export class ShotTracks {
  readonly camera: CameraTrackEntry[] = [];
  /** Subject boxes by subject object id. */
  readonly subjects = new Map<string, SubjectTrackEntry[]>();

  /** Adds the metadata of the next output frame of the shot. */
  add(frame: number, meta: FrameMeta | undefined): void {
    if (!meta) return;
    const m = meta.camera.matrix;
    this.camera.push({
      frame: round(frame, 4),
      position: [round(m[12], 5), round(m[13], 5), round(m[14], 5)],
      rotation_quat: quatFromMatrix(m).map((v) => round(v, 6)) as [number, number, number, number],
      fov_deg: round((meta.camera.fovY * 180) / Math.PI, 4),
    });
    for (const [id, box] of Object.entries(meta.subjects)) {
      let list = this.subjects.get(id);
      if (!list) this.subjects.set(id, (list = []));
      list.push(
        box
          ? { frame: round(frame, 4), x: box.x, y: box.y, w: box.w, h: box.h, visible: box.visible }
          : { frame: round(frame, 4), x: 0, y: 0, w: 0, h: 0, visible: false },
      );
    }
  }
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
}

/** The rotation of a column-major matrix (unit columns expected) as a quaternion [x, y, z, w]. */
export function quatFromMatrix(m: ArrayLike<number>): [number, number, number, number] {
  const len = (a: number, b: number, c: number) => Math.hypot(a, b, c) || 1;
  const s0 = len(m[0], m[1], m[2]);
  const s1 = len(m[4], m[5], m[6]);
  const s2 = len(m[8], m[9], m[10]);
  const m00 = m[0] / s0;
  const m10 = m[1] / s0;
  const m20 = m[2] / s0;
  const m01 = m[4] / s1;
  const m11 = m[5] / s1;
  const m21 = m[6] / s1;
  const m02 = m[8] / s2;
  const m12 = m[9] / s2;
  const m22 = m[10] / s2;
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  // one hemisphere (w ≥ 0), so equal rotations compare equal
  return w < 0 ? [-x, -y, -z, -w] : [x, y, z, w];
}

/** HH:MM:SS:FF of output frame `frame` at `fps` (whole frames per second, non-drop). */
export function timecode(frame: number, fps: number): string {
  const base = Math.max(1, Math.round(fps));
  const f = Math.max(0, Math.round(frame));
  const ff = f % base;
  const s = Math.floor(f / base);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(ff)}`;
}

/** A file listed in the manifest (the job record's files without their download links). */
export interface ManifestFile {
  name: string;
  kind: string;
  pass?: PassName;
  shot?: string;
  external_shot?: string;
  bytes: number;
  frames?: number;
  duration_s?: number;
  sha256: string;
}

export interface ManifestInput {
  doc: SceneDoc;
  project: { id: string; name: string };
  createdAt: string;
  plan: ExportPlan;
  codec: 'h264' | 'vp9';
  look: string;
  quality: string;
  passes: readonly PassName[];
  files: readonly ManifestFile[];
  palette: readonly PaletteEntry[];
  /** Tracks of each planned shot (same order). */
  tracks: readonly ShotTracks[];
  warnings: readonly string[];
}

const prop = (o: { custom_props?: Record<string, unknown> } | null, key: string): string | null => {
  const v = o?.custom_props?.[key];
  return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null;
};

/** Calls a director's-desk function that may be missing or fail (then `fallback`). */
function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

const hex = (c: readonly number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

function shotEntry(input: ManifestInput, p: PlannedShot, tracks: ShotTracks | undefined) {
  const { doc, plan } = input;
  const shot: ShotData | null = p.shot;
  const camObj = doc.getObject(p.camera);
  const cam = camObj?.data ? doc.getCamera(camObj.data) : null;
  const firstFrame = p.sceneStart;
  const subjectIds = shot?.subjects ?? [];
  const paletteColor = new Map(input.palette.map((e) => [e.object, hex(e.color)]));
  const trackKey = (id: string) => prop(doc.getObject(id), DESK_PROPS.characterId) ?? id;
  const files: Record<string, string> = {};
  for (const f of input.files) {
    if (f.shot !== p.id) continue;
    if (f.kind === 'clip' && f.pass) files[f.pass] = f.name;
    else if (f.kind === 'poster') files[f.name.endsWith('.jpg') ? 'poster_jpeg' : 'poster'] = f.name;
  }
  const external: ShotExternalRef | null = shot?.external ?? null;
  const movesLine = shot ? attempt(() => blockingMoves(doc, shot), '') : '';
  const layout = shot
    ? attempt(
        () =>
          shotLayout(doc, shot, firstFrame).map((e) => ({
            characterId: trackKey(e.subject),
            side: e.side,
            facing: e.facing,
          })),
        [] as { characterId: string; side: string; facing: string }[],
      )
    : [];
  return {
    id: p.id,
    name: p.name,
    index: p.index,
    external,
    camera: {
      object: p.camera,
      name: camObj?.name ?? p.camera,
      lens_mm: cam ? round(cam.lens, 3) : null,
      sensor_mm: 36,
    },
    framing: shot?.framing ?? null,
    angle: shot?.angle ?? null,
    height: shot?.height ?? null,
    move: shot?.move ?? null,
    notes: shot?.notes ?? '',
    scene_frames: [p.sceneStart, p.sceneEnd],
    output_frames: p.outFrames,
    timecode_in: timecode(p.outStart, plan.fps),
    timecode_out: timecode(p.outStart + p.outFrames, plan.fps),
    duration_s: round(p.outFrames / plan.fps, 6),
    files,
    blocking_line: shot ? attempt(() => blockingLine(doc, shot, firstFrame), '') : '',
    moves_line: movesLine,
    subjects: subjectIds.map((id) => {
      const o = doc.getObject(id);
      return {
        object: id,
        name: o?.name ?? id,
        role: prop(o, DESK_PROPS.role),
        color: prop(o, DESK_PROPS.color) ?? paletteColor.get(id) ?? null,
        character_id: prop(o, DESK_PROPS.characterId),
        element_id: prop(o, DESK_PROPS.elementId),
      };
    }),
    camera_track: tracks?.camera ?? [],
    subject_tracks: Object.fromEntries(
      [...(tracks?.subjects ?? new Map<string, SubjectTrackEntry[]>())].map(([id, list]) => [
        trackKey(id),
        list,
      ]),
    ),
    rideo: {
      clip: external?.clip ?? null,
      shot: external?.shot ?? null,
      camera_move: shot?.move ?? null,
      layout,
      moves: movesLine,
    },
  };
}

/** The store models' credits: every object with store attribution (store_id, licence, author, source). */
export function credits(doc: SceneDoc): {
  object: string;
  name: string;
  store_id: string | null;
  license: string | null;
  author: string | null;
  source_url: string | null;
}[] {
  return doc
    .listObjects()
    .filter((o) => prop(o, DESK_PROPS.storeId) || prop(o, DESK_PROPS.license))
    .map((o) => ({
      object: o.id,
      name: o.name,
      store_id: prop(o, DESK_PROPS.storeId),
      license: prop(o, DESK_PROPS.license),
      author: prop(o, DESK_PROPS.author),
      source_url: prop(o, DESK_PROPS.sourceUrl),
    }));
}

/** The manifest of an export (a plain JSON value). */
export function buildManifest(input: ManifestInput): Record<string, unknown> {
  const { plan, doc } = input;
  const shotIds = plan.shots.map((s) => s.shot?.id).filter((s): s is string => !!s);
  const issues: DeskIssue[] = shotIds.length
    ? attempt(() => checkShots(doc, { shots: shotIds }).issues, [])
    : [];
  return {
    version: MANIFEST_VERSION,
    project: input.project,
    created_at: input.createdAt,
    fps: plan.fps,
    width: plan.width,
    height: plan.height,
    aspect: round(plan.width / plan.height, 6),
    frames: plan.frames,
    duration_s: round(plan.frames / plan.fps, 6),
    codec: input.codec,
    color: { matrix: 'bt709', primaries: 'bt709', transfer: 'bt709', range: 'limited' },
    look: input.look,
    quality: input.quality,
    passes: [...input.passes],
    files: input.files,
    credits: credits(doc),
    issues,
    warnings: [...input.warnings],
    mask_palette: input.palette.map((e) => ({
      index: e.index,
      object: e.object,
      name: e.name,
      role: e.role,
      color: hex(e.color),
    })),
    shots: plan.shots.map((p, i) => shotEntry(input, p, input.tracks[i])),
  };
}
