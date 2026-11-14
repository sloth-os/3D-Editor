import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG, STORE_CATEGORIES, createOperatorRegistry } from '@3d-editor/core';
import { registerRideoRoutes, rideoTargetSchema } from '../../src/api/rideo';
import { SERVICE_ERROR_CODES, codedErrorDetails } from '../../src/mcp/agent';
import {
  MAX_ACTIVE_PREVIS,
  MAX_PREVIS_JOBS,
  MAX_PREVIS_WAIT_S,
  RideoBridge,
  type PrevisJob,
} from '../../src/rideo';
import { MAX_PUSH_BYTES } from '../../src/rideo/push';
import { defaultMode, type ShotFeatures } from '../../src/rideo/shots';
import type { ServerServices, ServiceContext } from '../../src/services';
import { VideoExports } from '../../src/video';
import { clearFfmpegChecks, ffmpegUnavailable, hasFfmpeg, requireFfmpeg } from '../../src/video/ffmpeg';
import {
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WAIT_S,
  MAX_EXPORT_WIDTH,
  videoExportParamsSchema,
} from '../../src/video/params';
import { MAX_EXPORT_FRAMES } from '../../src/video/plan';
import { RideoMock, kiteFixture } from '../helpers/rideo-mock';
import { makeFakeFfmpeg } from '../helpers/video-fake-ffmpeg';
import { exportScene, fakeContext, makeFakeRenderer } from '../helpers/video-fake-renderer';

/*
 * The director's desk docs (docs/rideo.md, video-export.md, model-store.md, director-desk.md) and
 * the README's environment table against the code: the previs snippet run against a stub editor,
 * the previs route's answers, the argument names of the calls, the default reference modes, what
 * features.videoExport checks, the export messages and what cancel deletes, the code line of the
 * service errors, the proxy variable, the Docker image's ffmpeg, the env defaults, the built-in
 * catalog, the limits, and the Markdown the formatter does not check (*.md is prettier-ignored).
 */

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** A file of the repository, by its path from the root. */
const repo = (rel: string) => file(`../../../../${rel}`);
const read = (doc: string) => repo(`docs/${doc}`);
/** A source file of the server (apps/server/src/…). */
const source = (rel: string) => file(`../../src/${rel}`);
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const readme = repo('README.md');
const rideo = read('rideo.md');
const videoExport = read('video-export.md');
const modelStore = read('model-store.md');
const directorDesk = read('director-desk.md');
const mcp = read('mcp.md');
const NEW_DOCS = {
  'rideo.md': rideo,
  'video-export.md': videoExport,
  'model-store.md': modelStore,
  'director-desk.md': directorDesk,
};

/** A doc's section: from its heading line to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = doc.slice(start + heading.length + 2);
  const next = new RegExp(`\\n#{1,${level}} `).exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

/** The cells of a Markdown table row (`|` inside code spans does not split). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let tick = 0;
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      tick = tick === 0 ? n : tick === n ? 0 : tick;
      cur += '`'.repeat(n);
      i += n - 1;
    } else if (c === '|' && tick === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  return out;
}

/** The tables of a Markdown text (outside code blocks): header cells and rows of cells, and their lines. */
function tables(doc: string): { header: string[]; rows: string[][]; lines: string[] }[] {
  const out: { header: string[]; rows: string[][]; lines: string[] }[] = [];
  let fence = false;
  let cur: string[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push({ header: cells(cur[0]), rows: cur.slice(2).map(cells), lines: cur });
    cur = [];
  };
  for (const l of doc.split('\n')) {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      flush();
    } else if (!fence && l.startsWith('|')) cur.push(l);
    else flush();
  }
  flush();
  return out;
}

/** The table row whose first cell starts with `first`. */
function row(doc: string, first: string): string[] {
  const hit = tables(doc)
    .flatMap((t) => t.rows)
    .find((r) => r[0].startsWith(first));
  expect(hit, first).toBeDefined();
  return hit!;
}

// ---------------------------------------------------------------- rideo.md, recipe 2

