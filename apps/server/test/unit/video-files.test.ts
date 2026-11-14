import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFoundError, ToolError } from '../../src/mcp/agent';
import { registerVideoExportRoutes, sendExportFile } from '../../src/api/video-exports';
import type { ServerServices } from '../../src/services';
import type { ExportFileRef, ExportJob } from '../../src/video';
import { contentTypeOf, etagMatches, etagOf, parseRange } from '../../src/video/files';

/*
 * Serving export files (media types, ETags, single byte ranges, 304/206/416, HEAD) and the REST
 * routes of video exports with their error codes (against a stub export service).
 */

describe('ranges and validators', () => {
  it('parses single byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=90-1000', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-1000', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange(' bytes = 5 - 5 ', 100)).toEqual({ start: 5, end: 5 });
    // unsatisfiable: past the end, empty suffix, empty file
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    // not a usable single range: the whole file
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
    expect(parseRange('bytes=-', 100)).toBeNull();
    expect(parseRange('bytes=9-3', 100)).toBeNull();
  });

  it('matches ETags (weak comparison, lists, *)', () => {
    const etag = etagOf('abc');
    expect(etag).toBe('"abc"');
    expect(etagMatches('"abc"', etag)).toBe(true);
    expect(etagMatches('W/"abc"', etag)).toBe(true);
    expect(etagMatches('"x", "abc"', etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('"abd"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });

  it('names media types by extension', () => {
    expect(contentTypeOf('a.mp4')).toBe('video/mp4');
    expect(contentTypeOf('a.depth.MP4')).toBe('video/mp4');
    expect(contentTypeOf('a.webm')).toBe('video/webm');
    expect(contentTypeOf('a.mask.mkv')).toBe('video/x-matroska');
    expect(contentTypeOf('p.png')).toBe('image/png');
    expect(contentTypeOf('p.jpg')).toBe('image/jpeg');
    expect(contentTypeOf('manifest.json')).toBe('application/json');
    expect(contentTypeOf('notes')).toBe('application/octet-stream');
  });
});

describe('REST routes', () => {
  let app: FastifyInstance;
  let file: ExportFileRef;
  const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const calls: { op: string; args: unknown[] }[] = [];
  const job = (patch: Partial<ExportJob> = {}): ExportJob => ({
    id: 'job1',
    project: 'p1',
    label: null,
    status: 'queued',
    params: {} as ExportJob['params'],
    created_at: '2026-11-13T10:00:00.000Z',
    started_at: null,
    finished_at: null,
    progress: { frames_done: 0, frames_total: 24, fraction: 0, fps: 0, eta_s: 5, shot: null },
    error: null,
    warnings: [],
    files: [],
    ...patch,
  });
  let failWith: Error | null = null;

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'video-files-'));
    const full = path.join(dir, 'shot-01.mp4');
    await writeFile(full, body);
    file = { path: full, bytes: body.length, contentType: 'video/mp4', etag: '"e1"' };
    const exports = {
      async start(id: string, params: unknown) {
        calls.push({ op: 'start', args: [id, params] });
        if (failWith) throw failWith;
        return job({ project: id });
      },
      async list(id: string) {
        calls.push({ op: 'list', args: [id] });
        return [job()];
      },
      async status(id: string, opts: unknown) {
        calls.push({ op: 'status', args: [id, opts] });
        if (id !== 'job1') throw new NotFoundError(`Video export '${id}' not found`);
        return job({ status: 'running' });
      },
      async file(id: string, name: string, opts: { project: string }) {
        calls.push({ op: 'file', args: [id, name, opts] });
        if (name !== 'shot-01.mp4') throw new NotFoundError(`no file '${name}'`);
        return file;
      },
      async cancel(id: string, opts: unknown) {
        calls.push({ op: 'cancel', args: [id, opts] });
        return job({ status: 'cancelled' });
      },
    };
    app = Fastify();
    registerVideoExportRoutes(app, { exports } as unknown as ServerServices);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const fileUrl = '/api/projects/p1/video-exports/job1/files/shot-01.mp4';

  it('serves a whole file with its validators', async () => {
    const r = await app.inject({ method: 'GET', url: fileUrl });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(body)).toBe(true);
    expect(r.headers['content-type']).toBe('video/mp4');
    expect(r.headers['content-length']).toBe('1000');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers.etag).toBe('"e1"');
    expect(r.headers['content-disposition']).toBe('inline; filename="shot-01.mp4"');
    expect(calls.find((c) => c.op === 'file')?.args).toEqual(['job1', 'shot-01.mp4', { project: 'p1' }]);
  });

  it('answers byte ranges with 206, suffix ranges and 416', async () => {
    const r = await app.inject({ method: 'GET', url: fileUrl, headers: { range: 'bytes=10-19' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 10-19/1000');
    expect(r.headers['content-length']).toBe('10');
    expect(r.rawPayload.equals(body.subarray(10, 20))).toBe(true);
    const tail = await app.inject({ method: 'GET', url: fileUrl, headers: { range: 'bytes=-4' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe('bytes 996-999/1000');
    expect(tail.rawPayload.equals(body.subarray(996))).toBe(true);
    const bad = await app.inject({ method: 'GET', url: fileUrl, headers: { range: 'bytes=5000-' } });
    expect(bad.statusCode).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */1000');
    // several ranges: the whole file
    const multi = await app.inject({ method: 'GET', url: fileUrl, headers: { range: 'bytes=0-1,4-5' } });
    expect(multi.statusCode).toBe(200);
    expect(multi.rawPayload.length).toBe(1000);
  });

  it('answers 304 for a matching If-None-Match and ignores ranges of another version (If-Range)', async () => {
    const r = await app.inject({ method: 'GET', url: fileUrl, headers: { 'if-none-match': '"e1"' } });
    expect(r.statusCode).toBe(304);
    expect(r.rawPayload.length).toBe(0);
    const same = await app.inject({
      method: 'GET',
      url: fileUrl,
      headers: { range: 'bytes=0-1', 'if-range': '"e1"' },
    });
    expect(same.statusCode).toBe(206);
    const other = await app.inject({
      method: 'GET',
      url: fileUrl,
      headers: { range: 'bytes=0-1', 'if-range': '"old"' },
    });
    expect(other.statusCode).toBe(200);
    expect(other.rawPayload.length).toBe(1000);
  });

  it('answers HEAD with the headers only', async () => {
    const r = await app.inject({ method: 'HEAD', url: fileUrl });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe('1000');
    expect(r.rawPayload.length).toBe(0);
    const ranged = await app.inject({ method: 'HEAD', url: fileUrl, headers: { range: 'bytes=0-99' } });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-length']).toBe('100');
  });

  it('starts, lists, polls and cancels exports', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/video-exports',
      payload: { width: 160, height: 90 },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json()).toMatchObject({ id: 'job1', status: 'queued' });
    const started = calls.filter((c) => c.op === 'start').at(-1)!;
    expect(started.args[0]).toBe('p1');
    expect(started.args[1]).toMatchObject({
      width: 160,
      height: 90,
      quality: 'standard',
      passes: ['beauty'],
    });
    const list = await app.inject({ method: 'GET', url: '/api/projects/p1/video-exports' });
    expect(list.json().exports).toHaveLength(1);
    const poll = await app.inject({ method: 'GET', url: '/api/projects/p1/video-exports/job1?wait=2' });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().status).toBe('running');
    const statusArgs = calls.filter((c) => c.op === 'status').at(-1)!.args;
    expect(statusArgs[0]).toBe('job1');
    expect(statusArgs[1]).toMatchObject({ project: 'p1', waitS: 2 });
    const del = await app.inject({ method: 'DELETE', url: '/api/projects/p1/video-exports/job1' });
    expect(del.json().status).toBe('cancelled');
    expect(calls.filter((c) => c.op === 'cancel').at(-1)!.args).toEqual([
      'job1',
      { project: 'p1', deleteFiles: true },
    ]);
  });

  it('answers bad requests and service errors with their codes', async () => {
    const odd = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/video-exports',
      payload: { width: 161 },
    });
    expect(odd.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/video-exports',
      payload: { bogus: 1 },
    });
    expect(unknown.statusCode).toBe(400);
    const wait = await app.inject({ method: 'GET', url: '/api/projects/p1/video-exports/job1?wait=99' });
    expect(wait.statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/api/projects/p1/video-exports/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('NOT_FOUND');
    const noFile = await app.inject({
      method: 'GET',
      url: '/api/projects/p1/video-exports/job1/files/x.mp4',
    });
    expect(noFile.statusCode).toBe(404);
    for (const [err, status] of [
      [new ToolError('Video export needs ffmpeg', 'FFMPEG_UNAVAILABLE'), 503],
      [new ToolError('renders on the main thread', 'UNAVAILABLE'), 503],
      [new ToolError('2 video exports are already waiting', 'QUEUE_FULL'), 409],
      [new ToolError('bad shot', 'INVALID_PARAMS'), 400],
    ] as const) {
      failWith = err;
      const r = await app.inject({ method: 'POST', url: '/api/projects/p1/video-exports', payload: {} });
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual({ error: err.message, code: err.code });
    }
    failWith = null;
  });

  it('sends empty files without a body', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'video-files-empty-'));
    const empty = path.join(dir, 'empty.json');
    await writeFile(empty, '');
    const local = Fastify();
    local.get('/f', (req, reply) =>
      sendExportFile(req, reply, { path: empty, bytes: 0, contentType: 'application/json', etag: '"0"' }),
    );
    const r = await local.inject({ method: 'GET', url: '/f' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-length']).toBe('0');
    await local.close();
  });
});
