// memory-desk.ts first: it must load before (and without) operators/memory.ts, which spreads its
// tables into OPERATOR_ESTIMATES (an import of memory.ts from it would fail here)
import {
  DESK_ACTOR_MAX_OBJECTS,
  DESK_SHOT_ESTIMATES,
  STORE_MODEL_MAX_OBJECTS,
} from '../src/operators/memory-desk';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_ESTIMATES,
  OPERATOR_FIXED_BYTES,
  createEditorState,
  createOperatorRegistry,
  estimateOperator,
  setOperatorMemoryCheck,
  unestimatedReason,
  type OperatorContext,
  type OperatorEstimate,
} from '../src/operators';
import { SceneDoc } from '../src/doc/scene-doc';
import { createCube } from '../src/mesh/primitives';
import { setShots } from '../src/desk/shots';
import { base64Encode } from '../src/util/json';

/*
 * The operators of the director's desk and the model store (spec §4): FOUNDATION registers every
 * id with its full schema, defaults and memory estimate; each workstream implements its own (an
 * operator not implemented yet fails with "<id> is not implemented yet", FAILED). The shot
 * operators (DESK-CORE) are implemented and tested in desk-shot-operators.test.ts.
 */

afterEach(() => setOperatorMemoryCheck(null));

const SHOTS = [
  'desk.shot_add',
  'desk.shot_update',
  'desk.shot_remove',
  'desk.shot_move',
  'desk.shot_solve',
  'desk.check',
  'desk.set_build',
  'desk.camera_move',
  'desk.import_rideo_blocking',
  'desk.export_rideo_blocking',
];
const ACTORS = [
  'desk.actor_add',
  'desk.actor_pose',
  'desk.actor_move',
  'desk.actor_face',
  'desk.actor_look_at',
  'desk.actor_hold',
  'desk.actor_mount',
];
const MOTION = [
  'desk.physics_setup',
  'desk.physics_drop',
  'desk.physics_throw',
  'desk.physics_push',
  'desk.physics_bake',
  'desk.tether_fly',
  'desk.vehicle_drive',
];
const STORE = ['store.add', 'store.search', 'store.insert_files'];
const BRIEF = ['desk.stage_brief', 'desk.update_from_brief', 'desk.shot_results'];
const READ_ONLY = ['desk.check', 'desk.export_rideo_blocking', 'desk.shot_results', 'store.search'];
/** The shot operators DESK-CORE implements (all but the phase-2 rideo import and export). */
const SHOT_OPERATORS = SHOTS.filter((id) => !id.includes('rideo'));

