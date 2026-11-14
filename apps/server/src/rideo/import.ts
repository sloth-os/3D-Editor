import {
  DESK_ANGLES,
  DESK_FRAMINGS,
  DESK_HEIGHTS,
  DESK_MOVES,
  MAX_SHOT_LAYOUT,
  MAX_SHOT_NOTES,
  MAX_SHOT_SUBJECTS,
  getShots,
  type OperatorRegistry,
  type RunResult,
  type SceneDoc,
} from '@3d-editor/core';
import { ToolError } from '../mcp/agent';
import { RideoError, type RideoClient } from './client';
import {
  type RideoBlockingView,
  type RideoCharacter,
  type RideoClip,
  type RideoConfig,
  type RideoElement,
  type RideoProject,
  type RideoShot,
} from './schemas';

/*
 * rideo_import (SPEC §11): a rideo clip read through rideo's document routes (project.json for the
 * fps, resolution and desk settings, the clip for its shots, the blocking route for the completed
 * draft, the cast's and elements' documents) and handed to the core operator
 * desk.import_rideo_blocking, which builds or updates the scene as one undo step. What the import
 * cannot fix is reported: a clip without blocking yet, rideo's desk off (its first frames are then not
 * drawn from any staging), storyboard frames drawn before this staging, missing documents.
 */

export const IMPORT_OPERATOR = 'desk.import_rideo_blocking';
export const EXPORT_OPERATOR = 'desk.export_rideo_blocking';
/** Documents read at once from rideo. */
const PARALLEL_READS = 6;

/** A project of ours an operator runs in (the agent's, one undo step; or a room's, for REST). */
export interface ProjectRunner {
  readonly id: string;
  readonly doc: SceneDoc;
  run(operator: string, params?: unknown): RunResult;
}

/** Everything the import reads of a rideo clip. */
export interface RideoClipDocs {
  project: RideoProject;
  clip: RideoClip;
  view: RideoBlockingView;
  characters: RideoCharacter[];
  elements: RideoElement[];
  /** Cast and element documents rideo does not have (422/404), as notes. */
  missing: string[];
  /**
   * The durations rideo clamps the project's takes to (its video model's limits, /api/config),
   * or null when rideo did not say (an older rideo, a token that may not read the config).
   */
  limits: ModelLimits | null;
}

/** A video model's shortest and longest take (s), as desk.import_rideo_blocking's model_limits. */
export interface ModelLimits {
  min_s: number;
  max_s: number;
}

/** rideo's clamp when its model names no limit (shared prompt/index.ts DEFAULT_VIDEO_LIMITS). */
export const RIDEO_DEFAULT_VIDEO_LIMITS: Readonly<ModelLimits> = { min_s: 4, max_s: 10 };

/**
 * The durations rideo clamps a project's takes to (prompt/index.ts clampDuration with the gateway's
 * limitsFor('video', settings.models.video)): the limits of the project's video model, the first
 * model's for 'auto', each bound rideo's default where the model names none.
 */
export function videoLimits(config: RideoConfig, project: RideoProject): ModelLimits {
  const model = project.settings.models.video;
  const entries = config.models.video;
  const entry = model && model !== 'auto' ? entries.find((e) => e.id === model) : entries[0];
  const lim = entry?.limits;
  const min = lim?.min_duration_seconds;
  const max = lim?.max_duration_seconds;
  return {
    min_s: typeof min === 'number' && min > 0 ? min : RIDEO_DEFAULT_VIDEO_LIMITS.min_s,
    max_s: typeof max === 'number' && max > 0 ? max : RIDEO_DEFAULT_VIDEO_LIMITS.max_s,
  };
}

async function inBatches<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

/** A document rideo does not have answers 422 ("no document at …") or 404. */
const isMissing = (err: unknown) => err instanceof RideoError && (err.status === 422 || err.status === 404);

