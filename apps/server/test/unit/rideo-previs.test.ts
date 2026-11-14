import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  SceneDoc,
  createCube,
  createEditorState,
  createOperatorRegistry,
  defaultRigidBody,
  defaultRigidBodyWorld,
  getShots,
  newShotId,
  setShots,
} from '@3d-editor/core';
import { registerRideoRoutes } from '../../src/api/rideo';
import { NotFoundError, ToolError } from '../../src/mcp/agent';
import {
  RideoBridge,
  exportBlockingOf,
  previsExportParams,
  previsPlan,
  type PrevisJob,
  type PrevisRequest,
} from '../../src/rideo';
import { RideoClient } from '../../src/rideo/client';
import { readClipDocs, type ProjectRunner, type RideoClipDocs } from '../../src/rideo/import';
import type { PushResult } from '../../src/rideo/push';
import type { ServerServices, ServiceContext } from '../../src/services';
import { RideoMock, kiteFixture, rideoId } from '../helpers/rideo-mock';

/*
 * POST /api/rideo/previs (SPEC §11): what a previs exports (the shots that need a reference and the
 * passes of their modes, over the previs defaults: draft, clay, clips only, rideo's fps and size),
 * and the REST routes' answers (202 with the job, 400 for a bad body, 404 for an unknown job, the
 * error codes of the bridge as HTTP statuses).
 */

async function rideoDocs(opts: { deskEnabled?: boolean } = {}) {
  const mock = new RideoMock(null);
  const fx = kiteFixture(opts);
  mock.add(fx.data);
  const client = new RideoClient({
    url: 'http://rideo.local',
    fetchImpl: mock.fetch,
    sleep: async () => undefined,
  });
  return { fx, docs: await readClipDocs(client, fx.ids.project, fx.ids.clip) };
}

/**
 * Our project after rideo_import: three shots imported from the kite clip, under one camera; a ball
 * simulated over shot 1, an actor throughout, shot 2 pushing in.
 */
function imported(docs: RideoClipDocs) {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({
    fps: 24,
    frame_start: 1,
    frame_end: 36,
    rigidbody_world: { ...defaultRigidBodyWorld(), enabled: true, frame_start: 1, frame_end: 12 },
  });
  const cam = doc.addObject({
    type: 'CAMERA',
    name: 'Cam',
    data: doc.addCamera({ lens: 35 }),
    location: [0, -8, 1],
    rotation_euler: [Math.PI / 2, 0, 0],
  });
  doc.addObject({ type: 'EMPTY', name: 'Rosie', location: [0, 0, 0], custom_props: { desk_role: 'actor' } });
  doc.addObject({
    type: 'MESH',
    name: 'Ball',
    data: doc.addMesh('Ball', createCube({ size: 0.3 })),
    location: [0.5, 0, 2],
    rigid_body: defaultRigidBody(),
  });
  const ids = [newShotId(), newShotId(), newShotId()];
  const external = (i: number) => ({
    source: 'rideo',
    project: docs.project.id,
    clip: docs.clip.id,
    shot: docs.clip.shots[i].id,
  });
  setShots(doc, [
    {
      id: ids[0],
      name: 'Shot 1',
      enabled: true,
      camera: cam,
      frame_start: 1,
      frame_end: 12,
      external: external(0),
    },
    {
      id: ids[1],
      name: 'Shot 2',
      enabled: true,
      camera: cam,
      frame_start: 13,
      frame_end: 24,
      move: 'push_in',
      external: external(1),
    },
    {
      id: ids[2],
      name: 'Shot 3',
      enabled: true,
      camera: cam,
      frame_start: 25,
      frame_end: 36,
      external: external(2),
    },
  ]);
  const map = Object.fromEntries(docs.clip.shots.map((s, i) => [s.id, ids[i]]));
  return { doc, ids, map };
}

