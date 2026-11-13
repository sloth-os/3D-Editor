import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sharedRenderer } from '../../src/render';
import { api, eventually, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

/*
 * Regression tests for the last round of server fixes (phase 3c issues and verifier notes):
 * get_scene counts only geometry shown in renders (objects with hide_render are counted apart),
 * get_object keeps sub-millimetre precision, project names stay unique through the REST API too,
 * editor_command checks its parameters, a selection that fails changes nothing, and modifier
 * visibility given inside `params` points to the tool argument.
 */

let server: TestServer;
let client: Client;
const syncClients: SyncTestClient[] = [];

type ToolResult = {
  content: { type: string; text?: string; resource?: { blob?: string; mimeType?: string } }[];
  isError?: boolean;
};

async function call(name: string, args: Record<string, unknown> = {}) {
  const raw = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })) as ToolResult;
  const text = raw.content.map((x) => x.text ?? '').join('\n');
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // text: an error message, or text followed by details
  }
  return { raw, json, text };
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

const op = (project: string, operator: string, params: Record<string, unknown> = {}) =>
  ok('run_operator', { project, operator, params });

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'final-fixes-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await Promise.all(syncClients.map((c) => c.destroy()));
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('get_scene counts the geometry renders show', () => {
  it('leaves objects hidden from renders (a Boolean cutter) out of counts.evaluated, like the exporters (clockwork-orrery #3)', async () => {
    const { id } = await ok('create_project', { name: 'Render counts', empty: true });
    await ok('add_object', { project: id, type: 'cube', name: 'Body' });
    await ok('add_object', {
      project: id,
      type: 'cube',
      name: 'Cutter',
      location: [1, 0, 1],
      params: { size: 1 },
    });
    await ok('add_modifier', {
      project: id,
      object: 'Body',
      type: 'BOOLEAN',
      params: { operation: 'DIFFERENCE', object: 'Cutter' },
    });
    // the cutter is only the Boolean operand: hidden in renders and in the viewport
    await op(id, 'data.set_property', {
      kind: 'objects',
      target: 'Cutter',
      values: { hide_render: true, hide_viewport: true },
    });
    const body = await ok('get_object', { project: id, object: 'Body' });
    const cutter = await ok('get_object', { project: id, object: 'Cutter' });
    // without modifiers a mesh's statistics are its evaluated geometry
    expect(cutter.data).toMatchObject({ vertices: 8, faces: 6, triangles: 12 });
    const { vertices, faces, triangles } = body.data.evaluated;
    const rendered = { vertices, faces, triangles };
    const scene = await ok('get_scene', { project: id });
    expect(scene.counts.evaluated).toEqual(rendered);
    expect(scene.counts.not_rendered).toEqual({ objects: ['Cutter'], vertices: 8, faces: 6, triangles: 12 });
    // the viewport hides the cutter too: no separate viewport counts
    expect(scene.counts.evaluated_viewport).toBeUndefined();

    // the same triangles as an export of the scene (binary STL: the count follows the header)
    const exported = await call('export_scene', { project: id, format: 'stl' });
    const blob = exported.raw.content.find((c) => c.type === 'resource')!.resource!.blob!;
    const stl = Buffer.from(blob, 'base64');
    expect(stl.readUInt32LE(80)).toBe(scene.counts.evaluated.triangles);

    // an object hidden only in the viewport is rendered: counted in evaluated, not in the viewport's
    await ok('add_object', { project: id, type: 'cube', name: 'Helper', location: [5, 0, 0] });
    await op(id, 'data.set_property', { kind: 'objects', target: 'Helper', values: { hide_viewport: true } });
    const both = await ok('get_scene', { project: id });
    expect(both.counts.evaluated.triangles).toBe(body.data.evaluated.triangles + 12);
    expect(both.counts.evaluated_viewport).toEqual(rendered);
    expect(both.counts.not_rendered.objects).toEqual(['Cutter']);
  });

  it('counts the instances of an emitter hidden from renders apart', async () => {
    const { id } = await ok('create_project', { name: 'Hidden emitter', empty: true });
    await ok('add_object', { project: id, type: 'plane', name: 'Ground', params: { size: 10 } });
    await ok('add_object', { project: id, type: 'cube', name: 'Pebble', params: { size: 0.2 } });
    await op(id, 'object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count: 10, seed: 3 });
    const shown = await ok('get_scene', { project: id });
    expect(shown.counts.instances).toBe(10);
    expect(shown.counts.instance_triangles).toBe(120);
    await op(id, 'data.set_property', { kind: 'objects', target: 'Ground', values: { hide_render: true } });
    const hidden = await ok('get_scene', { project: id });
    expect(hidden.counts.instances).toBe(0);
    expect(hidden.counts.instance_triangles).toBeUndefined();
    expect(hidden.counts.not_rendered).toMatchObject({
      objects: expect.arrayContaining(['Ground']),
      instances: 10,
      instance_triangles: 120,
    });
    // the viewport still shows them
    expect(hidden.counts.viewport_instances).toBe(10);
  });
});

describe('precision of the scene descriptions', () => {
  it('get_object reads sub-millimetre lengths back as they were made (product-shot #22)', async () => {
    const { id } = await ok('create_project', { name: 'Precision', empty: true });
    await op(id, 'curve.add_from_points', {
      name: 'Frame',
      points: [
        [0, 0, 0],
        [0.01, 0, 0],
        [0.01, 0.01, 0],
        [0, 0.01, 0],
      ],
      type: 'POLY',
      cyclic: true,
      dimensions: '3D',
      bevel_depth: 0.00011,
    });
    const frame = await ok('get_object', { project: id, object: 'Frame' });
    expect(frame.data.bevel_depth).toBe(0.00011);
    // world bounds to 1 µm: the same as the extremes of the render geometry's vertices
    const mesh = await ok('get_mesh_data', {
      project: id,
      object: 'Frame',
      source: 'RENDER',
      space: 'WORLD',
      decimals: 6,
      include: ['vertices'],
      limit: 20000,
    });
    const xs = (mesh.vertices as number[][]).map((v) => v[0]);
    expect(frame.world_bounds.min[0]).toBe(Math.min(...xs));
    expect(frame.world_bounds.max[0]).toBe(Math.max(...xs));
    expect(Math.round(frame.world_bounds.max[0] * 1e4)).not.toBe(frame.world_bounds.max[0] * 1e4);

    // fewer decimals on request; get_scene rounds to 4 (0.1 mm) unless asked for more
    expect((await ok('get_object', { project: id, object: 'Frame', decimals: 4 })).data.bevel_depth).toBe(
      0.0001,
    );
    const scene = await ok('get_scene', { project: id });
    expect(scene.objects[0].data.bevel_depth).toBe(0.0001);
    expect((await ok('get_scene', { project: id, decimals: 6 })).objects[0].data.bevel_depth).toBe(0.00011);
    // a rounding setting does not leak into the next description
    expect((await ok('get_scene', { project: id })).objects[0].data.bevel_depth).toBe(0.0001);

    // the transforms tools return are as precise
    const moved = await ok('transform_object', { project: id, object: 'Frame', location: [0.00011, 0, 0] });
    expect(moved.objects[0].location).toEqual([0.00011, 0, 0]);
    expect((await ok('get_object', { project: id, object: 'Frame' })).location).toEqual([0.00011, 0, 0]);
  });
});

describe('project names', () => {
  it('REST create and rename refuse a name another project has, ignoring case (SRV verify)', async () => {
    const first = await api(server.url, '/api/projects', { method: 'POST', json: { name: 'Taken Name' } });
    expect(first.status).toBe(201);
    const again = await api(server.url, '/api/projects', { method: 'POST', json: { name: 'Taken Name' } });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      id: first.body.id,
      error: expect.stringContaining(`already exists (id ${first.body.id})`),
    });
    expect(
      (await api(server.url, '/api/projects', { method: 'POST', json: { name: 'taken name' } })).status,
    ).toBe(409);
    // MCP refuses it in any case too, and says why
    const msg = await fails('create_project', { name: 'TAKEN NAME', empty: true });
    expect(msg).toContain(first.body.id);
    expect(msg).toMatch(/differ only in letter case/);

    // projects created without a name get the first free 'Untitled' name
    const u1 = await api(server.url, '/api/projects', { method: 'POST', json: {} });
    const u2 = await api(server.url, '/api/projects', { method: 'POST', json: {} });
    expect([u1.status, u2.status]).toEqual([201, 201]);
    expect(u1.body.name).toBe('Untitled');
    expect(u2.body.name).toBe('Untitled.001');

    // renames: not to another project's name; a new case of the own name is fine
    const renamed = await api(server.url, `/api/projects/${u2.body.id}`, {
      method: 'PATCH',
      json: { name: 'TAKEN name' },
    });
    expect(renamed.status).toBe(409);
    expect(renamed.body.id).toBe(first.body.id);
    const recased = await api(server.url, `/api/projects/${first.body.id}`, {
      method: 'PATCH',
      json: { name: 'TAKEN NAME' },
    });
    expect(recased.status).toBe(200);
    expect(recased.body.name).toBe('TAKEN NAME');

    // requests racing for one name (REST and MCP alike): exactly one gets it
    const race = await Promise.all([
      api(server.url, '/api/projects', { method: 'POST', json: { name: 'Raced' } }),
      api(server.url, '/api/projects', { method: 'POST', json: { name: 'raced' } }),
      call('create_project', { name: 'RACED', empty: true }),
    ]);
    const won = race.filter((r) => ('status' in r ? r.status === 201 : !r.raw.isError));
    expect(won).toHaveLength(1);

    const list = await api(server.url, '/api/projects');
    const named = list.body.projects.filter((p: { name: string }) => p.name.toLowerCase() === 'taken name');
    expect(named.map((p: { id: string }) => p.id)).toEqual([first.body.id]);
    // by-name references stay unambiguous
    expect((await ok('get_project', { project: 'taken name' })).id).toBe(first.body.id);
  });
});

