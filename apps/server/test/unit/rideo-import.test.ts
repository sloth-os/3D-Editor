import { describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createEditorState,
  createOperatorRegistry,
  getDeskSettings,
  getShots,
  newShotId,
  setDeskSettings,
  setShots,
  type OperatorContext,
} from '@3d-editor/core';
import { importTarget, type ProjectAccess } from '../../src/rideo';
import { RideoClient, RideoError } from '../../src/rideo/client';
import {
  EXPORT_OPERATOR,
  IMPORT_OPERATOR,
  boardState,
  clipNotes,
  defaultProjectName,
  identityFields,
  importParams,
  importedShots,
  operatorKeys,
  RIDEO_DEFAULT_VIDEO_LIMITS,
  readClipDocs,
  runImport,
  type ProjectRunner,
  type RideoClipDocs,
} from '../../src/rideo/import';
import { blockingProblem, kiteFixture, RideoMock } from '../helpers/rideo-mock';

/*
 * rideo_import (SPEC §11) against the rideo mock and the real desk.import_rideo_blocking: what is
 * read of rideo (project, clip, blocking draft, cast and element documents), the operator's
 * parameters, what the import reports (no blocking yet, rideo's desk off, boards to redraw, missing
 * documents), the project it goes into, and the round trip back (desk.export_rideo_blocking is a
 * blocking rideo accepts).
 */

const TOKEN = 'rdo_import_token';
const registry = createOperatorRegistry();

function setup(opts: { deskEnabled?: boolean; blocked?: boolean } = {}) {
  const mock = new RideoMock(TOKEN);
  const fx = kiteFixture(opts);
  mock.add(fx.data);
  const client = new RideoClient({
    url: 'http://rideo.local',
    token: TOKEN,
    fetchImpl: mock.fetch,
    sleep: async () => undefined,
  });
  const read = () => readClipDocs(client, fx.ids.project, fx.ids.clip);
  return { mock, fx, client, read };
}

/** A project of ours the operators run in (as the agent's would, without its undo history). */
function project(id = 'prj-ours', doc = SceneDoc.create({ empty: true })) {
  const reports: string[] = [];
  const ctx: OperatorContext = {
    doc,
    state: createEditorState(),
    origin: doc.origin,
    source: 'test',
    report: (_level, message) => reports.push(message),
  };
  const runner: ProjectRunner = { id, doc, run: (op, params) => registry.run(ctx, op, params) };
  return { runner, doc, reports };
}

const imp = (runner: ProjectRunner, docs: RideoClipDocs, extra: Record<string, unknown> = {}) =>
  runImport(runner, docs, {
    registry,
    url: 'http://rideo.local',
    created: true,
    projectName: 'Kite in the meadow',
    ...extra,
  });