describe('what a previs exports', () => {
  it('the shots with props in motion or a camera move, with beauty and the passes of their modes', async () => {
    const { docs } = await rideoDocs();
    const { doc, ids, map } = imported(docs);
    // motion (beauty) and pose, and depth: rideo's answer to the blocking can still make a shot's
    // reference a camera reference at push time, and the push sends no other pass in its place
    expect(previsPlan(doc, docs, map, undefined)).toEqual({
      shots: [ids[0], ids[1]],
      passes: ['beauty', 'depth', 'pose'],
      warnings: [],
    });
    // with rideo's desk off every reference is a camera reference: depth
    const off = await rideoDocs({ deskEnabled: false });
    const o = imported(off.docs);
    expect(previsPlan(o.doc, off.docs, o.map, undefined).passes).toEqual(['beauty', 'depth']);
  });

  it('the shots asked for (ours by name or id, or rideo ids), in their modes or the one asked', async () => {
    const { fx, docs } = await rideoDocs();
    const { doc, ids, map } = imported(docs);
    expect(previsPlan(doc, docs, map, { shots: ['shot 3', fx.ids.s1, ids[2]] })).toEqual({
      shots: [ids[2], ids[0]],
      passes: ['beauty', 'pose', 'depth'],
      warnings: [],
    });
    // a mode or a pass asked for is the one the push sends: nothing else is needed
    expect(previsPlan(doc, docs, map, { mode: 'camera' }).passes).toEqual(['beauty', 'depth']);
    expect(previsPlan(doc, docs, map, { mode: 'pose' }).passes).toEqual(['beauty', 'pose']);
    expect(previsPlan(doc, docs, map, { pass: 'normal' }).passes).toEqual(['beauty', 'normal']);
    expect(() => previsPlan(doc, docs, map, { shots: ['Shot 9'] })).toThrow(
      "push.shots: no shot 'Shot 9' in the imported project",
    );
  });

  it("draft clay clips at rideo's fps and size, labelled after the clip, under what the request sets", async () => {
    const { docs } = await rideoDocs();
    const plan = { shots: ['a', 'b'], passes: ['beauty', 'pose'] as ('beauty' | 'pose')[], warnings: [] };
    expect(previsExportParams(docs, plan, undefined)).toEqual({
      preset: 'rideo',
      shots: ['a', 'b'],
      quality: 'draft',
      look: 'clay',
      outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
      passes: ['beauty', 'pose'],
      fps: 24,
      width: 160,
      height: 90,
      codec: 'h264',
      match_model_duration: false,
      label: 'rideo previs: Kite in the meadow',
    });
    expect(previsExportParams(docs, plan, { quality: 'standard', look: 'material' })).toMatchObject({
      quality: 'standard',
      look: 'material',
      shots: ['a', 'b'],
    });
  });
});

