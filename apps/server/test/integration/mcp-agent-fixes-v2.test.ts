import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decodePNG } from '@3d-editor/core';
import { sharedRenderer } from '../../src/render';
import { evaluationStats } from '../../src/mcp/eval-cache';
import { api, eventually, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

/*
 * Regression tests for the second round of problems AI agents logged while building the example
 * projects through MCP (phase 3, /tmp/phase3/*-issues-v2.json) and the server leftovers: strict tool
 * arguments, export download links, browser path tracing, operator error codes, wire curve bounds
 * and curve settings, render vs viewport geometry counts, cached evaluations, per-frame samples of
 * path traced animations, named degenerate triangles and transparent film in raster renders.
 */

let server: TestServer;
let client: Client;
const syncClients: SyncTestClient[] = [];
process.env.RENDER_WORKERS = '2';

type Content = {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: any;
  uri?: string;
};
type ToolResult = { content: Content[]; isError?: boolean };

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(name: string, args: Record<string, unknown> = {}) {
  const raw = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })) as ToolResult;
  const text = raw.content.find((x) => x.type === 'text')?.text;
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  return { raw, json, text: raw.content.map((x) => x.text ?? '').join('\n') };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  if (r.raw.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.json;
}

async function fails(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await call(name, args);
  expect(r.raw.isError, `${name} should fail: ${r.text}`).toBe(true);
  return r.text;
}

/** The JSON details after the first line of a failed run_operator / batch / edit_mesh result. */
function details(text: string): any {
  return JSON.parse(text.slice(text.indexOf('\n') + 1));
}

