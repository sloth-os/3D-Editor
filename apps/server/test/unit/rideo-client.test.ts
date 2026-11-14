import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/mcp/agent';
import {
  DEFAULT_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  RideoClient,
  RideoError,
  retryAfterMs,
  rideoBaseUrl,
  rideoToolError,
  type RideoClientOptions,
} from '../../src/rideo/client';
import { RideoMock, kiteFixture } from '../helpers/rideo-mock';

/*
 * The rideo client (SPEC §11): rideo's document routes and the blocking, upload and shot routes,
 * Bearer auth, answers checked with zod, 429/503 retried with backoff or Retry-After, and failures
 * that name the request and rideo's status, code and detail (never the token).
 */

const TOKEN = 'rdo_secret_token_value';

function setup(opts: Partial<RideoClientOptions> = {}, deskEnabled = true) {
  const mock = new RideoMock(TOKEN);
  const fx = kiteFixture({ deskEnabled });
  mock.add(fx.data);
  const waits: number[] = [];
  const client = new RideoClient({
    url: 'https://rideo.example/studio/',
    token: TOKEN,
    fetchImpl: mock.fetch,
    sleep: async (ms) => void waits.push(ms),
    ...opts,
  });
  return { mock, fx, client, waits };
}

async function failure(p: Promise<unknown>): Promise<RideoError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RideoError);
  return err as RideoError;
}

