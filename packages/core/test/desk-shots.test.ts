import { describe, expect, it } from 'vitest';
import { SceneDoc } from '../src/doc/scene-doc';
import { defaultDeskSettings, defaultRigidBody, defaultSceneSettings } from '../src/doc/defaults';
import {
  MAX_PRE_ROLL,
  MAX_SHOT_FRAME,
  MAX_SHOTS,
  cameraForFrame,
  findShotIndex,
  getDeskSettings,
  getShots,
  newShotId,
  sanitizeDeskSettings,
  sanitizeShots,
  sceneFrameForSequenceFrame,
  sequenceLength,
  setDeskSettings,
  setShots,
  shotAtSequenceFrame,
  shotOutputFrames,
  shotSequenceStart,
} from '../src/desk/shots';
import { MAX_INITIAL_VELOCITY, MAX_START_FRAME, sanitizeRigidBody } from '../src/physics/settings';

/*
 * Shots and desk settings (desk/shots.ts, spec §2 and §5): stored values are sanitized on every
 * read against the document, reads are cached until the document changes, writes replace the whole
 * list in one transaction, and the cut's timing maps frames of the sequence to scene frames and
 * cameras.
 */

const ID = /^[0-9A-Za-z]{16}$/;

function scene() {
  const doc = SceneDoc.create({ empty: true });
  const cam1 = doc.addObject({ type: 'CAMERA', name: 'Cam1', data: doc.addCamera() });
  const cam2 = doc.addObject({ type: 'CAMERA', name: 'Cam2', data: doc.addCamera() });
  const sceneCam = doc.addObject({ type: 'CAMERA', name: 'SceneCam', data: doc.addCamera() });
  const ada = doc.addObject({ type: 'EMPTY', name: 'Ada' });
  const ben = doc.addObject({ type: 'EMPTY', name: 'Ben' });
  doc.updateScene({ camera: sceneCam });
  return { doc, cam1, cam2, sceneCam, ada, ben };
}

const shot = (o: Record<string, unknown>): Record<string, unknown> => ({
  name: 'S',
  frame_start: 1,
  frame_end: 10,
  ...o,
});

