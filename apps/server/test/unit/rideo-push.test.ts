import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createCube,
  defaultRigidBody,
  defaultRigidBodyWorld,
  getShots,
  newShotId,
  setShots,
} from '@3d-editor/core';
import { NotFoundError, ToolError } from '../../src/mcp/agent';
import { RideoClient } from '../../src/rideo/client';
import { MP4_FORMAT_NAME, type ClipProbe } from '../../src/rideo/probe';
import {
  MAX_PUSH_BYTES,
  PUSH_RECORD_FILE,
  clipMismatch,
  fileResources,
  parseManifest,
  pushExport,
  readPushRecord,
  resolveShotRefs,
  trackMoves,
  type PushEnvironment,
  type PushParams,
} from '../../src/rideo/push';
import type { PassName } from '../../src/render/protocol';
import type { ExportFile, ExportFileRef, ExportJob } from '../../src/video';
import { RideoMock, kiteFixture, rideoId } from '../helpers/rideo-mock';

/*
 * rideo_push (SPEC §11) against the rideo mock with a fake export on disk: which shots go up by
 * default and in which mode and pass, what rideo receives (the blocking PUT, multipart uploads,
 * shot PATCHes), the refusals (frames, fps, size, codec), what is never replaced ('performance'
 * references), and that a clip goes up once per content (sha256) however often it is pushed.
 */

const TOKEN = 'rdo_test_token';
const EXPORT = 'exp_kite';
const PASSES: PassName[] = ['beauty', 'pose', 'depth'];
const STATIC_TRACK = Array.from({ length: 12 }, () => ({
  position: [0, -8, 1],
  rotation_quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
}));

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/**
 * Our project as rideo_import would have made it: three shots of 12 frames under one camera at
 * (0, −8, 1) looking along +Y; an actor at the origin throughout; a ball simulated over shot 1 only;
 * shot 2 pushes in.
 */
function ourProject() {
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
  setShots(doc, [
    { id: ids[0], name: 'Shot 1', enabled: true, camera: cam, frame_start: 1, frame_end: 12 },
    {
      id: ids[1],
      name: 'Shot 2',
      enabled: true,
      camera: cam,
      frame_start: 13,
      frame_end: 24,
      move: 'push_in',
    },
    { id: ids[2], name: 'Shot 3', enabled: true, camera: cam, frame_start: 25, frame_end: 36 },
  ]);
  return { doc, ids };
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** The rideo mock with the kite fixture, our project, a finished export of it on disk and the push environment. */
async function harness(opts: { deskEnabled?: boolean; codec?: string; passes?: PassName[] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rideo-push-'));
  dirs.push(dir);
  const mock = new RideoMock(TOKEN);
  const fx = kiteFixture({ deskEnabled: opts.deskEnabled });
  mock.add(fx.data);
  const ours = ourProject();
  const rideoShots = [fx.ids.s1, fx.ids.s2, fx.ids.s3];
  const passes = opts.passes ?? PASSES;
  const files: ExportFile[] = [];
  const writeClip = async (i: number, pass: PassName, content: string) => {
    const name = `shot-0${i + 1}-${pass}.mp4`;
    await writeFile(path.join(dir, name), content);
    const f: ExportFile = {
      name,
      kind: 'clip',
      pass,
      shot: ours.ids[i],
      external_shot: rideoShots[i],
      bytes: Buffer.byteLength(content),
      frames: 12,
      duration_s: 0.5,
      url: `/api/projects/p/video-exports/${EXPORT}/files/${name}`,
      sha256: sha(content),
    };
    const at = files.findIndex((x) => x.name === name);
    if (at >= 0) files[at] = f;
    else files.push(f);
    return f;
  };
  for (let i = 0; i < 3; i++)
    for (const pass of passes) await writeClip(i, pass, `fake mp4 of shot ${i + 1}, ${pass}`);
  const manifest = {
    version: 1,
    fps: 24,
    width: 160,
    height: 90,
    codec: opts.codec ?? 'h264',
    look: 'clay',
    passes,
    shots: [0, 1, 2].map((i) => ({
      id: ours.ids[i],
      name: `Shot ${i + 1}`,
      index: i,
      external: { source: 'rideo', project: fx.ids.project, clip: fx.ids.clip, shot: rideoShots[i] },
      move: i === 1 ? 'push_in' : null,
      output_frames: 12,
      blocking_line: `Blocking: mock line of ${rideoShots[i]}.`,
      camera_track: STATIC_TRACK,
      rideo: { clip: fx.ids.clip, shot: rideoShots[i], camera_move: i === 1 ? 'push_in' : null },
    })),
  };
  const writeManifest = (m: unknown) => writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m));
  await writeManifest(manifest);
  const job = { status: 'done' as ExportJob['status'] };
  const sizes = new Map<string, number>();
  const exports: PushEnvironment['exports'] = {
    status: async (id) => {
      if (id !== EXPORT) throw new NotFoundError(`No video export '${id}'`);
      return {
        id,
        project: 'ours',
        label: null,
        status: job.status,
        params: {} as ExportJob['params'],
        created_at: '2026-11-13T09:00:00.000Z',
        started_at: '2026-11-13T09:00:00.000Z',
        finished_at: '2026-11-13T09:01:00.000Z',
        progress: { frames_done: 36, frames_total: 36, fraction: 1, fps: 10, eta_s: 0, shot: null },
        error: null,
        warnings: [],
        files: files.map((f) => ({ ...f })),
      };
    },
    file: async (id, name): Promise<ExportFileRef> => {
      if (id !== EXPORT) throw new NotFoundError(`No video export '${id}'`);
      const f = files.find((x) => x.name === name);
      if (name !== 'manifest.json' && !f)
        throw new NotFoundError(`Video export '${id}' has no file '${name}'`);
      return {
        path: path.join(dir, name),
        bytes: sizes.get(name) ?? f?.bytes ?? 1,
        contentType: name.endsWith('.json') ? 'application/json' : 'video/mp4',
        etag: `"${f?.sha256 ?? 'm'}"`,
      };
    },
  };
  const probe: { value: Partial<ClipProbe> | null } = { value: {} };
  const poster: { value: Uint8Array | null } = { value: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) };
  const probed: string[] = [];
  const exportWarnings: string[] = [];
  const env: PushEnvironment = {
    client: new RideoClient({
      url: 'http://rideo.local/',
      token: TOKEN,
      fetchImpl: mock.fetch,
      sleep: async () => undefined,
    }),
    exports,
    project: {
      id: 'ours',
      doc: ours.doc,
      exportBlocking: () => ({ blocking: structuredClone(fx.blocking), warnings: exportWarnings.splice(0) }),
    },
    probe: async (file) => {
      probed.push(path.basename(file));
      return probe.value === null
        ? null
        : {
            formatName: MP4_FORMAT_NAME,
            durationSec: 0.5,
            codec: 'h264',
            width: 160,
            height: 90,
            fps: 24,
            frames: 12,
            hasAudio: false,
            ...probe.value,
          };
    },
    poster: async () => poster.value,
    now: () => new Date('2026-11-13T10:00:00.000Z'),
  };
  const params = (over: Partial<PushParams> = {}): PushParams => ({
    export: EXPORT,
    rideo: { project: fx.ids.project, clip: fx.ids.clip },
    write_blocking: true,
    ...over,
  });
  const clip = fx.data.clips.get(fx.ids.clip)!;
  const rideoShot = (i: number) => (clip.shots as Record<string, any>[])[i];
  return {
    dir,
    mock,
    fx,
    ours,
    files,
    job,
    sizes,
    manifest,
    writeManifest,
    writeClip,
    probe,
    poster,
    probed,
    exportWarnings,
    env,
    params,
    clip,
    rideoShot,
    rideoShots,
  };
}