describe('editor_command', () => {
  it('refuses unknown commands and misspelled parameters before anything is sent (SRV verify)', async () => {
    const { id } = await ok('create_project', { name: 'Editor commands', empty: true });
    // checked even without a connected editor
    const typo = await fails('editor_command', {
      project: id,
      command: 'view.set_view',
      params: { veiw: 'TOP' },
    });
    expect(typo).toContain("'veiw' (did you mean 'view'?)");
    expect(typo).toMatch(/view \(FRONT \| BACK/);
    expect(await fails('editor_command', { project: id, command: 'view.frame_al' })).toMatch(
      /Unknown editor command 'view.frame_al' \(did you mean 'view.frame_all'\?\)/,
    );
    expect(
      await fails('editor_command', { project: id, command: 'view.frame_all', params: { all: true } }),
    ).toMatch(/view.frame_all takes no parameters/);
    expect(
      await fails('editor_command', { project: id, command: 'screenshot', params: { width: 'large' } }),
    ).toMatch(/'width' must be a whole number of pixels/);

    const browser = new SyncTestClient({
      baseUrl: server.url,
      projectId: id,
      name: 'Browser',
      capabilities: ['ui'],
      rpcHandler: (_method, params) => ({ received: params }),
    });
    syncClients.push(browser);
    await browser.connect();
    await eventually(() => server.handle.rooms.get(id)?.rpcCandidates('ui').length === 1);
    const res = await ok('editor_command', {
      project: id,
      command: 'view.set_view',
      params: { view: 'TOP' },
    });
    expect(res.result).toEqual({ received: { command: 'view.set_view', params: { view: 'TOP' } } });
    await fails('editor_command', { project: id, command: 'view.set_view', params: { veiw: 'TOP' } });
    // the refused commands never reached the editor
    expect(browser.rpcRequests.map((r) => r.method)).toEqual(['ui']);
  });
});

describe('a selection that fails changes nothing', () => {
  it('run_operator: a failed selection or operator leaves the selection as it was (SRV verify)', async () => {
    const { id } = await ok('create_project', { name: 'Selections' });
    await op(id, 'object.select_all', { action: 'DESELECT' });
    const before = (await ok('run_operator', { project: id, operator: 'scene.stats' })).selection;
    expect(before).toMatchObject({ mode: 'OBJECT', selected: [], active: null });

    // Edit Mode on a camera: refused, and nothing of it is kept
    const msg = await fails('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Camera'], mode: 'EDIT' },
    });
    expect(msg).toMatch(/Edit mode needs an active mesh object/);
    expect((await ok('run_operator', { project: id, operator: 'scene.stats' })).selection).toEqual(before);
    // so an operator without a selection does not act on the camera
    const del = await call('run_operator', { project: id, operator: 'object.delete' });
    expect(del.raw.isError).toBe(true);
    expect((await ok('get_scene', { project: id })).objects.map((o: { name: string }) => o.name)).toContain(
      'Camera',
    );

    // an unknown object in the list: nothing selected either
    await fails('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube', 'Nope'] },
    });
    expect((await ok('run_operator', { project: id, operator: 'scene.stats' })).selection).toEqual(before);

    // element indices out of range: still in Object Mode with nothing selected
    await fails('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [99] } },
    });
    expect((await ok('run_operator', { project: id, operator: 'scene.stats' })).selection).toEqual(before);

    // mesh elements without Edit Mode would be ignored: refused
    expect(
      await fails('run_operator', {
        project: id,
        operator: 'scene.stats',
        selection: { objects: ['Cube'], mesh: { faces: [0] } },
      }),
    ).toMatch(/selection.mesh selects vertices, edges or faces in Edit Mode: add mode 'EDIT'/);

    // a valid selection with an operator that fails: the selection is put back too
    const failed = await call('run_operator', {
      project: id,
      operator: 'object.modifier_add',
      params: { type: 'NOPE' },
      selection: { objects: ['Cube'] },
    });
    expect(failed.raw.isError).toBe(true);
    expect(failed.text).toContain('"selected": []');
    expect((await ok('run_operator', { project: id, operator: 'scene.stats' })).selection).toEqual(before);

    // a call that succeeds keeps its selection
    const kept = await ok('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [0] } },
    });
    expect(kept.selection).toMatchObject({ mode: 'EDIT', selected: ['Cube'], active: 'Cube' });
    expect(kept.selection.mesh).toMatchObject({ select_mode: 'FACE', faces: 1 });
  });

  it('batch: an operation that fails keeps neither its selection nor its mode', async () => {
    const { id } = await ok('create_project', { name: 'Batch selections' });
    await op(id, 'object.select_all', { action: 'DESELECT' });
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: [
        { operator: 'scene.stats', selection: { objects: ['Light'] } },
        { operator: 'scene.stats', selection: { objects: ['Camera'], mode: 'EDIT' } },
        { operator: 'object.modifier_add', params: { type: 'NOPE' }, selection: { objects: ['Cube'] } },
        { operator: 'scene.stats' },
      ],
    });
    expect(res.raw.isError).toBe(true);
    const out = JSON.parse(res.text.slice(res.text.indexOf('{')));
    expect(out.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false, false, true]);
    expect(out.results[1].code).toBe('POLL_FAILED');
    // the failed operations left the selection of the first one
    expect(out.selection).toMatchObject({ mode: 'OBJECT', selected: ['Light'], active: 'Light' });
  });

  it('edit_mesh: an element index out of range changes nothing', async () => {
    const { id } = await ok('create_project', { name: 'Edit mesh selections' });
    await op(id, 'object.select_all', { action: 'DESELECT' });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Light'] } });
    expect(
      await fails('edit_mesh', {
        project: id,
        object: 'Cube',
        operator: 'mesh.subdivide',
        selection: { faces: [42] },
      }),
    ).toMatch(/face index 42 out of range/);
    const after = (await ok('run_operator', { project: id, operator: 'scene.stats' })).selection;
    expect(after).toMatchObject({ mode: 'OBJECT', selected: ['Light'], active: 'Light' });
    // a successful call selects the edited object, in Object Mode
    await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.subdivide',
      selection: { faces: [0] },
    });
    expect((await ok('run_operator', { project: id, operator: 'scene.stats' })).selection).toMatchObject({
      mode: 'OBJECT',
      selected: ['Cube'],
      active: 'Cube',
    });
  });
});

