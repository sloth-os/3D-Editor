import * as Y from 'yjs';
import {
  SCHEMA_VERSION,
  SceneDoc,
  checkShots,
  getShots,
  shotResults,
  stageBrief,
  updateFromBrief,
  type BriefIssue,
  type DeskCheckResult,
  type DeskIssue,
  type SceneBrief,
  type ShotResultMeta,
  type StageBriefReport,
} from '@3d-editor/core';
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
 */

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
    }
  | { kind: 'update'; update: Uint8Array; brief: SceneBrief }
  | { kind: 'results'; update: Uint8Array; shots?: string[] }
  | { kind: 'check'; update: Uint8Array };

/** What staging or updating reports, besides the change. */
export interface StagingSummary {
  shots: number;
  warnings: string[];
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
    const before = Y.encodeStateVector(d.ydoc);
    let report: StageBriefReport;
    if (req.kind === 'stage') {
      report = d.transact(() => {
        const meta = d.map('meta');
        meta.set('schema_version', SCHEMA_VERSION);
        meta.set('name', req.brief.name);
        if (!meta.get('created_at')) meta.set('created_at', new Date().toISOString());
        meta.set('generator', req.generator);
        meta.set(LINEAGE_KEY, req.lineage);
        return stageBrief(d, req.brief);
      });
    } else report = updateFromBrief(d, req.brief);
    const diff = Y.encodeStateAsUpdate(d.ydoc, before);
    return {
      ok: true,
      kind: req.kind,
      diff,
      summary: { shots: getShots(d).length, warnings: report.warnings },
      check: checkFromReport(report),
      ms: now() - t0,
    };
  } catch (err) {
    return errorReply(err);
  } finally {
    doc?.destroy();
  }
}