const statuses = (r: Awaited<ReturnType<typeof pushExport>>) =>
  r.shots.map((s) => [s.rideo_shot, s.status, s.mode, s.pass]);

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolError);
  return err as ToolError;
}

describe('rideo_push: default selection, modes and what rideo receives', () => {
  it('writes the blocking, then uploads and sets the shots with props in motion or a camera move', async () => {
    const h = await harness();
    const r = await pushExport(h.env, h.params());
    const [s1, s2, s3] = h.rideoShots;
    expect(r.status).toBe('done');
    expect(r.selection).toBe('default');
    expect(r.rideo).toEqual({ url: 'http://rideo.local', project: h.fx.ids.project, clip: h.fx.ids.clip });
    expect(r.blocking).toEqual({
      written: true,
      state: 'ready',
      error: null,
      differences: [],
      plan_mismatch: [],
    });
    expect(r.stale).toEqual([]);
    expect(r.moves).toEqual([]);
    expect(statuses(r)).toEqual([
      [s1, 'pushed', 'motion', 'beauty'],
      [s2, 'pushed', 'pose', 'pose'],
      [s3, 'skipped', null, null],
    ]);
    expect(r.shots[0]).toMatchObject({
      shot: h.ours.ids[0],
      name: 'Shot 1',
      found: ['Ball (physics)'],
      why: 'motion: props in motion (Ball (physics))',
      file: 'shot-01-beauty.mp4',
      sha256: h.files.find((f) => f.name === 'shot-01-beauty.mp4')!.sha256,
      reused: false,
      camera_move: 'locked_off',
      error: null,
      warnings: [],
    });
    expect(r.shots[1]).toMatchObject({
      found: ['camera move'],
      why: 'pose: actors in the shot',
      camera_move: 'push_in',
    });
    expect(r.shots[2].why).toMatch(/^no physics, tether, held prop or camera move in view/);
    expect(r.warnings).toEqual([]);

    // (1) the blocking, as desk.export_rideo_blocking made it, without rideo's fixing
    expect(h.mock.puts).toHaveLength(1);
    expect(h.mock.puts[0].body).toEqual({ blocking: h.fx.blocking, fix: false });
    // (2) two multipart uploads with the ffprobe account and a JPEG poster
    expect(h.mock.uploads.map((u) => u.status)).toEqual([201, 201]);
    const [u1, u2] = h.mock.uploads;
    expect(u1.fields).toMatchObject({ kind: 'video', role: 'reference', name: '3D previs: Shot 1 (motion)' });
    expect(u2.fields.name).toBe('3D previs: Shot 2 (pose)');
    expect(JSON.parse(u1.fields.meta)).toEqual({
      probe: {
        formatName: MP4_FORMAT_NAME,
        durationSec: 0.5,
        hasVideo: true,
        hasAudio: false,
        width: 160,
        height: 90,
        fps: 24,
        videoCodec: 'h264',
      },
    });
    expect(u1.file).toMatchObject({ filename: 'shot-01-beauty.mp4', type: 'video/mp4' });
    expect(Buffer.from(u1.file!.bytes).toString()).toBe('fake mp4 of shot 1, beauty');
    expect(Buffer.from(u2.file!.bytes).toString()).toBe('fake mp4 of shot 2, pose');
    expect(u1.poster).toMatchObject({ type: 'image/jpeg' });
    expect([...u1.poster!.bytes.slice(0, 2)]).toEqual([0xff, 0xd8]);
    expect(u1.resource).toMatchObject({
      kind: 'video',
      status: 'ready',
      media: { fps: 24, videoCodec: 'h264' },
    });
    // (3) the shots point at them, with the moves we rendered, each with the shot's whole camera
    expect(h.mock.patches.map((p) => [p.shot, p.body])).toEqual([
      [
        s1,
        {
          motionReference: { resourceId: r.shots[0].resource, mode: 'motion' },
          camera: { framing: 'wide', movement: 'static', lensMm: 24, move: 'locked_off' },
        },
      ],
      [
        s2,
        {
          motionReference: { resourceId: r.shots[1].resource, mode: 'pose' },
          camera: { framing: 'medium', movement: 'dolly_in', lensMm: 50, move: 'push_in' },
        },
      ],
    ]);
    expect(h.rideoShot(0).motionReference).toEqual({ resourceId: r.shots[0].resource, mode: 'motion' });
    expect(h.rideoShot(2).motionReference).toBeNull();
    expect(h.mock.requests.every((q) => q.authorization === `Bearer ${TOKEN}`)).toBe(true);

    // what went up is remembered next to the export
    const rec = await readPushRecord(h.dir);
    const target = rec.targets[`http://rideo.local|${h.fx.ids.project}|${h.fx.ids.clip}`];
    expect(Object.keys(target)).toEqual([s1, s2]);
    expect(target[s1]).toEqual({
      sha256: r.shots[0].sha256,
      resource: r.shots[0].resource,
      mode: 'motion',
      pass: 'beauty',
      file: 'shot-01-beauty.mp4',
      uploaded_at: '2026-11-13T10:00:00.000Z',
      patched_at: '2026-11-13T10:00:00.000Z',
    });
    expect(rec.push).toEqual({
      status: 'done',
      shots: [
        { rideo_shot: s1, resource: r.shots[0].resource, error: null },
        { rideo_shot: s2, resource: r.shots[1].resource, error: null },
      ],
    });
  });

  it("reports what the blocking export left out among the push's warnings", async () => {
    const h = await harness();
    h.exportWarnings.push("actor 'Extra' has no rideo character id: left out");
    const r = await pushExport(h.env, h.params());
    expect(r.status).toBe('done');
    expect(r.warnings).toEqual(["our blocking: actor 'Extra' has no rideo character id: left out"]);
  });

  it('pushes the shots given (ours by id or name, or rideo shot ids) in that order, needed or not', async () => {
    const h = await harness();
    const [s1, , s3] = h.rideoShots;
    const r = await pushExport(h.env, h.params({ shots: ['shot 3', s1, h.ours.ids[0]] }));
    expect(r.selection).toBe('given');
    expect(statuses(r)).toEqual([
      [s3, 'pushed', 'pose', 'pose'],
      [s1, 'pushed', 'motion', 'beauty'],
    ]);
    expect(h.mock.patches.map((p) => p.shot)).toEqual([s3, s1]);
  });

  it('refuses an unknown shot before anything is sent to rideo', async () => {
    const h = await harness();
    const err = await refusal(pushExport(h.env, h.params({ shots: ['Shot 1', 'Shot 9'] })));
    expect(err.code).toBe('INVALID_PARAMS');
    expect(err.message).toContain(
      "The export has no shot 'Shot 9' from this rideo clip. Its shots: 'Shot 1'",
    );
    expect(h.mock.requests).toHaveLength(0);
  });

  it('takes the mode and pass asked for every shot', async () => {
    const h = await harness();
    const r = await pushExport(h.env, h.params({ mode: 'camera', pass: 'beauty' }));
    expect(statuses(r).slice(0, 2)).toEqual([
      [h.rideoShots[0], 'pushed', 'camera', 'beauty'],
      [h.rideoShots[1], 'pushed', 'camera', 'beauty'],
    ]);
    expect(r.shots[0].why).toBe("mode 'camera' as asked");
    expect(h.mock.patches.map((p) => p.body.motionReference.mode)).toEqual(['camera', 'camera']);
  });

  it("fails a shot whose export lacks the clip of its mode's pass, and names the export to make", async () => {
    // an export of beauty clips only (export_video's defaults): shot 2 is a pose reference
    const h = await harness({ passes: ['beauty'] });
    const r = await pushExport(h.env, h.params());
    expect(statuses(r).slice(0, 2)).toEqual([
      [h.rideoShots[0], 'pushed', 'motion', 'beauty'],
      [h.rideoShots[1], 'failed', 'pose', 'pose'],
    ]);
    // nothing in its place: a beauty clip set as a pose reference would carry what it is meant to leave out
    expect(r.shots[1]).toMatchObject({
      file: null,
      resource: null,
      error:
        "the export has no pose clip of this shot, the pass a 'pose' reference sends: export_video {project: 'ours', preset: 'rideo'}, then push that export",
    });
    expect(h.mock.uploads.map((u) => u.file!.filename)).toEqual(['shot-01-beauty.mp4']);
    expect(h.mock.patches.map((p) => p.shot)).toEqual([h.rideoShots[0]]);
    expect(r.status).toBe('partial');
    expect(r.warnings).toContain(
      "1 shot(s) were not pushed: the export has no clip of the pass their reference mode sends (pose). Export them with export_video {project: 'ours', preset: 'rideo'} and push that export",
    );
  });

  it("pushes nothing and reports failed when every shot's pass is missing (camera references of a beauty export)", async () => {
    // rideo words every line otherwise: every reference is a camera reference, which sends depth
    const h = await harness({ passes: ['beauty'] });
    h.mock.setLines(
      h.fx.ids.clip,
      Object.fromEntries(h.rideoShots.map((s) => [s, `Blocking: ${s} elsewhere.`])),
    );
    const r = await pushExport(h.env, h.params());
    expect(statuses(r).slice(0, 2)).toEqual([
      [h.rideoShots[0], 'failed', 'camera', 'depth'],
      [h.rideoShots[1], 'failed', 'camera', 'depth'],
    ]);
    expect(r.status).toBe('failed');
    expect(h.mock.uploads).toHaveLength(0);
    expect(h.mock.patches.filter((p) => p.body.motionReference)).toHaveLength(0);
    expect(r.warnings).toContain(
      "2 shot(s) were not pushed: the export has no clip of the pass their reference mode sends (depth). Export them with export_video {project: 'ours', preset: 'rideo'} and push that export",
    );
  });

  it('fails a shot whose export lacks the pass asked for', async () => {
    const h = await harness({ passes: ['depth'] });
    const r = await pushExport(h.env, h.params({ shots: ['Shot 1'] }));
    expect(r.status).toBe('failed');
    expect(r.shots[0]).toMatchObject({
      status: 'failed',
      pass: 'beauty',
      error:
        "the export has no beauty clip of this shot, the pass a 'motion' reference sends: export_video {project: 'ours', preset: 'rideo'}, then push that export",
    });
    const asked = await pushExport(h.env, h.params({ shots: ['Shot 1'], pass: 'normal' }));
    expect(asked.shots[0]).toMatchObject({
      status: 'failed',
      pass: 'normal',
      error:
        "the export has no normal clip of this shot (pass 'normal' as asked): export it with outputs.clips and passes ['normal'], then push that export",
    });
    // a pass asked for that is missing is no reason to suggest the preset
    expect(asked.warnings.join('\n')).not.toMatch(/preset/);
    expect(h.mock.uploads).toHaveLength(0);
  });

  it('warns when a beauty clip is not a clay render', async () => {
    const h = await harness();
    await h.writeManifest({ ...h.manifest, look: 'material' });
    const r = await pushExport(h.env, h.params({ shots: ['Shot 1'] }));
    expect(r.shots[0]).toMatchObject({ status: 'pushed', pass: 'beauty' });
    expect(r.shots[0].warnings).toEqual([
      "the beauty clip is in the 'material' look, which the video model may copy: rideo's references are clay renders that leave the look to the model (export_video {project: 'ours', preset: 'rideo'})",
    ]);
    // a depth or pose pass has no look
    const pose = await pushExport(h.env, h.params({ shots: ['Shot 2'] }));
    expect(pose.shots[0]).toMatchObject({ status: 'pushed', pass: 'pose', warnings: [] });
  });

  it("never replaces a 'performance' reference", async () => {
    const h = await harness();
    const theirs = { resourceId: rideoId('res', 999), mode: 'performance' };
    h.rideoShot(0).motionReference = theirs;
    const r = await pushExport(h.env, h.params({ shots: ['Shot 1', 'Shot 2'] }));
    expect(r.shots[0]).toMatchObject({
      status: 'skipped',
      why: "it has a 'performance' reference, which rideo_push never replaces",
    });
    expect(r.shots[1].status).toBe('pushed');
    expect(h.mock.uploads.map((u) => u.file!.filename)).toEqual(['shot-02-pose.mp4']);
    expect(h.rideoShot(0).motionReference).toEqual(theirs);
  });

  it('a shot whose camera moves without a library move goes without one (rideo keeps its own)', async () => {
    const h = await harness();
    h.manifest.shots[0].camera_track = STATIC_TRACK.map((t, i) => ({
      ...t,
      position: [0, -8 + i * 0.05, 1],
    }));
    await h.writeManifest(h.manifest);
    const r = await pushExport(h.env, h.params());
    expect(r.shots[0]).toMatchObject({ status: 'pushed', camera_move: null });
    expect(r.shots[0].found).toEqual(['Ball (physics)', 'camera move']);
    expect(r.shots[0].warnings).toEqual([
      'its camera moves without a move of the library: rideo keeps the move it has for the shot',
    ]);
    expect(h.mock.patches[0].body).toEqual({
      motionReference: { resourceId: r.shots[0].resource, mode: 'motion' },
    });
  });

  it('chooses a shot that left our project by the camera move the export recorded', async () => {
    const h = await harness();
    setShots(
      h.ours.doc,
      getShots(h.ours.doc).filter((s) => s.id !== h.ours.ids[1]),
    );
    const r = await pushExport(h.env, h.params());
    expect(r.shots[1]).toMatchObject({
      status: 'pushed',
      mode: 'camera',
      pass: 'depth',
      found: ['camera move'],
    });
    expect(r.shots[1].warnings).toEqual([
      'the shot is no longer in the project: chosen by its camera move only',
    ]);
  });
});