/** Reads a rideo clip and what its import needs (project settings, blocking draft, cast, elements). */
export async function readClipDocs(
  client: RideoClient,
  project: string,
  clipId: string,
): Promise<RideoClipDocs> {
  const [proj, clip, view, config] = await Promise.all([
    client.project(project),
    client.clip(project, clipId),
    client.blocking(project, clipId),
    // best effort: without the limits the import keeps the desk's own
    client.config().catch(() => null),
  ]);
  const castIds = [
    ...new Set([
      ...clip.shots.flatMap((s) => s.characterIds),
      ...view.draft.actors.map((a) => a.characterId),
    ]),
  ];
  const elementIds = [
    ...new Set(
      [
        ...clip.shots.flatMap((s) => s.elementIds),
        ...view.draft.props.map((p) => p.elementId),
        ...view.draft.set.landmarks.map((l) => l.elementId),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
  const missing: string[] = [];
  const characters = (
    await inBatches(castIds, PARALLEL_READS, async (id) => {
      try {
        return await client.character(project, id);
      } catch (err) {
        if (!isMissing(err)) throw err;
        missing.push(`rideo has no character document ${id}: imported without its name and description`);
        return null;
      }
    })
  ).filter((c): c is RideoCharacter => !!c);
  const elements = (
    await inBatches(elementIds, PARALLEL_READS, async (id) => {
      try {
        return await client.element(project, id);
      } catch (err) {
        if (!isMissing(err)) throw err;
        missing.push(`rideo has no element document ${id}: imported by its blocking label only`);
        return null;
      }
    })
  ).filter((e): e is RideoElement => !!e);
  return {
    project: proj,
    clip,
    view,
    characters,
    elements,
    missing,
    limits: config ? videoLimits(config, proj) : null,
  };
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

/** The state of a shot's storyboard frame: none, drawn (not approved) or approved. */
export function boardState(shot: Pick<RideoShot, 'board'>): 'none' | 'drawn' | 'approved' {
  if (!shot.board) return 'none';
  return shot.board.approved ? 'approved' : 'drawn';
}

/** The camera description of a shot in the blocking draft (its spec), when it has one. */
function specOf(view: RideoBlockingView, shotId: string): { angle?: unknown; height?: unknown } {
  const s = view.draft.shots[shotId] as { spec?: { angle?: unknown; height?: unknown } | null } | undefined;
  return s?.spec ?? {};
}

/** rideo's element kinds the importer reads (element.ts ElementKindSchema). */
const ELEMENT_KINDS = ['location', 'prop', 'style'] as const;

/** A character's identity fields with text (rideo's IdentitySchema), or null when it has none. */
export function identityFields(identity: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(identity))
    if (typeof v === 'string' && v.trim()) out[k.slice(0, 64)] = v.trim().slice(0, 4000);
  return Object.keys(out).length ? out : null;
}

/** Which parameters an operator takes (its schema's top-level keys), or null when unknown. */
export function operatorKeys(registry: OperatorRegistry, id: string): Set<string> | null {
  const schema = registry.get(id)?.schema as { shape?: Record<string, unknown> } | undefined;
  return schema?.shape ? new Set(Object.keys(schema.shape)) : null;
}

export interface ImportOptions {
  cast_overrides?: Record<string, string>;
  /** Props and landmarks as built-in store models (default: as the importer decides). */
  use_store_models?: boolean;
  /** The video model's duration limits (default: rideo's, read from its /api/config). */
  model_limits?: ModelLimits;
}

/**
 * The parameters of desk.import_rideo_blocking for a rideo clip (its shots in rideo order, the cast,
 * the elements, the project's fps and resolution, the completed blocking draft); `accepts` limits
 * them to what the operator takes. Returns the notes of what was left out.
 */
export function importParams(
  docs: RideoClipDocs,
  opts: ImportOptions,
  accepts: Set<string> | null,
): { params: Record<string, unknown>; notes: string[] } {
  const notes: string[] = [];
  const { project, clip, view } = docs;
  const heights = new Map(view.draft.actors.map((a) => [a.characterId, a.heightM]));
  const shots = [...clip.shots]
    .sort((a, b) => a.index - b.index)
    .map((s) => {
      const spec = specOf(view, s.id);
      if (s.characterIds.length > MAX_SHOT_SUBJECTS)
        notes.push(
          `shot ${s.index + 1} has ${s.characterIds.length} characters: the first ${MAX_SHOT_SUBJECTS} were imported`,
        );
      const notesText = [s.description, s.action].filter((t) => t.trim()).join('\n');
      return {
        id: s.id,
        index: s.index,
        duration_s: s.durationSec,
        framing: oneOf(DESK_FRAMINGS, s.camera.framing),
        angle: oneOf(DESK_ANGLES, spec.angle),
        height: oneOf(DESK_HEIGHTS, spec.height),
        move: oneOf(DESK_MOVES, s.camera.move),
        movement: s.camera.movement ? s.camera.movement.slice(0, 40) : null,
        lens_mm: typeof s.camera.lensMm === 'number' ? s.camera.lensMm : null,
        character_ids: s.characterIds.slice(0, MAX_SHOT_SUBJECTS),
        element_ids: s.elementIds.slice(0, 64),
        layout: s.layout
          .slice(0, MAX_SHOT_LAYOUT)
          .map((l) => ({ character_id: l.characterId, side: l.side, facing: l.facing })),
        continuity: s.continuity,
        ...(notesText ? { notes: notesText.slice(0, MAX_SHOT_NOTES) } : {}),
        board_state: boardState(s),
      };
    });
  const known = new Set(docs.characters.map((c) => c.id));
  const characters = [
    ...docs.characters.map((c) => {
      const identity = identityFields(c.identity);
      return {
        id: c.id,
        name: c.name.slice(0, 200),
        ...(c.summary ? { summary: c.summary.slice(0, 4000) } : {}),
        ...(identity ? { identity } : {}),
        ...(heights.has(c.id) ? { height_m: Math.min(10, Math.max(0.1, heights.get(c.id)!)) } : {}),
      };
    }),
    // a cast member without a document still has its marks: it comes in under its id
    ...[...heights.keys()]
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: id, height_m: Math.min(10, Math.max(0.1, heights.get(id)!)) })),
  ];
  const elements = docs.elements.map((e) => ({
    id: e.id,
    name: e.name.slice(0, 200),
    ...(oneOf(ELEMENT_KINDS, e.kind) ? { kind: e.kind } : {}),
    ...(e.description ? { summary: e.description.slice(0, 4000) } : {}),
  }));
  const aspect = project.settings.aspectRatio;
  const params: Record<string, unknown> = {
    blocking: view.draft,
    // 'missing': rideo's draft is its placeholder row; the importer then places the cast itself
    state: view.state,
    shots,
    characters,
    elements,
    settings: {
      fps: Math.round(project.settings.fps),
      width: project.settings.resolution.width,
      height: project.settings.resolution.height,
      ...(typeof aspect === 'string' && aspect.length <= 10 ? { aspect_ratio: aspect } : {}),
    },
    project: project.id,
    clip: clip.id,
    update: true,
    // without limits the importer keeps the desk's own (it never clears them)
    ...((opts.model_limits ?? docs.limits) ? { model_limits: opts.model_limits ?? docs.limits } : {}),
    ...(opts.cast_overrides && Object.keys(opts.cast_overrides).length
      ? { cast_overrides: opts.cast_overrides }
      : {}),
    ...(opts.use_store_models !== undefined ? { use_store_models: opts.use_store_models } : {}),
  };
  if (accepts)
    for (const k of Object.keys(params))
      if (!accepts.has(k)) {
        if (k === 'use_store_models')
          notes.push(
            "this server's importer has no use_store_models option: it chooses built-in models itself",
          );
        delete params[k];
      }
  return { params, notes };
}

