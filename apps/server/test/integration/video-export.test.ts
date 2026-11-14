import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { newShotId, setShots } from '@3d-editor/core';
import type { RenderLease, RenderPool, RenderRequest, RenderThread } from '../../src/render/pool';
import type { WorkerResult } from '../../src/render/protocol';
import { defaultFfmpegPath, hasFfmpeg } from '../../src/video/ffmpeg';
import { startServer, type TestServer } from '../helpers/app';

/*
 * Video exports with the real ffmpeg (SPEC §9), through MCP and REST: a 160×90 scene with three
 * shots of odd lengths (7, 13 and 5 frames; three cameras, an animated cube). Every clip of every
 * pass has exactly its shot's frames and duration (the last one too), the passes are written (mask
 * and edges also losslessly), the manifest describes it; an export renders the snapshot taken when
 * it was asked for — frame for frame (framemd5) the same as an export made before the project was
 * edited mid-export while a render_image and a render_animation shared the render processes; an
 * export whose render processes are all killed mid-way finishes with the same frames; cancel stops
 * it, and a server without ffmpeg answers FFMPEG_UNAVAILABLE. Skipped without ffmpeg unless
 * FFMPEG_REQUIRED=1 (CI installs it).
 */

process.env.RENDER_WORKERS = '2';

const run = (await hasFfmpeg(defaultFfmpegPath())) || process.env.FFMPEG_REQUIRED === '1';
const execFileP = promisify(execFile);
/** ffprobe next to the ffmpeg in use (FFMPEG_PATH), else from the PATH. */
const ffprobePath = /[\\/]/.test(defaultFfmpegPath())
  ? path.join(path.dirname(defaultFfmpegPath()), 'ffprobe')
  : 'ffprobe';

/** The shots: name, camera (index into `cameras`), scene frames (inclusive). */
const SHOTS = [
  { name: 'Wide', slug: 'shot-01-wide', camera: 0, start: 1, end: 7 },
  { name: 'Close', slug: 'shot-02-close', camera: 1, start: 8, end: 20 },
  { name: 'Low', slug: 'shot-03-low', camera: 2, start: 21, end: 25 },
] as const;
const FRAMES = 25;
const framesOf = (s: (typeof SHOTS)[number]) => s.end - s.start + 1;

let server: TestServer;
let client: Client;
let projectId = '';
let shotIds: string[] = [];

type ToolResult = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
}

async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await call(name, args);
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

/** Polls export_status (waiting up to 20 s each time) until the export ends. */
async function finished(id: string): Promise<any> {
  for (let i = 0; i < 30; i++) {
    const s = await ok('export_status', { export: id, wait_s: 20 });
    if (['done', 'failed', 'cancelled'].includes(s.status)) return s;
  }
  throw new Error(`export ${id} did not finish`);
}

/** Starts an export through REST (202) and returns its id. */
async function postExport(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${server.url}/api/projects/${projectId}/video-exports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { id: string }).id;
}

async function probe(
  file: string,
): Promise<{ frames: number; duration: number; stream: Record<string, string> }> {
  const { stdout } = await execFileP(ffprobePath, [
    '-v',
    'error',
    '-count_frames',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_frames,codec_name,pix_fmt,color_space,color_transfer,color_primaries,color_range,has_b_frames,width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file,
  ]);
  const j = JSON.parse(stdout);
  return {
    frames: Number(j.streams[0].nb_read_frames),
    duration: Number(j.format.duration),
    stream: j.streams[0],
  };
}