describe("rideo_push: rideo's shots keep what the push does not change", () => {
  it("keeps each pushed shot's framing, movement and lens: the PATCH carries the shot's whole camera", async () => {
    const h = await harness();
    const before = [0, 1].map((i) => ({ ...h.rideoShot(i).camera }));
    const r = await pushExport(h.env, h.params());
    expect(statuses(r).map((x) => x[1])).toEqual(['pushed', 'pushed', 'skipped']);
    // rideo parses the camera with CameraSchema.partial(), whose framing and movement default to
    // medium and static when left out, and merges it over the shot's: only the move may change
    expect(before[0]).toEqual({ framing: 'wide', movement: 'static', lensMm: 24 });
    expect(h.rideoShot(0).camera).toEqual({ ...before[0], move: 'locked_off' });
    expect(before[1]).toEqual({ framing: 'medium', movement: 'dolly_in', lensMm: 50, move: 'push_in' });
    expect(h.rideoShot(1).camera).toEqual(before[1]);
  });

  it("gives the clip's other shots our camera move too (rideo sets a blocked move only on a shot without one)", async () => {
    const h = await harness();
    const [s1, s2, s3] = h.rideoShots;
    h.rideoShot(2).camera.move = 'push_in';
    const blocking = structuredClone(h.fx.blocking);
    h.env.project.exportBlocking = () => ({
      blocking,
      warnings: [],
      moves: { [s1]: 'locked_off', [s2]: 'push_in', [s3]: 'pan_left' },
    });
    const r = await pushExport(h.env, h.params());
    expect(statuses(r).map((x) => x[1])).toEqual(['pushed', 'pushed', 'skipped']);
    // shot 3 has no reference to push: its move is ours all the same, the rest of its camera kept
    expect(r.moves).toEqual([{ rideo_shot: s3, from: 'push_in', to: 'pan_left', error: null }]);
    expect(h.rideoShot(2).camera).toEqual({
      framing: 'medium',
      movement: 'static',
      lensMm: 35,
      move: 'pan_left',
    });
    expect(h.mock.patches.map((x) => x.shot)).toEqual([s1, s2, s3]);
    expect(h.mock.patches[2].body).toEqual({
      camera: { framing: 'medium', movement: 'static', lensMm: 35, move: 'pan_left' },
    });
    expect(r.warnings).toContain(
      `rideo's camera move of 1 shot(s) without a reference pushed now is ours: ${s3} push_in → pan_left`,
    );
    // nothing to change the next time
    const again = await pushExport(h.env, h.params());
    expect(again.moves).toEqual([]);
    // without writing our blocking, rideo's moves are left alone
    h.rideoShot(2).camera.move = 'push_in';
    const unwritten = await pushExport(h.env, h.params({ write_blocking: false }));
    expect(unwritten.moves).toEqual([]);
    expect(h.rideoShot(2).camera.move).toBe('push_in');
  });
});

