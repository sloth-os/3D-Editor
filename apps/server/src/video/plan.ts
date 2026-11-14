import {
  findShotIndex,
  getDeskSettings,
  getShots,
  shotOutputFrames,
  type SceneDoc,
  type ShotData,
} from '@3d-editor/core';
import { NotFoundError, ToolError } from '../mcp/agent';
import { exportSize, type VideoExportParams } from './params';

/*
 * What a video export renders (SPEC §5, §9): the shots in cut order (or one frame range), each
 * with its camera, scene frames and place in the output sequence. The output may run at another
 * rate than the scene (frames are then evaluated at fractional scene frames), and with
 * match_model_duration a shot is trimmed or padded (its last frame held) to the video model's
 * duration limits of the desk settings.
 */

/** Most frames one export writes (about 70 minutes at 24 fps). */
export const MAX_EXPORT_FRAMES = 100_000;

/** One shot of an export. */
export interface PlannedShot {
  /** The shot's id ('range' for a frame range export). */
  id: string;
  name: string;
  /** Position in the export (0-based). */
  index: number;
  /** The shot as the snapshot stores it (null for a frame range). */
  shot: ShotData | null;
  /** Camera object id. */
  camera: string;
  /** Scene frames of the shot (inclusive). */
  sceneStart: number;
  sceneEnd: number;
  /** First frame of the shot in the output sequence. */
  outStart: number;
  /** Frames of the shot in the output. */
  outFrames: number;
  /** Frames rendered: the first `renderFrames` of the output; the rest repeat the last one. */
  renderFrames: number;
  /** Base of the shot's file names (e.g. 'shot-01-opening'). */
  slug: string;
}

/** The whole export. */
export interface ExportPlan {
  shots: PlannedShot[];
  /** Output frames in all. */
  frames: number;
  /** Output rate and the scene's. */
  fps: number;
  sceneFps: number;
  width: number;
  height: number;
  /** Shots trimmed or padded (match_model_duration), as warnings. */
  warnings: string[];
}

/** The scene frame shown at output frame `k` of a shot (fractional when the rates differ). */
export function sceneFrameAt(
  plan: Pick<ExportPlan, 'fps' | 'sceneFps'>,
  shot: PlannedShot,
  k: number,
): number {
  const i = Math.min(k, shot.renderFrames - 1);
  const f = Math.min(shot.sceneEnd, shot.sceneStart + (i * plan.sceneFps) / plan.fps);
  return Math.abs(f - Math.round(f)) < 1e-9 ? Math.round(f) : f;
}

/** A file-name-safe slug of a name (lower case ASCII letters, digits and dashes; at most 32). */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '');
  return s;
}

function cameraObject(doc: SceneDoc, ref: string | null | undefined): string | null {
  if (!ref) return null;
  const o = doc.resolveObject(ref);
  return o && o.type === 'CAMERA' ? o.id : null;
}

/** Output frames of `sceneFrames` scene frames at another rate (at least 1). */
function outputFrames(sceneFrames: number, sceneFps: number, fps: number): number {
  return Math.max(1, Math.round((sceneFrames * fps) / sceneFps));
}

/**
 * The plan of an export of `doc` (a snapshot) with these parameters. Throws a ToolError
 * (INVALID_PARAMS / NOT_FOUND) for shots or cameras that do not exist, and for exports that are too
 * long.
 */