describe('sanitizeShots', () => {
  it('keeps valid shots and fills every field', () => {
    const id = newShotId();
    expect(id).toMatch(ID);
    const [s] = sanitizeShots([{ id, name: 'Wide', frame_start: 1, frame_end: 48 }]);
    expect(s).toEqual({
      id,
      name: 'Wide',
      enabled: true,
      camera: null,
      frame_start: 1,
      frame_end: 48,
      notes: '',
      framing: null,
      angle: null,
      height: null,
      move: null,
      lens_mm: null,
      subjects: [],
      layout: [],
      continuity: 'cut',
      pre_roll: 0,
      external: null,
    });
    expect(sanitizeShots('nope')).toEqual([]);
    expect(sanitizeShots([null, 3, 'x', [], shot({})])).toHaveLength(1);
  });

  it('gives shots without a valid or unique id one derived from the shot, the same on every read', () => {
    const id = newShotId();
    const raw = [
      shot({ id }),
      shot({ id, name: 'Copy' }),
      shot({ id: 'bad id', name: 'B' }),
      shot({ name: 'C' }),
    ];
    const a = sanitizeShots(raw);
    const b = sanitizeShots(JSON.parse(JSON.stringify(raw)));
    expect(a[0].id).toBe(id);
    for (const s of a) expect(s.id).toMatch(ID);
    expect(new Set(a.map((s) => s.id)).size).toBe(4);
    expect(b.map((s) => s.id)).toEqual(a.map((s) => s.id));
    // a derived id never takes the valid id of a later shot
    const later = newShotId();
    const c = sanitizeShots([shot({ name: 'X' }), shot({ id: later })]);
    expect(c[0].id).not.toBe(later);
    expect(c[1].id).toBe(later);
  });

  it('cuts texts, validates enums and clamps ranges', () => {
    const [s] = sanitizeShots([
      {
        name: 'n'.repeat(100),
        notes: 'x'.repeat(3000),
        frame_start: 10.6,
        frame_end: 3,
        framing: 'medium',
        angle: 'sideways',
        height: 'eye',
        move: 'zoom',
        lens_mm: 2,
        continuity: 'later',
        pre_roll: -4,
        enabled: 'yes',
      },
    ]);
    expect(s.name).toHaveLength(64);
    expect(s.notes).toHaveLength(2000);
    expect([s.frame_start, s.frame_end]).toEqual([11, 11]);
    expect([s.framing, s.angle, s.height, s.move]).toEqual(['medium', null, 'eye', null]);
    expect(s.lens_mm).toBe(8);
    expect(s.continuity).toBe('cut');
    expect(s.pre_roll).toBe(0);
    expect(s.enabled).toBe(true);
    const [t] = sanitizeShots([
      {
        name: '  ',
        frame_start: -5e9,
        frame_end: 5e9,
        lens_mm: 9000,
        pre_roll: 1e9,
        continuity: 'continuous',
      },
    ]);
    expect(t.name).toBe('Shot 1');
    expect([t.frame_start, t.frame_end]).toEqual([-MAX_SHOT_FRAME, MAX_SHOT_FRAME]);
    expect(t.lens_mm).toBe(800);
    expect(t.pre_roll).toBe(MAX_PRE_ROLL);
    expect(t.continuity).toBe('continuous');
    expect(sanitizeShots(Array.from({ length: MAX_SHOTS + 20 }, () => shot({})))).toHaveLength(MAX_SHOTS);
  });

  it('keeps a rideo reference and drops other external values', () => {
    const [a, b] = sanitizeShots([
      shot({ external: { source: 'rideo', project: 'p', clip: 'c', shot: 's', index: 2.4, extra: 1 } }),
      shot({ external: { source: 'other', project: 'p' } }),
    ]);
    expect(a.external).toEqual({ source: 'rideo', project: 'p', clip: 'c', shot: 's', index: 2 });
    expect(b.external).toBeNull();
  });

  it('drops cameras, subjects and layout entries the document does not have', () => {
    const { doc, cam1, ada, ben } = scene();
    const [s] = sanitizeShots(
      [
        shot({
          camera: ada,
          subjects: [ada, 'missing', ada, ben, 7],
          layout: [
            { subject: ada, side: 'left', facing: 'right' },
            { subject: ada, side: 'right', facing: 'left' },
            { subject: 'missing', side: 'left', facing: 'camera' },
            { subject: ben, side: 'middle', facing: 'camera' },
          ],
        }),
      ],
      doc,
    );
    // not a camera
    expect(s.camera).toBeNull();
    expect(s.subjects).toEqual([ada, ben]);
    expect(s.layout).toEqual([{ subject: ada, side: 'left', facing: 'right' }]);
    expect(sanitizeShots([shot({ camera: cam1 })], doc)[0].camera).toBe(cam1);
    // without a document only the shapes are checked
    expect(sanitizeShots([shot({ camera: 'anything', subjects: ['x'] })])[0]).toMatchObject({
      camera: 'anything',
      subjects: ['x'],
    });
  });
});

describe('desk settings', () => {
  it('defaults and sanitizes', () => {
    const d = defaultDeskSettings();
    expect(d).toEqual({
      set_width: 0,
      set_depth: 0,
      interior: false,
      main_pair: null,
      aspect: null,
      max_shot_s: null,
      min_shot_s: null,
    });
    expect(sanitizeDeskSettings('x')).toEqual(d);
    const { doc, ada, ben } = scene();
    expect(
      sanitizeDeskSettings(
        {
          set_width: -3,
          set_depth: 1e9,
          interior: true,
          main_pair: [ada, ben],
          aspect: 100,
          max_shot_s: 10,
          min_shot_s: 30,
        },
        doc,
      ),
    ).toEqual({
      set_width: 0,
      set_depth: 10_000,
      interior: true,
      main_pair: [ada, ben],
      aspect: 10,
      max_shot_s: 10,
      min_shot_s: 10,
    });
    expect(sanitizeDeskSettings({ main_pair: [ada, ada] }, doc).main_pair).toBeNull();
    expect(sanitizeDeskSettings({ main_pair: [ada, 'gone'] }, doc).main_pair).toBeNull();
    expect(sanitizeDeskSettings({ aspect: -1, max_shot_s: 0 })).toMatchObject({
      aspect: null,
      max_shot_s: null,
    });
  });

  it('are part of a new scene and change through setDeskSettings', () => {
    expect(defaultSceneSettings()).toMatchObject({ shots: [], desk: defaultDeskSettings() });
    const { doc, ada, ben } = scene();
    expect(getDeskSettings(doc)).toEqual(defaultDeskSettings());
    const stored = setDeskSettings(doc, { set_width: 12, main_pair: [ada, ben] });
    expect(stored).toMatchObject({ set_width: 12, main_pair: [ada, ben] });
    expect(getDeskSettings(doc)).toEqual(stored);
    setDeskSettings(doc, { set_depth: 10 });
    expect(getDeskSettings(doc)).toMatchObject({ set_width: 12, set_depth: 10 });
    // deleting one of the pair drops the pair on the next read
    doc.removeObject(ben);
    expect(getDeskSettings(doc).main_pair).toBeNull();
  });
});