/** Frame `n` of a video (or an image) as raw RGB bytes. */
async function rgbFrame(file: string, n = 0): Promise<Buffer> {
  const { stdout } = await execFileP(
    defaultFfmpegPath(),
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      `select=eq(n\\,${n})`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout as unknown as Buffer;
}

/** The MD5 of every decoded frame of a video, in order (ffmpeg's framemd5). */
async function framemd5(file: string): Promise<string[]> {
  const { stdout } = await execFileP(
    defaultFfmpegPath(),
    ['-v', 'error', '-i', file, '-f', 'framemd5', '-'],
    {
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return stdout
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(',').pop()!.trim());
}

const meanDiff = (a: Buffer, b: Buffer) => {
  expect(a.length).toBe(b.length);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

const exportDir = (id: string) => path.join(server.dataDir, 'exports', projectId, id);

/** The live project's document key in the render processes (the snapshots of exports have their own). */
const liveKey = () => `${projectId}:${server.handle.rooms.get(projectId)!.scene.ydoc.guid}`;

/**
 * Wraps the calls of every thread the render pool leases from now on (until the returned function
 * is called): `before` runs before each call is sent, `after` once it is sent.
 */
function hookRenderCalls(hooks: {
  before?: (req: RenderRequest) => Promise<void> | void;
  after?: (req: RenderRequest, lease: RenderLease) => void;
}): () => void {
  const pool: RenderPool = server.handle.services.renderer.pool;
  const lease = pool.lease.bind(pool);
  pool.lease = async (...args: Parameters<RenderPool['lease']>) => {
    const l = await lease(...args);
    const wrap = (t: RenderThread): RenderThread => ({
      id: t.id,
      kind: t.kind,
      release: (job) => t.release(job),
      get pending() {
        return t.pending;
      },
      get alive() {
        return t.alive;
      },
      call: async <T extends WorkerResult>(req: RenderRequest): Promise<T> => {
        await hooks.before?.(req);
        const p = t.call<T>(req);
        hooks.after?.(req, l);
        return p;
      },
    });
    return { threads: l.threads.map(wrap), release: () => l.release() };
  };
  return () => void Reflect.deleteProperty(pool, 'lease');
}

/** An image request of an export's snapshot (not of the live project) for scene frame `frame` or later. */
const exportFrame = (req: RenderRequest, from: number) =>
  req.type === 'image' && req.doc.key !== liveKey() && (req.options.frame ?? 0) >= from;

describe.skipIf(!run)('video export with ffmpeg', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    server = await startServer();
    client = new Client({ name: 'video-export-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    projectId = (await ok('create_project', { name: 'Video export' })).id;
    // the cube moves across the frames, so frames differ from each other
    await ok('insert_keyframe', {
      project: projectId,
      object: 'Cube',
      property: 'location',
      frame: 1,
      value: [-1, 0, 0],
    });
    await ok('insert_keyframe', {
      project: projectId,
      object: 'Cube',
      property: 'location',
      frame: FRAMES,
      value: [1, 0, 1],
    });
    const doc = server.handle.rooms.get(projectId)!.scene;
    const wide = doc.listObjects().find((o) => o.type === 'CAMERA')!.id;
    const cube = doc.listObjects().find((o) => o.type === 'MESH')!.id;
    doc.transact(() => {
      doc.updateScene({ fps: 24, frame_start: 1, frame_end: FRAMES });
      doc.updateObject(cube, { custom_props: { desk_role: 'prop', desk_character_id: 'cube-1' } });
    });
    const close = doc.addObject({
      type: 'CAMERA',
      name: 'Close',
      data: doc.addCamera({ lens: 85 }),
      location: [0, -7, 1],
      rotation_euler: [1.45, 0, 0],
    });
    const low = doc.addObject({
      type: 'CAMERA',
      name: 'Low',
      data: doc.addCamera({ lens: 35 }),
      location: [4, -6, 0.4],
      rotation_euler: [1.5, 0, 0.6],
    });
    const cameras = [wide, close, low];
    shotIds = setShots(
      doc,
      SHOTS.map((s) => ({
        id: newShotId(),
        name: s.name,
        enabled: true,
        camera: cameras[s.camera],
        frame_start: s.start,
        frame_end: s.end,
        subjects: [cube],
      })),
    ).map((s) => s.id);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await server?.cleanup();
  });

  it('exports shots of 7, 13 and 5 frames through MCP: every clip frame-exact, the last one too', async () => {
    const start = await ok('export_video', {
      project: projectId,
      width: 160,
      height: 90,
      quality: 'draft',
      passes: ['beauty', 'depth', 'normal', 'mask', 'edges', 'pose'],
      label: 'first',
    });
    expect(start.frames_total).toBe(FRAMES);
    const job = await finished(start.export);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    const names = job.files.map((f: any) => f.name).sort();
    for (const n of [
      'sequence.mp4',
      'sequence.depth.mp4',
      'sequence.normal.mp4',
      'sequence.mask.mp4',
      'sequence.mask.mkv',
      'sequence.edges.mp4',
      'sequence.edges.mkv',
      'sequence.pose.mp4',
      'shot-01-wide.mp4',
      'shot-01-wide.depth.mp4',
      'shot-02-close.mp4',
      'shot-02-close.pose.mp4',
      'shot-03-low.mp4',
      'shot-03-low.edges.mp4',
      'shot-01-wide.png',
      'shot-01-wide.jpg',
      'shot-03-low.png',
      'contact-sheet.png',
      'manifest.json',
    ])
      expect(names).toContain(n);
    // links are absolute (the request's origin)
    const clip2 = job.files.find((f: any) => f.name === 'shot-02-close.mp4');
    expect(clip2.url).toBe(
      `${server.url}/api/projects/${projectId}/video-exports/${job.id}/files/shot-02-close.mp4`,
    );
    const dir = exportDir(job.id);
    // every clip of every pass has exactly its shot's frames and duration, the last shot's too
    const clips = job.files.filter((x: any) => x.kind === 'clip');
    expect(clips).toHaveLength(SHOTS.length * 6);
    for (const f of clips) {
      const shot = SHOTS[shotIds.indexOf(f.shot)];
      const p = await probe(path.join(dir, f.name));
      expect(p.frames, f.name).toBe(framesOf(shot));
      expect(p.duration, f.name).toBeCloseTo(framesOf(shot) / 24, 2);
      expect(f.frames).toBe(framesOf(shot));
      expect(f.duration_s).toBeCloseTo(framesOf(shot) / 24, 5);
    }
    const seq = await probe(path.join(dir, 'sequence.mp4'));
    expect(seq.frames).toBe(FRAMES);
    expect(seq.duration).toBeCloseTo(FRAMES / 24, 2);
    expect(seq.stream).toMatchObject({
      codec_name: 'h264',
      pix_fmt: 'yuv420p',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_range: 'tv',
      width: 160,
      height: 90,
    });
    expect(Number(seq.stream.has_b_frames)).toBe(0);
    const mask = await probe(path.join(dir, 'sequence.mask.mkv'));
    expect(mask.frames).toBe(FRAMES);
    expect(mask.stream.codec_name).toBe('h264');
    // each clip starts on its shot's first frame (its poster) and ends on its last one: the
    // sequence's frame at the shot's end
    const seqFile = path.join(dir, 'sequence.mp4');
    for (const s of SHOTS) {
      const clip = path.join(dir, `${s.slug}.mp4`);
      const poster = await rgbFrame(path.join(dir, `${s.slug}.png`));
      expect(meanDiff(await rgbFrame(clip), poster), s.slug).toBeLessThan(6);
      expect(
        meanDiff(await rgbFrame(clip, framesOf(s) - 1), await rgbFrame(seqFile, s.end - 1)),
        s.slug,
      ).toBe(0);
      expect(meanDiff(await rgbFrame(clip), await rgbFrame(seqFile, s.start - 1)), s.slug).toBe(0);
    }
    const crossed = meanDiff(
      await rgbFrame(path.join(dir, 'shot-02-close.mp4')),
      await rgbFrame(path.join(dir, 'shot-01-wide.png')),
    );
    expect(crossed).toBeGreaterThan(6);
    // the manifest
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      version: 1,
      project: { id: projectId, name: 'Video export' },
      fps: 24,
      width: 160,
      height: 90,
      frames: FRAMES,
      duration_s: Math.round((FRAMES / 24) * 1e6) / 1e6,
      codec: 'h264',
      passes: ['beauty', 'depth', 'normal', 'mask', 'edges', 'pose'],
    });
    expect(manifest.shots.map((s: any) => [s.id, s.timecode_in, s.timecode_out, s.output_frames])).toEqual([
      [shotIds[0], '00:00:00:00', '00:00:00:07', 7],
      [shotIds[1], '00:00:00:07', '00:00:00:20', 13],
      [shotIds[2], '00:00:00:20', '00:00:01:01', 5],
    ]);
    expect(manifest.shots[2].files).toMatchObject({
      beauty: 'shot-03-low.mp4',
      edges: 'shot-03-low.edges.mp4',
      poster: 'shot-03-low.png',
      poster_jpeg: 'shot-03-low.jpg',
    });
    expect(manifest.shots.map((s: any) => s.camera_track.length)).toEqual([7, 13, 5]);
    expect(manifest.shots[1].camera_track[0].position).toEqual([0, -7, 1]);
    expect(manifest.shots[2].camera_track.map((e: any) => e.frame)).toEqual([21, 22, 23, 24, 25]);
    const track = manifest.shots[0].subject_tracks['cube-1'];
    expect(track).toHaveLength(7);
    expect(track.every((b: any) => b.visible && b.w > 0 && b.h > 0)).toBe(true);
    expect(typeof manifest.shots[0].blocking_line).toBe('string');
    // the lossless mask holds exactly the palette's colours (and black)
    const colours = new Set(['0,0,0', ...manifest.mask_palette.map((e: any) => hexRgb(e.color))]);
    const m = await rgbFrame(path.join(dir, 'sequence.mask.mkv'), 3);
    const seen = new Set<string>();
    for (let i = 0; i < m.length; i += 3) seen.add(`${m[i]},${m[i + 1]},${m[i + 2]}`);
    for (const c of seen) expect(colours, c).toContain(c);
    expect(seen.size).toBeGreaterThan(1);
    // a file by its link, with a byte range
    const ranged = await fetch(clip2.url, { headers: { range: 'bytes=0-99' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-type')).toBe('video/mp4');
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    const listed = await ok('list_exports', { project: projectId });
    expect(listed.exports.map((j: any) => j.id)).toContain(job.id);
  });

  /** The export settings of the comparisons below. */
  const compared = { width: 160, height: 90, quality: 'draft', passes: ['beauty', 'mask'] };
  let reference: { beauty: string[]; mask: string[] } | null = null;
  /** The frames of an export of the project before any edit (made once). */
  async function referenceFrames(): Promise<{ beauty: string[]; mask: string[] }> {
    if (reference) return reference;
    const before = await finished(await postExport(compared));
    expect(before.status).toBe('done');
    reference = {
      beauty: await framemd5(path.join(exportDir(before.id), 'sequence.mp4')),
      mask: await framemd5(path.join(exportDir(before.id), 'sequence.mask.mkv')),
    };
    expect(reference.beauty).toHaveLength(FRAMES);
    expect(new Set(reference.beauty).size).toBe(FRAMES);
    return reference;
  }

  it('finishes with the same frames when every render process of the export is killed mid-way', async () => {
    const ref = await referenceFrames();
    // the moment frame 12 is sent, both render processes of the export are killed (SIGKILL, as the
    // system's out-of-memory killer does): the frames in flight are lost with them
    const killed: number[] = [];
    const unhook = hookRenderCalls({
      after: (req, lease) => {
        if (killed.length || !exportFrame(req, 12)) return;
        for (const t of lease.threads) {
          const pid = (t as unknown as { pid?: number }).pid;
          if (pid) {
            killed.push(pid);
            process.kill(pid, 'SIGKILL');
          }
        }
      },
    });
    let job: any;
    try {
      job = await finished(await postExport(compared));
    } finally {
      unhook();
    }
    expect(killed).toHaveLength(2);
    expect(job.error).toBeNull();
    expect(job.status).toBe('done');
    expect(job.warnings.some((w: string) => /render process(es)? stopped during the export/i.test(w))).toBe(
      true,
    );
    expect(await framemd5(path.join(exportDir(job.id), 'sequence.mp4'))).toEqual(ref.beauty);
    expect(await framemd5(path.join(exportDir(job.id), 'sequence.mask.mkv'))).toEqual(ref.mask);
  });

  it('renders the snapshot taken when asked, whatever happens to the project and the render processes meanwhile', async () => {
    const ref = await referenceFrames();
    // the export is held at scene frame 10 (shot 2) until the project was edited and rendered
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const unhook = hookRenderCalls({ before: (req) => (exportFrame(req, 10) ? gate : undefined) });
    let id: string;
    try {
      id = await postExport(compared);
      let status: any;
      for (let i = 0; i < 600; i++) {
        status = await (await fetch(`${server.url}/api/projects/${projectId}/video-exports/${id}`)).json();
        if (status.progress.frames_done >= 3) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // mid-export: frames from 10 on are held
      expect(status.status).toBe('running');
      expect(status.progress.frames_done).toBeGreaterThanOrEqual(3);
      expect(status.progress.frames_done).toBeLessThanOrEqual(9);
      // edit the live project mid-export: delete the cube, add an empty
      const doc = server.handle.rooms.get(projectId)!.scene;
      doc.transact(() => {
        for (const o of doc.listObjects()) if (o.type === 'MESH') doc.removeObject(o.id);
        doc.addObject({ type: 'EMPTY', name: 'Added meanwhile' });
      });
      // and render the live project meanwhile: a still, and an animation that shares the
      // export's render processes (another document state in them)
      const [still, anim] = await Promise.all([
        call('render_image', { project: projectId, camera: 'shots', frame: 13, width: 160, height: 90 }),
        // one camera per frame (7 in the wide shot, 8 close)
        call('render_animation', {
          project: projectId,
          format: 'PNG_SEQUENCE',
          frame_start: 7,
          frame_end: 8,
          camera: 'shots',
          width: 64,
          height: 36,
        }),
      ]);
      expect(still.isError, still.content[0]?.text).toBeFalsy();
      expect(anim.isError, anim.content[0]?.text).toBeFalsy();
      expect(anim.content.filter((c) => c.type === 'resource')).toHaveLength(2);
    } finally {
      open();
      unhook();
    }
    let status: any = null;
    for (let i = 0; i < 30; i++) {
      const r = await fetch(`${server.url}/api/projects/${projectId}/video-exports/${id}?wait=20`);
      expect(r.status).toBe(200);
      status = await r.json();
      if (['done', 'failed', 'cancelled'].includes(status.status)) break;
    }
    expect(status.error).toBeNull();
    expect(status.status).toBe('done');
    // every frame is the one of the project before the edit
    expect(await framemd5(path.join(exportDir(id), 'sequence.mp4'))).toEqual(ref.beauty);
    expect(await framemd5(path.join(exportDir(id), 'sequence.mask.mkv'))).toEqual(ref.mask);
    const file = await fetch(
      `${server.url}/api/projects/${projectId}/video-exports/${id}/files/shot-02-close.mp4`,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    expect((await probe(path.join(exportDir(id), 'shot-02-close.mp4'))).frames).toBe(13);
  });

  it('cancels a running export and deletes its partial files', async () => {
    const start = await ok('export_video', {
      project: projectId,
      frame_start: 1,
      frame_end: 4000,
      width: 160,
      height: 90,
      quality: 'draft',
    });
    for (let i = 0; i < 100; i++) {
      const s = await ok('export_status', { export: start.export, wait_s: 2 });
      if (s.progress.frames_done > 3) break;
    }
    const t0 = Date.now();
    const c = await ok('cancel_export', { export: start.export });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(c.status).toBe('cancelled');
    expect(await readdir(exportDir(start.export))).toEqual(['job.json']);
    const del = await fetch(`${server.url}/api/projects/${projectId}/video-exports/${start.export}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    expect(
      (await fetch(`${server.url}/api/projects/${projectId}/video-exports/${start.export}`)).status,
    ).toBe(404);
  });

  it('answers FFMPEG_UNAVAILABLE when FFMPEG_PATH does not run ffmpeg', async () => {
    const other = await startServer({ FFMPEG_PATH: '/nonexistent/bin/ffmpeg' });
    try {
      const c = new Client({ name: 'video-export-test-2', version: '1.0.0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(`${other.url}/mcp`)));
      const p = JSON.parse(
        ((await c.callTool({ name: 'create_project', arguments: { name: 'No ffmpeg' } })) as ToolResult)
          .content[0].text!,
      );
      const r = (await c.callTool({ name: 'export_video', arguments: { project: p.id } })) as ToolResult;
      expect(r.isError).toBe(true);
      const [message, ...rest] = r.content[0].text!.split('\n');
      expect(message).toMatch(/Video export needs ffmpeg: .*\/nonexistent\/bin\/ffmpeg/);
      expect(JSON.parse(rest.join('\n'))).toEqual({ code: 'FFMPEG_UNAVAILABLE' });
      const rest503 = await fetch(`${other.url}/api/projects/${p.id}/video-exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(rest503.status).toBe(503);
      expect(((await rest503.json()) as { code: string }).code).toBe('FFMPEG_UNAVAILABLE');
      await c.close();
    } finally {
      await other.close();
      await other.cleanup();
    }
  });
});

function hexRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