/** Width × height of every PNG image embedded in a GLB file. */
function glbImageSizes(glb: Buffer): string[] {
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));
  const bin = glb.subarray(20 + jsonLength + 8);
  return (gltf.images ?? []).map((img: { bufferView: number }) => {
    const view = gltf.bufferViews[img.bufferView];
    const png = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
  });
}

describe('export_scene', () => {
  it('takes the size of procedural texture bakes (bake_resolution), also in its download link', async () => {
    const { id } = await ok('create_project', { name: 'Bake size', empty: true });
    await ok('add_object', { project: id, type: 'cube', name: 'Crate' });
    await ok('set_material', { project: id, object: 'Crate', name: 'Wood' });
    await op(id, 'material.procedural_set', { material: 'Wood', procedural: { type: 'NOISE' } });
    const glbOf = (r: Awaited<ReturnType<typeof call>>) =>
      Buffer.from(r.raw.content.find((c) => c.type === 'resource')!.resource!.blob!, 'base64');

    const auto = await call('export_scene', { project: id, format: 'glb' });
    // automatic: chosen by the exporter from the size of the mesh (at least 512 px)
    const [autoSize] = glbImageSizes(glbOf(auto));
    expect(Number(autoSize.split('x')[0])).toBeGreaterThanOrEqual(512);
    const small = await call('export_scene', { project: id, format: 'glb', bake_resolution: 64 });
    expect(glbImageSizes(glbOf(small))).toEqual(['64x64']);
    const info = JSON.parse(small.raw.content[0].text!);
    expect(info.bake_resolution).toBe(64);
    expect(info.download_url).toContain('bake_resolution=64');
    // the link exports again with the same size
    const fetched = Buffer.from(await (await fetch(info.download_url)).arrayBuffer());
    expect(glbImageSizes(fetched)).toEqual(['64x64']);
    expect(await fails('export_scene', { project: id, format: 'glb', bake_resolution: 10_000 })).toMatch(
      /bake_resolution/,
    );
  });
});