describe('getShots / setShots', () => {
  it('write the whole list in one transaction and read it back sanitized', () => {
    const { doc, cam1, ada } = scene();
    expect(getShots(doc)).toEqual([]);
    let transactions = 0;
    const count = () => transactions++;
    doc.ydoc.on('afterTransaction', count);
    const stored = setShots(doc, [
      shot({ name: 'A', camera: cam1, subjects: [ada, 'gone'] }),
      shot({ name: 'B', frame_start: 11, frame_end: 20 }),
    ]);
    doc.ydoc.off('afterTransaction', count);
    expect(transactions).toBe(1);
    expect(stored.map((s) => s.name)).toEqual(['A', 'B']);
    expect(stored[0].subjects).toEqual([ada]);
    expect(getShots(doc)).toEqual(stored);
    expect(findShotIndex(stored, stored[1].id)).toBe(1);
    expect(findShotIndex(stored, 'B')).toBe(1);
    expect(findShotIndex(stored, 'nope')).toBe(-1);
  });

  it('give copies: changing what a read returned changes nothing stored', () => {
    const { doc } = scene();
    setShots(doc, [shot({ name: 'A' })]);
    const a = getShots(doc);
    a[0].name = 'changed';
    a.push(a[0]);
    expect(getShots(doc).map((s) => s.name)).toEqual(['A']);
  });

  it('sanitize values other clients stored, and follow later changes of the document', () => {
    const { doc, cam1, cam2 } = scene();
    doc.updateScene({
      shots: [{ id: 'x', name: 'Raw', camera: cam1, frame_start: 5, frame_end: 2 }] as never,
    });
    const first = getShots(doc);
    expect(first[0]).toMatchObject({ name: 'Raw', camera: cam1, frame_start: 5, frame_end: 5 });
    expect(first[0].id).toMatch(ID);
    // the derived id is stable across reads, and setShots stores it
    expect(getShots(doc)[0].id).toBe(first[0].id);
    expect(setShots(doc, getShots(doc))[0].id).toBe(first[0].id);
    // a deleted camera is dropped on the next read
    doc.removeObject(cam1);
    expect(getShots(doc)[0].camera).toBeNull();
    setShots(doc, [shot({ camera: cam2 })]);
    expect(getShots(doc)[0].camera).toBe(cam2);
  });

  it('refuse more than MAX_SHOTS shots', () => {
    const { doc } = scene();
    expect(() =>
      setShots(
        doc,
        Array.from({ length: MAX_SHOTS + 1 }, () => shot({})),
      ),
    ).toThrow(/512/);
    expect(getShots(doc)).toEqual([]);
  });
});