describe('rideo client: reads', () => {
  it('reads project.json, the clip, the blocking view, characters and elements through /docs with the Bearer token', async () => {
    const { mock, fx, client } = setup();
    const project = await client.project(fx.ids.project);
    expect(project.settings).toMatchObject({ fps: 24, resolution: { width: 160, height: 90 } });
    expect(project.settings.blocking).toEqual({ enabled: true, layoutImage: true });
    const clip = await client.clip(fx.ids.project, fx.ids.clip);
    expect(clip.shots.map((s) => [s.id, s.index, s.durationSec])).toEqual([
      [fx.ids.s1, 0, 0.5],
      [fx.ids.s2, 1, 0.5],
      [fx.ids.s3, 2, 0.5],
    ]);
    expect(clip.shots[1].camera).toMatchObject({
      framing: 'medium',
      movement: 'dolly_in',
      move: 'push_in',
      lensMm: 50,
    });
    const view = await client.blocking(fx.ids.project, fx.ids.clip);
    expect(view.state).toBe('ready');
    expect(view.draft.actors.map((a) => [a.characterId, a.heightM])).toEqual([
      [fx.ids.rosie, 1.2],
      [fx.ids.clover, 1.3],
    ]);
    expect((await client.character(fx.ids.project, fx.ids.rosie)).name).toBe('Rosie');
    expect((await client.element(fx.ids.project, fx.ids.kite)).kind).toBe('prop');
    // the subpath is kept, the token is sent on every request
    expect(mock.requests.map((r) => r.path)).toEqual([
      `/studio/api/projects/${fx.ids.project}/docs/project.json`,
      `/studio/api/projects/${fx.ids.project}/docs/clips/${fx.ids.clip}.json`,
      `/studio/api/projects/${fx.ids.project}/clips/${fx.ids.clip}/blocking`,
      `/studio/api/projects/${fx.ids.project}/docs/characters/${fx.ids.rosie}.json`,
      `/studio/api/projects/${fx.ids.project}/docs/elements/${fx.ids.kite}.json`,
    ]);
    expect(mock.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reads an older project.json without the desk's settings as rideo does: the desk off", async () => {
    const { fx, client } = setup();
    delete fx.data.project.settings.blocking;
    delete fx.data.project.settings.resolution;
    const project = await client.project(fx.ids.project);
    expect(project.settings.blocking).toEqual({ enabled: false, layoutImage: true });
    expect(project.settings.resolution).toEqual({ width: 1280, height: 720 });
  });

  it('answers the draft rideo completes for a clip without blocking (state missing)', async () => {
    const mock = new RideoMock();
    const fx = kiteFixture({ blocked: false });
    mock.add(fx.data);
    const client = new RideoClient({ url: 'http://rideo.local', fetchImpl: mock.fetch });
    const view = await client.blocking(fx.ids.project, fx.ids.clip);
    expect(view.state).toBe('missing');
    expect(view.blocking).toBeNull();
    expect(view.draft.actors.map((a) => a.characterId)).toEqual([fx.ids.rosie, fx.ids.clover]);
    // no token: no Authorization header at all
    expect(mock.requests[0].authorization).toBeNull();
  });
});

describe('rideo client: errors', () => {
  it('a missing document is rideo’s 422 validation_error, and becomes a NOT_FOUND ToolError with its detail', async () => {
    const { fx, client } = setup();
    const missing = 'clp_zzzzzzzzzzzzzzzz';
    const err = await failure(client.clip(fx.ids.project, missing));
    expect(err.status).toBe(422);
    expect(err.code).toBe('validation_error');
    expect(err.detail).toBe(`no document at clips/${missing}.json`);
    expect(err.message).toBe(
      `rideo answered 422 validation_error to GET /api/projects/${fx.ids.project}/docs/clips/${missing}.json: no document at clips/${missing}.json`,
    );
    const tool = rideoToolError(err);
    expect(tool).toBeInstanceOf(ToolError);
    expect(tool.code).toBe('NOT_FOUND');
    expect(tool.message).toBe(err.message);
  });

  it('codes a failure by what the caller can do about it: only an outage is UPSTREAM (503, retried)', async () => {
    const { fx, client } = setup();
    const code = async (p: Promise<unknown>) => rideoToolError(await failure(p)).code;
    // an unknown project or clip
    expect(await code(client.project('prj_zzzzzzzzzzzzzzzz'))).toBe('NOT_FOUND');
    expect(await code(client.blocking(fx.ids.project, 'clp_zzzzzzzzzzzzzzzz'))).toBe('NOT_FOUND');
    // a token rideo refuses
    const wrong = setup({ token: 'rdo_wrong' });
    expect(await code(wrong.client.project(fx.ids.project))).toBe('NEEDS_KEY');
    // a blocking rideo does not accept, and an approved clip
    expect(await code(client.putBlocking(fx.ids.project, fx.ids.clip, { actors: 'none' }))).toBe(
      'INVALID_PARAMS',
    );
    fx.data.clips.get(fx.ids.clip)!.status = 'approved';
    expect(await code(client.putBlocking(fx.ids.project, fx.ids.clip, fx.blocking))).toBe('POLL_FAILED');
    // rideo down: 5xx after the retries, or no answer
    const errOf = (status: number | null) =>
      rideoToolError(new RideoError('x', 'GET /api/projects/prj_0000000001/docs/project.json', status));
    expect(errOf(500).code).toBe('UPSTREAM');
    expect(errOf(503).code).toBe('UPSTREAM');
    expect(errOf(429).code).toBe('UPSTREAM');
    expect(errOf(null).code).toBe('UPSTREAM');
    expect(errOf(403).code).toBe('NEEDS_KEY');
    // a 422 to anything but a document read is a request rideo does not accept
    expect(rideoToolError(new RideoError('x', 'PATCH /api/projects/p/clips/c/shots/s', 422)).code).toBe(
      'INVALID_PARAMS',
    );
  });

  it('an unknown project is 404 not_found; a refused token 401 with what to check, and never the token', async () => {
    const { fx, client } = setup();
    const unknown = 'prj_zzzzzzzzzzzzzzzz';
    expect((await failure(client.project(unknown))).status).toBe(404);
    const wrong = setup({ token: 'rdo_wrong' });
    const err = await failure(wrong.client.project(fx.ids.project));
    expect(err.status).toBe(401);
    expect(err.message).toContain('check RIDEO_TOKEN or pass rideo.token');
    expect(err.message).not.toContain('rdo_wrong');
  });

  it('refuses malformed ids before any request (INVALID_PARAMS)', async () => {
    const { mock, fx, client } = setup();
    const calls: (() => Promise<unknown>)[] = [
      () => client.project('project-1'),
      () => client.clip(fx.ids.project, '../../etc/passwd'),
      () => client.character(fx.ids.project, 'CHR_X'),
      () => client.patchShot(fx.ids.project, fx.ids.clip, 'shot 1', {}),
    ];
    for (const call of calls) {
      const err = await Promise.resolve()
        .then(call)
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(ToolError);
      expect((err as ToolError).code).toBe('INVALID_PARAMS');
    }
    expect(mock.requests).toHaveLength(0);
  });

  it('an answer that does not validate, or is not JSON, names the request', async () => {
    const bad = new RideoClient({
      url: 'http://rideo.local',
      fetchImpl: async () =>
        new Response(JSON.stringify({ id: 'clp_0123456789', shots: [{ id: 'x', index: 0 }] })),
    });
    const err = await failure(bad.clip('prj_0123456789', 'clp_0123456789'));
    expect(err.message).toMatch(
      /^rideo answered GET \/api\/projects\/prj_0123456789\/docs\/clips\/clp_0123456789\.json with an unexpected body \(shots\.0\.durationSec: /,
    );
    const html = new RideoClient({
      url: 'http://rideo.local',
      fetchImpl: async () => new Response('<html>hi</html>'),
    });
    expect((await failure(html.project('prj_0123456789'))).message).toContain('not JSON');
    // a proxy's HTML error page is summarized without its markup
    const proxy = new RideoClient({
      url: 'http://rideo.local',
      retries: 0,
      fetchImpl: async () =>
        new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 }),
    });
    expect((await failure(proxy.project('prj_0123456789'))).message).toBe(
      'rideo answered 502 to GET /api/projects/prj_0123456789/docs/project.json: 502 Bad Gateway',
    );
  });
});