/** The TypeScript snippet of recipe 2, compiled. */
const SNIPPET = (() => {
  const ts = /```ts\n([\s\S]*?)```/.exec(section(rideo, '## Recipe 2: one REST call'))?.[1] ?? '';
  return { ts, js: ts ? transformSync(ts, { loader: 'ts', format: 'esm' }).code : '' };
})();
const EDITOR = /const EDITOR = '([^']+)'/.exec(SNIPPET.ts)?.[1] ?? '';

interface StubCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Runs the snippet against `answer` (the editor's server), with a clock that moves `stepMs` each
 * time it is read. More than 50 requests is a runaway loop: the stub then throws.
 */
async function runSnippet(answer: (call: StubCall, n: number) => Response, stepMs = 0) {
  const calls: StubCall[] = [];
  const fetchStub = async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? 'GET',
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    if (calls.length > 50) throw new Error(`runaway: ${calls.length} requests`);
    return answer(call, calls.length);
  };
  let now = 1_000_000;
  const clock = { now: () => (now += stepMs) };
  const logged: unknown[][] = [];
  const consoleStub = { log: (...args: unknown[]) => logged.push(args) };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  const run = new AsyncFunction('fetch', 'process', 'console', 'Date', SNIPPET.js);
  const error = await run(fetchStub, { env: { EDITOR_TOKEN: 'token' } }, consoleStub, clock).then(
    () => null,
    (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  );
  return { calls, logged, error };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const job = (status: string) => ({ id: 'job1', status, error: null, push: null, warnings: [] });

describe('docs/rideo.md: the previs snippet of recipe 2', () => {
  it('compiles and follows a job to its end, asking for camera references', async () => {
    expect(SNIPPET.js).not.toBe('');
    const statuses = ['exporting', 'pushing', 'done'];
    const { calls, logged, error } = await runSnippet((call, n) =>
      call.method === 'POST' ? json(job('importing'), 202) : json(job(statuses[n - 2])),
    );
    expect(error).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${EDITOR}/api/rideo/previs`,
      ...statuses.map(() => `GET ${EDITOR}/api/rideo/previs/job1?wait=${MAX_PREVIS_WAIT_S}`),
    ]);
    // the body is a previs request the route accepts, with camera references (see below)
    expect(calls[0].body).toMatchObject({ rideo: { project: expect.any(String), clip: expect.any(String) } });
    expect(calls[0].body).toMatchObject({ push: { mode: 'camera' } });
    expect(logged[0][0]).toBe('done');
  });

  it('stops on a job the server does not have (404 after a restart) instead of polling on', async () => {
    const { calls, error } = await runSnippet((call) =>
      call.method === 'POST'
        ? json(job('importing'), 202)
        : json(
            {
              error: "Previs job 'job1' not found (jobs are kept until the server restarts)",
              code: 'NOT_FOUND',
            },
            404,
          ),
    );
    expect(error?.message).toMatch(/^previs job1: 404 /);
    expect(calls).toHaveLength(2);
  });

  it('stops on a refused previs and on a job that never ends', async () => {
    const refused = await runSnippet(() => json({ error: 'busy', code: 'QUEUE_FULL' }, 409));
    expect(refused.error?.message).toMatch(/^previs refused: 409 /);
    expect(refused.calls).toHaveLength(1);
    // a clock that moves half an hour per read: the deadline (hours) ends the loop
    const stuck = await runSnippet(
      (call) => (call.method === 'POST' ? json(job('importing'), 202) : json(job('exporting'))),
      30 * 60_000,
    );
    expect(stuck.error?.message).toMatch(/^previs job1: still exporting after \d+ ms$/);
    expect(stuck.calls.length).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------- rideo.md, what POST refuses

/** A real bridge behind the real routes; rideo is `fetch`. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function previsServer(o: { rideoUrl: string | null; rideoToken?: string | null; fetch: FetchLike }) {
  const bridge = new RideoBridge({
    config: {
      rideoUrl: o.rideoUrl,
      rideoToken: o.rideoToken ?? null,
      dataDir: '/nonexistent',
      ffmpegPath: 'ffmpeg',
    },
    fetch: o.fetch,
    services: { registry: createOperatorRegistry(), exports: {} },
    rooms: {
      open: async () => {
        throw new Error('no project');
      },
      listProjects: async () => [],
    },
  } as unknown as ServiceContext);
  const app = Fastify();
  registerRideoRoutes(app, { rideo: bridge } as unknown as ServerServices);
  await app.ready();
  return { app, bridge };
}

let servers: { app: FastifyInstance; bridge: RideoBridge }[] = [];
afterEach(async () => {
  for (const s of servers) {
    await s.bridge.close();
    await s.app.close();
  }
  servers = [];
});

async function serve(o: Parameters<typeof previsServer>[0]) {
  const s = await previsServer(o);
  servers.push(s);
  return s.app;
}

const post = (app: FastifyInstance, payload: object) =>
  app.inject({ method: 'POST', url: '/api/rideo/previs', payload });

/** Follows a job until it ends (each GET waits up to 5 s for a change). */
async function settle(app: FastifyInstance, id: string): Promise<PrevisJob> {
  for (let i = 0; i < 20; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/rideo/previs/${id}?wait=5` });
    expect(res.statusCode).toBe(200);
    const j = res.json() as PrevisJob;
    if (['done', 'failed', 'cancelled'].includes(j.status)) return j;
  }
  throw new Error(`previs ${id} did not end`);
}

describe("docs/rideo.md: the previs route's answers", () => {
  const fx = kiteFixture();
  const target = { project: fx.ids.project, clip: fx.ids.clip };

  it('POST refuses at once only with the codes the table lists; GET says when a job is gone', async () => {
    const refusals = new Set<string>();
    const refused = async (app: FastifyInstance, payload: object) => {
      const res = await post(app, payload);
      expect(res.statusCode, JSON.stringify(payload)).not.toBe(202);
      refusals.add(`${res.statusCode} ${(res.json() as { code: string }).code}`);
    };
    const mock = new RideoMock(null);
    mock.add(fx.data);
    const app = await serve({ rideoUrl: 'http://rideo.local', fetch: mock.fetch });
    await refused(app, { rideo: target, export: { width: 161 } });
    await refused(app, { rideo: { ...target, url: 'ftp://rideo.local' } });
    await refused(await serve({ rideoUrl: null, fetch: mock.fetch }), { rideo: target });
    // four jobs whose rideo never answers, then a fifth
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
    const busy = await serve({ rideoUrl: 'http://rideo.local', fetch: hanging });
    for (let i = 0; i < MAX_ACTIVE_PREVIS; i++)
      expect((await post(busy, { rideo: target })).statusCode).toBe(202);
    await refused(busy, { rideo: target });
    expect([...refusals].sort()).toEqual(['400 INVALID_PARAMS', '409 QUEUE_FULL', '503 UNAVAILABLE']);

    const failure = section(rideo, '## Recipe 2: one REST call');
    const table = tables(failure).find((t) => t.header[0] === 'Status');
    expect(table).toBeDefined();
    const documented = table!.rows.map((r) => `${r[0]} ${r[1].replace(/`/g, '')}`);
    expect(documented.sort()).toEqual([...refusals].sort());
    // the codes of rideo's own failures are the MCP tools', never the route's
    expect(failure).not.toMatch(/UPSTREAM|NEEDS_KEY/);
    expect(flat(failure)).toContain("Everything else ends the job later with `status: 'failed'`");

    const gone = await app.inject({ method: 'GET', url: '/api/rideo/previs/nope' });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'NOT_FOUND' });
    expect(flat(failure)).toContain(
      '`GET /api/rideo/previs/:job` answers 404 `NOT_FOUND` for a job the server does not have',
    );
    const tooLong = await app.inject({
      method: 'GET',
      url: `/api/rideo/previs/nope?wait=${MAX_PREVIS_WAIT_S + 1}`,
    });
    expect(tooLong.statusCode).toBe(400);
    expect(flat(failure)).toContain(`A \`wait\` over ${MAX_PREVIS_WAIT_S} answers 400.`);
  });

  it('starts the job (202) when rideo fails, refuses the token or lacks the clip; the job ends failed, without a code', async () => {
    const down = await serve({
      rideoUrl: 'http://rideo.local',
      fetch: async () => new Response('bad gateway', { status: 502 }),
    });
    const strict = new RideoMock('right');
    strict.add(fx.data);
    const refusing = await serve({
      rideoUrl: 'http://rideo.local',
      rideoToken: 'wrong',
      fetch: strict.fetch,
    });
    const open = new RideoMock(null);
    open.add(fx.data);
    const lacking = await serve({ rideoUrl: 'http://rideo.local', fetch: open.fetch });
    for (const [app, rideoTarget] of [
      [down, target],
      [refusing, target],
      [lacking, { ...target, clip: 'clp_0000000000' }],
    ] as const) {
      const res = await post(app, { rideo: rideoTarget });
      expect(res.statusCode).toBe(202);
      const ended = await settle(app, (res.json() as PrevisJob).id);
      expect(ended.status).toBe('failed');
      expect(ended.error).toEqual(expect.any(String));
      // the docs say a job carries no code; a job that gains one must be documented
      const codeFields = Object.keys(ended).filter((k) => /code/.test(k));
      const failure = flat(section(rideo, '## Recipe 2: one REST call'));
      if (codeFields.length === 0) expect(failure).toContain('(a job has no code)');
      else for (const k of codeFields) expect(failure).toContain(`\`${k}\``);
    }
  });
});

