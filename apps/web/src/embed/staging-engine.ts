import * as Y from 'yjs';
import {
  DESK_PROPS,
  MAX_UNIT_STAGE_M,
  MIN_UNIT_STAGE_M,
  SCHEMA_VERSION,
  SceneDoc,
  SceneEvaluator,
  adoptPublished,
  checkShots,
  createExportRenderDocument,
  evaluatedBounds,
  extractUnit,
  getShots,
  makeLocal,
  renderExportFrame,
  renderItems,
  shotResults,
  stageBrief,
  threeQuarterView,
  thumbnailFrameOptions,
  unitSourceOf,
  updateFromBrief,
  type BriefIssue,
  type DeskCheckResult,
  type DeskIssue,
  type GivenProblem,
  type GivenUnit,
  type SceneBrief,
  type ShotResultMeta,
  type StageBriefReport,
  type StageUnitRow,
  type ThumbnailFraming,
  type UnitHeader,
  type UnitLinkPlan,
  type UnitPublishMeta,
  type UnitSlot,
  type UnitSpec,
} from '@3d-editor/core';
import { MAX_THUMBNAIL_BYTES } from './protocol';
import { LINEAGE_KEY } from './state';

/*
 * The desk's heavy brief work, off the page's main thread (stage.worker.ts runs it; tests and
 * browsers without workers run it in process): staging a brief, updating the staging to a later
 * brief, the shot results and the checks. Each request carries a snapshot of the session's document
 * (a Yjs update); staging and updating answer with the change they made to it (an update that the
 * page applies to the session's document in one transaction: the stage as the scene's start, the
 * update as one undo step) and the desk's checks of the result.
 *
 * Long briefs take long here (B measured, on a main thread: 34 s to stage 200 shots × 12 cast,
 * 13 s for the shot results, 12 s for an update): the page stays responsive meanwhile.
 *
 * Library units (docs/embedding.md "Library units"): a staging or an update may carry the unit
 * files of the open (`units`, checked by the page: units.ts readOpenUnits), given to core as its
 * UnitSource (unitSourceOf: headers read at once, bodies decoded when placed); without them it
 * stages exactly as before. `unit-extract` makes a unit of the scene for Save to library (read only)
 * with its thumbnail, rendered here from the unit alone; `unit-adopt` links the scene to the version
 * the host saved (core adoptPublished); `unit-local` cuts an instance's link (core makeLocal).
 */

/** The library units a staging or an update may place: the files the page checked, and why others are not usable. */
export interface StagingUnits {
  units: GivenUnit[];
  problems: GivenProblem[];
}

/** What a unit is made of for Save to library: the scene's set, or the object (an actor or a prop) `root`. */
export type UnitTarget = { set: true } | { root: string };

export type StagingRequest =
  | {
      kind: 'stage';
      /** The session's document (empty, or holding only what a failed staging left: nothing). */
      update: Uint8Array;
      brief: SceneBrief;
      /** The staging's lineage (state.ts), written into the document's meta. */
      lineage: string;
      /** The document's generator (meta). */
      generator: string;
      /** The open's library units (absent: units are off, every pin is staged from the words). */
      units?: StagingUnits;
    }
  | { kind: 'update'; update: Uint8Array; brief: SceneBrief; units?: StagingUnits }
  | { kind: 'results'; update: Uint8Array; shots?: string[] }
  | { kind: 'check'; update: Uint8Array }
  | {
      kind: 'unit-extract';
      update: Uint8Array;
      what: UnitTarget;
      /** The unit's name (1–120 characters). */
      name: string;
      deskVersion: string;
      /** Render its thumbnail (default true). */
      thumbnail?: boolean;
    }
  | {
      kind: 'unit-adopt';
      update: Uint8Array;
      brief: SceneBrief;
      /** The brief slot the unit came from (the extraction's `from`). */
      slot: UnitSlot | null;
      link: UnitLinkPlan;
      pin: { ref: string; version: number; sha256: string };
      linked: boolean;
      header?: UnitHeader;
    }
  | { kind: 'unit-local'; update: Uint8Array; root: string };

