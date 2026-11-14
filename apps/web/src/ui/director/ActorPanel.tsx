import {
  ANIMAL_POSES,
  BUILT_KINDS,
  DESK_PROPS,
  HUMANOID_KINDS,
  HUMAN_POSES,
  deskProp,
  type ActorKind,
} from '@3d-editor/core';
import type { ProjectSession } from '../../project/session';
import { run } from '../../editor/editor';
import { Panel, Row } from '../fields/fields';
import { positionAt, subjectCandidates } from './shots';
import { ActionSelect, IconButton, humanize } from './widgets';

/** The look-at choice that turns the head back to looking ahead (no object id is this). */
const LOOK_AHEAD = '-';

/*
 * The actor panel: what the selected actor is, and the desk operators that direct it at the current
 * frame (pose, walk or run to the 3D cursor, look at, turn to the cursor). Without an actor
 * selected it offers to add one.
 */

const isHumanoid = (kind: string) => (HUMANOID_KINDS as readonly string[]).includes(kind);

/** The gaits the move buttons offer for a kind: people walk and run, animals walk, trot and gallop. */
export function gaitsFor(kind: string): ('walk' | 'run' | 'trot' | 'gallop')[] {
  return isHumanoid(kind) ? ['walk', 'run'] : ['walk', 'trot', 'gallop'];
}

/** The poses desk.actor_pose takes for a kind. */
export function posesFor(kind: string): readonly string[] {
  return isHumanoid(kind) ? HUMAN_POSES : ANIMAL_POSES;
}

/** The current frame as the actor operators take it (whole frames). */
const frameOf = (s: ProjectSession) => Math.round(s.state.frame);

/**
 * Moves an actor from the current frame to the 3D cursor with a gait: desk.actor_move along a
 * straight path, its feet staying on the level they stand on now.
 */
export function moveToCursor(s: ProjectSession, actor: string, gait: string): boolean {
  const frame = frameOf(s);
  const c = s.state.cursorLocation;
  const at = positionAt(s.doc, actor, frame);
  return run(
    'desk.actor_move',
    { actor, points: [[c[0], c[1], at ? at[2] : c[2]]], frame_start: frame, gait },
    'ui',
  );
}

/** Buttons that add an actor of each kind built so far at the 3D cursor. */
function AddActor() {
  const people = BUILT_KINDS.filter((k) => isHumanoid(k));
  const animals = BUILT_KINDS.filter((k) => !isHumanoid(k));
  const button = (kind: ActorKind) => (
    <button
      key={kind}
      type="button"
      class="btn"
      data-testid={`actor-add-${kind}`}
      title={`Add a ${humanize(kind).toLowerCase()} at the 3D cursor`}
      onClick={() => run('desk.actor_add', { kind }, 'ui')}
    >
      {humanize(kind)}
    </button>
  );
  return (
    <Panel title="Add Actor" id="director-actor-add">
      <div class="hint" style={{ marginBottom: '4px' }}>
        Actors stand at the 3D cursor (also in the viewport's Add › Actor menu).
      </div>
      <div class="actor-kinds" data-testid="actor-kinds">
        {people.map(button)}
      </div>
      <div class="actor-kinds" style={{ marginTop: '6px' }}>
        {animals.map(button)}
      </div>
    </Panel>
  );
}

/** The actor panel for the actor `actor` (an armature object with desk_role 'actor'). */
export function ActorPanel({ s, actor }: { s: ProjectSession; actor: string | null }) {
  void s.revision.value;
  const frame = Math.round(s.state.$frame.value);
  const o = actor ? s.doc.getObject(actor) : null;
  if (!actor || !o) {
    return (
      <div data-testid="actor-panel-empty">
        <div class="hint" style={{ padding: '8px' }}>
          Select an actor in the viewport or the Outliner to pose and move it.
        </div>
        <AddActor />
      </div>
    );
  }
  const kind = deskProp(o, DESK_PROPS.kind) || 'adult';
  const color = deskProp(o, DESK_PROPS.color) || '#888888';
  const height = Number(o.custom_props?.[DESK_PROPS.heightM]);
  const targets = subjectCandidates(s.doc).filter((c) => c.id !== actor);
  const cameras = s.doc.listObjects().filter((x) => x.type === 'CAMERA');
  return (
    <div data-testid="actor-panel" data-actor={actor}>
      <Panel title={`Actor: ${o.name}`} id="director-actor">
        <Row label="Kind">
          <span data-testid="actor-kind">{humanize(kind)}</span>
        </Row>
        <Row label="Colour">
          <span>
            <span class="actor-swatch" style={{ background: color }} />
            {color}
          </span>
        </Row>
        <Row label="Height" title="People to the top of the head, animals at the withers">
          <span data-testid="actor-height">{Number.isFinite(height) ? `${height.toFixed(2)} m` : '—'}</span>
        </Row>
      </Panel>
      <Panel title={`Direct at frame ${frame}`} id="director-actor-direct">
        <Row label="Pose" title="Key a pose at the current frame (blended in over 6 frames)">
          <ActionSelect
            prompt="Pose…"
            title="Pose at the current frame"
            testId="actor-pose"
            options={posesFor(kind).map((p) => ({ value: p, label: humanize(p) }))}
            onPick={(pose) => run('desk.actor_pose', { actor, pose, frame }, 'ui')}
          />
        </Row>
        <Row label="Move" title="Move from the current frame to the 3D cursor, keyed along the way">
          <div class="actor-buttons">
            {gaitsFor(kind).map((gait) => (
              <IconButton
                key={gait}
                icon="cursor"
                label={`${humanize(gait)} to 3D cursor`}
                title={`${humanize(gait)} from frame ${frame} to the 3D cursor`}
                testId={`actor-${gait}`}
                onClick={() => moveToCursor(s, actor, gait)}
              />
            ))}
          </div>
        </Row>
        <Row label="Look at" title="Turn the head toward an object from the current frame">
          <ActionSelect
            prompt="Look at…"
            title="Look at an object from the current frame"
            testId="actor-look-at"
            options={[
              { value: LOOK_AHEAD, label: '(look ahead)' },
              ...[...targets, ...cameras.map((c) => ({ id: c.id, name: c.name }))].map((t) => ({
                value: t.id,
                label: t.name,
              })),
            ]}
            onPick={(v) =>
              run('desk.actor_look_at', { actor, target: v === LOOK_AHEAD ? null : v, frame }, 'ui')
            }
          />
        </Row>
        <Row label="Turn">
          <IconButton
            icon="rotate"
            label="Face the 3D cursor"
            title="Turn to face the 3D cursor, ending at the current frame"
            testId="actor-face-cursor"
            onClick={() =>
              run('desk.actor_face', { actor, target: [...s.state.cursorLocation], frame }, 'ui')
            }
          />
        </Row>
      </Panel>
    </div>
  );
}