// ---------------------------------------------------------------- rideo.md, recipe 1 and the modes

/**
 * rideo's MCP tools the docs call, with their arguments as rideo declares them
 * (packages/server/src/mcp/server.ts of rideo; checked against it below when a checkout is found).
 */
const RIDEO_TOOLS: Record<string, string[]> = { blocking_get: ['projectId', 'clipId'] };
const RIDEO_REPO =
  process.env.RIDEO_REPO ?? fileURLToPath(new URL('../../../../../sloth-os/rideo', import.meta.url));
const RIDEO_MCP = path.join(RIDEO_REPO, 'packages/server/src/mcp/server.ts');

describe('docs/rideo.md: the calls of recipe 1', () => {
  it("call rideo's tools with the arguments rideo declares, and the editor's with rideo: {project, clip}", () => {
    const calls = [...rideo.matchAll(/\*\*rideo\*\* `(\w+) \{([^}]*)\}`/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, tool, args] of calls) {
      expect(RIDEO_TOOLS[tool], tool).toBeDefined();
      expect(
        args.split(',').map((a) => a.trim()),
        tool,
      ).toEqual(RIDEO_TOOLS[tool]);
    }
    expect(rideoTargetSchema.safeParse({ project: 'prj_0123456789', clip: 'clp_0123456789' }).success).toBe(
      true,
    );
    expect(
      rideoTargetSchema.safeParse({ projectId: 'prj_0123456789', clipId: 'clp_0123456789' }).success,
    ).toBe(false);
    expect(flat(rideo)).toContain("the editor's tools take them as `rideo: {project, clip}`");
  });

  it.skipIf(!existsSync(RIDEO_MCP))("match rideo's own tool declarations", () => {
    const server = readFileSync(RIDEO_MCP, 'utf8');
    for (const [tool, args] of Object.entries(RIDEO_TOOLS)) {
      const decl = new RegExp(`tool\\(\\s*'${tool}',[\\s\\S]*?\\n\\s*\\{([^}]*)\\},`).exec(server);
      expect(decl, tool).not.toBeNull();
      const declared = [...decl![1].matchAll(/(\w+):/g)].map((m) => m[1]);
      expect(declared, tool).toEqual(args);
    }
  });

  it("say the bridge's default modes, and ask for camera references until rideo has measured the others", () => {
    const features = (f: Partial<ShotFeatures>): ShotFeatures => ({
      camera_move: false,
      physics: false,
      tether: false,
      held: false,
      characters: false,
      found: [],
      ...f,
    });
    // the defaults the docs give: camera when the first frame cannot follow, motion, pose, else camera
    expect(defaultMode(features({ tether: true, characters: true }), false)).toBe('camera');
    expect(defaultMode(features({ tether: true, characters: true }), true)).toBe('motion');
    expect(defaultMode(features({ characters: true }), true)).toBe('pose');
    expect(defaultMode(features({ camera_move: true }), true)).toBe('camera');
    expect(row(rideo, '`mode`')[1]).toBe(
      "per shot: `camera` when rideo's first frame cannot follow our staging, else `motion` for props in motion, `pose` for actors, else `camera`",
    );
    const measure = flat(section(rideo, '## What rideo should measure first'));
    expect(measure).toContain(
      'a `motion` reference when props move in it and a `pose` reference when it shows actors',
    );
    // a kite shot with an actor would get an unmeasured motion reference: the recipes ask for camera
    if (defaultMode(features({ tether: true, characters: true }), true) !== 'camera') {
      expect(measure).toContain('ask for `camera` (the most conservative) as the recipes above do');
      expect(flat(section(rideo, '## Recipe 1: an agent with both MCP servers'))).toContain(
        "`rideo_push {project, export, rideo: {project, clip}, mode: 'camera'}`",
      );
      expect(SNIPPET.ts).toContain("push: { mode: 'camera' }");
    }
  });
});