describe('a previs job', () => {
  it('pushes the staging its clips show: edits made while they render reach neither the blocking nor the moves', async () => {
    const mock = new RideoMock(null);
    const fx = kiteFixture();
    mock.add(fx.data);
    const registry = createOperatorRegistry();
    const doc = SceneDoc.create({ empty: true });
    const room = { id: 'prj-ours', scene: doc, touch: () => undefined };
    const live: ProjectRunner = {
      id: room.id,
      doc,
      run: (op, params) =>
        registry.run(
          { doc, state: createEditorState(), origin: doc.origin, source: 'test', report: () => undefined },
          op,
          params,
        ),
    };
    const exportJob = (status: string) => ({ id: 'exp1', status, progress: null, error: null, warnings: [] });
    let edits = 0;
    const exports = {
      start: async () => exportJob('running'),
      status: async () => {
        // the project changes while the clips render: shot 2 pans instead of pushing in
        if (!edits++)
          setShots(
            doc,
            getShots(doc).map((s) =>
              s.external?.shot === fx.ids.s2 ? { ...s, move: 'pan_left' as const } : s,
            ),
          );
        return exportJob('done');
      },
    };
    // the bridge keeps its previs jobs in DATA_DIR
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rideo-previs-'));
    const bridge = new RideoBridge({
      config: {
        rideoUrl: 'http://rideo.local',
        rideoToken: null,
        dataDir,
        ffmpegPath: 'ffmpeg',
      },
      fetch: mock.fetch,
      services: { registry, exports },
      rooms: {
        open: async (id: string) => {
          if (id !== room.id) throw new Error(`no project ${id}`);
          return room;
        },
        listProjects: async () => [],
      },
    } as unknown as ServiceContext);
    onTestFinished(async () => {
      // its last writes end before the folder goes
      await bridge.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const pushed: { doc: SceneDoc; moves: Record<string, string | null> }[] = [];
    vi.spyOn(bridge, 'push').mockImplementation(async (runner) => {
      pushed.push({ doc: runner.doc, moves: exportBlockingOf(runner).moves ?? {} });
      return {
        status: 'done',
        blocking: { written: true, state: 'ready', error: null, differences: [], plan_mismatch: [] },
        shots: [],
        moves: [],
        stale: [],
        warnings: [],
      } as unknown as PushResult;
    });

    const job = await bridge.startPrevis({
      rideo: { project: fx.ids.project, clip: fx.ids.clip },
      project: room.id,
    });
    let st = job;
    for (let i = 0; i < 50 && !['done', 'failed', 'cancelled'].includes(st.status); i++)
      st = await bridge.previsStatus(job.id, { waitS: 1 });
    expect(st.error).toBeNull();
    expect(st.status).toBe('done');
    expect(edits).toBe(1);
    expect(pushed).toHaveLength(1);
    // the push reads a copy of the project taken as the export started, not the project as it is now
    expect(pushed[0].doc).not.toBe(doc);
    expect(pushed[0].moves[fx.ids.s2]).toBe('push_in');
    expect(exportBlockingOf(live).moves?.[fx.ids.s2]).toBe('pan_left');
  });
});

describe('REST: /api/rideo/previs', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const job = (over: Partial<PrevisJob> = {}): PrevisJob => ({
    id: 'job1',
    status: 'importing',
    created_at: '2026-11-13T10:00:00.000Z',
    finished_at: null,
    rideo: { url: 'http://rideo.local', project: rideoId('prj', 1), clip: rideoId('clp', 2) },
    project: null,
    project_name: null,
    export: null,
    import: null,
    export_status: null,
    push: null,
    error: null,
    warnings: [],
    ...over,
  });

  /** The routes over a bridge that records its calls and fails as told. */
  async function serve(fail?: Error) {
    const calls: { start: PrevisRequest[]; status: { id: string; waitS?: number }[] } = {
      start: [],
      status: [],
    };
    const rideo = {
      startPrevis: async (req: PrevisRequest) => {
        calls.start.push(req);
        if (fail) throw fail;
        return job();
      },
      previsStatus: async (id: string, opts: { waitS?: number } = {}) => {
        calls.status.push({ id, waitS: opts.waitS });
        if (id !== 'job1') throw new NotFoundError(`Previs job '${id}' not found`);
        return job({ status: 'done' });
      },
    };
    app = Fastify();
    registerRideoRoutes(app, { rideo } as unknown as ServerServices);
    await app.ready();
    return calls;
  }

  const body = { rideo: { project: rideoId('prj', 1), clip: rideoId('clp', 2) } };

  it('starts a job (202) and answers its status', async () => {
    const calls = await serve();
    const res = await app.inject({
      method: 'POST',
      url: '/api/rideo/previs',
      payload: {
        ...body,
        project: 'Kite',
        model_limits: { min_s: 4, max_s: 10 },
        push: { mode: 'motion', write_blocking: false },
        export: { quality: 'standard' },
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: 'job1', status: 'importing' });
    expect(calls.start).toEqual([
      {
        ...body,
        project: 'Kite',
        model_limits: { min_s: 4, max_s: 10 },
        push: { mode: 'motion', write_blocking: false },
        export: { quality: 'standard' },
      },
    ]);
    const st = await app.inject({ method: 'GET', url: '/api/rideo/previs/job1?wait=2' });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ id: 'job1', status: 'done' });
    expect(calls.status).toEqual([{ id: 'job1', waitS: 2 }]);
  });

  it('refuses bodies that are not a previs request (400) before starting anything', async () => {
    const calls = await serve();
    for (const payload of [
      {},
      { rideo: { project: 'prj_1', clip: rideoId('clp', 2) } },
      { rideo: { ...body.rideo, extra: 1 } },
      { ...body, push: { mode: 'performance' } },
      { ...body, extra: true },
      { ...body, model_limits: { min_s: 4, max_s: 10, model: 'x' } },
      { ...body, model_limits: { min_s: -1, max_s: 10 } },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/rideo/previs', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toHaveProperty('error');
    }
    const wait = await app.inject({ method: 'GET', url: '/api/rideo/previs/job1?wait=60' });
    expect(wait.statusCode).toBe(400);
    expect(calls.start).toEqual([]);
    expect(calls.status).toEqual([]);
  });

  it('answers 404 for an unknown job', async () => {
    await serve();
    const res = await app.inject({ method: 'GET', url: '/api/rideo/previs/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });

  it.each([
    ['QUEUE_FULL', 409],
    ['UNAVAILABLE', 503],
    ['UPSTREAM', 503],
    ['INVALID_PARAMS', 400],
  ] as const)('maps the bridge error %s to %i', async (code, status) => {
    await serve(new ToolError(`it failed (${code})`, code));
    const res = await app.inject({ method: 'POST', url: '/api/rideo/previs', payload: body });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code, error: expect.stringContaining('it failed') });
  });
});