const op = (project: string, operator: string, params: Record<string, unknown> = {}, selection?: unknown) =>
  ok('run_operator', { project, operator, params, ...(selection ? { selection } : {}) });

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'fix-agent-v2', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  for (const c of syncClients) await c.destroy();
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('MCP fixes for agents (round 2)', () => {
  it('rejects unknown and misspelled tool arguments with suggestions (lighthouse-cove v2 #0)', async () => {
    const { id } = await ok('create_project', { name: 'Strict' });
    const settings = await fails('set_scene_settings', { project: id, sampels: 7 });
    expect(settings).toMatch(/unknown argument 'sampels' \(did you mean 'samples'\?\)/);
    expect(settings).toMatch(/Valid arguments: project, frame_start, frame_end/);
    expect((await ok('get_scene', { project: id })).render.samples).toBe(64);

    expect(
      await fails('set_material', { project: id, object: 'Cube', name: 'Y', base_colour: [1, 0, 0, 1] }),
    ).toMatch(/'base_colour' \(did you mean 'base_color'\?\)/);
    expect(
      await fails('set_material', { project: id, object: 'Cube', name: 'Y', emission_strenght: 5 }),
    ).toMatch(/'emission_strenght' \(did you mean 'emission_strength'/);
    expect(await fails('add_object', { project: id, type: 'cube', name: 'RT', rotaton: [1, 0, 0] })).toMatch(
      /'rotaton' \(did you mean 'rotation'/,
    );
    expect(
      await fails('add_modifier', { project: id, object: 'Cube', type: 'SUBSURF', parms: { levels: 1 } }),
    ).toMatch(/'parms' \(did you mean 'params'\?\)/);
    expect(
      await fails('run_operator', { project: id, operator: 'object.empty_add', parmas: { name: 'E' } }),
    ).toMatch(/'parmas' \(did you mean 'params'\?\)/);
    // operator parameters given as tool arguments: told where they belong
    expect(await fails('run_operator', { project: id, operator: 'object.empty_add', name: 'E' })).toMatch(
      /unknown argument 'name'.*Operator parameters go inside `params`/s,
    );
    expect(await fails('render_image', { project: id, sampels: 4 })).toMatch(/did you mean 'samples'/);
    expect(await fails('get_object', { project: id, object: 'Cube', frmae: 3 })).toMatch(
      /did you mean 'frame'/,
    );
    expect(await fails('get_scene', { project: id, fram: 3 })).toMatch(/did you mean 'frame'/);
    expect(await fails('list_projects', { verbose: true })).toMatch(/unknown argument 'verbose'/);

    // nested argument objects are strict too
    expect(
      await fails('render_image', {
        project: id,
        view: { position: [5, -5, 3], target: [0, 0, 0], fov: 40 },
      }),
    ).toMatch(/unknown key 'fov' \(did you mean [^)]*'fov_degrees'\?\).* at view/s);
    expect(await fails('render_image', { project: id, position: [5, -5, 3] })).toMatch(
      /'position' goes inside 'view'/,
    );
    expect(
      await fails('batch', { project: id, operations: [{ operator: 'object.empty_add', parms: {} }] }),
    ).toMatch(/unknown key 'parms' \(did you mean 'params'\?\).* at operations\[0\]/s);
    expect(
      await fails('run_operator', {
        project: id,
        operator: 'object.select_all',
        selection: { object: ['Cube'] },
      }),
    ).toMatch(/unknown key 'object' \(did you mean 'objects'/);
    expect(
      await fails('edit_mesh', {
        project: id,
        object: 'Cube',
        operator: 'mesh.subdivide',
        selection: { face: [0] },
      }),
    ).toMatch(/unknown key 'face' \(did you mean 'faces'/);

    // the rejected calls changed nothing
    const names = (await ok('get_scene', { project: id })).objects.map((o: any) => o.name);
    expect([...names].sort()).toEqual(['Camera', 'Cube', 'Light']);
    expect((await ok('get_scene', { project: id })).materials.map((m: any) => m.name)).not.toContain('Y');
  });

  it('publishes closed input schemas for every tool', async () => {
    const { tools } = await client.listTools();
    const open: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`));
      const n = node as Record<string, unknown>;
      if (n.type === 'object' && n.properties && n.additionalProperties !== false) open.push(at);
      for (const [k, v] of Object.entries(n)) walk(v, `${at}.${k}`);
    };
    for (const t of tools) walk(t.inputSchema, t.name);
    expect(tools.length).toBeGreaterThan(20);
    expect(open).toEqual([]);
  });

  it('passes operator error codes through run_operator, batch and edit_mesh (leftovers #21)', async () => {
    const { id } = await ok('create_project', { name: 'Codes' });
    const invalid = await fails('run_operator', {
      project: id,
      operator: 'mesh.primitive_cylinder_add',
      params: { raduis: 2 },
    });
    expect(details(invalid)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(details(invalid).error).toMatch(/did you mean 'radius'/);
    const poll = await fails('run_operator', { project: id, operator: 'mesh.subdivide' });
    expect(details(poll)).toMatchObject({ ok: false, code: 'POLL_FAILED' });
    const missing = await fails('run_operator', {
      project: id,
      operator: 'object.constraint_add',
      params: { type: 'TRACK_TO', target: 'Nope' },
      selection: { objects: ['Cube'] },
    });
    expect(details(missing)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    const unknown = await fails('run_operator', { project: id, operator: 'mesh.primitive_cylindr_add' });
    expect(unknown).toMatch(/Did you mean: mesh.primitive_cylinder_add/);
    expect(details(unknown)).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const batch = await fails('batch', {
      project: id,
      stop_on_error: false,
      operations: [
        { operator: 'mesh.primitive_cube_add', params: { size: 1 } },
        { operator: 'mesh.primitive_cube_add', params: { sise: 1 } },
        { operator: 'mesh.subdivide' },
        { operator: 'nope.op' },
        { operator: 'render.render_software', params: {} },
      ],
    });
    expect(details(batch).results.map((r: any) => r.code ?? null)).toEqual([
      null,
      'INVALID_PARAMS',
      'POLL_FAILED',
      'NOT_FOUND',
      'FAILED',
    ]);

    const edit = await fails('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.extrude_region_move',
      params: { valeu: [0, 0, 1] },
    });
    expect(details(edit)).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
  });

  it('gives wire curves real bounds and reports the curve shape settings (leftovers #3)', async () => {
    const { id } = await ok('create_project', { name: 'Wires', empty: true });
    await op(id, 'curve.add_from_points', {
      name: 'W',
      points: [
        [0, 0, 0],
        [1, 0, 2],
      ],
      type: 'POLY',
      dimensions: '3D',
      location: [5, 5, 0],
    });
    const wire = await ok('get_object', { project: id, object: 'W' });
    expect(wire.world_bounds).toMatchObject({ min: [5, 5, 0], max: [6, 5, 2], size: [1, 0, 2] });
    expect(wire.data.evaluated).toMatch(/^wire/);
    expect(wire.data.wire_edges).toBe(1);
    // an ARRAY modifier keeps the wire (edges only): the bounds follow the repeated wire
    await ok('add_modifier', {
      project: id,
      object: 'W',
      type: 'ARRAY',
      params: { count: 3, relative_offset_displace: [1, 0, 0] },
    });
    const arrayed = await ok('get_object', { project: id, object: 'W' });
    expect(arrayed.world_bounds.size[0]).toBeCloseTo(3, 4);

    await op(id, 'curve.add_from_points', {
      name: 'Gutter',
      points: [
        [0, 0, 0],
        [2, 0, 0],
      ],
      type: 'POLY',
      dimensions: '3D',
    });
    await op(id, 'curve.properties_set', { object: 'Gutter', bevel_depth: 0.1, fill_mode: 'HALF' });
    const gutter = await ok('get_object', { project: id, object: 'Gutter' });
    expect(gutter.data).toMatchObject({
      fill_mode: 'HALF',
      bevel_mode: 'ROUND',
      bevel_depth: 0.1,
      bevel_factor: [0, 1],
      twist_mode: 'MINIMUM',
      use_fill_caps: false,
      resolution_u: 12,
      render_resolution_u: 0,
      extrude: 0,
      offset: 0,
    });
    const listed = (await ok('get_scene', { project: id })).objects.find((o: any) => o.name === 'Gutter');
    expect(listed.data.fill_mode).toBe('HALF');
  });

  it('counts the geometry renders show, with the viewport counts where they differ (product-shot v2 #0)', async () => {
    const { id } = await ok('create_project', { name: 'Lathe', empty: true });
    await op(id, 'curve.add_from_points', {
      name: 'Profile',
      points: [
        [0, 0, 0],
        [0.03, 0, 0],
        [0.03, 0, 0.08],
        [0.01, 0, 0.09],
        [0.01, 0, 0.1],
        [0, 0, 0.1],
      ],
      type: 'POLY',
      dimensions: '3D',
    });
    await ok('add_modifier', {
      project: id,
      object: 'Profile',
      type: 'SCREW',
      params: { steps: 8, angle: 6.283185, axis: 'Z' },
    });
    const render = await ok('get_mesh_data', {
      project: id,
      object: 'Profile',
      source: 'RENDER',
      include: ['vertices'],
      limit: 1,
    });
    const profile = await ok('get_object', { project: id, object: 'Profile' });
    // render_steps stays 16 (Blender): renders show 16 steps, the viewport 8
    expect(profile.data.evaluated.vertices).toBe(render.totals.vertices);
    expect(profile.data.evaluated.vertices).toBe(96);
    expect(profile.data.evaluated_viewport.vertices).toBe(48);
    const scene = await ok('get_scene', { project: id });
    expect(scene.counts.evaluated.vertices).toBe(96);
    expect(scene.counts.evaluated_viewport.vertices).toBe(48);
    // matching settings: no viewport counts
    await ok('update_modifier', {
      project: id,
      object: 'Profile',
      modifier: 'Screw',
      params: { render_steps: 8 },
    });
    const same = await ok('get_object', { project: id, object: 'Profile' });
    expect(same.data.evaluated.vertices).toBe(48);
    expect(same.data.evaluated_viewport).toBeUndefined();
    expect((await ok('get_scene', { project: id })).counts.evaluated_viewport).toBeUndefined();
  });

  it('evaluates a scene once per state and frame for repeated inspections (clockwork-orrery v2 #2)', async () => {
    const { id } = await ok('create_project', { name: 'Orrery' });
    await ok('insert_keyframe', {
      project: id,
      object: 'Cube',
      property: 'location',
      frame: 1,
      value: [0, 0, 0],
    });
    await ok('insert_keyframe', {
      project: id,
      object: 'Cube',
      property: 'location',
      frame: 25,
      value: [4, 0, 0],
    });
    const scene = server.handle.rooms.get(id)!.scene;
    await ok('get_object', { project: id, object: 'Cube', frame: 13 });
    const before = evaluationStats(scene);
    for (let i = 0; i < 6; i++) {
      for (const object of ['Cube', 'Camera', 'Light'])
        await ok('get_object', { project: id, object, frame: 13 });
      await ok('get_scene', { project: id, frame: 13 });
    }
    const after = evaluationStats(scene);
    expect(after.misses).toBe(before.misses);
    expect(after.hits).toBeGreaterThanOrEqual(before.hits + 24);
    // another frame and a changed scene are evaluated again
    expect((await ok('get_object', { project: id, object: 'Cube', frame: 25 })).location).toEqual([4, 0, 0]);
    await ok('transform_object', { project: id, object: 'Camera', location: [1, 1, 1] });
    expect((await ok('get_object', { project: id, object: 'Camera', frame: 13 })).location).toEqual([
      1, 1, 1,
    ]);
    expect(evaluationStats(scene).misses).toBeGreaterThan(after.misses + 1);
  });

  it('export_scene links reproduce the exported options (leftovers #19)', async () => {
    const { id } = await ok('create_project', { name: 'Export link' });
    await ok('insert_keyframe', {
      project: id,
      object: 'Cube',
      property: 'location',
      frame: 1,
      value: [0, 0, 0],
    });
    await ok('insert_keyframe', {
      project: id,
      object: 'Cube',
      property: 'location',
      frame: 11,
      value: [0, 0, 5],
    });
    await ok('add_modifier', {
      project: id,
      object: 'Cube',
      type: 'SUBSURF',
      params: { levels: 1, render_levels: 1 },
    });
    const res = await call('export_scene', {
      project: id,
      format: 'obj',
      objects: ['Cube'],
      apply_modifiers: false,
      frame: 11,
    });
    expect(res.raw.isError).toBeFalsy();
    const info = JSON.parse(res.raw.content[0].text!);
    expect(info).toMatchObject({ format: 'obj', frame: 11, objects: ['Cube'], apply_modifiers: false });
    const url = new URL(info.download_url);
    expect(url.searchParams.get('format')).toBe('obj');
    expect(url.searchParams.get('frame')).toBe('11');
    expect(url.searchParams.get('apply_modifiers')).toBe('false');
    expect(url.searchParams.get('objects')).toBeTruthy();
    const embedded = Buffer.from(res.raw.content.find((c) => c.type === 'resource')!.resource.blob, 'base64');
    const download = Buffer.from(await (await fetch(info.download_url)).arrayBuffer());
    expect(download.equals(embedded)).toBe(true);
    // what the link holds: the cube only, unmodified (8 vertices), at frame 11 (z up to 6)
    const text = download.toString('utf8');
    const vertices = text.split('\n').filter((l) => l.startsWith('v '));
    expect(vertices).toHaveLength(8);
    expect(Math.max(...vertices.map((l) => Number(l.split(/\s+/)[2])))).toBeCloseTo(6, 3);
    expect(text).not.toMatch(/Camera|Light/);
    // without options the link exports every object with modifiers applied, at the agent's frame
    const all = await ok('export_scene', { project: id, format: 'obj' });
    expect(all).toMatchObject({ objects: 'all', apply_modifiers: true, frame: 1 });
    expect(new URL(all.download_url).searchParams.get('objects')).toBeNull();
    expect(new URL(all.download_url).searchParams.get('apply_modifiers')).toBeNull();
    expect((await api(server.url, `/api/projects/${id}/export?format=obj&objects=Nope`)).body.error).toMatch(
      /objects not found: Nope/,
    );
  });

  it('path traces through a browser editor with renderer browser (leftovers #20)', async () => {
    const { id } = await ok('create_project', { name: 'Browser PT' });
    const browser = new SyncTestClient({
      baseUrl: server.url,
      projectId: id,
      name: 'Browser',
      capabilities: ['render', 'ui'],
      rpcHandler: (method, params) => {
        if (method !== 'render') throw new Error('unknown');
        const p = params as Record<string, number>;
        return { mime: 'image/png', data_base64: TINY_PNG, width: p.width, height: p.height };
      },
    });
    syncClients.push(browser);
    await browser.connect();
    await eventually(() => server.handle.rooms.get(id)?.rpcCandidates('render').length === 1);
    const r = await call('render_image', {
      project: id,
      renderer: 'browser',
      engine: 'PATHTRACER',
      width: 64,
      height: 48,
      samples: 12,
      max_bounces: 3,
      denoise: false,
      time_limit: 7,
      seed: 5,
    });
    expect(r.raw.isError, r.text).toBeFalsy();
    const info = JSON.parse(r.raw.content.find((c) => c.type === 'text')!.text!);
    expect(info).toMatchObject({
      renderer: 'browser',
      engine: 'PATHTRACER',
      requested_samples: 12,
      time_limit: 7,
    });
    expect(browser.rpcRequests.at(-1)).toMatchObject({
      method: 'render',
      params: {
        width: 64,
        height: 48,
        engine: 'PATHTRACER',
        samples: 12,
        max_bounces: 3,
        denoise: false,
        time_limit: 7,
        seed: 5,
      },
    });
    // RASTER stays a raster request; auto still path traces on the server
    await ok('render_image', { project: id, renderer: 'browser', engine: 'RASTER', width: 32, height: 24 });
    expect(browser.rpcRequests.at(-1)?.params).toMatchObject({ engine: 'RASTER' });
  });

  it('reports the samples each path traced animation frame reached (lighthouse-cove v2 #7, robot-workcell v2 #2)', async () => {
    const { id } = await ok('create_project', { name: 'Samples' });
    const res = await call('render_animation', {
      project: id,
      format: 'CONTACT_SHEET',
      engine: 'PATHTRACER',
      frame_start: 1,
      frame_end: 3,
      width: 24,
      height: 16,
      samples: 4,
      time_limit: 120,
    });
    expect(res.raw.isError, res.text).toBeFalsy();
    const info = JSON.parse(res.raw.content.find((c) => c.type === 'text')!.text!);
    expect(info.requested_samples).toBe(4);
    expect(info.frame_samples).toEqual([4, 4, 4]);
    expect(info.samples_reached).toEqual({ min: 4, mean: 4, max: 4 });
    expect(info.undersampled_frames).toBeUndefined();
    // rasterized animations have no sample counts
    const raster = await call('render_animation', {
      project: id,
      engine: 'RASTER',
      frame_start: 1,
      frame_end: 2,
      width: 24,
      height: 16,
    });
    const rinfo = JSON.parse(raster.raw.content.find((c) => c.type === 'text')!.text!);
    expect(rinfo.frame_samples).toBeUndefined();
  });

  it('names the objects with degenerate triangles in path tracer warnings (clockwork-orrery v2 #0)', async () => {
    const { id } = await ok('create_project', { name: 'Degenerate' });
    await ok('create_mesh', {
      project: id,
      name: 'Motto Plate',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
        [0, 1, 0],
      ],
      faces: [
        [0, 1, 2],
        [0, 1, 3],
      ],
    });
    const still = await call('render_image', {
      project: id,
      engine: 'PATHTRACER',
      width: 32,
      height: 24,
      samples: 1,
      time_limit: 20,
    });
    const info = JSON.parse(still.raw.content.find((c) => c.type === 'text')!.text!);
    expect(info.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^1 degenerate triangle\(s\) skipped .*'Motto Plate' 1$/),
      ]),
    );
    const anim = await call('render_animation', {
      project: id,
      engine: 'PATHTRACER',
      frame_start: 1,
      frame_end: 4,
      width: 24,
      height: 16,
      samples: 1,
    });
    const ainfo = JSON.parse(anim.raw.content.find((c) => c.type === 'text')!.text!);
    expect(ainfo.warnings).toEqual([expect.stringMatching(/'Motto Plate' 1$/)]);
  });

  it('keeps Film > Transparent in server raster renders (leftovers #8)', async () => {
    const { id } = await ok('create_project', { name: 'Transparent' });
    await ok('set_scene_settings', { project: id, film_transparent: true });
    const res = await call('render_image', {
      project: id,
      engine: 'RASTER',
      renderer: 'software',
      width: 64,
      height: 48,
    });
    expect(res.raw.isError, res.text).toBeFalsy();
    const png = decodePNG(Buffer.from(res.raw.content.find((c) => c.type === 'image')!.data!, 'base64'));
    expect(png.data[3]).toBe(0); // the top-left corner shows no object: transparent
    const centre = ((png.height >> 1) * png.width + (png.width >> 1)) * 4;
    expect(png.data[centre + 3]).toBe(255); // the cube
    // an opaque film keeps the world colour
    await ok('set_scene_settings', { project: id, film_transparent: false });
    const opaque = await call('render_image', {
      project: id,
      engine: 'RASTER',
      renderer: 'software',
      width: 64,
      height: 48,
    });
    const img = decodePNG(Buffer.from(opaque.raw.content.find((c) => c.type === 'image')!.data!, 'base64'));
    expect(img.data[3]).toBe(255);
  });

  it('the presence drops objects that undo removed (product-shot v2 #3)', async () => {
    const { id } = await ok('create_project', { name: 'Presence after undo', empty: true });
    await ok('add_object', { project: id, type: 'cube', name: 'A' });
    const me = async () =>
      (await ok('get_connected_clients', { project: id })).presence.find((e: any) => e.you);
    expect((await me()).selection).toEqual(['A']);
    expect((await ok('undo', { project: id })).undone).toBe(1);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(0);
    // the presence others see no longer selects the removed cube (it showed its raw id before)
    const after = await me();
    expect(after.selection).toEqual([]);
    expect(after.active).toBeNull();
    const r = await ok('run_operator', { project: id, operator: 'scene.stats', params: {} });
    expect(r.selection).toMatchObject({ selected: [], active: null });
    expect((await me()).selection).toEqual([]);
    // redo brings the cube back, unselected
    expect((await ok('redo', { project: id })).redone).toBe(1);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(1);
    expect((await me()).selection).toEqual([]);
  });

  it('scripts/mcp.mjs tools <filter> lists the arguments of the tools (robot-workcell v2 #3)', async () => {
    const run = promisify(execFile);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const cli = (...args: string[]) =>
      run(process.execPath, [path.join(root, 'scripts', 'mcp.mjs'), 'tools', ...args], {
        cwd: root,
        env: { ...process.env, MCP_URL: `${server.url}/mcp` },
        timeout: 60_000,
      }).then((r) => r.stdout);
    const text = await cli('render_animation');
    expect(text).toMatch(/^render_animation\n {2}Render a range of frames/);
    // every argument with its type, default and range: what an agent needs to call the tool
    expect(text).toContain(
      'dither ("FLOYD_STEINBERG" | "BAYER" | "NONE", optional, default "FLOYD_STEINBERG")',
    );
    expect(text).toMatch(/frame_time_limit \(number, optional, range 0\.1\.\.600\): PATHTRACER/);
    expect(text).toContain('animated_seed (boolean, optional, default false)');
    // nested arguments
    expect(await cli('render_image')).toMatch(/\n {6}position \(\[number, number, number\], required\)/);
    // the input schemas as JSON
    const schemas = JSON.parse(await cli('undo', '--json'));
    expect(schemas).toEqual([
      expect.objectContaining({ name: 'undo', inputSchema: expect.objectContaining({ type: 'object' }) }),
    ]);
    expect(Object.keys(schemas[0].inputSchema.properties)).toEqual(['project', 'steps']);
    // without a filter: one line per tool
    const list = (await cli()).trim().split('\n');
    expect(list.length).toBeGreaterThan(30);
    expect(list.every((l) => /^[a-z_]+: /.test(l))).toBe(true);
  });
});