describe('rideo_push: modes when rideo cannot start from our staging', () => {
  it("rideo's plan_mismatch makes the shot's reference a camera reference and lists it", async () => {
    const h = await harness();
    const [s1, s2] = h.rideoShots;
    const message = 'The camera of shot 1 disagrees with its plan: Rosie faces left, not right';
    h.mock.setIssues(h.fx.ids.clip, [
      { code: 'plan_mismatch', severity: 'warning', shotId: s1, characterId: null, message },
      { code: 'actors_overlap', severity: 'warning', shotId: s2, characterId: null, message: 'overlap' },
    ]);
    const r = await pushExport(h.env, h.params());
    expect(r.blocking.plan_mismatch).toEqual([{ rideo_shot: s1, shot: h.ours.ids[0], message }]);
    expect(statuses(r).slice(0, 2)).toEqual([
      [s1, 'pushed', 'camera', 'depth'],
      [s2, 'pushed', 'pose', 'pose'],
    ]);
    expect(r.shots[0].why).toBe(
      `camera: rideo's plan disagrees with this camera (plan_mismatch), so rideo prompts it without our blocking line and camera view: ${message}`,
    );
    expect(r.warnings.find((w) => w.includes('plan_mismatch'))).toMatch(
      new RegExp(
        `^rideo finds the camera of 1 shot\\(s\\) at odds with their planned layout \\(plan_mismatch: ${s1}\\)`,
      ),
    );
    // a mode asked for is kept, with a word about it
    const asked = await pushExport(h.env, h.params({ mode: 'motion' }));
    expect(asked.shots[0].mode).toBe('motion');
    expect(asked.shots[0].warnings[0]).toMatch(/^mode 'motion' as asked, although rideo's plan disagrees/);
  });

  it("a blocking line rideo words differently makes the shot's reference a camera reference", async () => {
    const h = await harness();
    const [s1, s2] = h.rideoShots;
    h.mock.setLines(h.fx.ids.clip, {
      [s1]: `  Blocking:   mock line of ${s1}. `,
      [s2]: 'Blocking: Rosie walks to the kite.',
    });
    const r = await pushExport(h.env, h.params());
    expect(r.blocking.differences).toEqual([
      {
        rideo_shot: s2,
        shot: h.ours.ids[1],
        ours: `Blocking: mock line of ${s2}.`,
        rideo: 'Blocking: Rosie walks to the kite.',
      },
    ]);
    expect(statuses(r).slice(0, 2)).toEqual([
      [s1, 'pushed', 'motion', 'beauty'],
      [s2, 'pushed', 'camera', 'depth'],
    ]);
    expect(r.shots[1].why).toBe("camera: rideo's blocking line for it is not ours");
    expect(r.warnings).toContain(
      "rideo's blocking line differs from ours for 1 shot(s): their references default to mode 'camera'",
    );
  });

  it("with rideo's desk off every reference is a camera reference, and no board is to redraw", async () => {
    const h = await harness({ deskEnabled: false });
    h.rideoShot(0).board = { createdAt: '2026-11-01T10:00:00.000Z', approved: false };
    const r = await pushExport(h.env, h.params());
    expect(statuses(r).slice(0, 2)).toEqual([
      [h.rideoShots[0], 'pushed', 'camera', 'depth'],
      [h.rideoShots[1], 'pushed', 'camera', 'depth'],
    ]);
    expect(r.shots[0].why).toMatch(/^camera: rideo's director's desk is off for this project/);
    expect(r.warnings[0]).toMatch(
      /^rideo's director's desk is off for this project \(settings\.blocking\.enabled\)/,
    );
    expect(r.boards_to_redraw).toEqual([]);
  });

  it('an approved storyboard frame or an image start makes a camera reference; drawn boards are listed to redraw', async () => {
    const h = await harness();
    h.rideoShot(0).startFrame = { mode: 'resource', resourceId: rideoId('res', 77) };
    h.rideoShot(1).board = { createdAt: '2026-11-01T10:00:00.000Z', approved: true };
    h.rideoShot(2).board = { createdAt: '2026-11-01T10:00:00.000Z', approved: false };
    const r = await pushExport(h.env, h.params());
    expect(r.shots.map((s) => s.why)).toEqual([
      'camera: it starts from an image resource',
      'camera: its storyboard frame was approved before this staging',
      expect.stringMatching(/^no physics/),
    ]);
    expect(r.boards_to_redraw).toEqual([
      { rideo_shot: h.rideoShots[1], index: 1, approved: true },
      { rideo_shot: h.rideoShots[2], index: 2, approved: false },
    ]);
  });
});

describe('rideo_push: the project changed since the export', () => {
  const quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

  it("refuses the clip of a shot whose camera moved since the export: the blocking written is the project's", async () => {
    const h = await harness();
    // the export recorded where the camera of shot 1 stood at its first, middle and last frame
    h.manifest.shots[0].camera_track = [1, 6, 12].map((frame) => ({
      frame,
      position: [0, -8, 1],
      rotation_quat: quat,
    })) as never;
    (h.manifest.shots[0] as Record<string, unknown>).scene_frames = [1, 12];
    await h.writeManifest(h.manifest);
    const ok = await pushExport(h.env, h.params());
    expect(ok.stale).toEqual([]);
    expect(ok.shots[0].status).toBe('pushed');

    // the director moves the camera, then pushes the old export
    const cam = getShots(h.ours.doc)[0].camera!;
    h.ours.doc.updateObject(cam, { location: [0.5, -8, 1] });
    const r = await pushExport(h.env, h.params());
    expect(r.shots[0]).toMatchObject({ status: 'failed' });
    expect(r.shots[0].error).toBe(
      "refused: the project changed since export 'exp_kite' was made (at frame 1 its camera stands 0.500 m away from where the export rendered it): export the shot again, then push that export",
    );
    expect(r.stale).toEqual([
      {
        rideo_shot: h.rideoShots[0],
        shot: h.ours.ids[0],
        changes: [expect.stringContaining('0.500 m')],
        refused: true,
      },
    ]);
    expect(r.status).toBe('partial');
    // turned, not moved; and a shot whose frames changed
    h.ours.doc.updateObject(cam, { location: [0, -8, 1], rotation_euler: [Math.PI / 2, 0, 0.05] });
    expect((await pushExport(h.env, h.params())).shots[0].error).toMatch(
      /at frame 1 its camera looks 2\.9° away/,
    );
    h.ours.doc.updateObject(cam, { rotation_euler: [Math.PI / 2, 0, 0] });
    setShots(
      h.ours.doc,
      getShots(h.ours.doc).map((s, i) => (i === 0 ? { ...s, frame_end: 13 } : s)),
    );
    expect((await pushExport(h.env, h.params())).shots[0].error).toContain(
      "its frames are 1–13, the export's 1–12",
    );
  });

  it('makes the reference of a shot whose walks changed since the export a camera reference', async () => {
    const h = await harness();
    // the export showed Rosie walking; the project has her stand
    (h.manifest.shots[0] as Record<string, unknown>).moves_line =
      'Rosie walks from left of frame to the centre.';
    (h.manifest.shots[1] as Record<string, unknown>).moves_line = '';
    await h.writeManifest(h.manifest);
    const r = await pushExport(h.env, h.params());
    expect(statuses(r).slice(0, 2)).toEqual([
      [h.rideoShots[0], 'pushed', 'camera', 'depth'],
      [h.rideoShots[1], 'pushed', 'pose', 'pose'],
    ]);
    expect(r.shots[0].why).toBe(
      'camera: its cast moves otherwise than the export shows ("nobody moves", not "Rosie walks from left of frame to the centre.") since the export',
    );
    expect(r.stale).toEqual([
      {
        rideo_shot: h.rideoShots[0],
        shot: h.ours.ids[0],
        changes: [expect.stringMatching(/^its cast moves otherwise/)],
        refused: false,
      },
    ]);
  });
});

describe('rideo_push: refusals', () => {
  it("refuses a clip whose frames are not the CURRENT rideo shot's duration × fps", async () => {
    const h = await harness();
    h.rideoShot(0).durationSec = 1;
    const r = await pushExport(h.env, h.params());
    expect(r.status).toBe('partial');
    expect(r.shots[0]).toMatchObject({
      status: 'failed',
      error:
        'refused: the clip has 12 frames and the rideo shot is 1 s at 24 fps (24 frames): import the clip again (rideo_import) and export again',
    });
    expect(r.shots[1].status).toBe('pushed');
    expect(h.mock.uploads.map((u) => u.file!.filename)).toEqual(['shot-02-pose.mp4']);
    // ffprobe's count is what is compared: a clip that lost a frame is refused too
    const h2 = await harness();
    h2.probe.value = { frames: 11 };
    const r2 = await pushExport(h2.env, h2.params());
    expect(r2.status).toBe('failed');
    expect(r2.shots[0].error).toMatch(
      /^refused: the clip has 11 frames and the rideo shot is 0\.5 s at 24 fps \(12 frames\)/,
    );
    expect(h2.mock.uploads).toHaveLength(0);
    expect(h2.mock.patches).toHaveLength(0);
  });

  it("refuses a clip at another frame rate or size than rideo's settings", async () => {
    const h = await harness();
    h.probe.value = { fps: 25 };
    const r = await pushExport(h.env, h.params());
    expect(r.shots[0].error).toBe(
      'refused: the clip runs at 25 fps and the rideo project at 24: export with fps 24',
    );
    const h2 = await harness();
    h2.fx.data.project.settings.resolution = { width: 320, height: 180 };
    const r2 = await pushExport(h2.env, h2.params());
    expect(r2.status).toBe('failed');
    expect(r2.shots[0].error).toBe(
      'refused: the clip is 160×90 and the rideo project 320×180: export with width 320 and height 180',
    );
  });

  it('refuses a VP9 export, an unfinished one and one without rideo shots before writing anything', async () => {
    const h = await harness({ codec: 'vp9' });
    const vp9 = await refusal(pushExport(h.env, h.params()));
    expect(vp9).toMatchObject({ code: 'INVALID_PARAMS' });
    expect(vp9.message).toBe(
      "Video export 'exp_kite' is vp9; rideo takes H.264 MP4 references: export with codec 'h264'.",
    );
    const h2 = await harness();
    h2.job.status = 'running';
    expect(await refusal(pushExport(h2.env, h2.params()))).toMatchObject({
      code: 'POLL_FAILED',
      message: "Video export 'exp_kite' is running: push it once it is done (export_status).",
    });
    h2.job.status = 'cancelled';
    expect((await refusal(pushExport(h2.env, h2.params()))).code).toBe('INVALID_PARAMS');
    h2.job.status = 'done';
    const other = await refusal(
      pushExport(h2.env, h2.params({ rideo: { project: h2.fx.ids.project, clip: rideoId('clp', 55) } })),
    );
    expect(other.message).toBe(
      `The shots of video export 'exp_kite' come from rideo clip ${h2.fx.ids.clip}, not ${rideoId('clp', 55)}.`,
    );
    for (const s of h2.manifest.shots) s.external = null as never;
    await h2.writeManifest(h2.manifest);
    expect((await refusal(pushExport(h2.env, h2.params()))).message).toMatch(
      /^None of the shots of video export 'exp_kite' comes from rideo/,
    );
    expect([...h.mock.requests, ...h2.mock.requests]).toHaveLength(0);
  });

  it('refuses a clip too large to send inline', async () => {
    const h = await harness();
    h.sizes.set('shot-01-beauty.mp4', MAX_PUSH_BYTES + 1);
    const r = await pushExport(h.env, h.params());
    expect(r.shots[0].error).toBe(
      'the clip is 256 MB; rideo sends references inline, so they must stay under 256 MB (export at a lower quality or size)',
    );
    expect(r.shots[1].status).toBe('pushed');
  });
});

describe('rideo_push: once per content', () => {
  it('pushing again uploads nothing and patches nothing; a new clip goes up again', async () => {
    const h = await harness();
    const first = await pushExport(h.env, h.params());
    const again = await pushExport(h.env, h.params());
    expect(statuses(again).map((s) => s[1])).toEqual(['unchanged', 'unchanged', 'skipped']);
    expect(again.shots.map((s) => s.reused)).toEqual([true, true, false]);
    expect(again.shots[0].resource).toBe(first.shots[0].resource);
    expect(h.mock.uploads).toHaveLength(2);
    expect(h.mock.patches).toHaveLength(2);
    // the blocking is written each time: it is what rideo's camera views come from
    expect(h.mock.puts).toHaveLength(2);

    // shot 1 exported again with other pixels: only it goes up
    await h.writeClip(0, 'beauty', 'fake mp4 of shot 1, beauty, take 2');
    const third = await pushExport(h.env, h.params());
    expect(statuses(third).map((s) => s[1])).toEqual(['pushed', 'unchanged', 'skipped']);
    expect(third.shots[0].reused).toBe(false);
    expect(third.shots[0].resource).not.toBe(first.shots[0].resource);
    expect(h.mock.uploads.map((u) => u.file!.filename)).toEqual([
      'shot-01-beauty.mp4',
      'shot-02-pose.mp4',
      'shot-01-beauty.mp4',
    ]);
    expect(h.rideoShot(0).motionReference.resourceId).toBe(third.shots[0].resource);
  });

  it('sets the resource again, without uploading, where rideo lost or changed the reference', async () => {
    const h = await harness();
    const first = await pushExport(h.env, h.params());
    h.rideoShot(1).motionReference = null;
    h.rideoShot(0).motionReference = { resourceId: first.shots[0].resource, mode: 'pose' };
    const r = await pushExport(h.env, h.params());
    expect(r.shots.slice(0, 2).map((s) => [s.status, s.reused])).toEqual([
      ['pushed', true],
      ['pushed', true],
    ]);
    expect(h.mock.uploads).toHaveLength(2);
    expect(h.mock.patches).toHaveLength(4);
    expect(h.rideoShot(1).motionReference).toEqual({ resourceId: first.shots[1].resource, mode: 'pose' });
  });

  it('a clip uploaded before a failed PATCH is set on the next push without another upload', async () => {
    const h = await harness();
    h.mock.failNext({
      method: 'PATCH',
      path: new RegExp(`${h.rideoShots[0]}$`),
      status: 422,
      code: 'validation_error',
      detail: 'try later',
    });
    const first = await pushExport(h.env, h.params());
    expect(first.status).toBe('partial');
    // the clip did go up: the result names its resource (it can be set by hand in rideo)
    expect(first.shots[0]).toMatchObject({ status: 'failed', resource: h.mock.uploads[0].resource!.id });
    expect(first.shots[0].error).toContain('rideo answered 422 validation_error to PATCH');
    const rec = await readPushRecord(h.dir);
    expect(
      rec.targets[`http://rideo.local|${h.fx.ids.project}|${h.fx.ids.clip}`][h.rideoShots[0]].patched_at,
    ).toBeNull();
    expect(rec.push).toMatchObject({ status: 'failed' });
    const second = await pushExport(h.env, h.params());
    expect(second.status).toBe('done');
    expect(second.shots[0]).toMatchObject({ status: 'pushed', reused: true });
    expect(h.mock.uploads).toHaveLength(2);
  });

  it('a new export of the same clips uploads nothing: resources are remembered per rideo clip, by content', async () => {
    const h = await harness();
    h.env.resources = fileResources(path.join(h.dir, 'server-data'));
    const first = await pushExport(h.env, h.params());
    expect(h.mock.uploads).toHaveLength(2);
    // another export folder with the same clips: no record of its own, the server remembers them
    await rm(path.join(h.dir, PUSH_RECORD_FILE));
    const second = await pushExport(h.env, h.params());
    expect(second.shots.slice(0, 2).map((s) => [s.status, s.reused, s.resource])).toEqual([
      ['pushed', true, first.shots[0].resource],
      ['pushed', true, first.shots[1].resource],
    ]);
    expect(h.mock.uploads).toHaveLength(2);
  });

  it('uploads again, once, a remembered resource rideo no longer has', async () => {
    const h = await harness();
    h.env.resources = fileResources(path.join(h.dir, 'server-data'));
    const first = await pushExport(h.env, h.params({ shots: ['Shot 1'] }));
    const lost = first.shots[0].resource!;
    // deleted in rideo, its reference with it
    h.fx.data.resources.delete(lost);
    h.rideoShot(0).motionReference = null;
    const r = await pushExport(h.env, h.params({ shots: ['Shot 1'] }));
    expect(r.shots[0]).toMatchObject({ status: 'pushed', reused: false });
    expect(r.shots[0].resource).not.toBe(lost);
    expect(r.shots[0].warnings).toContain(
      `rideo refused the resource ${lost} uploaded before (404): the clip was uploaded again`,
    );
    expect(h.mock.uploads).toHaveLength(2);
    expect(h.rideoShot(0).motionReference.resourceId).toBe(r.shots[0].resource);
    // what is remembered is the new one
    expect(
      await h.env.resources.get(
        `http://rideo.local|${h.fx.ids.project}|${h.fx.ids.clip}`,
        r.shots[0].sha256!,
      ),
    ).toBe(r.shots[0].resource);
  });

  it('a damaged record only costs the uploads again', async () => {
    const h = await harness();
    await pushExport(h.env, h.params());
    await writeFile(path.join(h.dir, PUSH_RECORD_FILE), '{"version": 1, "targ');
    expect(await readPushRecord(h.dir)).toEqual({ version: 1, updated_at: '', targets: {}, push: null });
    const r = await pushExport(h.env, h.params());
    expect(r.shots.slice(0, 2).map((s) => [s.status, s.reused])).toEqual([
      ['pushed', false],
      ['pushed', false],
    ]);
    expect(h.mock.uploads).toHaveLength(4);
  });
});

describe('rideo_push: rideo refusing', () => {
  it('stops at a 409 for an approved clip, and pushes without the blocking when asked', async () => {
    const h = await harness();
    h.clip.status = 'approved';
    const r = await pushExport(h.env, h.params());
    expect(r.status).toBe('failed');
    expect(r.blocking.written).toBe(false);
    expect(r.blocking.error).toMatch(
      /^rideo answered 409 conflict to PUT \/api\/projects\/prj_\w+\/clips\/clp_\w+\/blocking: clip 1 is approved/,
    );
    expect(r.blocking.error).toContain(
      'pass write_blocking: false to push the references without the blocking',
    );
    expect(r.shots).toEqual([]);
    expect(h.mock.uploads).toHaveLength(0);
    expect(h.mock.patches).toHaveLength(0);

    const r2 = await pushExport(h.env, h.params({ write_blocking: false }));
    expect(r2.status).toBe('done');
    expect(r2.blocking).toMatchObject({ written: false, state: 'ready', error: null });
    expect(h.mock.puts).toHaveLength(0);
    expect(h.mock.patches).toHaveLength(2);
  });

  it('a refused token stops the push: the other shots are not tried', async () => {
    const h = await harness();
    h.mock.failNext({
      method: 'POST',
      path: /\/uploads$/,
      status: 401,
      code: 'unauthorized',
      detail: 'the token was revoked',
    });
    const r = await pushExport(h.env, h.params());
    expect(r.status).toBe('failed');
    expect(r.shots[0].status).toBe('failed');
    expect(r.shots[0].error).toMatch(
      /^rideo answered 401 unauthorized to POST .*: the token was revoked \(check RIDEO_TOKEN or pass rideo\.token\)$/,
    );
    expect(r.shots.slice(1).map((s) => [s.status, s.error])).toEqual([
      ['skipped', `not tried: ${r.shots[0].error}`],
      ['skipped', `not tried: ${r.shots[0].error}`],
    ]);
    expect(h.mock.requests.filter((q) => q.method === 'POST').map((q) => q.status)).toEqual([401]);
    expect(h.mock.uploads).toHaveLength(0);
    expect(h.mock.patches).toHaveLength(0);
  });

  it('a shot rideo deleted is skipped by default and fails when asked for', async () => {
    const h = await harness();
    h.clip.shots = (h.clip.shots as Record<string, any>[]).filter((s) => s.id !== h.rideoShots[0]);
    const r = await pushExport(h.env, h.params());
    expect(r.shots[0]).toMatchObject({
      status: 'skipped',
      error: `rideo's clip has no shot ${h.rideoShots[0]} any more: import the clip again (rideo_import)`,
    });
    expect(r.status).toBe('done');
    const r2 = await pushExport(h.env, h.params({ shots: ['Shot 1'] }));
    expect(r2.status).toBe('failed');
    expect(r2.shots[0].status).toBe('failed');
  });

  it('without ffprobe the probe comes from the export; without a poster the upload has none', async () => {
    const h = await harness();
    h.probe.value = null;
    h.poster.value = null;
    const r = await pushExport(h.env, h.params({ shots: ['Shot 1'] }));
    expect(r.status).toBe('done');
    expect(r.shots[0].warnings).toEqual([
      "ffprobe is not available: the clip's probe comes from the export's records",
      'no poster could be made: rideo shows the resource without one',
    ]);
    const up = h.mock.uploads[0];
    expect(up.poster).toBeNull();
    expect(JSON.parse(up.fields.meta).probe).toEqual({
      formatName: MP4_FORMAT_NAME,
      durationSec: 0.5,
      hasVideo: true,
      hasAudio: false,
      width: 160,
      height: 90,
      fps: 24,
      videoCodec: 'h264',
    });
  });
});

describe('push helpers', () => {
  it('clip checks: codec and container, rate, size, frames', () => {
    const rideo = { durationSec: 0.5, fps: 24, width: 160, height: 90 };
    const clip = { frames: 12, fps: 24, width: 160, height: 90, codec: 'h264', file: 'a.mp4' };
    expect(clipMismatch(clip, rideo)).toBeNull();
    expect(clipMismatch({ ...clip, codec: 'vp9', file: 'a.webm' }, rideo)).toBe(
      "the clip is vp9 (a.webm); rideo takes H.264 MP4 references: export with codec 'h264'",
    );
    expect(clipMismatch({ ...clip, fps: 24000 / 1001 }, rideo)).toMatch(/^the clip runs at 23\.976 fps/);
    expect(clipMismatch(clip, { ...rideo, durationSec: 0.52 })).toBeNull(); // round(12.48) = 12
    expect(clipMismatch(clip, { ...rideo, durationSec: 0.53 })).toMatch(/\(13 frames\)/);
  });

  it('camera tracks move from 1 cm or half a degree', () => {
    const q = (deg: number) => [Math.sin((deg * Math.PI) / 360), 0, 0, Math.cos((deg * Math.PI) / 360)];
    const t = (p: number[], deg: number) => ({ position: p, rotation_quat: q(deg) });
    expect(trackMoves([])).toBe(false);
    expect(trackMoves([t([0, 0, 0], 0), t([0.009, 0, 0], 0.4)])).toBe(false);
    expect(trackMoves([t([0, 0, 0], 0), t([0.011, 0, 0], 0)])).toBe(true);
    expect(trackMoves([t([0, 0, 0], 0), t([0, 0, 0], 0.6)])).toBe(true);
  });

  it('a manifest that is not JSON or not an export manifest is refused with what is wrong', () => {
    expect(() => parseManifest('nope')).toThrow("The export's manifest.json is not JSON");
    expect(() => parseManifest('{"version":1,"fps":24}')).toThrow(
      /is not one rideo_push understands: width: /,
    );
  });

  it('shot references resolve by id, rideo id, name and name in any case', () => {
    const m = parseManifest(
      JSON.stringify({
        version: 1,
        fps: 24,
        width: 16,
        height: 9,
        codec: 'h264',
        shots: [
          { id: 'A1', name: 'Wide', output_frames: 12, external: { shot: 'sht_0000000000000001' } },
          { id: 'B2', name: 'Close', output_frames: 12, external: { shot: 'sht_0000000000000002' } },
        ],
      }),
    );
    expect(resolveShotRefs(['close', 'sht_0000000000000001', 'B2'], m.shots).map((s) => s.id)).toEqual([
      'B2',
      'A1',
    ]);
  });
});