/** What rideo's settings and state mean for the import and the later push (the import's warnings). */
export function clipNotes(docs: RideoClipDocs): {
  warnings: string[];
  boards: { rideo_shot: string; index: number; approved: boolean }[];
} {
  const { project, clip, view } = docs;
  const warnings: string[] = [];
  // (the importer says where it put the cast and how it made the cameras)
  if (view.state === 'missing')
    warnings.push(
      'rideo has no blocking for this clip yet: once it is staged here, rideo_push writes it back',
    );
  else if (view.state === 'incomplete')
    warnings.push("rideo's blocking of this clip is incomplete: rideo's completed draft was imported");
  const desk = project.settings.blocking;
  if (!desk.enabled)
    warnings.push(
      "rideo's director's desk is off for this project (settings.blocking.enabled): rideo draws its first frames without any staging, so rideo_push defaults every reference to mode 'camera'; turn the desk on in rideo to use 'pose' and 'motion'",
    );
  else if (!desk.layoutImage)
    warnings.push(
      "rideo does not show its image model the desk's camera view (settings.blocking.layoutImage is off)",
    );
  const boards = [...clip.shots]
    .sort((a, b) => a.index - b.index)
    .filter((s) => s.board)
    .map((s) => ({ rideo_shot: s.id, index: s.index, approved: !!s.board?.approved }));
  if (boards.length && desk.enabled) {
    const approved = boards.filter((b) => b.approved).map((b) => b.index + 1);
    warnings.push(
      `shot(s) ${boards.map((b) => b.index + 1).join(', ')} have storyboard frames drawn before this staging${approved.length ? ` (approved: ${approved.join(', ')})` : ''}: redraw them in rideo once rideo_push has written the blocking; references of approved ones default to mode 'camera'`,
    );
  }
  return { warnings, boards };
}