/** What staging or updating reports, besides the change. */
export interface StagingSummary {
  shots: number;
  warnings: string[];
  /** Per library pin of the brief, whether the scene holds it (core's report.units; [] without pins). */
  units: StageUnitRow[];
}

/** A unit made of the scene for Save to library (unit-extract). */
export interface UnitExtract {
  /** The unit file. */
  data: Uint8Array;
  /** The SHA-256 of `data`. */
  sha256: string;
  header: UnitHeader;
  /** The protocol `meta` of unit-publish. */
  meta: UnitPublishMeta;
  /** How the scene is linked to the version once the host saved it (unit-adopt). */
  link: UnitLinkPlan;
  /** The brief slot it came from (null: none). */
  from: UnitSlot | null;
  /** The library version it is a new version of (the instance's), else null. */
  basedOn: { ref: string; version: number } | null;
  warnings: string[];
  /** Its thumbnail: a PNG of at most MAX_THUMBNAIL_BYTES (null: none could be made that small). */
  thumbnail: Uint8Array | null;
  /** The thumbnail's side in pixels (null without one). */
  thumbnailSize: number | null;
}

export type StagingReply =
  | {
      ok: true;
      kind: 'stage' | 'update';
      /** The change to apply to the session's document. */
      diff: Uint8Array;
      summary: StagingSummary;
      /** The desk's checks of the staged shots (as desk.check reports them, desk shot ids). */
      check: DeskCheckResult;
      ms: number;
    }
  | { ok: true; kind: 'results'; results: ShotResultMeta[]; ms: number }
  | { ok: true; kind: 'check'; check: DeskCheckResult; ms: number }
  | ({ ok: true; kind: 'unit-extract'; ms: number } & UnitExtract)
  | {
      ok: true;
      kind: 'unit-adopt';
      diff: Uint8Array;
      root: string;
      /** Whether the record now says the slot holds the version (linked, and the slot is the brief's). */
      recorded: boolean;
      warnings: string[];
      ms: number;
    }
  | { ok: true; kind: 'unit-local'; diff: Uint8Array; root: string; parts: number; ms: number }
  | { ok: false; error: string; code: string };

/** The summary line of a check, as desk.check words it. */
export function checkSummary(shots: number, issues: readonly DeskIssue[]): string {
  const count = (sev: DeskIssue['severity']) => issues.filter((i) => i.severity === sev).length;
  const e = count('error');
  const w = count('warning');
  const n = count('info');
  if (!issues.length) return `${shots} shot${shots === 1 ? '' : 's'} checked: no issues`;
  const codes = [...new Set(issues.map((i) => i.code))].join(', ');
  return `${shots} shot${shots === 1 ? '' : 's'} checked: ${e} error${e === 1 ? '' : 's'}, ${w} warning${w === 1 ? '' : 's'}, ${n} info (${codes})`;
}

/**
 * The checks staging ran, as desk.check reports them (desk shot ids; staging keeps no objects), shown
 * at once: their issues only, without blocking lines or layouts. The workspace runs the full check
 * (a `check` request) right after it applies the staging or the update.
 */