// ---------------------------------------------------------------- video-export.md

/** The export messages the troubleshooting table quotes come from the code. */
const VIDEO_SOURCES = readdirSync(fileURLToPath(new URL('../../src/video/', import.meta.url)))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => source(`video/${f}`))
  .join('\n');

describe('docs/video-export.md', () => {
  it('says what features.videoExport checks, and what an ffmpeg without libx264 answers', async () => {
    const fake = await makeFakeFfmpeg();
    const before = process.env.FAKE_FFMPEG_NO_X264;
    process.env.FAKE_FFMPEG_NO_X264 = '1';
    clearFfmpegChecks();
    try {
      expect(await hasFfmpeg(fake.path)).toBe(true);
      const err = (await requireFfmpeg(fake.path).catch((e: unknown) => e)) as {
        code?: string;
        message: string;
      };
      expect(err.code).toBe('FFMPEG_UNAVAILABLE');
      expect(err.message).toContain('has no libx264 encoder');
    } finally {
      if (before === undefined) delete process.env.FAKE_FFMPEG_NO_X264;
      else process.env.FAKE_FFMPEG_NO_X264 = before;
      clearFfmpegChecks();
    }
    // app.ts: the flag
    const flag = /const videoExport = ([^;]+);/.exec(source('app.ts'))?.[1];
    expect(flag).toBeDefined();
    const flagChecksEncoders = /ffmpegEncoders|requireFfmpeg|libx264/.test(flag!);
    const troubleshooting = section(videoExport, '## Troubleshooting');
    const off = row(troubleshooting, '`features.videoExport: false`');
    expect(off.join(' ').includes('libx264'), off.join(' | ')).toBe(flagChecksEncoders);
    if (!flagChecksEncoders) {
      expect(row(troubleshooting, '`FFMPEG_UNAVAILABLE` "has no libx264 encoder"')[0]).toContain(
        'although `features.videoExport` is `true`',
      );
      expect(flat(section(videoExport, '## Requirements'))).toContain(
        'reports `features.videoExport: true` when that works, whatever encoders that ffmpeg has',
      );
    }
  });

  it('quotes the messages of the code: both ends of a running export at a restart, the others', () => {
    const ends = [
      ...source('video/index.ts').matchAll(/'(server (?:shut down|restarted) while the export ran)/g),
    ];
    expect(ends.map((m) => m[1]).sort()).toEqual([
      'server restarted while the export ran',
      'server shut down while the export ran',
    ]);
    const jobs = flat(section(videoExport, '## Jobs'));
    const troubleshooting = section(videoExport, '## Troubleshooting');
    for (const [, message] of ends) {
      expect(jobs).toContain(`"${message}"`);
      expect(row(troubleshooting, `failed "${message}"`)).toBeDefined();
    }
    // every quoted message of the table is one the server writes
    const written = [
      VIDEO_SOURCES,
      ffmpegUnavailable('ffmpeg').message,
      ffmpegUnavailable('ffmpeg', 'libx264').message,
    ].join('\n');
    const symptoms = tables(troubleshooting)[0].rows.map((r) => r[0]);
    const quoted = symptoms.flatMap((s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    for (const q of quoted) expect(written, q).toContain(q);
  });

  it('says that cancel with delete_files deletes a finished export too', async () => {
    const fake = await makeFakeFfmpeg();
    const dir = await mkdtemp(path.join(tmpdir(), 'docs-desk-'));
    const renderer = makeFakeRenderer();
    const exports = new VideoExports(
      fakeContext({
        exportDir: dir,
        ffmpegPath: fake.path,
        renderer: renderer.renderer,
        projects: { p1: exportScene({ shots: 1, frames: 2 }).doc },
      }),
      { memory: () => ({ available: 2 ** 40, source: 'meminfo' }) },
    );
    try {
      let st = await exports.start('p1', videoExportParamsSchema.parse({ width: 32, height: 18 }));
      for (let i = 0; i < 40 && !['done', 'failed', 'cancelled'].includes(st.status); i++)
        st = await exports.status(st.id, { waitS: 5 });
      expect(st.status).toBe('done');
      // without delete_files a finished job stays as it is
      expect((await exports.cancel(st.id)).status).toBe('done');
      expect((await exports.status(st.id)).status).toBe('done');
      expect((await exports.cancel(st.id, { deleteFiles: true })).status).toBe('done');
      await expect(exports.status(st.id)).rejects.toThrow(/not found/i);
    } finally {
      await exports.close();
    }
    const cancel = flat(section(videoExport, '## Jobs'));
    expect(cancel).toContain(
      'With `delete_files: true` it also deletes the job and its files, whatever its status (a finished export too)',
    );
    expect(row(mcp, '`cancel_export`')[2]).toBe(
      'The job as it was: a queued or running one is cancelled, a finished one left as it is; `delete_files` deletes any job and its files, a finished one too',
    );
    for (const doc of [videoExport, mcp]) expect(flat(doc)).not.toContain('a finished one is kept');
  });

  it('give the limits of the code', () => {
    const doc = flat(videoExport);
    expect(doc).toContain(`At most ${MAX_EXPORT_FRAMES.toLocaleString('en-US')} output frames per export.`);
    expect(row(videoExport, '`width`, `height`')[2]).toContain(
      `Even, 16–${MAX_EXPORT_WIDTH} × 16–${MAX_EXPORT_HEIGHT}`,
    );
    expect(doc).toContain(`wait up to ${MAX_EXPORT_WAIT_S} s for the job to change status`);
    const d = ENV_DEFAULTS;
    expect(doc).toContain(`At most \`EXPORT_MAX_QUEUED\` (${d.get('EXPORT_MAX_QUEUED')}) may wait`);
    expect(doc).toContain(
      `finished jobs older than \`EXPORT_TTL_HOURS\` (${d.get('EXPORT_TTL_HOURS')}) are deleted`,
    );
    expect(doc).toContain(`beyond \`EXPORT_MAX_MB\` (${d.get('EXPORT_MAX_MB')}) of exports in all`);
    expect(flat(mcp)).toContain(
      `Even sizes up to ${MAX_EXPORT_WIDTH} × ${MAX_EXPORT_HEIGHT}, 120 fps and ${MAX_EXPORT_FRAMES.toLocaleString('en-US')} frames`,
    );
    expect(flat(mcp)).toContain(
      `\`EXPORT_MAX_MB\` (${d.get('EXPORT_MAX_MB')}) in all, each kept \`EXPORT_TTL_HOURS\` (${d.get('EXPORT_TTL_HOURS')}) after it ends`,
    );
  });
});

// ---------------------------------------------------------------- mcp.md, errors

describe('docs/mcp.md: the code line of the video, store and rideo tools', () => {
  it('names the codes that carry it, and the codes that do not', () => {
    const doc = flat(mcp);
    const start = doc.indexOf('The video export, model store and rideo tools fail with codes of their own');
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = doc.slice(start, doc.indexOf(' | ', start));
    const listed = paragraph.slice(
      paragraph.indexOf('on the line after the message:'),
      paragraph.indexOf('Their `OUT_OF_MEMORY` failures carry that line too'),
    );
    expect(listed).not.toBe('');
    const codes = [...listed.matchAll(/`([A-Z_]+)` \(/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual([...SERVICE_ERROR_CODES].sort());
    for (const code of [...SERVICE_ERROR_CODES, 'OUT_OF_MEMORY'] as const)
      expect(codedErrorDetails(code)).toEqual({ code });
    for (const code of ['NOT_FOUND', 'INVALID_PARAMS'] as const) {
      expect(codedErrorDetails(code)).toBeUndefined();
      expect(paragraph).toContain(`(\`${code}\`)`);
    }
    expect(paragraph).toContain('are plain messages without it.');
  });
});

// ---------------------------------------------------------------- README and model-store.md

/** config.ts's environment variables, with the default of each that has one (as the docs write it). */
const ENV_DEFAULTS = (() => {
  const schema = /const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(source('config.ts'))?.[1] ?? '';
  const keys = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)];
  const out = new Map<string, string | null>();
  keys.forEach((m, i) => {
    const body = schema.slice(m.index, keys[i + 1]?.index);
    // the last .default(…) of the variable, as the docs write it ('info' → info, 20_000 → 20000)
    const d =
      [...body.matchAll(/\.default\(([^()]*)\)/g)]
        .pop()?.[1]
        .trim()
        .replace(/^'(.*)'$/, '$1') ?? null;
    out.set(m[1], d !== null && /^\d[\d_]*$/.test(d) ? d.replace(/_/g, '') : d);
  });
  return out;
})();

/** Variables the server reads outside config.ts's schema (process.env.X / env.X anywhere in src). */
const ENV_READ = (() => {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const names = new Set<string>();
  for (const f of readdirSync(src, { recursive: true }) as string[])
    if (f.endsWith('.ts'))
      for (const m of readFileSync(path.join(src, f), 'utf8').matchAll(
        /\benv(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g,
      ))
        names.add(m[1] ?? m[2]);
  return names;
})();

describe('README.md: the environment variables', () => {
  const config = tables(section(readme, '## Configuration (server environment variables)'))[0];
  const documented = config.rows.flatMap((r) => [...r[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));

  it('list every variable of config.ts, and only variables the server or Node.js read', () => {
    expect(ENV_DEFAULTS.size).toBeGreaterThan(30);
    for (const key of ENV_DEFAULTS.keys()) expect(documented, key).toContain(key);
    for (const key of documented)
      expect(ENV_DEFAULTS.has(key) || ENV_READ.has(key) || key === 'NODE_USE_ENV_PROXY', key).toBe(true);
  });

  it('give the defaults of config.ts, here and in the docs of the desk', () => {
    const docs = { 'README.md': readme, 'video-export.md': videoExport, 'model-store.md': modelStore };
    let checked = 0;
    for (const [name, doc] of Object.entries(docs))
      for (const t of tables(doc).filter((x) => x.header[1] === 'Default'))
        for (const r of t.rows)
          for (const [, key] of r[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
            const d = ENV_DEFAULTS.get(key);
            if (d == null) continue;
            expect(r[1], `${name} ${key}`).toContain(`\`${d}\``);
            checked++;
          }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it('say which Node.js reads NODE_USE_ENV_PROXY, and that it applies to every outgoing request', () => {
    const engines = (JSON.parse(repo('package.json')) as { engines: { node: string } }).engines.node;
    const [major, minor] = /(\d+)\.(\d+)/.exec(engines)!.slice(1).map(Number);
    const proxyRow = row(readme, '`NODE_USE_ENV_PROXY`')[2];
    const proxySection = flat(section(modelStore, '## Behind a proxy'));
    // Node.js reads it from 22.21 (--use-env-proxy); the engines allow older ones
    if (major === 22 && minor < 21) {
      expect(proxyRow).toContain('Node.js 22.21 or later');
      expect(proxySection).toContain('Node.js 22.21 and later read');
    }
    for (const text of [proxyRow, proxySection])
      for (const name of ['RIDEO_URL', 'WEBDAV_URL', 'NO_PROXY']) expect(text, name).toContain(name);
  });

  it('say how to build an image without ffmpeg, and the Dockerfile builds one', () => {
    const dockerfile = repo('Dockerfile');
    expect(dockerfile).not.toMatch(/\btiny\b/);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(runtime).toContain(
      'ARG WITH_FFMPEG=1\nRUN if [ "$WITH_FFMPEG" = 1 ]; then apk add --no-cache ffmpeg; fi\n',
    );
    expect(runtime.indexOf('apk add')).toBeLessThan(runtime.indexOf('\nUSER node'));
    expect(flat(readme)).toContain('`docker build --build-arg WITH_FFMPEG=0 .`');
    expect(flat(videoExport)).toContain('`--build-arg WITH_FFMPEG=0`');
    // the published image is the one with ffmpeg (its smoke test exports a video)
    expect(repo('.github/workflows/docker.yml')).not.toContain('WITH_FFMPEG');
  });
});

describe('docs/model-store.md: the built-in models', () => {
  it('lists the catalog per category, and its size wherever the docs give it', () => {
    let total = 0;
    for (const category of STORE_CATEGORIES) {
      const r = row(modelStore, `\`${category}\``);
      const ids = r[2].replace(/ \(actors\)$/, '').split(', ');
      const entries = BUILTIN_CATALOG.filter((e) => e.category === category).map((e) => e.id);
      expect(Number(r[1]), category).toBe(entries.length);
      expect([...ids].sort(), category).toEqual([...entries].sort());
      total += entries.length;
    }
    expect(total).toBe(BUILTIN_CATALOG.length);
    const counts = [readme, modelStore, directorDesk, read('features.md')].flatMap((doc) =>
      [...flat(doc).matchAll(/\b(\d+) (?:original |built-in )?procedural models\b/g)].map((m) =>
        Number(m[1]),
      ),
    );
    expect(counts.length).toBeGreaterThanOrEqual(4);
    for (const n of counts) expect(n).toBe(BUILTIN_CATALOG.length);
  });
});

// ---------------------------------------------------------------- rideo.md and mcp.md limits

describe('docs/rideo.md and docs/mcp.md: the limits of the bridge', () => {
  it('give the limits of rideo/index.ts and push.ts', () => {
    const words: Record<number, string> = {
      2: 'two',
      3: 'three',
      4: 'four',
      5: 'five',
      6: 'six',
      8: 'eight',
    };
    const pushMb = MAX_PUSH_BYTES / 1048576;
    const doc = flat(rideo);
    expect(doc).toContain(`(the last ${MAX_PREVIS_JOBS}, at most ${MAX_ACTIVE_PREVIS} running)`);
    expect(row(rideo, '409')[2]).toBe(`${words[MAX_ACTIVE_PREVIS]} previs jobs already run`);
    expect(doc).toContain(`(waits up to ${MAX_PREVIS_WAIT_S} s for it to change)`);
    expect(doc).toContain(`at most ${pushMb} MB`);
    expect(doc).toContain(`the push refuses clips over ${pushMb} MB`);
    expect(row(mcp, '`rideo_push`, previs jobs')[1]).toBe(
      `Clips of at most ${pushMb} MB; ${MAX_ACTIVE_PREVIS} previs jobs at once, the last ${MAX_PREVIS_JOBS} kept in memory`,
    );
    expect(row(mcp, '`GET /api/rideo/previs/:job`')[1]).toBe(
      `The previs job (\`?wait=\` 0–${MAX_PREVIS_WAIT_S} s)`,
    );
  });
});

// ---------------------------------------------------------------- Markdown of the new docs

describe('the Markdown of the new docs (prettier does not format *.md)', () => {
  it.each(Object.entries(NEW_DOCS))(
    '%s: aligned tables, code spans on one line, prose within 100 columns',
    (_name, doc) => {
      for (const t of tables(doc)) {
        const widths = new Set(t.lines.map((l) => Array.from(l).length));
        expect(widths.size, t.lines[0]).toBe(1);
      }
      let fence = false;
      doc.split('\n').forEach((line, i) => {
        if (/^\s*```/.test(line)) fence = !fence;
        if (fence || /^\s*```/.test(line) || line.startsWith('|')) return;
        // a run of backticks opens a span that the next run of the same length closes
        let open = 0;
        for (const [run] of line.matchAll(/`+/g))
          open = open === 0 ? run.length : open === run.length ? 0 : open;
        expect(open, `line ${i + 1}: ${line}`).toBe(0);
        if (Array.from(line).length <= 100) return;
        // longer only when it cannot break: one code span or word after the list marker
        const rest = line.replace(/^\s*(?:[-*]|\d+\.)?\s*/, '').replace(/(`+)[\s\S]*?\1/g, 'x');
        expect(rest.trim(), `line ${i + 1}: ${line}`).not.toMatch(/ /);
      });
    },
  );
});
