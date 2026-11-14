import {
  DESK_ANGLES,
  DESK_CONTINUITIES,
  DESK_FACINGS,
  DESK_FRAMINGS,
  DESK_HEIGHTS,
  DESK_MOVES,
  DESK_SIDES,
  MAX_PRE_ROLL,
  MAX_SHOT_LAYOUT,
  MAX_SHOT_NAME,
  MAX_SHOT_NOTES,
  MAX_SHOT_SUBJECTS,
  SHOT_LENS_MAX,
  SHOT_LENS_MIN,
  type DeskFacing,
  type DeskLayoutEntry,
  type DeskSide,
  type ShotData,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { toast } from '../../app/store';
import { run } from '../../editor/editor';
import { shotsOf } from '../../viewport/follow-shots';
import { Checkbox, Panel, Row, SelectField, TextField } from '../fields/fields';
import { lastCheck } from './state';
import { subjectCandidates } from './shots';
import { seconds } from './sequence';
import { CommitNumber, IconButton, NotesField, humanize } from './widgets';

/*
 * The shot inspector: every field of the selected shot. Each edit runs desk.shot_update on that shot
 * (one undo step; a new framing, angle, height, move, lens, subjects or layout solves its camera
 * again, as the operator does).
 */

const NONE = '';

/** Options of an optional enum field ('—' for none). */
function enumOptions(values: readonly string[], none: string): { value: string; label: string }[] {
  return [{ value: NONE, label: none }, ...values.map((v) => ({ value: v, label: humanize(v) }))];
}

/** Runs desk.shot_update for one shot. */
export function updateShot(shotId: string, patch: Record<string, unknown>): boolean {
  return run('desk.shot_update', { shot: shotId, ...patch }, 'ui');
}

/** How much of a lost text a toast quotes. */
const QUOTED_CHARS = 160;

/**
 * Runs desk.shot_update for `shot` when it is still in the scene. A field can commit after the shot
 * went away (an agent or another device removed it while the person typed; a text field commits on
 * blur, which comes after): then nothing runs, and a toast names the shot (not its id) and, for
 * typed text, quotes what was not saved so that it can be typed again.
 */
export function updateShownShot(
  s: ProjectSession,
  shot: Pick<ShotData, 'id' | 'name'>,
  patch: Record<string, unknown>,
  typed?: string,
): boolean {
  if (shotsOf(s.doc).some((x) => x.id === shot.id)) return updateShot(shot.id, patch);
  const text = typed?.trim() ?? '';
  const quote = text.length > QUOTED_CHARS ? `${text.slice(0, QUOTED_CHARS - 1)}…` : text;
  toast(
    `Shot '${shot.name}' was removed meanwhile (by an agent or on another device): ` +
      (quote ? `what you typed was not saved: “${quote}”` : 'the change was not saved'),
    'warning',
    quote ? 12_000 : 6000,
  );
  return false;
}

/** The planned layout as desk.shot_update takes it. */
const layoutParam = (layout: readonly DeskLayoutEntry[]) =>
  layout.map((e) => ({ subject: e.subject, side: e.side, facing: e.facing }));

/** A planned side for the n-th row: left, right, centre, then left again. */
const sideFor = (n: number): DeskSide => (['left', 'right', 'centre'] as const)[n % 3];

function Subjects({ s, shot }: { s: ProjectSession; shot: ShotData }) {
  const candidates = subjectCandidates(s.doc);
  // subjects that are not candidates (any object can be one) are listed too
  for (const id of shot.subjects)
    if (!candidates.some((c) => c.id === id)) {
      const o = s.doc.getObject(id);
      if (o) candidates.push({ id, name: o.name, role: '' });
    }
  const toggle = (id: string, on: boolean) => {
    if (on) {
      if (shot.subjects.length >= MAX_SHOT_SUBJECTS) return;
      updateShot(shot.id, { subjects: [...shot.subjects, id] });
      return;
    }
    // a planned subject leaves the plan too (the operator would put it back among the subjects)
    const patch: Record<string, unknown> = { subjects: shot.subjects.filter((x) => x !== id) };
    if (shot.layout.some((e) => e.subject === id))
      patch.layout = layoutParam(shot.layout.filter((e) => e.subject !== id));
    updateShot(shot.id, patch);
  };
  if (!candidates.length)
    return <div class="hint">No actors or props yet (Add › Actor, or the Assets tab).</div>;
  return (
    <div class="subject-list" role="group" aria-label="Subjects" data-testid="shot-subjects">
      {candidates.map((c) => {
        const on = shot.subjects.includes(c.id);
        const lead = shot.subjects[0] === c.id;
        return (
          <Checkbox
            key={c.id}
            value={on}
            testId={`shot-subject-${c.name}`}
            label={`${c.name}${lead ? ' (lead)' : ''}${c.role ? ` · ${c.role}` : ''}`}
            onChange={(v) => toggle(c.id, v)}
          />
        );
      })}
    </div>
  );
}

function Layout({ s, shot }: { s: ProjectSession; shot: ShotData }) {
  const names = (id: string) => s.doc.getObject(id)?.name ?? id;
  const set = (layout: DeskLayoutEntry[]) => updateShot(shot.id, { layout: layoutParam(layout) });
  const free = shot.subjects.filter((id) => !shot.layout.some((e) => e.subject === id));
  const add = () => {
    const subject = free[0];
    if (!subject || shot.layout.length >= MAX_SHOT_LAYOUT) return;
    set([...shot.layout, { subject, side: sideFor(shot.layout.length), facing: 'camera' }]);
  };
  return (
    <div data-testid="shot-layout">
      {shot.layout.map((e, i) => {
        const change = (patch: Partial<DeskLayoutEntry>) =>
          set(shot.layout.map((x, j) => (j === i ? { ...x, ...patch } : x)));
        const subjects = [e.subject, ...free];
        return (
          <div class="layout-row" key={`${e.subject}-${i}`}>
            <SelectField
              value={e.subject}
              testId={`shot-layout-${i}-subject`}
              title="Subject"
              options={subjects.map((id) => ({ value: id, label: names(id) }))}
              onChange={(v) => change({ subject: v })}
            />
            <SelectField<DeskSide>
              value={e.side}
              testId={`shot-layout-${i}-side`}
              title="Third of the frame"
              options={DESK_SIDES.map((v) => ({ value: v, label: humanize(v) }))}
              onChange={(v) => change({ side: v })}
            />
            <SelectField<DeskFacing>
              value={e.facing}
              testId={`shot-layout-${i}-facing`}
              title="Facing on screen"
              options={DESK_FACINGS.map((v) => ({
                value: v,
                label: `Faces ${v === 'camera' ? 'camera' : v}`,
              }))}
              onChange={(v) => change({ facing: v })}
            />
            <IconButton
              icon="close"
              title="Remove from the plan"
              testId={`shot-layout-${i}-remove`}
              onClick={() => set(shot.layout.filter((_, j) => j !== i))}
            />
          </div>
        );
      })}
      {shot.layout.length === 0 && (
        <div class="hint" style={{ marginBottom: '4px' }}>
          No planned layout: the camera is solved from the framing and angle.
        </div>
      )}
      <IconButton
        icon="plus"
        label="Plan a subject"
        title={
          free.length
            ? 'Plan where a subject stands in the frame and which way it faces (the camera is fitted to it)'
            : 'Every subject is planned (add subjects first)'
        }
        testId="shot-layout-add"
        disabled={!free.length || shot.layout.length >= MAX_SHOT_LAYOUT}
        onClick={add}
      />
    </div>
  );
}

/** The inspector of the shot `shotId` (nothing when it is gone). */
export function ShotInspector({ s, shot }: { s: ProjectSession; shot: ShotData }) {
  void s.revision.value;
  const fps = Math.max(1, s.doc.getScene().fps || 24);
  const frames = shot.frame_end - shot.frame_start + 1;
  const cameras = s.doc.listObjects().filter((o) => o.type === 'CAMERA');
  const update = (patch: Record<string, unknown>, typed?: string) => updateShownShot(s, shot, patch, typed);
  const check = lastCheck.value;
  const line =
    check?.session === s && check.revision === s.revision.value
      ? (check.result.lines.find((l) => l.shot === shot.id)?.line ?? '')
      : '';
  const select = (key: 'framing' | 'angle' | 'height' | 'move', values: readonly string[], none: string) => (
    <SelectField
      value={shot[key] ?? NONE}
      testId={`shot-${key}`}
      options={enumOptions(values, none)}
      onChange={(v) => update({ [key]: v === NONE ? null : v })}
    />
  );
  return (
    <div data-testid="shot-inspector" data-shot={shot.id}>
      <Panel title="Shot" id="director-shot">
        <Row label="Name">
          <TextField
            value={shot.name}
            testId="shot-name"
            ariaLabel="Shot name"
            onChange={(v) => {
              const name = v.trim().slice(0, MAX_SHOT_NAME);
              if (name && name !== shot.name) update({ name }, name);
            }}
          />
        </Row>
        <Row label="Enabled" title="Disabled shots stay in the list but are left out of the cut">
          <Checkbox
            value={shot.enabled}
            testId="shot-enabled"
            label="In the cut"
            onChange={(v) => update({ enabled: v })}
          />
        </Row>
        <Row label="Camera">
          <SelectField
            value={shot.camera ?? NONE}
            testId="shot-camera"
            options={[
              { value: NONE, label: '(none)' },
              ...cameras.map((o) => ({ value: o.id, label: o.name })),
            ]}
            onChange={(v) => update({ camera: v === NONE ? null : v })}
          />
        </Row>
        <Row label="Start" title="First scene frame of the shot">
          <CommitNumber
            value={shot.frame_start}
            integer
            step={1}
            testId="shot-start"
            onCommit={(v) => update({ frame_start: Math.round(v) })}
          />
        </Row>
        <Row label="End" title="Last scene frame of the shot (inclusive)">
          <CommitNumber
            value={shot.frame_end}
            integer
            step={1}
            min={shot.frame_start}
            testId="shot-end"
            onCommit={(v) => update({ frame_end: Math.round(v) })}
          />
        </Row>
        <Row label="Duration" title={`${frames} frames at ${fps} fps`}>
          <CommitNumber
            value={frames / fps}
            min={1 / fps}
            max={3600}
            step={0.1}
            precision={2}
            unit=" s"
            testId="shot-duration"
            onCommit={(v) => update({ duration_s: v })}
          />
        </Row>
        <div class="hint" style={{ margin: '2px 0 4px' }}>
          Frames {shot.frame_start}–{shot.frame_end} · {frames} frames · {seconds(frames, fps)}
        </div>
      </Panel>
      <Panel title="Camera" id="director-shot-camera">
        <Row label="Framing">{select('framing', DESK_FRAMINGS, '— (none)')}</Row>
        <Row label="Angle">{select('angle', DESK_ANGLES, '— (front)')}</Row>
        <Row label="Height">{select('height', DESK_HEIGHTS, '— (eye)')}</Row>
        <Row
          label="Lens"
          title={`Focal length on a 36 mm wide sensor (${SHOT_LENS_MIN}–${SHOT_LENS_MAX} mm)`}
        >
          <div style={{ display: 'flex', gap: '3px' }}>
            <div style={{ flex: 1 }}>
              <CommitNumber
                value={shot.lens_mm ?? NaN}
                placeholder="Auto (framing)"
                min={SHOT_LENS_MIN}
                max={SHOT_LENS_MAX}
                step={1}
                precision={1}
                unit=" mm"
                testId="shot-lens"
                onCommit={(v) => update({ lens_mm: v })}
              />
            </div>
            {shot.lens_mm !== null && (
              <IconButton
                icon="close"
                title="Use the framing's lens"
                testId="shot-lens-clear"
                onClick={() => update({ lens_mm: null })}
              />
            )}
          </div>
        </Row>
        <Row label="Move">{select('move', DESK_MOVES, '— (none)')}</Row>
        <Row label="Continuity" title="cut, or continuous: the action carries on from the shot before">
          <SelectField
            value={shot.continuity}
            testId="shot-continuity"
            options={DESK_CONTINUITIES.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={(v) => update({ continuity: v })}
          />
        </Row>
        <Row
          label="Pre-roll"
          title="Frames before the start that are animated and simulated but never exported"
        >
          <CommitNumber
            value={shot.pre_roll}
            integer
            min={0}
            max={MAX_PRE_ROLL}
            step={1}
            unit=" fr"
            testId="shot-pre-roll"
            onCommit={(v) => update({ pre_roll: Math.round(v) })}
          />
        </Row>
      </Panel>
      <Panel title={`Subjects (${shot.subjects.length})`} id="director-shot-subjects">
        <Subjects s={s} shot={shot} />
      </Panel>
      <Panel title="Planned layout" id="director-shot-layout" defaultOpen={false}>
        <Layout s={s} shot={shot} />
      </Panel>
      <Panel title="Notes" id="director-shot-notes">
        <NotesField
          value={shot.notes}
          maxLength={MAX_SHOT_NOTES}
          testId="shot-notes"
          ariaLabel="Shot notes"
          placeholder="What happens in the shot (Ctrl+Enter to save)"
          onChange={(v) => update({ notes: v }, v)}
        />
        {line && (
          <p class="blocking-line" data-testid="shot-blocking-line">
            {line}
          </p>
        )}
      </Panel>
    </div>
  );
}