const OBJ = base64Encode(new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'));

/** Valid parameters of each operator (the required ones, and a few more). */
const SAMPLE: Record<string, Record<string, unknown>> = {
  'desk.shot_add': {},
  'desk.shot_update': { shot: 'Shot 1', framing: 'wide' },
  'desk.shot_remove': { shots: ['Shot 1'] },
  'desk.shot_move': { shot: 'Shot 1', index: 0 },
  'desk.shot_solve': {},
  'desk.check': {},
  'desk.set_build': {},
  'desk.camera_move': { shot: 'Shot 1', move: 'push_in' },
  'desk.import_rideo_blocking': {
    blocking: { version: 1, actors: [{ id: 'a1' }], props: [{ label: 'kite' }] },
    shots: [{ id: 's1', index: 0, duration_s: 4 }],
  },
  'desk.export_rideo_blocking': {},
  'desk.stage_brief': {
    brief: {
      id: 'scene-1',
      name: 'Sample',
      fps: 24,
      width: 640,
      height: 360,
      set: { description: 'A meadow.', interior: false, timeOfDay: null },
      cast: [{ id: 'ada', name: 'Ada', description: 'A woman.', kind: 'person', heightM: null }],
      elements: [],
      shots: [
        {
          id: 's1',
          index: 0,
          durationSec: 1,
          description: 'Wide: Ada waits.',
          action: '',
          castIds: ['ada'],
          elementIds: [],
          framing: 'wide',
          movement: 'static',
          move: null,
          lensMm: null,
          continuity: 'cut',
          layout: [],
        },
      ],
    },
  },
  'desk.update_from_brief': { brief: { id: 'scene-1' } },
  'desk.shot_results': {},
  'desk.actor_add': { kind: 'adult' },
  'desk.actor_pose': { actor: 'Cube', pose: 'sit' },
  'desk.actor_move': { actor: 'Cube', points: [[2, 0, 0]], frame_start: 1 },
  'desk.actor_face': { actor: 'Cube', facing_deg: 90, frame: 10 },
  'desk.actor_look_at': { actor: 'Cube', target: null, frame: 10 },
  'desk.actor_hold': { actor: 'Cube', prop: 'Ball', frame: 10 },
  'desk.actor_mount': { rider: 'Cube', mount: 'Ball', frame: 10 },
  'desk.physics_setup': { objects: ['Ball'] },
  'desk.physics_drop': { objects: ['Ball'], frame: 10, height: 2 },
  'desk.physics_throw': { object: 'Ball', target: [3, 0, 0], frame: 10 },
  'desk.physics_push': { object: 'Ball', direction: [1, 0, 0], speed_mps: 2, frame: 10 },
  'desk.physics_bake': {},
  'desk.tether_fly': {
    flyer: 'Ball',
    anchor: 'Cube',
    length_m: 10,
    wind_dir_deg: 0,
    wind_mps: 5,
    frame_start: 1,
    frame_end: 100,
  },
  'desk.vehicle_drive': { vehicle: 'Cube', points: [[10, 0, 0]], frame_start: 1, speed_mps: 5 },
  'store.add': { model: 'oak_tree' },
  'store.search': { query: 'tree' },
  'store.insert_files': {
    entry: {
      id: 'polyhaven:chair',
      name: 'Chair',
      provider: 'polyhaven',
      license: { spdx: 'CC0-1.0', url: null, attribution: null },
      author: null,
      source_url: null,
    },
    format: 'obj',
    files: { 'chair.obj': OBJ },
    main: 'chair.obj',
  },
};

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const reg = createOperatorRegistry();
  const cube = doc.addObject({
    type: 'MESH',
    name: 'Cube',
    data: doc.addMesh('Cube', createCube({ size: 1 })),
  });
  const ball = doc.addObject({
    type: 'MESH',
    name: 'Ball',
    data: doc.addMesh('Ball', createCube({ size: 0.3 })),
  });
  const cam = doc.addObject({ type: 'CAMERA', name: 'Cam', data: doc.addCamera() });
  setShots(doc, [{ name: 'Shot 1', camera: cam, frame_start: 1, frame_end: 48 }]);
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: () => undefined,
  };
  return { doc, reg, ctx, cube, ball, cam };
}

type Json = {
  description?: string;
  properties?: Record<string, Json>;
  items?: Json | false;
  anyOf?: Json[];
};

/** Parameters (dotted paths) without a description, nested objects and list items included. */
function undescribed(s: Json, at = '', out: string[] = []): string[] {
  for (const [k, v] of Object.entries(s.properties ?? {})) {
    const p = at ? `${at}.${k}` : k;
    if (!v.description && !(v.anyOf ?? []).some((b) => b.description)) out.push(p);
    for (const b of [v, ...(v.anyOf ?? [])]) {
      undescribed(b, p, out);
      if (b.items) undescribed(b.items, `${p}[]`, out);
    }
  }
  return out;
}

