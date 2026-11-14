import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getShots } from '@3d-editor/core';
import { MP4_FORMAT_NAME } from '../../src/rideo/probe';
import { PUSH_RECORD_FILE } from '../../src/rideo/push';
import { defaultFfmpegPath, hasFfmpeg } from '../../src/video/ffmpeg';
import { api, startServer, type TestServer } from '../helpers/app';
import { blockingProblem, kiteFixture, RideoMock } from '../helpers/rideo-mock';

/*
 * The rideo bridge end to end (SPEC §11) against the rideo mock served over HTTP, with the real
 * importer, a real tiny export (160×90 at 24 fps, draft, clay) and the real ffmpeg/ffprobe:
 * rideo_import builds the project named after the clip (one undo step; importing again updates it),
 * rideo_push writes the blocking (a SceneBlocking v1 rideo accepts) and sends the clips of the shots
 * that need a reference as multipart uploads (H.264 MP4 with its ffprobe account and a JPEG
 * poster) and shot PATCHes; pushing again sends nothing; an approved clip refuses the blocking
 * (409) unless write_blocking is false; POST /api/rideo/previs does it all as one job: it imports
 * the blocking the push wrote, so its draft renders the same clips byte for byte and rideo, which has
 * them (by sha256), gets no upload, while a staging changed in rideo uploads the clips that changed;
 * RIDEO_TOKEN only goes to RIDEO_URL. Skipped without ffmpeg unless FFMPEG_REQUIRED=1.
 */

process.env.RENDER_WORKERS = '2';

const run = (await hasFfmpeg(defaultFfmpegPath())) || process.env.FFMPEG_REQUIRED === '1';
const TOKEN = 'rdo_integration_token';

let mock: RideoMock;
let fx: ReturnType<typeof kiteFixture>;
let server: TestServer;
let client: Client;
let projectId = '';
let exportId = '';
/** The previs job of POST /api/rideo/previs as it ended. */
let previsJob: any = null;
/** What the first rideo_push sent of each shot it pushed: its clip's sha256 and rideo's resource. */
let firstPush: { rideo_shot: string; sha256: string; resource: string }[] = [];

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await call(name, args);
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

const target = () => ({ project: fx.ids.project, clip: fx.ids.clip });
const clipDoc = () => fx.data.clips.get(fx.ids.clip)!;
const rideoShot = (id: string) => (clipDoc().shots as Record<string, any>[]).find((s) => s.id === id)!;
const exportDir = (id: string) => path.join(server.dataDir, 'exports', projectId, id);

/** POST /api/rideo/previs for the fixture's clip, followed to its end: the answer and the job. */
async function previs(): Promise<{ started: any; job: any }> {
  const started = await api(server.url, '/api/rideo/previs', { method: 'POST', json: { rideo: target() } });
  expect(started.status).toBe(202);
  let job = started.body;
  for (let i = 0; i < 40 && !['done', 'failed', 'cancelled'].includes(job.status); i++)
    job = (await api(server.url, `/api/rideo/previs/${job.id}?wait=20`)).body;
  return { started: started.body, job };
}

/** Moves a character's opening mark and its marks of every shot `dx` metres along rideo's x. */
function moveCharacter(blocking: any, characterId: string, dx: number): void {
  for (const a of blocking.actors) if (a.characterId === characterId) a.x += dx;
  for (const shot of Object.values(blocking.shots) as any[]) {
    const mark = shot.marks?.[characterId];
    if (!mark) continue;
    mark.x += dx;
    if (typeof mark.toX === 'number') mark.toX += dx;
  }
}

/** Pushed shots by rideo shot id, for comparisons that do not depend on their order. */
const byShot = <T extends { rideo_shot: string }>(shots: T[]): T[] =>
  [...shots].sort((a, b) => a.rideo_shot.localeCompare(b.rideo_shot));

async function exported(id: string): Promise<any> {
  for (let i = 0; i < 40; i++) {
    const s = await ok('export_status', { export: id, wait_s: 20 });
    if (['done', 'failed', 'cancelled'].includes(s.status)) return s;
  }
  throw new Error(`export ${id} did not finish`);
}

