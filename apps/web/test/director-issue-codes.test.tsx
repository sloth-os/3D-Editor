import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import {
  DESK_ISSUE_CODES,
  DESK_ISSUE_SEVERITY,
  SceneDoc,
  SceneEvaluator,
  type DeskCheckResult,
  type DeskIssue,
  type DeskIssueCode,
} from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { ShotList } from '../src/ui/director/ShotList';
import { lastCheck, selectedShot } from '../src/ui/director/state';

/*
 * The Director's issue list shows every code desk.check reports (core DESK_ISSUE_CODES) with the
 * severity core gives it (DESK_ISSUE_SEVERITY), the kite and water codes among them, and marks the
 * shots that have an error; director.css colours every severity.
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

/** A shot over scene frames start..end with its own camera; its id. */
function addShot(name: string, start: number, end: number): string {
  const r = runResult(
    'desk.shot_add',
    {
      name,
      frame_start: start,
      frame_end: end,
      from_view: { position: [0, -8, 1.6], target: [0, 0, 1], lens_mm: 35 },
      solve: false,
    },
    'test',
  );
  if (!r?.ok) throw new Error(`desk.shot_add failed: ${r?.error}`);
  return (r.result as { shot: { id: string } }).shot.id;
}

let s: ProjectSession;
beforeEach(() => {
  s = fakeSession();
  sessionSignal.value = s;
  selectedShot.value = null;
  lastCheck.value = null;
});
afterEach(() => {
  cleanup();
  lastCheck.value = null;
  sessionSignal.value = null;
});

describe("the Director's issue list", () => {
  it('shows every code of desk.check with its severity, and the shots with an error', () => {
    const kites = addShot('Kites', 1, 24);
    const lake = addShot('Lake', 25, 48);
    // the kite and water codes on shots: errors on one, warnings on the other; the rest scene-wide
    const shotOf: Partial<Record<DeskIssueCode, string>> = {
      tether_detached: kites,
      walks_on_water: kites,
      subject_revealed: lake,
      body_in_water: lake,
    };
    const issues: DeskIssue[] = DESK_ISSUE_CODES.map((code) => ({
      code,
      severity: DESK_ISSUE_SEVERITY[code],
      shot: shotOf[code] ?? null,
      objects: [],
      message: `${code} message`,
    }));
    const result: DeskCheckResult = { issues, lines: [], layouts: [], summary: 'checked' };
    lastCheck.value = { session: s, revision: s.revision.peek(), result };
    const ui = render(<ShotList s={s} />);
    const q = (id: string) => ui.container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

    expect(ui.container.querySelectorAll('[data-testid^="check-issue-"]').length).toBe(
      DESK_ISSUE_CODES.length,
    );
    DESK_ISSUE_CODES.forEach((code, i) => {
      const row = q(`check-issue-${i}`)!;
      expect(row.dataset.code).toBe(code);
      const sev = row.querySelector('.sev')!;
      expect([...sev.classList].sort(), code).toEqual(['sev', DESK_ISSUE_SEVERITY[code]].sort());
      expect(sev.getAttribute('aria-label')).toBe(DESK_ISSUE_SEVERITY[code]);
      const shot = shotOf[code] === kites ? ' · Kites' : shotOf[code] === lake ? ' · Lake' : '';
      expect(row.querySelector('.code')?.textContent).toBe(`${code}${shot}`);
      expect(row.textContent).toContain(`${code} message`);
    });
    expect(DESK_ISSUE_SEVERITY).toMatchObject({
      tether_detached: 'error',
      walks_on_water: 'error',
      subject_revealed: 'warning',
      body_in_water: 'warning',
    });
    // a shot with an error is marked as one; warnings only are not
    const kitesIssues = q('shot-row-Kites')!.querySelector('.issues')!;
    expect(kitesIssues.textContent?.trim()).toBe('⚠2');
    expect(kitesIssues.classList.contains('error')).toBe(true);
    const lakeIssues = q('shot-row-Lake')!.querySelector('.issues')!;
    expect(lakeIssues.textContent?.trim()).toBe('⚠2');
    expect(lakeIssues.classList.contains('error')).toBe(false);
  });

  it('director.css colours every severity core gives', () => {
    const css = readFileSync(resolve(__dirname, '../src/ui/director/director.css'), 'utf8');
    for (const severity of new Set(Object.values(DESK_ISSUE_SEVERITY)))
      expect(css, severity).toMatch(
        new RegExp(`\\.check-issue \\.sev\\.${severity} \\{\\s*background: [^;]+;`),
      );
  });
});