describe('modifier tools', () => {
  it('point to the tool arguments when visibility or the name is given inside params (SRV verify)', async () => {
    const { id } = await ok('create_project', { name: 'Modifier args', empty: true });
    await ok('add_object', { project: id, type: 'cube', name: 'S' });
    await ok('add_modifier', { project: id, object: 'S', type: 'SUBSURF', name: 'Subdivision' });
    const msg = await fails('update_modifier', {
      project: id,
      object: 'S',
      modifier: 'Subdivision',
      params: { show_render: false },
    });
    expect(msg).toContain("'show_render' is an argument of update_modifier itself");
    expect(msg).toContain('update_modifier {project, object, modifier: "Subdivision", show_render: false}');
    // the top-level argument works
    const updated = await ok('update_modifier', {
      project: id,
      object: 'S',
      modifier: 'Subdivision',
      show_render: false,
    });
    expect(updated.modifier.show_render).toBe(false);

    const add = await fails('add_modifier', {
      project: id,
      object: 'S',
      type: 'BEVEL',
      params: { show_viewport: false, name: 'Edge' },
    });
    expect(add).toContain("'show_viewport', 'name' are not parameters of the BEVEL modifier");
    expect(add).toContain('name: "Edge"');
    expect(add).toContain('update_modifier {project, object, modifier: <its name>, show_viewport: false}');
    // nothing was added
    expect((await ok('get_object', { project: id, object: 'S' })).modifiers).toHaveLength(1);
  });
});