describe('rideo client: retries', () => {
  it('retries 503 storage_offline and 429, honouring Retry-After, then answers', async () => {
    const { mock, fx, client, waits } = setup();
    mock.failNext({ path: /project\.json$/, status: 503, times: 2, retryAfter: '0' });
    mock.failNext({ path: /blocking$/, status: 429, times: 1, retryAfter: '2' });
    expect((await client.project(fx.ids.project)).id).toBe(fx.ids.project);
    expect((await client.blocking(fx.ids.project, fx.ids.clip)).state).toBe('ready');
    expect(waits).toEqual([0, 0, 2000]);
    expect(mock.requests.map((r) => r.status)).toEqual([503, 503, 200, 429, 200]);
  });

  it('backs off exponentially without Retry-After and gives up after the retries with the last answer', async () => {
    const { mock, fx, client, waits } = setup({ retries: 3 });
    mock.failNext({ path: /project\.json$/, status: 503, times: 10, detail: 'the browser is away' });
    const err = await failure(client.project(fx.ids.project));
    expect(waits).toEqual([DEFAULT_BACKOFF_MS, DEFAULT_BACKOFF_MS * 2, DEFAULT_BACKOFF_MS * 4]);
    expect(err.status).toBe(503);
    expect(err.message).toBe(
      `rideo answered 503 storage_offline to GET /api/projects/${fx.ids.project}/docs/project.json: the browser is away (the rideo project is kept in a browser with no tab open: open it in rideo and try again)`,
    );
    expect(mock.requests).toHaveLength(4);
  });

  it('does not retry other failures (409, 422)', async () => {
    const { mock, fx, client, waits } = setup();
    fx.data.clips.get(fx.ids.clip)!.status = 'approved';
    const err = await failure(client.putBlocking(fx.ids.project, fx.ids.clip, fx.blocking));
    expect(err.status).toBe(409);
    expect(err.message).toContain('clip 1 is approved; unapprove it to change its blocking');
    expect(mock.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('retries a network failure of a read, never of an upload (it may have been stored)', async () => {
    let calls = 0;
    const mock = new RideoMock();
    const fx = kiteFixture();
    mock.add(fx.data);
    const flaky: typeof fetch = async (input, init) => {
      if (++calls === 1) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      return mock.fetch(input as string, init);
    };
    const client = new RideoClient({
      url: 'http://rideo.local',
      fetchImpl: flaky,
      sleep: async () => undefined,
    });
    expect((await client.project(fx.ids.project)).id).toBe(fx.ids.project);
    expect(calls).toBe(2);
    calls = 0;
    const err = await failure(
      client.upload(fx.ids.project, {
        file: new Uint8Array([1, 2, 3]),
        filename: 'shot.mp4',
        name: 'shot',
        probe: { formatName: 'mov,mp4', durationSec: 1, hasVideo: true, hasAudio: false },
      }),
    );
    expect(calls).toBe(1);
    expect(err.status).toBeNull();
    expect(err.message).toBe(
      `rideo at http://rideo.local could not be reached for POST /api/projects/${fx.ids.project}/uploads: ECONNRESET`,
    );
  });

  it('times out a request that gets no answer, and stops when the caller goes away', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    const slow = new RideoClient({ url: 'http://rideo.local', fetchImpl: hang, timeoutMs: 30, retries: 0 });
    expect((await failure(slow.project('prj_0123456789'))).message).toBe(
      'rideo did not answer GET /api/projects/prj_0123456789/docs/project.json within 0 s',
    );
    const ctl = new AbortController();
    const stopped = new RideoClient({ url: 'http://rideo.local', fetchImpl: hang, signal: ctl.signal });
    const p = stopped.project('prj_0123456789');
    ctl.abort();
    expect((await failure(p)).message).toBe(
      'the request GET /api/projects/prj_0123456789/docs/project.json to rideo was stopped',
    );
  });

  it('reads Retry-After as seconds or a date, capped', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('1.5')).toBe(1500);
    expect(retryAfterMs('9999')).toBe(MAX_RETRY_AFTER_MS);
    const now = Date.parse('2026-11-13T10:00:00Z');
    expect(retryAfterMs('Fri, 13 Nov 2026 10:00:05 GMT', now)).toBe(5000);
    expect(retryAfterMs('Fri, 13 Nov 2026 09:00:00 GMT', now)).toBe(0);
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('rideo client: writes', () => {
  it('uploads a clip as multipart: the file as video/mp4, a JPEG poster, kind, role, name and meta {probe}', async () => {
    const { mock, fx, client } = setup();
    const probe = {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSec: 0.5,
      hasVideo: true,
      hasAudio: false,
      width: 160,
      height: 90,
      fps: 24,
      videoCodec: 'h264',
    };
    const res = await client.upload(fx.ids.project, {
      file: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]),
      filename: 'shot-01.mp4',
      poster: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      name: '3D previs: Shot 1 (motion)',
      probe,
    });
    expect(res).toMatchObject({
      kind: 'video',
      role: 'reference',
      status: 'ready',
      name: '3D previs: Shot 1 (motion)',
    });
    const up = mock.uploads[0];
    expect(up.status).toBe(201);
    expect(up.file).toMatchObject({ filename: 'shot-01.mp4', type: 'video/mp4' });
    expect([...up.file!.bytes]).toEqual([0, 0, 0, 24, 102, 116, 121, 112]);
    expect(up.poster).toMatchObject({ type: 'image/jpeg' });
    expect(up.fields).toMatchObject({ kind: 'video', role: 'reference', name: '3D previs: Shot 1 (motion)' });
    expect(JSON.parse(up.fields.meta)).toEqual({ probe });
    expect(fx.data.resources.get(res.id)?.media).toMatchObject({
      mime: 'video/mp4',
      fps: 24,
      width: 160,
      videoCodec: 'h264',
    });
  });

  it('PUTs the blocking with fix:false and PATCHes a shot with its reference and move', async () => {
    const { mock, fx, client } = setup();
    const view = await client.putBlocking(fx.ids.project, fx.ids.clip, fx.blocking);
    expect(view.state).toBe('ready');
    expect(mock.puts[0].body.fix).toBe(false);
    const res = await client.upload(fx.ids.project, {
      file: new Uint8Array([1]),
      filename: 'a.mp4',
      name: 'a',
      probe: { formatName: 'mov,mp4', durationSec: 0.5, hasVideo: true, hasAudio: false },
    });
    const clip = await client.patchShot(fx.ids.project, fx.ids.clip, fx.ids.s2, {
      motionReference: { resourceId: res.id, mode: 'camera' },
      camera: { framing: 'medium', movement: 'dolly_in', lensMm: 50, move: 'push_in' },
    });
    expect(clip.shots[1].motionReference).toEqual({ resourceId: res.id, mode: 'camera' });
    expect(mock.patches[0].body).toEqual({
      motionReference: { resourceId: res.id, mode: 'camera' },
      camera: { framing: 'medium', movement: 'dolly_in', lensMm: 50, move: 'push_in' },
    });
  });

  it("the mock merges a PATCH's camera as rideo does: CameraSchema.partial() defaults what is left out", async () => {
    // rideo's ShotUpdateInputSchema parses the camera with CameraSchema.partial(), which in zod 4
    // still fills framing and movement in: a camera of {move} alone resets them (the reason the push
    // sends a shot's whole camera)
    const { fx, client } = setup();
    const clip = await client.patchShot(fx.ids.project, fx.ids.clip, fx.ids.s1, {
      camera: { move: 'locked_off' } as never,
    });
    expect(clip.shots[0].camera).toMatchObject({
      framing: 'medium',
      movement: 'static',
      lensMm: 24,
      move: 'locked_off',
    });
  });

  it('reads the video models and their limits from /api/config', async () => {
    const { mock, client } = setup();
    mock.setVideoModels([{ id: 'vid-a', limits: { min_duration_seconds: 3, max_duration_seconds: 8 } }]);
    const config = await client.config();
    expect(config.models.video).toEqual([
      { id: 'vid-a', limits: { min_duration_seconds: 3, max_duration_seconds: 8 } },
    ]);
  });
});

describe('rideo base URL', () => {
  it('keeps the origin and subpath, drops trailing slashes and a trailing /api', () => {
    expect(rideoBaseUrl('https://rideo.example')).toBe('https://rideo.example');
    expect(rideoBaseUrl('https://rideo.example/api/')).toBe('https://rideo.example');
    expect(rideoBaseUrl('http://10.0.0.5:8080/rideo/')).toBe('http://10.0.0.5:8080/rideo');
    expect(rideoBaseUrl(' https://rideo.example/rideo/api ')).toBe('https://rideo.example/rideo');
  });

  it('refuses other schemes, credentials in the URL and non-URLs', () => {
    for (const url of ['ftp://rideo.example', 'https://user:pw@rideo.example', 'rideo.example', ''])
      expect(() => rideoBaseUrl(url), url).toThrow(ToolError);
  });
});