describe('desk and store operators', () => {
  it('are all registered, in the Desk and Store categories', () => {
    const { reg } = setup();
    const ids = reg
      .list()
      .map((d) => d.id)
      .filter((id) => id.startsWith('desk.') || id.startsWith('store.'));
    expect(ids.sort()).toEqual([...SHOTS, ...ACTORS, ...MOTION, ...STORE, ...BRIEF].sort());
    expect(Object.keys(SAMPLE).sort()).toEqual(ids);
    for (const id of ids) {
      const d = reg.get(id)!;
      expect(d.category, id).toBe(id.startsWith('store.') ? 'Store' : 'Desk');
      expect(d.label.length, id).toBeGreaterThan(2);
      expect(d.description.length, id).toBeGreaterThan(40);
      expect(d.uiOnly, id).toBeFalsy();
      // read-only operators run outside a transaction; the others make one undo step
      expect(d.undo === false, id).toBe(READ_ONLY.includes(id));
    }
  });

  it('describe every parameter, in closed JSON schemas', () => {
    const { reg } = setup();
    for (const info of reg.describe().filter((d) => /^(desk|store)\./.test(d.id))) {
      const schema = info.parameters as Json & { additionalProperties?: unknown };
      expect(schema.additionalProperties, info.id).toBe(false);
      expect(undescribed(schema), info.id).toEqual([]);
    }
  });

  it('fill in the defaults of the spec and refuse unknown or invalid parameters', () => {
    const { reg } = setup();
    expect(reg.parseParams('desk.shot_add', {})).toEqual({ continuity: 'cut', pre_roll: 0, solve: true });
    expect(reg.parseParams('desk.shot_remove', { shots: ['a'] })).toEqual({
      shots: ['a'],
      delete_cameras: false,
    });
    expect(reg.parseParams('desk.shot_solve', {})).toEqual({
      enforce_line: true,
      fit_plan: true,
      keep_lens: false,
      only_missing: false,
    });
    expect(reg.parseParams('desk.set_build', {})).toMatchObject({ sky: true, interior: false });
    expect(reg.parseParams('desk.actor_pose', { actor: 'a', pose: 'wave' })).toMatchObject({
      blend_frames: 6,
    });
    expect(reg.parseParams('desk.actor_move', SAMPLE['desk.actor_move'])).toMatchObject({
      gait: 'auto',
      face_path: true,
    });
    expect(reg.parseParams('desk.actor_face', SAMPLE['desk.actor_face'])).toMatchObject({ turn_frames: 8 });
    expect(reg.parseParams('desk.actor_look_at', SAMPLE['desk.actor_look_at'])).toMatchObject({
      blend_frames: 6,
    });
    expect(reg.parseParams('desk.actor_hold', SAMPLE['desk.actor_hold'])).toMatchObject({ hand: 'right' });
    expect(reg.parseParams('desk.physics_setup', { objects: ['a'] })).toMatchObject({
      kind: 'active',
      ground: true,
    });
    expect(reg.parseParams('desk.physics_throw', SAMPLE['desk.physics_throw'])).toMatchObject({
      flight_s: 1,
    });
    expect(reg.parseParams('desk.tether_fly', SAMPLE['desk.tether_fly'])).toMatchObject({
      tail: true,
      string: true,
    });
    expect(reg.parseParams('store.search', {})).toEqual({ limit: 20, offset: 0 });
    expect(reg.parseParams('desk.import_rideo_blocking', SAMPLE['desk.import_rideo_blocking'])).toMatchObject(
      {
        characters: [],
        elements: [],
        pre_roll_frames: 12,
        update: true,
        shots: [{ character_ids: [], element_ids: [], layout: [], continuity: 'cut' }],
      },
    );
    for (const [id, params] of [
      ['desk.shot_add', { nmae: 'x' }],
      ['desk.shot_add', { framing: 'cowboy' }],
      ['desk.shot_add', { layout: [{ subject: 'a', side: 'left', facing: 'camera', extra: 1 }] }],
      ['desk.actor_add', { kind: 'panda' }],
      ['desk.actor_add', { kind: 'adult', color: 'red' }],
      ['desk.actor_move', { actor: 'a', points: [], frame_start: 1 }],
      ['store.search', { limit: 0 }],
      ['store.insert_files', { ...SAMPLE['store.insert_files'], format: 'fbx' }],
    ] as const)
      expect(() => reg.parseParams(id, params), `${id} ${JSON.stringify(params)}`).toThrow(
        /Invalid parameters/,
      );
  });

  it('run with their sample parameters, or fail with an operator error (FAILED while not implemented)', () => {
    for (const [id, params] of Object.entries(SAMPLE)) {
      const { reg, ctx } = setup();
      const res = reg.run(ctx, id, params);
      if (SHOT_OPERATORS.includes(id)) expect(res, `${id}: ${res.error}`).toMatchObject({ ok: true });
      else if (!res.ok && res.error?.includes('not implemented yet'))
        expect(res, id).toMatchObject({ code: 'FAILED', error: `${id} is not implemented yet` });
      // a refusal names its reason with a code; anything else escaped the operator
      else if (!res.ok) expect(res.code, `${id}: ${res.error}`).toBeTypeOf('string');
    }
  });

  it('need Object Mode to change the scene', () => {
    const { reg, ctx } = setup();
    ctx.state.mode = 'EDIT';
    expect(reg.run(ctx, 'desk.actor_add', { kind: 'adult' })).toMatchObject({
      ok: false,
      code: 'POLL_FAILED',
    });
    expect(reg.run(ctx, 'desk.shot_add', {})).toMatchObject({ ok: false, code: 'POLL_FAILED' });
    // read-only operators run in any mode
    expect(reg.run(ctx, 'desk.check', {})).toMatchObject({ ok: true });
    expect(reg.run(ctx, 'store.search', {}).code).not.toBe('POLL_FAILED');
  });
});