export function checkFromReport(report: StageBriefReport): DeskCheckResult {
  const desk = new Map(report.shots.map((s) => [s.shotId, s.deskShotId]));
  const issues: DeskIssue[] = report.issues.map((i: BriefIssue) => ({
    code: i.code as DeskIssue['code'],
    severity: i.severity,
    shot: i.shotId ? (desk.get(i.shotId) ?? null) : null,
    objects: [],
    message: i.message,
  }));
  return { issues, lines: [], layouts: [], summary: checkSummary(report.shots.length, issues) };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function errorReply(err: unknown): StagingReply {
  const e = err as { message?: unknown; code?: unknown };
  return {
    ok: false,
    error: typeof e?.message === 'string' ? e.message : String(err),
    code: typeof e?.code === 'string' ? e.code : 'FAILED',
  };
}

/** Sides a unit's thumbnail is tried at, largest first: the first PNG of at most MAX_THUMBNAIL_BYTES is kept. */
export const UNIT_THUMBNAIL_SIZES = [256, 192, 128] as const;
/** An object of a set unit with the set's role flatter than this (m) is its ground: the framing leaves it out. */
export const SET_GROUND_FLAT_M = 0.05;
/** The height (m) of the stage box a set's thumbnail frames. */
const STAGE_HEIGHT_M = 1.8;

type Box = { min: [number, number, number]; max: [number, number, number] };

const unionBox = (a: Box | null, b: Box | null): Box | null =>
  !a
    ? b
    : !b
      ? a
      : {
          min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
          max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
        };

/**
 * How a unit's thumbnail frames the unit alone (`probe`: the document extraction made of it, at the
 * origin): a prop or a figure whole, from the three-quarter view of the built-in thumbnails; a set on
 * its stage (its width and depth from the header, clamped as staging clamps them) and what stands on
 * it, leaving out its flat ground (objects with the set's role flatter than SET_GROUND_FLAT_M), which
 * framed whole is hundreds of metres wide and shows the set as a dot.
 */
export function unitThumbnailFraming(probe: SceneDoc, header: UnitHeader): ThumbnailFraming {
  const frame = probe.getScene().frame_start;
  const scene = new SceneEvaluator(probe).evaluate(frame, { forRender: true });
  let items = renderItems(scene, { forRender: true }).filter((o) => o.mesh.faces.length > 0);
  let box: Box | null;
  if (header.kind === 'set') {
    items = items.filter((it) => {
      if (String(it.data.custom_props?.[DESK_PROPS.role] ?? '') !== 'set') return true;
      const b = evaluatedBounds([it]);
      return !b || b.max[2] - b.min[2] >= SET_GROUND_FLAT_M;
    });
    const clamp = (v: number | undefined) =>
      Math.min(MAX_UNIT_STAGE_M, Math.max(MIN_UNIT_STAGE_M, Number.isFinite(v) ? (v as number) : 12));
    const w = clamp(header.set?.width) / 2;
    const d = clamp(header.set?.depth) / 2;
    box = unionBox({ min: [-w, -d, 0], max: [w, d, STAGE_HEIGHT_M] }, evaluatedBounds(items));
  } else box = evaluatedBounds(items);
  return { frame, view: threeQuarterView(box ?? { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 1] }, 1) };
}

/**
 * The thumbnail of a unit (its probe document): a PNG in the built-in thumbnails' look on a
 * transparent background, at the first of UNIT_THUMBNAIL_SIZES whose PNG is at most
 * MAX_THUMBNAIL_BYTES (null when none is, or the render fails: a unit may be published without one).
 */
export function renderUnitThumbnail(
  probe: SceneDoc,
  header: UnitHeader,
  sizes: readonly number[] = UNIT_THUMBNAIL_SIZES,
): { png: Uint8Array; size: number } | null {
  try {
    const framing = unitThumbnailFraming(probe, header);
    const doc = createExportRenderDocument(probe);
    for (const size of sizes) {
      const img = renderExportFrame(doc, thumbnailFrameOptions(framing, size), true);
      if (img.png && img.png.byteLength <= MAX_THUMBNAIL_BYTES) return { png: img.png, size };
    }
  } catch {
    // no thumbnail: the unit goes without one
  }
  return null;
}

/** The unit spec of a Save to library target: the set, an actor's figure, or a prop. */
function unitSpec(doc: SceneDoc, what: UnitTarget, name: string): UnitSpec {
  if ('set' in what) return { kind: 'set', name };
  const o = doc.getObject(what.root);
  return String(o?.custom_props?.[DESK_PROPS.role] ?? '') === 'actor'
    ? { kind: 'figure', actor: what.root, name }
    : { kind: 'prop', root: what.root, name };
}