export function planExport(doc: SceneDoc, params: VideoExportParams): ExportPlan {
  const scene = doc.getScene();
  const sceneFps = scene.fps > 0 && Number.isFinite(scene.fps) ? scene.fps : 24;
  const fps = params.fps ?? sceneFps;
  // preset 'rideo': rideo's frame size, which rideo_import sets as the render resolution (at 100 %)
  const render = doc.getRender();
  const { width, height } = exportSize(
    params.preset === 'rideo' ? { ...render, resolution_percentage: 100 } : render,
    params.width,
    params.height,
  );
  const sceneCamera = cameraObject(doc, scene.camera);
  const all = getShots(doc);
  const rangeMode =
    params.shots === undefined &&
    (params.frame_start !== undefined ||
      params.frame_end !== undefined ||
      params.camera !== undefined ||
      !all.some((s) => s.enabled));
  const planned: Omit<PlannedShot, 'outStart' | 'index' | 'slug'>[] = [];
  if (rangeMode) {
    const start = Math.round(params.frame_start ?? scene.frame_start);
    const end = Math.round(params.frame_end ?? scene.frame_end);
    if (end < start)
      throw new ToolError(`frame_end (${end}) is before frame_start (${start})`, 'INVALID_PARAMS');
    let camera = sceneCamera;
    if (params.camera !== undefined) {
      camera = cameraObject(doc, params.camera);
      if (!camera)
        throw new NotFoundError(`Camera '${params.camera}' not found (a CAMERA object id or name)`);
    }
    if (!camera)
      throw new ToolError(
        'The scene has no camera: add one and make it the scene camera (set_active_camera), pass `camera`, or add shots',
        'INVALID_PARAMS',
      );
    const n = outputFrames(end - start + 1, sceneFps, fps);
    planned.push({
      id: 'range',
      name: `Frames ${start}–${end}`,
      shot: null,
      camera,
      sceneStart: start,
      sceneEnd: end,
      outFrames: n,
      renderFrames: n,
    });
  } else {
    let chosen: ShotData[];
    if (params.shots === undefined || params.shots === 'all') chosen = all.filter((s) => s.enabled);
    else {
      const picked = new Set<number>();
      for (const ref of params.shots) {
        const i = findShotIndex(all, ref);
        if (i < 0)
          throw new NotFoundError(
            `Shot '${ref}' not found (shots: ${all.map((s) => s.name).join(', ') || 'none'})`,
          );
        picked.add(i);
      }
      // in cut order, each once
      chosen = [...picked].sort((a, b) => a - b).map((i) => all[i]);
    }
    if (!chosen.length) throw new ToolError('No shot to export: every shot is disabled', 'INVALID_PARAMS');
    for (const shot of chosen) {
      const camera = shot.camera ?? sceneCamera;
      if (!camera)
        throw new ToolError(
          `Shot '${shot.name}' has no camera and the scene has none: solve it (desk.shot_solve) or set its camera`,
          'INVALID_PARAMS',
        );
      const n = outputFrames(shotOutputFrames(shot), sceneFps, fps);
      planned.push({
        id: shot.id,
        name: shot.name,
        shot,
        camera,
        sceneStart: shot.frame_start,
        sceneEnd: shot.frame_end,
        outFrames: n,
        renderFrames: n,
      });
    }
  }
  const warnings: string[] = [];
  if (params.match_model_duration) {
    const desk = getDeskSettings(doc);
    for (const p of planned) {
      const seconds = p.outFrames / fps;
      const target = Math.min(desk.max_shot_s ?? Infinity, Math.max(desk.min_shot_s ?? 0, seconds));
      const frames = Math.max(1, Math.round(target * fps));
      if (frames === p.outFrames) continue;
      if (frames < p.outFrames) {
        p.renderFrames = frames;
        warnings.push(
          `duration_clamped: shot '${p.name}' (${seconds.toFixed(2)} s) was trimmed to ${(frames / fps).toFixed(2)} s, the video model's longest take`,
        );
      } else
        warnings.push(
          `duration_clamped: shot '${p.name}' (${seconds.toFixed(2)} s) was padded to ${(frames / fps).toFixed(2)} s, the video model's shortest take, by holding its last frame`,
        );
      p.outFrames = frames;
    }
  }
  const shots: PlannedShot[] = [];
  let at = 0;
  const used = new Set<string>();
  planned.forEach((p, index) => {
    const base = p.shot
      ? `shot-${String(index + 1).padStart(2, '0')}${slugify(p.name) ? `-${slugify(p.name)}` : ''}`
      : 'range';
    let slug = base;
    for (let k = 2; used.has(slug); k++) slug = `${base}-${k}`;
    used.add(slug);
    shots.push({ ...p, index, outStart: at, slug });
    at += p.outFrames;
  });
  if (at > MAX_EXPORT_FRAMES)
    throw new ToolError(
      `The export would have ${at} frames (at most ${MAX_EXPORT_FRAMES}): export fewer shots or a shorter range`,
      'INVALID_PARAMS',
    );
  return { shots, frames: at, fps, sceneFps, width, height, warnings };
}