describe('reading a rideo clip', () => {
  it('reads the project, clip, blocking and the documents of its cast and elements, with the token', async () => {
    const { mock, fx, read } = setup();
    mock.setVideoModels([{ id: 'vid-fast', limits: { min_duration_seconds: 5, max_duration_seconds: 8 } }]);
    const docs = await read();
    expect(docs.project.settings).toMatchObject({ fps: 24, resolution: { width: 160, height: 90 } });
    expect(docs.clip.shots.map((s) => s.id)).toEqual([fx.ids.s1, fx.ids.s2, fx.ids.s3]);
    expect(docs.view.state).toBe('ready');
    expect(docs.characters.map((c) => c.name).sort()).toEqual(['Clover', 'Rosie']);
    expect(docs.elements.map((e) => e.name).sort()).toEqual(['Kite', 'Meadow']);
    expect(docs.missing).toEqual([]);
    // the project's video model ('auto': the gateway's first) and its limits
    expect(docs.limits).toEqual({ min_s: 5, max_s: 8 });
    expect(new Set(mock.requests.map((r) => r.path))).toEqual(
      new Set([
        '/api/config',
        `/api/projects/${fx.ids.project}/docs/project.json`,
        `/api/projects/${fx.ids.project}/docs/clips/${fx.ids.clip}.json`,
        `/api/projects/${fx.ids.project}/clips/${fx.ids.clip}/blocking`,
        `/api/projects/${fx.ids.project}/docs/characters/${fx.ids.rosie}.json`,
        `/api/projects/${fx.ids.project}/docs/characters/${fx.ids.clover}.json`,
        `/api/projects/${fx.ids.project}/docs/elements/${fx.ids.kite}.json`,
        `/api/projects/${fx.ids.project}/docs/elements/${fx.ids.meadow}.json`,
      ]),
    );
    expect(mock.requests.every((r) => r.authorization === `Bearer ${TOKEN}` && r.status === 200)).toBe(true);
  });

  it('notes the documents rideo does not have and fails on anything else', async () => {
    const { fx, read, mock } = setup();
    fx.data.characters.delete(fx.ids.clover);
    fx.data.elements.delete(fx.ids.meadow);
    const docs = await read();
    expect(docs.missing.sort()).toEqual([
      `rideo has no character document ${fx.ids.clover}: imported without its name and description`,
      `rideo has no element document ${fx.ids.meadow}: imported by its blocking label only`,
    ]);
    mock.failNext({ path: /elements\//, status: 500, code: 'internal_error', detail: 'disk on fire' });
    const err = await read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RideoError);
    expect((err as RideoError).message).toContain('rideo answered 500 internal_error to GET');
  });
});

describe("the video model's limits", () => {
  it("are those of the project's video model, rideo's own where it names none, and none from an older rideo", async () => {
    const { mock, fx, read } = setup();
    // an older rideo without /api/config: no limits, the import keeps the desk's own
    expect((await read()).limits).toBeNull();
    mock.setVideoModels([
      { id: 'vid-a', limits: { min_duration_seconds: 3, max_duration_seconds: 6 } },
      { id: 'vid-b', limits: { min_duration_seconds: 2, max_duration_seconds: 12 } },
      { id: 'vid-c', limits: null },
    ]);
    expect((await read()).limits).toEqual({ min_s: 3, max_s: 6 });
    fx.data.project.settings.models = { video: 'vid-b' };
    expect((await read()).limits).toEqual({ min_s: 2, max_s: 12 });
    // a model that names no limit, or one the gateway does not list: rideo clamps to 4–10 s
    fx.data.project.settings.models = { video: 'vid-c' };
    expect((await read()).limits).toEqual(RIDEO_DEFAULT_VIDEO_LIMITS);
    fx.data.project.settings.models = { video: 'vid-gone' };
    expect((await read()).limits).toEqual(RIDEO_DEFAULT_VIDEO_LIMITS);
  });

  it("reach desk.import_rideo_blocking, which keeps the desk's own when there are none", async () => {
    const { mock, read } = setup();
    const accepts = operatorKeys(registry, IMPORT_OPERATOR);
    const none = await read();
    expect(importParams(none, {}, accepts).params).not.toHaveProperty('model_limits');
    expect(importParams(none, { model_limits: { min_s: 3, max_s: 9 } }, accepts).params.model_limits).toEqual(
      {
        min_s: 3,
        max_s: 9,
      },
    );
    const { runner, doc } = project();
    setDeskSettings(doc, { min_shot_s: 3, max_shot_s: 9 });
    imp(runner, none);
    expect(getDeskSettings(doc)).toMatchObject({ min_shot_s: 3, max_shot_s: 9 });
    mock.setVideoModels([{ id: 'vid-a', limits: { min_duration_seconds: 4, max_duration_seconds: 8 } }]);
    const docs = await read();
    expect(importParams(docs, {}, accepts).params.model_limits).toEqual({ min_s: 4, max_s: 8 });
    // the limits asked for win over rideo's
    expect(importParams(docs, { model_limits: { min_s: 2, max_s: 6 } }, accepts).params.model_limits).toEqual(
      {
        min_s: 2,
        max_s: 6,
      },
    );
    imp(runner, docs, { created: false });
    expect(getDeskSettings(doc)).toMatchObject({ min_shot_s: 4, max_shot_s: 8 });
  });
});

describe('the parameters of desk.import_rideo_blocking', () => {
  it("are rideo's documents in the names the operator takes, and only those", async () => {
    const { fx, read } = setup();
    fx.data.characters.get(fx.ids.rosie)!.identity = { age: '8', build: ' small ', face: '', eyes: 7 };
    const docs = await read();
    docs.clip.shots.reverse(); // rideo's order is the index, not the array
    docs.clip.shots[0].board = { approved: true };
    const accepts = operatorKeys(registry, IMPORT_OPERATOR);
    expect(accepts).not.toBeNull();
    const { params, notes } = importParams(
      docs,
      { cast_overrides: { [fx.ids.clover]: 'pony' }, use_store_models: true },
      accepts,
    );
    expect(notes).toEqual([
      "this server's importer has no use_store_models option: it chooses built-in models itself",
    ]);
    expect(Object.keys(params).sort()).toEqual(
      [
        'blocking',
        'cast_overrides',
        'characters',
        'clip',
        'elements',
        'project',
        'settings',
        'shots',
        'state',
        'update',
      ].sort(),
    );
    expect(params).toMatchObject({
      blocking: fx.blocking,
      state: 'ready',
      settings: { fps: 24, width: 160, height: 90, aspect_ratio: '16:9' },
      project: fx.ids.project,
      clip: fx.ids.clip,
      update: true,
      cast_overrides: { [fx.ids.clover]: 'pony' },
    });
    const shots = params.shots as Record<string, unknown>[];
    expect(shots.map((s) => [s.id, s.index, s.board_state])).toEqual([
      [fx.ids.s1, 0, 'none'],
      [fx.ids.s2, 1, 'none'],
      [fx.ids.s3, 2, 'approved'],
    ]);
    expect(shots[1]).toEqual({
      id: fx.ids.s2,
      index: 1,
      duration_s: 0.5,
      framing: 'medium',
      angle: 'three_quarter_left',
      height: 'eye',
      move: 'push_in',
      movement: 'dolly_in',
      lens_mm: 50,
      character_ids: [fx.ids.rosie, fx.ids.clover],
      element_ids: [fx.ids.kite, fx.ids.meadow],
      layout: [],
      continuity: 'cut',
      notes: 'Shot 2 of the kite scene',
      board_state: 'none',
    });
    expect(params.characters).toEqual([
      {
        id: fx.ids.rosie,
        name: 'Rosie',
        summary: 'A young panda who loves kites',
        identity: { age: '8', build: 'small' },
        height_m: 1.2,
      },
      {
        id: fx.ids.clover,
        name: 'Clover',
        summary: 'A small grey pony, Rosie’s friend',
        identity: { build: 'pony' },
        height_m: 1.3,
      },
    ]);
    expect(params.elements).toEqual([
      { id: fx.ids.kite, name: 'Kite', kind: 'prop', summary: 'A red diamond kite with a long tail' },
      { id: fx.ids.meadow, name: 'Meadow', kind: 'location', summary: 'A wide summer meadow' },
    ]);
    // the operator's own schema takes them as they are
    const schema = registry.get(IMPORT_OPERATOR)!.schema;
    expect(schema.safeParse(params).success).toBe(true);
  });

  it('a cast member without a document comes in under its id with its height', async () => {
    const { fx, read } = setup();
    fx.data.characters.delete(fx.ids.clover);
    const { params } = importParams(await read(), {}, operatorKeys(registry, IMPORT_OPERATOR));
    expect(params.characters).toContainEqual({ id: fx.ids.clover, name: fx.ids.clover, height_m: 1.3 });
    expect(params).not.toHaveProperty('cast_overrides');
  });

  it('identity fields keep text only', () => {
    expect(identityFields({ a: ' x ', b: '', c: 3, d: null })).toEqual({ a: 'x' });
    expect(identityFields({ a: '' })).toBeNull();
  });
});

describe('what the import reports', () => {
  it('a missing blocking, the desk off and boards drawn before this staging', async () => {
    const { fx, read } = setup({ blocked: false, deskEnabled: false });
    const docs = await read();
    expect(docs.view.state).toBe('missing');
    expect(clipNotes(docs).warnings).toEqual([
      expect.stringMatching(/^rideo has no blocking for this clip yet/),
      expect.stringMatching(/^rideo's director's desk is off for this project/),
    ]);
    const on = setup();
    const d2 = await on.read();
    d2.clip.shots[1].board = { approved: false };
    d2.clip.shots[2].board = { approved: true };
    const notes = clipNotes(d2);
    expect(notes.boards).toEqual([
      { rideo_shot: on.fx.ids.s2, index: 1, approved: false },
      { rideo_shot: on.fx.ids.s3, index: 2, approved: true },
    ]);
    expect(notes.warnings).toEqual([
      "shot(s) 2, 3 have storyboard frames drawn before this staging (approved: 3): redraw them in rideo once rideo_push has written the blocking; references of approved ones default to mode 'camera'",
    ]);
    expect(boardState({ board: null })).toBe('none');
    void fx;
  });
});

describe('the import into a project (real desk.import_rideo_blocking)', () => {
  it("builds the shots of the clip, one per rideo shot, at rideo's fps and size, and updates them in place", async () => {
    const { fx, read } = setup();
    const docs = await read();
    const { runner, doc } = project();
    const r = imp(runner, docs);
    expect(r.project).toBe('prj-ours');
    expect(r.rideo).toEqual({
      url: 'http://rideo.local',
      project: fx.ids.project,
      clip: fx.ids.clip,
      title: 'Kite in the meadow',
    });
    expect(Object.keys(r.shots)).toEqual([fx.ids.s1, fx.ids.s2, fx.ids.s3]);
    expect(r.unmapped).toEqual([]);
    expect(r.blocking_state).toBe('ready');
    expect(r.desk).toEqual({ enabled: true, layout_image: true });
    const shots = getShots(doc);
    expect(shots.map((s) => s.id)).toEqual(Object.values(r.shots));
    expect(shots.map((s) => s.frame_end - s.frame_start + 1)).toEqual([12, 12, 12]);
    expect(shots.every((s) => s.external?.source === 'rideo' && s.external.clip === fx.ids.clip)).toBe(true);
    expect(doc.getScene().fps).toBe(24);
    const render = doc.getRender();
    expect([render.resolution_x, render.resolution_y]).toEqual([160, 90]);
    expect(Array.isArray(r.issues)).toBe(true);
    expect(r.result).toMatchObject({ actors: expect.any(Array), shots: expect.any(Array) });

    const objects = doc.listObjects().length;
    const again = imp(runner, docs, { created: false });
    expect(again.shots).toEqual(r.shots);
    expect(getShots(doc)).toHaveLength(3);
    expect(doc.listObjects().length).toBe(objects);
    expect(importedShots(doc, fx.ids.clip)).toEqual(r.shots);
  });

  it('imports a clip rideo has no blocking for, with the warning', async () => {
    const { read } = setup({ blocked: false });
    const docs = await read();
    const { runner, doc } = project();
    const r = imp(runner, docs);
    expect(r.blocking_state).toBe('missing');
    expect(getShots(doc)).toHaveLength(3);
    expect(r.warnings[0]).toMatch(/^rideo has no blocking for this clip yet/);
    // one account of what the import did: the operator's (the bridge's says only what comes next)
    const about = r.warnings.filter((w) => /no blocking/.test(w));
    expect(about).toEqual([
      'rideo has no blocking for this clip yet: once it is staged here, rideo_push writes it back',
      "rideo has no blocking for this clip (state 'missing'): the cast stands where the shots' planned layouts put them and every camera is solved",
    ]);
    expect(r.warnings.some((w) => /1\.2 m apart|generic camera|empty draft/.test(w))).toBe(false);
  });

  it('the export of the imported scene is a blocking rideo accepts, with every rideo shot and the cast', async () => {
    const { fx, read, client } = setup();
    const docs = await read();
    const { runner } = project();
    imp(runner, docs);
    const res = runner.run(EXPORT_OPERATOR, {});
    expect(res.ok).toBe(true);
    const blocking = (res.result as { blocking: Record<string, any> }).blocking;
    expect(blockingProblem(blocking)).toBeNull();
    expect(Object.keys(blocking.shots).sort()).toEqual([fx.ids.s1, fx.ids.s2, fx.ids.s3].sort());
    expect((blocking.actors as { characterId: string }[]).map((a) => a.characterId).sort()).toEqual(
      [fx.ids.rosie, fx.ids.clover].sort(),
    );
    const view = await client.putBlocking(fx.ids.project, fx.ids.clip, blocking, { fix: false });
    expect(view.state).toBe('ready');
  });

  it('fails as the operator fails', async () => {
    const { read } = setup();
    const docs = await read();
    const failing: ProjectRunner = {
      id: 'x',
      doc: SceneDoc.create({ empty: true }),
      run: () => ({
        ok: false,
        error: 'the blocking is not valid',
        code: 'INVALID_PARAMS',
        reports: [],
        durationMs: 0,
        params: {},
      }),
    };
    expect(() => imp(failing, docs)).toThrow(`${IMPORT_OPERATOR} failed: the blocking is not valid`);
  });
});

describe('the project a clip goes into', () => {
  /** Projects by name, as the agent or the rooms would find them. */
  function access(existing: Record<string, SceneDoc> = {}) {
    const made: string[] = [];
    const runnerOf = (name: string, doc: SceneDoc) => ({ runner: project(`id-${name}`, doc).runner, name });
    const a: ProjectAccess = {
      find: async (ref) => (existing[ref] ? runnerOf(ref, existing[ref]) : null),
      create: async (name) => {
        made.push(name);
        existing[name] = SceneDoc.create({ empty: true });
        return runnerOf(name, existing[name]);
      },
    };
    return { a, made };
  }
  const withShots = (clip: string | null) => {
    const doc = SceneDoc.create({ empty: true });
    setShots(doc, [
      {
        id: newShotId(),
        name: 'S',
        enabled: true,
        camera: null,
        frame_start: 1,
        frame_end: 10,
        external: clip ? { source: 'rideo', project: 'p', clip, shot: 'sht_0000000000000001' } : null,
      },
    ]);
    return doc;
  };

  it('is the one given (made when missing), else one named after the clip', async () => {
    const { fx, read } = setup();
    const docs = await read();
    const one = access();
    expect(await importTarget(one.a, 'My film', docs)).toMatchObject({ created: true, name: 'My film' });
    expect(await importTarget(one.a, 'My film', docs)).toMatchObject({ created: false, name: 'My film' });
    const two = access();
    expect(await importTarget(two.a, undefined, docs)).toMatchObject({
      created: true,
      name: 'Kite in the meadow',
    });
    expect(two.made).toEqual(['Kite in the meadow']);
    void fx;
  });

  it("reuses the clip's own project, and names another after the clip id when the title is taken", async () => {
    const { fx, read } = setup();
    const docs = await read();
    const own = access({ 'Kite in the meadow': withShots(fx.ids.clip) });
    expect(await importTarget(own.a, undefined, docs)).toMatchObject({
      created: false,
      name: 'Kite in the meadow',
    });
    const empty = access({ 'Kite in the meadow': SceneDoc.create({ empty: true }) });
    expect(await importTarget(empty.a, undefined, docs)).toMatchObject({ created: false });
    for (const taken of [withShots('clp_0000000000000999'), withShots(null)]) {
      const other = access({ 'Kite in the meadow': taken });
      expect(await importTarget(other.a, undefined, docs)).toMatchObject({
        created: true,
        name: `Kite in the meadow (${fx.ids.clip})`,
      });
    }
    const both = access({
      'Kite in the meadow': withShots(null),
      [`Kite in the meadow (${fx.ids.clip})`]: withShots('clp_0000000000000999'),
    });
    await expect(importTarget(both.a, undefined, docs)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('a clip without a title is named by its place in the story', () => {
    expect(defaultProjectName({ id: 'clp_0000000000000002', index: 4, title: '  ' })).toBe('Scene 5');
    expect(defaultProjectName({ id: 'clp_0000000000000002', index: 0, title: 'Kite day' })).toBe('Kite day');
  });
});