describe.skipIf(!run)('rideo bridge end to end', { timeout: 300_000 }, () => {
  beforeAll(async () => {
    mock = new RideoMock(TOKEN);
    fx = kiteFixture();
    mock.add(fx.data);
    await mock.listen();
    server = await startServer({ RIDEO_URL: `${mock.url}/`, RIDEO_TOKEN: TOKEN });
    client = new Client({ name: 'rideo-bridge-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await server?.cleanup();
    await mock?.close();
  });

  it('rideo_import builds the project named after the clip, one shot per rideo shot, as one undo step', async () => {
    const r = await ok('rideo_import', { rideo: target() });
    projectId = r.project;
    expect(r).toMatchObject({
      project_name: 'Kite in the meadow',
      created: true,
      rideo: { url: mock.url, project: fx.ids.project, clip: fx.ids.clip, title: 'Kite in the meadow' },
      blocking_state: 'ready',
      desk: { enabled: true, layout_image: true },
      unmapped: [],
      boards_to_redraw: [],
    });
    expect(Object.keys(r.shots)).toEqual([fx.ids.s1, fx.ids.s2, fx.ids.s3]);
    const doc = server.handle.rooms.get(projectId)!.scene;
    const shots = getShots(doc);
    expect(shots.map((s) => s.id)).toEqual(Object.values(r.shots));
    expect(shots.map((s) => [s.frame_end - s.frame_start + 1, s.external?.shot])).toEqual([
      [12, fx.ids.s1],
      [12, fx.ids.s2],
      [12, fx.ids.s3],
    ]);
    expect(doc.getScene().fps).toBe(24);
    expect([doc.getRender().resolution_x, doc.getRender().resolution_y]).toEqual([160, 90]);
    expect(mock.requests.length).toBeGreaterThanOrEqual(7);
    expect(mock.requests.every((q) => q.authorization === `Bearer ${TOKEN}`)).toBe(true);

    // one undo step takes the whole import back, redo brings it again
    expect(await ok('undo', { project: projectId })).toMatchObject({ undone: 1 });
    expect(getShots(doc)).toHaveLength(0);
    expect(await ok('redo', { project: projectId })).toMatchObject({ redone: 1 });
    expect(getShots(doc).map((s) => s.id)).toEqual(Object.values(r.shots));

    // importing again (by the clip's name) updates the same project in place
    const objects = doc.listObjects().length;
    const again = await ok('rideo_import', { rideo: target() });
    expect(again).toMatchObject({ project: projectId, created: false, shots: r.shots });
    expect(doc.listObjects()).toHaveLength(objects);
  });

  it('rideo_push writes the blocking and sends the clips of the shots that need a reference', async () => {
    const start = await ok('export_video', {
      project: projectId,
      quality: 'draft',
      look: 'clay',
      outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
      passes: ['beauty', 'pose', 'depth'],
      fps: 24,
      width: 160,
      height: 90,
    });
    exportId = start.export;
    const job = await exported(exportId);
    expect(job.status).toBe('done');
    const manifest = JSON.parse(await readFile(path.join(exportDir(exportId), 'manifest.json'), 'utf8'));
    // rideo words the blocking lines as our export does (its solver and ours agree on the staging)
    mock.setLines(
      fx.ids.clip,
      Object.fromEntries(manifest.shots.map((s: any) => [s.external.shot, s.blocking_line])),
    );

    // the cameras rideo has before the push: a PATCH that sets a move keeps the rest of them
    const cameras = new Map((clipDoc().shots as Record<string, any>[]).map((s) => [s.id, { ...s.camera }]));

    const r = await ok('rideo_push', { project: projectId, export: exportId, rideo: target() });
    expect(r.status).toBe('done');
    expect(r.blocking).toEqual({
      written: true,
      state: 'ready',
      error: null,
      differences: [],
      plan_mismatch: [],
    });
    // nothing changed between the export and the push
    expect(r.stale).toEqual([]);
    expect(mock.puts).toHaveLength(1);
    expect(mock.puts[0].body.fix).toBe(false);
    expect(blockingProblem(mock.puts[0].body.blocking)).toBeNull();
    expect(Object.keys(mock.puts[0].body.blocking.shots).sort()).toEqual(
      [fx.ids.s1, fx.ids.s2, fx.ids.s3].sort(),
    );

    const pushed = r.shots.filter((s: any) => s.status === 'pushed');
    // shot 2 pushes in: a camera move always needs a reference
    expect(pushed.map((s: any) => s.rideo_shot)).toContain(fx.ids.s2);
    firstPush = pushed.map((s: any) => ({
      rideo_shot: s.rideo_shot,
      sha256: s.sha256,
      resource: s.resource,
    }));
    for (const s of r.shots.filter((x: any) => x.status === 'skipped')) expect(s.why).toBeTruthy();
    expect(mock.uploads).toHaveLength(pushed.length);
    expect(mock.patches).toHaveLength(pushed.length);
    for (const s of pushed) {
      const upload = mock.uploads.find((u) => u.resource?.id === s.resource)!;
      expect(upload, s.rideo_shot).toBeDefined();
      const file = job.files.find((f: any) => f.name === s.file);
      expect(file).toMatchObject({ kind: 'clip', shot: s.shot, pass: s.pass, frames: 12 });
      // the multipart parts: the clip as it is on disk, its probe, a JPEG poster
      expect(upload.status).toBe(201);
      expect(upload.fields).toMatchObject({ kind: 'video', role: 'reference' });
      expect(upload.fields.name).toBe(`3D previs: ${s.name} (${s.mode})`);
      expect(upload.file).toMatchObject({ filename: s.file, type: 'video/mp4' });
      expect(Buffer.from(upload.file!.bytes.slice(4, 8)).toString('latin1')).toBe('ftyp');
      expect(createHash('sha256').update(upload.file!.bytes).digest('hex')).toBe(file.sha256);
      expect(upload.file!.bytes.length).toBe((await stat(path.join(exportDir(exportId), s.file))).size);
      expect(upload.poster).toMatchObject({ type: 'image/jpeg' });
      expect([...upload.poster!.bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
      const probe = JSON.parse(upload.fields.meta).probe;
      expect(probe).toMatchObject({
        formatName: MP4_FORMAT_NAME,
        hasVideo: true,
        hasAudio: false,
        width: 160,
        height: 90,
        fps: 24,
        videoCodec: 'h264',
      });
      expect(probe.durationSec).toBeCloseTo(0.5, 2);
      expect(upload.resource).toMatchObject({ kind: 'video', status: 'ready' });
      // the shot points at it, with the move we rendered
      const patch = mock.patches.find((p) => p.shot === s.rideo_shot)!;
      expect(patch.body.motionReference).toEqual({ resourceId: s.resource, mode: s.mode });
      if (s.camera_move) {
        // the whole camera rideo had, with our move: a camera of {move} alone resets its framing
        const camera = { ...cameras.get(s.rideo_shot), move: s.camera_move };
        expect(patch.body.camera).toEqual(camera);
        expect(rideoShot(s.rideo_shot).camera).toEqual(camera);
      }
      expect(rideoShot(s.rideo_shot).motionReference).toEqual({ resourceId: s.resource, mode: s.mode });
    }
    expect(r.shots.find((s: any) => s.rideo_shot === fx.ids.s2)).toMatchObject({
      camera_move: 'push_in',
      reused: false,
    });
    const record = JSON.parse(await readFile(path.join(exportDir(exportId), PUSH_RECORD_FILE), 'utf8'));
    expect(Object.keys(record.targets[`${mock.url}|${fx.ids.project}|${fx.ids.clip}`]).sort()).toEqual(
      pushed.map((s: any) => s.rideo_shot).sort(),
    );

    // pushing again sends nothing new: every clip is already there
    const again = await ok('rideo_push', { project: projectId, export: exportId, rideo: target() });
    expect(again.status).toBe('done');
    expect(again.shots.filter((s: any) => s.status !== 'skipped').map((s: any) => s.status)).toEqual(
      pushed.map(() => 'unchanged'),
    );
    expect(mock.uploads).toHaveLength(pushed.length);
    expect(mock.patches).toHaveLength(pushed.length);
  });

  it('an approved clip refuses the blocking (409): nothing is pushed unless write_blocking is false', async () => {
    const puts = mock.puts.length;
    const uploads = mock.uploads.length;
    clipDoc().status = 'approved';
    for (const s of clipDoc().shots as Record<string, any>[]) s.motionReference = null;
    try {
      const refused = await ok('rideo_push', { project: projectId, export: exportId, rideo: target() });
      expect(refused.status).toBe('failed');
      expect(refused.blocking.error).toMatch(/rideo answered 409 conflict to PUT .*: clip 1 is approved/);
      expect(refused.shots).toEqual([]);
      const r = await ok('rideo_push', {
        project: projectId,
        export: exportId,
        rideo: target(),
        write_blocking: false,
      });
      expect(r.status).toBe('done');
      expect(r.blocking).toMatchObject({ written: false, state: 'ready' });
      const pushed = r.shots.filter((s: any) => s.status === 'pushed');
      expect(pushed.length).toBeGreaterThan(0);
      // the clips went up before: they are only set on the shots again
      expect(pushed.every((s: any) => s.reused)).toBe(true);
      expect(mock.uploads).toHaveLength(uploads);
      expect(mock.puts).toHaveLength(puts);
    } finally {
      clipDoc().status = 'planned';
    }
  });

  it('POST /api/rideo/previs imports, exports a draft and pushes as one job', async () => {
    const uploads = mock.uploads.length;
    const patches = mock.patches.length;
    const { started, job } = await previs();
    expect(started).toMatchObject({ status: 'importing', rideo: { url: mock.url, ...target() } });
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.project).toBe(projectId);
    expect(job.project_name).toBe('Kite in the meadow');
    expect(Object.keys(job.import.shots)).toEqual([fx.ids.s1, fx.ids.s2, fx.ids.s3]);
    expect(job.export).toBeTruthy();
    expect(job.export).not.toBe(exportId);
    expect(job.export_status).toMatchObject({ status: 'done' });
    expect(job.push).toMatchObject({ status: 'done', export: job.export });
    // the round trip is exact: the import rebuilds the staging the first push wrote, so the new
    // export renders the same clips byte for byte; rideo has them (by sha256), so every shot is set
    // to the resource the first push uploaded, and nothing is uploaded again
    const pushed = job.push.shots.filter((s: any) => s.status === 'pushed');
    expect(pushed.length).toBeGreaterThan(0);
    expect(
      byShot(pushed).map((s: any) => ({
        rideo_shot: s.rideo_shot,
        sha256: s.sha256,
        resource: s.resource,
        reused: s.reused,
      })),
    ).toEqual(byShot(firstPush).map((s) => ({ ...s, reused: true })));
    expect(mock.uploads).toHaveLength(uploads);
    // a new export keeps a record of its own: each shot is set to its reference again, once
    expect(
      mock.patches
        .slice(patches)
        .filter((p) => p.body.motionReference)
        .map((p) => p.shot),
    ).toEqual(pushed.map((s: any) => s.rideo_shot));
    for (const s of pushed)
      expect(rideoShot(s.rideo_shot).motionReference).toEqual({ resourceId: s.resource, mode: s.mode });
    // the previs export: draft clay clips only, at rideo's fps and size
    const ex = await ok('export_status', { export: job.export });
    expect(ex.params).toMatchObject({
      quality: 'draft',
      look: 'clay',
      fps: 24,
      width: 160,
      height: 90,
      outputs: { sequence: false, clips: true, posters: false, contact_sheet: false },
    });
    expect(ex.params.passes).toContain('beauty');
    expect((await api(server.url, '/api/rideo/previs/nope')).status).toBe(404);
    previsJob = job;
  });

  it('a previs of a staging changed in rideo uploads the clips that changed', async () => {
    // rideo's blocking as the last push wrote it, with Clover 1.5 m further right in every mark
    moveCharacter(clipDoc().blocking, fx.ids.clover, 1.5);
    const uploads = mock.uploads.length;
    const known = new Set(mock.uploads.map((u) => u.resource?.id));
    const { job } = await previs();
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.push).toMatchObject({ status: 'done', export: job.export });
    const pushed = job.push.shots.filter((s: any) => s.status === 'pushed');
    const fresh = pushed.filter((s: any) => !s.reused);
    expect(fresh.length).toBeGreaterThan(0);
    expect(mock.uploads).toHaveLength(uploads + fresh.length);
    const before = new Map(firstPush.map((s) => [s.rideo_shot, s.sha256]));
    for (const s of fresh) {
      // a clip rideo did not have, uploaded as a new resource with its bytes
      expect(s.sha256, s.rideo_shot).not.toBe(before.get(s.rideo_shot));
      expect(known.has(s.resource), s.rideo_shot).toBe(false);
      const upload = mock.uploads.slice(uploads).find((u) => u.resource?.id === s.resource);
      expect(upload, s.rideo_shot).toBeDefined();
      expect(createHash('sha256').update(upload!.file!.bytes).digest('hex')).toBe(s.sha256);
      expect(rideoShot(s.rideo_shot).motionReference).toEqual({ resourceId: s.resource, mode: s.mode });
    }
    // a clip the change left as it was keeps the resource rideo has
    for (const s of pushed.filter((x: any) => x.reused)) expect(known.has(s.resource)).toBe(true);
  });

  it('RIDEO_TOKEN goes to RIDEO_URL only: another rideo server gets the token passed or none', async () => {
    const other = new RideoMock(null);
    other.add(kiteFixture().data);
    await other.listen();
    try {
      await ok('rideo_import', { project: 'Elsewhere', rideo: { ...target(), url: other.url } });
      expect(other.requests.length).toBeGreaterThan(0);
      expect(other.requests.every((q) => q.authorization === null)).toBe(true);
      await ok('rideo_import', {
        project: 'Elsewhere',
        rideo: { ...target(), url: other.url, token: 'rdo_other' },
      });
      expect(other.requests.at(-1)!.authorization).toBe('Bearer rdo_other');
    } finally {
      await other.close();
    }
  });

  it('a server restarted on the same DATA_DIR answers the previs job as it ended', async () => {
    expect(previsJob?.status).toBe('done');
    await client.close();
    await server.close();
    server = await startServer({ DATA_DIR: server.dataDir, RIDEO_URL: `${mock.url}/`, RIDEO_TOKEN: TOKEN });
    client = new Client({ name: 'rideo-bridge-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    const again = await api(server.url, `/api/rideo/previs/${previsJob.id}`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(previsJob);
    expect(again.body).toMatchObject({
      status: 'done',
      export: expect.any(String),
      push: { status: 'done' },
    });
  });
});