describe('sequence timing', () => {
  const list = [
    { enabled: true, frame_start: 1, frame_end: 10 },
    { enabled: false, frame_start: 100, frame_end: 199 },
    { enabled: true, frame_start: 50, frame_end: 54 },
  ];

  it('counts the output frames of the enabled shots', () => {
    expect(shotOutputFrames({ frame_start: 5, frame_end: 5 })).toBe(1);
    expect(shotOutputFrames({ frame_start: 1, frame_end: 48 })).toBe(48);
    expect(sequenceLength(list)).toBe(15);
    expect(sequenceLength([])).toBe(0);
  });

  it('maps frames of the cut to shots and scene frames', () => {
    expect(shotAtSequenceFrame(list, 0)).toMatchObject({ index: 0, sceneFrame: 1, offset: 0 });
    expect(shotAtSequenceFrame(list, 9)).toMatchObject({ index: 0, sceneFrame: 10, offset: 9 });
    expect(shotAtSequenceFrame(list, 9.9)).toMatchObject({ index: 0, sceneFrame: 10 });
    // the disabled shot is skipped, its index still counts
    expect(shotAtSequenceFrame(list, 10)).toMatchObject({ index: 2, sceneFrame: 50, offset: 0 });
    expect(shotAtSequenceFrame(list, 14)).toMatchObject({ index: 2, sceneFrame: 54 });
    expect(shotAtSequenceFrame(list, 15)).toBeNull();
    expect(shotAtSequenceFrame(list, -1)).toBeNull();
    expect(shotAtSequenceFrame(list, Number.NaN)).toBeNull();
    expect(sceneFrameForSequenceFrame(list, 12)).toBe(52);
    expect(sceneFrameForSequenceFrame(list, 99)).toBeNull();
    expect([0, 1, 2, 3].map((i) => shotSequenceStart(list, i))).toEqual([0, null, 10, null]);
  });
});

describe('cameraForFrame', () => {
  it('is the camera of the first enabled shot covering the frame, else the scene camera', () => {
    const { doc, cam1, cam2, sceneCam } = scene();
    expect(cameraForFrame(doc, 1)).toBe(sceneCam);
    setShots(doc, [
      shot({ name: 'A', camera: cam1, frame_start: 1, frame_end: 10 }),
      shot({ name: 'B', camera: cam2, frame_start: 5, frame_end: 20 }),
      shot({ name: 'Off', camera: cam1, frame_start: 21, frame_end: 30, enabled: false }),
      shot({ name: 'None', frame_start: 31, frame_end: 40 }),
    ]);
    expect(cameraForFrame(doc, 1)).toBe(cam1);
    // overlapping shots: the first one in cut order
    expect(cameraForFrame(doc, 7)).toBe(cam1);
    // a fraction of a frame belongs to the frame it starts
    expect(cameraForFrame(doc, 10.5)).toBe(cam1);
    expect(cameraForFrame(doc, 11)).toBe(cam2);
    // disabled shots are skipped; a shot without a camera shows the scene camera
    expect(cameraForFrame(doc, 25)).toBe(sceneCam);
    expect(cameraForFrame(doc, 35)).toBe(sceneCam);
    expect(cameraForFrame(doc, 0)).toBe(sceneCam);
    doc.updateScene({ camera: null });
    expect(cameraForFrame(doc, 35)).toBeNull();
    expect(cameraForFrame(doc, 15)).toBe(cam2);
  });
});

describe('rigid body start frame and initial velocities', () => {
  it('default to the world start, no velocity and inherited motion', () => {
    expect(defaultRigidBody('ACTIVE')).toMatchObject({
      start_frame: null,
      initial_linear_velocity: [0, 0, 0],
      initial_angular_velocity: [0, 0, 0],
      inherit_velocity: true,
    });
    // stored before they existed
    expect(sanitizeRigidBody({ type: 'ACTIVE', mass: 2 })).toMatchObject({
      start_frame: null,
      initial_linear_velocity: [0, 0, 0],
      initial_angular_velocity: [0, 0, 0],
      inherit_velocity: true,
    });
  });

  it('are sanitized', () => {
    const rb = sanitizeRigidBody({
      type: 'ACTIVE',
      start_frame: 12.6,
      initial_linear_velocity: [1, -2e6, 3],
      initial_angular_velocity: [Number.NaN, 0, 1],
      inherit_velocity: false,
    })!;
    expect(rb.start_frame).toBe(13);
    expect(rb.initial_linear_velocity).toEqual([1, -MAX_INITIAL_VELOCITY, 3]);
    expect(rb.initial_angular_velocity).toEqual([0, 0, 0]);
    expect(rb.inherit_velocity).toBe(false);
    expect(sanitizeRigidBody({ start_frame: 'soon', inherit_velocity: 1 })).toMatchObject({
      start_frame: null,
      inherit_velocity: true,
    });
    expect(sanitizeRigidBody({ start_frame: -1e9 })!.start_frame).toBe(-MAX_START_FRAME);
  });
});