/** Our shots imported from a rideo clip, by rideo shot id (enabled ones first). */
export function importedShots(doc: SceneDoc, clipId: string): Record<string, string> {
  const out: Record<string, string> = {};
  const shots = getShots(doc).filter(
    (s) =>
      s.external?.source === 'rideo' && s.external.shot && (!s.external.clip || s.external.clip === clipId),
  );
  for (const s of [...shots.filter((x) => x.enabled), ...shots.filter((x) => !x.enabled)])
    out[s.external!.shot!] ??= s.id;
  return out;
}

/** Whether a project already holds shots imported from another rideo clip than `clipId`. */
export function otherClips(doc: SceneDoc, clipId: string): string[] {
  return [
    ...new Set(
      getShots(doc)
        .filter((s) => s.external?.source === 'rideo' && s.external.clip && s.external.clip !== clipId)
        .map((s) => s.external!.clip!),
    ),
  ];
}

export interface RideoImportResult {
  project: string;
  project_name: string;
  /** The project was created for this import. */
  created: boolean;
  rideo: { url: string; project: string; clip: string; title: string };
  /** Our shot id of each rideo shot. */
  shots: Record<string, string>;
  /** rideo shots with no shot here after the import (the importer left them out). */
  unmapped: string[];
  /** What the importer found (DeskIssue list), as it reports it. */
  issues: unknown[];
  /** rideo's own issues with its blocking draft. */
  rideo_issues: { code: string; severity: string; shot: string | null; message: string }[];
  blocking_state: 'missing' | 'incomplete' | 'ready';
  desk: { enabled: boolean; layout_image: boolean };
  boards_to_redraw: { rideo_shot: string; index: number; approved: boolean }[];
  /** The importer's own result (actors, objects …). */
  result: unknown;
  warnings: string[];
}

/** Runs desk.import_rideo_blocking for a clip in a project and reports what it made. */
export function runImport(
  runner: ProjectRunner,
  docs: RideoClipDocs,
  opts: ImportOptions & { registry: OperatorRegistry; url: string; created: boolean; projectName: string },
): RideoImportResult {
  const { params, notes } = importParams(docs, opts, operatorKeys(opts.registry, IMPORT_OPERATOR));
  const res = runner.run(IMPORT_OPERATOR, params);
  if (!res.ok)
    throw new ToolError(`${IMPORT_OPERATOR} failed: ${res.error ?? 'unknown error'}`, res.code ?? 'FAILED');
  const { warnings, boards } = clipNotes(docs);
  const shots = importedShots(runner.doc, docs.clip.id);
  const unmapped = docs.clip.shots.map((s) => s.id).filter((id) => !shots[id]);
  const out = (res.result ?? null) as { issues?: unknown; warnings?: unknown } | null;
  // the importer's warnings: all of them from its result (its reports stop after 20)
  const imported = Array.isArray(out?.warnings)
    ? out.warnings.filter((w): w is string => typeof w === 'string')
    : res.reports.filter((r) => r.level !== 'INFO').map((r) => r.message);
  for (const o of otherClips(runner.doc, docs.clip.id))
    warnings.push(`the project also holds shots imported from rideo clip ${o}`);
  return {
    project: runner.id,
    project_name: opts.projectName,
    created: opts.created,
    rideo: { url: opts.url, project: docs.project.id, clip: docs.clip.id, title: docs.clip.title },
    shots,
    unmapped,
    issues: Array.isArray(out?.issues) ? out.issues : [],
    rideo_issues: docs.view.issues.map((i) => ({
      code: i.code,
      severity: i.severity,
      shot: i.shotId,
      message: i.message,
    })),
    blocking_state: docs.view.state,
    desk: {
      enabled: docs.project.settings.blocking.enabled,
      layout_image: docs.project.settings.blocking.layoutImage,
    },
    boards_to_redraw: boards,
    result: res.result ?? null,
    warnings: [
      ...warnings,
      ...docs.missing,
      ...notes,
      ...imported,
      ...(unmapped.length
        ? [`${unmapped.length} rideo shot(s) have no shot here: ${unmapped.join(', ')}`]
        : []),
    ],
  };
}

/** The name of the project a clip is imported into when none is given: the clip's title. */
export function defaultProjectName(clip: Pick<RideoClip, 'id' | 'index' | 'title'>): string {
  const title = clip.title.trim() || `Scene ${clip.index + 1}`;
  return title.slice(0, 200);
}