/** The UnitSource of a request's units (none: units are off). */
const sourceOf = (units: StagingUnits | undefined) =>
  units ? { units: unitSourceOf(units.units, units.problems) } : {};

/** The buffers a reply transfers, each once (a transfer list naming one twice is refused). */
export function replyTransfer(reply: StagingReply): Transferable[] {
  const out = new Set<ArrayBuffer>();
  if (reply.ok) {
    if ('diff' in reply) out.add(reply.diff.buffer as ArrayBuffer);
    if (reply.kind === 'unit-extract') {
      out.add(reply.data.buffer as ArrayBuffer);
      if (reply.thumbnail) out.add(reply.thumbnail.buffer as ArrayBuffer);
    }
  }
  return [...out];
}

/** Runs one request on a document made from its snapshot. */
export function runStaging(req: StagingRequest): StagingReply {
  const t0 = now();
  let doc: SceneDoc | null = null;
  try {
    doc = SceneDoc.fromUpdate(req.update);
    if (req.kind === 'results') {
      const results = shotResults(doc, req.shots?.length ? { shots: req.shots } : {});
      return { ok: true, kind: 'results', results, ms: now() - t0 };
    }
    if (req.kind === 'check') return { ok: true, kind: 'check', check: checkShots(doc), ms: now() - t0 };
    const d = doc;
    if (req.kind === 'unit-extract') {
      const ex = extractUnit(d, unitSpec(d, req.what, req.name), { deskVersion: req.deskVersion });
      try {
        const thumb = req.thumbnail === false ? null : renderUnitThumbnail(ex.probe, ex.header);
        return {
          ok: true,
          kind: 'unit-extract',
          data: ex.data,
          sha256: ex.sha256,
          header: ex.header,
          meta: ex.meta,
          link: ex.link,
          from: ex.from,
          basedOn: ex.basedOn,
          warnings: ex.warnings,
          thumbnail: thumb?.png ?? null,
          thumbnailSize: thumb?.size ?? null,
          ms: now() - t0,
        };
      } finally {
        ex.probe.destroy();
        ex.probe.ydoc.destroy();
      }
    }
    const before = Y.encodeStateVector(d.ydoc);
    if (req.kind === 'unit-adopt') {
      const r = adoptPublished(d, req.brief, {
        slot: req.slot,
        link: req.link,
        pin: req.pin,
        linked: req.linked,
        ...(req.header ? { header: req.header } : {}),
      });
      return {
        ok: true,
        kind: 'unit-adopt',
        diff: Y.encodeStateAsUpdate(d.ydoc, before),
        root: r.root,
        recorded: r.recorded,
        warnings: r.warnings,
        ms: now() - t0,
      };
    }
    if (req.kind === 'unit-local') {
      const r = makeLocal(d, req.root);
      return {
        ok: true,
        kind: 'unit-local',
        diff: Y.encodeStateAsUpdate(d.ydoc, before),
        root: r.root,
        parts: r.parts,
        ms: now() - t0,
      };
    }
    let report: StageBriefReport;
    if (req.kind === 'stage') {
      report = d.transact(() => {
        const meta = d.map('meta');
        meta.set('schema_version', SCHEMA_VERSION);
        meta.set('name', req.brief.name);
        if (!meta.get('created_at')) meta.set('created_at', new Date().toISOString());
        meta.set('generator', req.generator);
        meta.set(LINEAGE_KEY, req.lineage);
        return stageBrief(d, req.brief, sourceOf(req.units));
      });
    } else report = updateFromBrief(d, req.brief, sourceOf(req.units));
    const diff = Y.encodeStateAsUpdate(d.ydoc, before);
    return {
      ok: true,
      kind: req.kind,
      diff,
      summary: { shots: getShots(d).length, warnings: report.warnings, units: report.units },
      check: checkFromReport(report),
      ms: now() - t0,
    };
  } catch (err) {
    return errorReply(err);
  } finally {
    doc?.destroy();
  }
}