describe('desk and store memory estimates', () => {
  const estimate = (t: ReturnType<typeof setup>, id: string, params: Record<string, unknown>) =>
    estimateOperator(id, t.ctx, t.reg.parseParams(id, params));

  it('cover every desk and store operator: an estimate or a reason', () => {
    for (const id of [...SHOTS, ...ACTORS, ...MOTION, ...STORE, ...BRIEF])
      expect(!!OPERATOR_ESTIMATES[id] || !!unestimatedReason(id), id).toBe(true);
    expect(OPERATOR_ESTIMATES['desk.shot_add']).toBe(DESK_SHOT_ESTIMATES['desk.shot_add']);
    for (const id of [
      'desk.actor_add',
      'desk.actor_move',
      'desk.physics_bake',
      'store.add',
      'store.insert_files',
    ])
      expect(OPERATOR_ESTIMATES[id], id).toBeTypeOf('function');
  });

  it('give an estimate or none for the sample parameters', () => {
    const t = setup();
    for (const [id, params] of Object.entries(SAMPLE)) {
      if (!OPERATOR_ESTIMATES[id]) continue;
      const e = estimate(t, id, params);
      if (!e) continue;
      expect(e.bytes, id).toBeGreaterThanOrEqual(OPERATOR_FIXED_BYTES);
      expect(e.addedStoredBytes, id).toBeGreaterThanOrEqual(0);
      expect(typeof e.lower, id).toBe('string');
    }
  });

  it('count the objects the operators add', () => {
    const t = setup();
    expect(estimate(t, 'desk.actor_add', { kind: 'adult' })!.objects).toBe(DESK_ACTOR_MAX_OBJECTS);
    expect(estimate(t, 'store.add', { model: 'oak_tree' })!.objects).toBe(STORE_MODEL_MAX_OBJECTS);
    // a new camera unless the shot names one
    expect(estimate(t, 'desk.shot_add', {})!.objects).toBe(1);
    expect(estimate(t, 'desk.shot_add', { camera: 'Cam' })!.objects ?? 0).toBe(0);
    // the imported model and its root
    const files = estimate(t, 'store.insert_files', SAMPLE['store.insert_files'])!;
    expect(files.objects).toBe(2);
    expect(files.faces).toBe(1);
  });

  it('grow with what the operators key and import', () => {
    const t = setup();
    const keys = (id: string, params: Record<string, unknown>) => estimate(t, id, params)!.keyframes ?? 0;
    // a longer walk keys more gait cycles; a given end frame sets the length
    const walk = (x: number) =>
      keys('desk.actor_move', { actor: 'Cube', points: [[x, 0, 0]], frame_start: 1 });
    expect(walk(50)).toBeGreaterThan(walk(5));
    expect(
      keys('desk.actor_move', { actor: 'Cube', points: [[5, 0, 0]], frame_start: 1, frame_end: 2400 }),
    ).toBeGreaterThan(walk(5));
    // a move that follows a subject keys every frame of the shot
    const shot = (move: string) => keys('desk.shot_add', { frame_start: 1, frame_end: 2400, move });
    expect(shot('tracking_follow')).toBeGreaterThan(10 * shot('push_in'));
    expect(keys('desk.tether_fly', { ...SAMPLE['desk.tether_fly'], frame_end: 1000 })).toBeGreaterThan(
      keys('desk.tether_fly', SAMPLE['desk.tether_fly']),
    );
    // the companion files of a store model count as the images they are
    const big = estimate(t, 'store.insert_files', {
      ...SAMPLE['store.insert_files'],
      files: { 'chair.obj': OBJ, 'tex.png': base64Encode(new Uint8Array(3_000_000)) },
    })!;
    const small = estimate(t, 'store.insert_files', SAMPLE['store.insert_files'])!;
    expect(big.bytes - small.bytes).toBeGreaterThanOrEqual(6 * 3_000_000);
    expect(big.addedStoredBytes - small.addedStoredBytes).toBe(3_000_000);
  });

  it('let the installed check refuse a desk operator before it runs', () => {
    const t = setup();
    const asked: OperatorEstimate[] = [];
    setOperatorMemoryCheck((req) => {
      asked.push(req.estimate);
      return req.operator.startsWith('desk.') ? `${req.operator} does not fit` : null;
    });
    expect(t.reg.run(t.ctx, 'desk.actor_add', { kind: 'adult' })).toMatchObject({
      ok: false,
      code: 'OUT_OF_MEMORY',
      error: 'desk.actor_add does not fit',
    });
    expect(asked[0].objects).toBe(DESK_ACTOR_MAX_OBJECTS);
    // operators without an estimate are not asked about
    expect(t.reg.run(t.ctx, 'desk.shot_move', SAMPLE['desk.shot_move'])).toMatchObject({ ok: true });
    expect(asked).toHaveLength(1);
  });
});
