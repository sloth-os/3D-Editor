import { isActor } from '../desk/characters';
import { DESK_PROPS } from '../desk/props';
import type { SceneDoc } from '../doc/scene-doc';
import type { QualityPreset, VideoExportParams } from './params';
import { sceneFrameAt, type ExportPlan, type PlannedShot } from './plan';
import type { DeskFrameOptions, DeskShotInfo, PassName } from './protocol';
import { stringLineWidth } from './screen';

/*
 * How an export renders its frames, the same on the server (video/exporter.ts) and in the browser
 * (apps/web/src/export): the strings drawn as lines, the actors whose skeletons the pose pass
 * draws, the desk options of a shot's frames, which output frames posters and contact sheet tiles
 * are taken from and how they are labelled.
 */

const linearToSrgb = (c: number): number => {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
};

/** The strings of the snapshot (desk_role 'string'), drawn as lines of at least 2 px. */
export function stringLines(doc: SceneDoc, height: number): NonNullable<DeskFrameOptions['lines']> {
  const width = stringLineWidth(height);
  return doc
    .listObjects()
    .filter((o) => o.custom_props?.[DESK_PROPS.role] === 'string')
    .map((o) => {
      const mat = o.material_slots.map((id) => (id ? doc.getMaterial(id) : null)).find(Boolean);
      const c = mat?.base_color ?? [0.85, 0.85, 0.85, 1];
      return {
        object: o.id,
        width_px: width,
        color: [linearToSrgb(c[0]), linearToSrgb(c[1]), linearToSrgb(c[2])] as [number, number, number],
      };
    });
}

/** The actors (armature objects) whose skeletons the pose pass draws: every actor of the snapshot. */
export function poseActorsOf(doc: SceneDoc): string[] {
  return doc
    .listObjects()
    .filter((o) => isActor(doc, o.id))
    .map((o) => o.id);
}

/** The warning of a pose pass in a scene without actors. */
export const NO_POSE_ACTORS_WARNING =
  "pose pass: the scene has no actors (desk_role 'actor'), so the pose images are black";

/** The desk options of every frame of a shot. */
export function shotDeskOptions(o: {
  look: VideoExportParams['look'];
  preset: QualityPreset;
  passes: PassName[];
  /** The shot's measurement. */
  info: DeskShotInfo;
  objectPalette: Record<string, [number, number, number]>;
  shot: PlannedShot;
  poseActors: string[];
  lines: NonNullable<DeskFrameOptions['lines']>;
}): DeskFrameOptions {
  return {
    look: o.look,
    shadows: o.preset.shadows,
    ao: o.preset.ao,
    msaa: o.preset.msaa,
    shadowFit: o.info.shadowFit ?? undefined,
    aoRadius: o.info.aoRadius,
    passes: o.passes,
    depthRange: o.info.depthRange,
    objectPalette: o.objectPalette,
    subjects: o.shot.shot?.subjects ?? [],
    poseActors: o.poseActors,
    lines: o.lines,
  };
}

/** The scene frames of the frames a shot renders (output frames 0 … renderFrames − 1). */
export function shotRenderFrames(plan: Pick<ExportPlan, 'fps' | 'sceneFps'>, shot: PlannedShot): number[] {
  return Array.from({ length: shot.renderFrames }, (_, i) => sceneFrameAt(plan, shot, i));
}

/** The output frame of a shot its second contact sheet tile shows (its middle). */
export function middleFrame(shot: Pick<PlannedShot, 'outFrames'>): number {
  return Math.floor(shot.outFrames / 2);
}

/**
 * Whether output frame `k` of a shot is one of its contact sheet tiles: its first and its middle
 * frame (one tile for a shot of a single frame).
 */
export function isTileFrame(shot: Pick<PlannedShot, 'outFrames'>, k: number): boolean {
  const middle = middleFrame(shot);
  return (k === 0 || k === middle) && (k === 0 || middle > 0);
}

/** The label of a contact sheet tile: the shot's number and the scene frame shown ('2-37'). */
export function tileLabel(plan: Pick<ExportPlan, 'fps' | 'sceneFps'>, shot: PlannedShot, k: number): string {
  return `${shot.index + 1}-${Math.round(sceneFrameAt(plan, shot, k))}`;
}

/** Tiles per row of a contact sheet of `tiles` tiles (two per shot: pairs side by side). */
export function contactSheetColumns(tiles: number): number {
  const pairs = Math.max(1, Math.round(Math.sqrt(tiles / 2)));
  return Math.min(tiles, 2 * pairs);
}

/** A duration in seconds rounded to microseconds, as files and manifests list them. */
export const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;
