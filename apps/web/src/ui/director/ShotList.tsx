import {
  DESK_PROPS,
  deskProp,
  getShots,
  type DeskCheckResult,
  type DeskIssue,
  type ShotData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { run, runResult, viewport } from '../../editor/editor';
import { Panel } from '../fields/fields';
import { lastCheck, panelSelection, selectedShot } from './state';
import { duplicateParams, shotAspect, subjectOf, viewFromCamera, viewFromPose, type ShotView } from './shots';
import { seconds } from './sequence';
import { showShot } from './playback';
import { IconButton, humanize } from './widgets';

/*
 * The shot list of the Director workspace: the shots in cut order (name, length, framing, camera)
 * with the buttons that change the cut. Every change runs a desk operator (one undo step each);
 * selecting a shot is local state (selectedShot).
 */

/**
 * The view a shot added now starts from: the camera the viewport looks through in the camera view,
 * else the viewport's own view; null without a viewport.
 */
export function currentShotView(s: ProjectSession): ShotView | null {
  const e = viewport.engine;
  if (!e) return null;
  const shown = s.view.cameraView.peek() ? e.viewCamera() : null;
  const fromCamera = shown ? viewFromCamera(s.doc, shown.id, s.state.frame) : null;
  return fromCamera ?? viewFromPose(e.pose, e.width / Math.max(1, e.height), shotAspect(s.doc));
}

/**
 * The actors, props and store models among the selected objects, each once: a part counts as its
 * actor or model ({@link subjectOf}).
 */
export function selectedSubjects(s: ProjectSession): string[] {
  const out: string[] = [];
  for (const id of s.state.selectedIds) {
    const subject = subjectOf(s.doc, id);
    if (subject && !out.includes(subject)) out.push(subject);
  }
  return out;
}

/** Adds a shot from the current view (desk.shot_add with from_view) and selects it. */
export function addShotFromView(s: ProjectSession): string | null {
  const view = currentShotView(s);
  const subjects = selectedSubjects(s);
  const r = runResult(
    'desk.shot_add',
    { ...(view ? { from_view: view } : {}), ...(subjects.length ? { subjects } : {}) },
    'ui',
  );
  const id = r?.ok ? ((r.result as { shot?: { id?: string } } | undefined)?.shot?.id ?? null) : null;
  if (id) selectedShot.value = id;
  return id;
}

/** Runs desk.check and keeps its result for the issues list. */
export function checkShots(s: ProjectSession): DeskCheckResult | null {
  const r = runResult('desk.check', {}, 'ui');
  if (!r?.ok) return null;
  const result = r.result as DeskCheckResult;
  lastCheck.value = { session: s, revision: s.revision.peek(), result };
  return result;
}

/** Selects an issue's shot (looking through it at its first frame) and its objects. */
export function pickIssue(s: ProjectSession, issue: DeskIssue): void {
  const shots = getShots(s.doc);
  if (issue.shot && shots.some((x) => x.id === issue.shot)) {
    selectedShot.value = issue.shot;
    showShot(s, issue.shot);
  }
  const objects = issue.objects.filter((id) => !!s.doc.getObject(id));
  if (objects.length) {
    panelSelection.id = objects[0];
    s.state.selectedIds = objects;
    s.state.activeId = objects[0];
  }
}

function ShotRow(p: {
  shot: ShotData;
  index: number;
  active: boolean;
  fps: number;
  camera: string | null;
  issues: { count: number; error: boolean } | null;
  onSelect: () => void;
  onView: () => void;
}) {
  const { shot } = p;
  const frames = shot.frame_end - shot.frame_start + 1;
  const meta = [
    shot.framing ? humanize(shot.framing) : 'No framing',
    p.camera ?? 'no camera',
    `${shot.frame_start}–${shot.frame_end}`,
  ].join(' · ');
  return (
    <div
      role="option"
      aria-selected={p.active}
      class={`shot-row ${p.active ? 'active' : ''} ${shot.enabled ? '' : 'disabled'}`}
      data-testid={`shot-row-${shot.name}`}
      data-shot={shot.id}
      title={shot.notes || shot.name}
      onClick={p.onSelect}
      onDblClick={p.onView}
    >
      <span class="num">{p.index + 1}</span>
      <span class="name">
        {shot.name}
        {!shot.enabled && <span class="hint"> (off)</span>}
        {p.issues && (
          <span
            class={`issues ${p.issues.error ? 'error' : ''}`}
            title={`${p.issues.count} issue${p.issues.count === 1 ? '' : 's'} in the last check`}
          >
            {' '}
            ⚠{p.issues.count}
          </span>
        )}
      </span>
      <span class="dur">{seconds(frames, p.fps)}</span>
      <span class="meta">{meta}</span>
    </div>
  );
}

/** The issues of the last check, or a hint when it is out of date. */
function CheckResults({ s }: { s: ProjectSession }) {
  const c = lastCheck.value;
  if (!c || c.session !== s) return null;
  const stale = c.revision !== s.revision.value;
  const { issues, summary } = c.result;
  const shots = getShots(s.doc);
  const shotName = (id: string | null) => (id ? (shots.find((x) => x.id === id)?.name ?? null) : null);
  return (
    <div data-testid="check-results">
      <div class={`check-summary ${stale ? 'stale' : ''}`} data-testid="check-summary">
        {summary}
        {stale && ' (the scene changed since: check again)'}
      </div>
      {issues.length > 0 && (
        <ul class="check-issues" data-testid="check-issues" aria-label="Continuity issues">
          {issues.map((issue, i) => {
            const name = shotName(issue.shot);
            return (
              <li key={`${issue.code}-${issue.shot}-${i}`}>
                <button
                  type="button"
                  class="check-issue"
                  data-testid={`check-issue-${i}`}
                  data-code={issue.code}
                  title={
                    issue.shot || issue.objects.length
                      ? 'Select the shot and the objects involved'
                      : undefined
                  }
                  onClick={() => pickIssue(s, issue)}
                >
                  <span class={`sev ${issue.severity}`} aria-label={issue.severity} />
                  <span>
                    <span class="code">
                      {issue.code}
                      {name ? ` · ${name}` : ''}
                    </span>
                    <br />
                    {issue.message}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The shot list panel (SPEC §13): the cut, its buttons and the continuity checks. */
export function ShotList({ s }: { s: ProjectSession }) {
  void s.revision.value;
  const shots = getShots(s.doc);
  const fps = Math.max(1, s.doc.getScene().fps || 24);
  const selected = selectedShot.value;
  const index = shots.findIndex((x) => x.id === selected);
  const shot = index >= 0 ? shots[index] : null;
  const check = lastCheck.value;
  const counts = new Map<string, { count: number; error: boolean }>();
  if (check?.session === s && check.revision === s.revision.value)
    for (const issue of check.result.issues) {
      if (!issue.shot) continue;
      const c = counts.get(issue.shot) ?? { count: 0, error: false };
      c.count++;
      c.error ||= issue.severity === 'error';
      counts.set(issue.shot, c);
    }
  const select = (i: number) => {
    const next = shots[Math.max(0, Math.min(shots.length - 1, i))];
    if (next) selectedShot.value = next.id;
  };
  const remove = () => {
    if (!shot) return;
    // the camera made for the shot goes with it (one another shot uses stays: desk.shot_remove)
    const own = !!shot.camera && deskProp(s.doc.getObject(shot.camera), DESK_PROPS.shot) === shot.id;
    const neighbour = shots[index + 1]?.id ?? shots[index - 1]?.id ?? null;
    if (run('desk.shot_remove', { shots: [shot.id], delete_cameras: own }, 'ui'))
      selectedShot.value = neighbour;
  };
  const duplicate = () => {
    if (!shot) return;
    const r = runResult('desk.shot_add', duplicateParams(s.doc, shot, index), 'ui');
    const id = r?.ok ? (r.result as { shot?: { id?: string } } | undefined)?.shot?.id : null;
    if (id) selectedShot.value = id;
  };
  const move = (delta: number) => {
    if (shot) run('desk.shot_move', { shot: shot.id, index: index + delta }, 'ui');
  };
  return (
    <Panel title={`Shots (${shots.length})`} id="director-shots">
      <div
        role="listbox"
        aria-label="Shots in cut order"
        class="shot-list"
        data-testid="shot-list"
        tabIndex={0}
        onKeyDown={(e) => {
          // the list's own keys: not the editor's (frame steps, keyframe jumps)
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            select(index < 0 ? 0 : index + (e.key === 'ArrowDown' ? 1 : -1));
          } else if (e.key === 'Enter' && shot) {
            e.preventDefault();
            e.stopPropagation();
            showShot(s, shot.id);
          }
        }}
      >
        {shots.map((x, i) => (
          <ShotRow
            key={x.id}
            shot={x}
            index={i}
            active={x.id === selected}
            fps={fps}
            camera={x.camera ? (s.doc.getObject(x.camera)?.name ?? null) : null}
            issues={counts.get(x.id) ?? null}
            onSelect={() => (selectedShot.value = x.id)}
            onView={() => showShot(s, x.id)}
          />
        ))}
        {shots.length === 0 && (
          <div class="hint" style={{ padding: '6px 8px' }}>
            No shots yet. Frame the view (or select actors) and press Add.
          </div>
        )}
      </div>
      <div class="shot-actions">
        <IconButton
          icon="cameraAdd"
          label="Add"
          title="Add a shot from the current view (the selected actors, props and models become its subjects)"
          testId="shot-add"
          onClick={() => addShotFromView(s)}
        />
        <IconButton
          icon="copy"
          title="Duplicate the shot (same frames and description, a new camera where its camera stands)"
          testId="shot-duplicate"
          disabled={!shot}
          onClick={duplicate}
        />
        <IconButton
          icon="trash"
          title="Delete the shot (and the camera made for it)"
          testId="shot-delete"
          disabled={!shot}
          onClick={remove}
        />
        <IconButton
          icon="up"
          title="Move the shot earlier in the cut"
          testId="shot-up"
          disabled={!shot || index === 0}
          onClick={() => move(-1)}
        />
        <IconButton
          icon="down"
          title="Move the shot later in the cut"
          testId="shot-down"
          disabled={!shot || index === shots.length - 1}
          onClick={() => move(1)}
        />
        <IconButton
          icon="camera"
          title="Look through the shot at its first frame (double-click a shot, or Enter)"
          testId="shot-view"
          disabled={!shot?.enabled}
          onClick={() => shot && showShot(s, shot.id)}
        />
        <span class="grow" />
        <IconButton
          icon="solve"
          label="Solve"
          title="Solve the selected shot's camera from its framing, angle, height, subjects and lens"
          testId="shot-solve"
          disabled={!shot}
          onClick={() => shot && run('desk.shot_solve', { shots: [shot.id] }, 'ui')}
        />
        <IconButton
          icon="solve"
          label="All"
          title="Solve the cameras of every enabled shot (keeping them on one side of the line)"
          testId="shot-solve-all"
          disabled={!shots.length}
          onClick={() => run('desk.shot_solve', {}, 'ui')}
        />
        <IconButton
          icon="check"
          label="Check"
          title="Check continuity: the line, framing, cameras inside objects, jump cuts, overlaps…"
          testId="shot-check"
          disabled={!shots.length}
          onClick={() => checkShots(s)}
        />
      </div>
      <CheckResults s={s} />
    </Panel>
  );
}
