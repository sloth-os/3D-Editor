import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  SceneDoc,
  createOperatorRegistry,
  encodePNG,
  exportScene,
  importFile,
  listModifierDefs,
  registerBuiltinModifiers,
  renderSceneSoftware,
} from '@3d-editor/core';
import { api, eventually, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

/** Probes whether a core feature implemented by another package is available yet. */
function implemented(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    return !/not implemented/i.test(String(err));
  }
}

const canRender = implemented(() =>
  encodePNG(renderSceneSoftware(SceneDoc.create({ name: 'probe' }), { width: 8, height: 8 })),
);
const canExport = implemented(() => exportScene(SceneDoc.create({ name: 'probe' }), 'obj'));
const canImport = implemented(() =>
  importFile(
    SceneDoc.create({ empty: true }),
    'obj',
    new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
  ),
);
registerBuiltinModifiers();
const hasSubsurf = listModifierDefs().some((d) => d.type === 'SUBSURF');
const meshOps = createOperatorRegistry()
  .list()
  .map((d) => d.id);
const hasExtrude = meshOps.includes('mesh.extrude_region_move');
const hasModifierOperators =
  meshOps.includes('object.modifier_add') && meshOps.includes('object.modifier_set');

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let server: TestServer;
let client: Client;
const syncClients: SyncTestClient[] = [];

type ToolResult = {
  content: { type: string; text?: string; data?: string; mimeType?: string; resource?: any; uri?: string }[];
  isError?: boolean;
};

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ raw: ToolResult; json: any }> {
  const raw = (await client.callTool({ name, arguments: args })) as ToolResult;
  const textItem = raw.content.find((c) => c.type === 'text');
  const parse = (t: string | undefined): any => {
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return t;
    }
  };
  return { raw, json: parse(textItem?.text) };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { raw, json } = await call(name, args);
  if (raw.isError) throw new Error(`${name} failed: ${raw.content.map((c) => c.text).join('\n')}`);
  return json;
}

async function fails(name: string, args: Record<string, unknown>): Promise<string> {
  const { raw } = await call(name, args);
  expect(raw.isError).toBe(true);
  return raw.content.map((c) => c.text ?? '').join('\n');
}

function syncClient(projectId: string, opts: Partial<ConstructorParameters<typeof SyncTestClient>[0]> = {}) {
  const c = new SyncTestClient({ baseUrl: server.url, projectId, ...opts });
  syncClients.push(c);
  return c;
}

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'disk' });
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await Promise.all(syncClients.map((c) => c.destroy()));
  await server?.close();
  await server?.cleanup();
});

describe('MCP endpoint', () => {
  it('lists the tools and sends instructions', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    for (const expected of [
      'list_projects',
      'create_project',
      'get_project',
      'rename_project',
      'delete_project',
      'get_scene',
      'get_object',
      'list_operators',
      'run_operator',
      'add_object',
      'transform_object',
      'delete_objects',
      'duplicate_object',
      'set_parent',
      'set_material',
      'add_modifier',
      'update_modifier',
      'remove_modifier',
      'apply_modifier',
      'edit_mesh',
      'create_mesh',
      'insert_keyframe',
      'set_scene_settings',
      'set_active_camera',
      'undo',
      'redo',
      'batch',
      'import_model',
      'export_scene',
      'render_image',
      'get_connected_clients',
      'editor_command',
    ]) {
      expect(names).toContain(expected);
    }
    const addObject = tools.find((t) => t.name === 'add_object')!;
    expect(addObject.description).toMatch(/uv_sphere/);
    expect((addObject.inputSchema as any).properties.type.enum).toContain('torus');
    expect(client.getInstructions()).toMatch(/Z is up/);
    expect(client.getInstructions()).toMatch(/list_operators/);
  });

  it('creates a project whose changes reach connected editors live, with agent presence', async () => {
    const created = await ok('create_project', { name: 'Agent scene' });
    expect(created.editor_url).toMatch(/\/\?project=/);
    expect(created.objects.map((o: any) => o.name).sort()).toEqual(['Camera', 'Cube', 'Light']);
    const id = created.id as string;

    const human = syncClient(id, { name: 'Human' });
    await human.connect();
    await human.waitFor(
      () =>
        human.remoteStates().some((s) => s.user?.kind === 'agent' && s.user.name === 'AI agent (test-agent)'),
      10_000,
      'agent presence',
    );

    const added = await ok('add_object', {
      project: id,
      type: 'uv_sphere',
      name: 'Ball',
      location: [0, 0, 3],
      params: { radius: 0.5 },
    });
    expect(added.object).toMatchObject({ name: 'Ball', type: 'MESH', location: [0, 0, 3] });
    await human.waitFor(() => !!human.scene.findObjectByName('Ball'), 10_000, 'Ball synced');
    await human.waitFor(
      () =>
        human
          .remoteStates()
          .some(
            (s) =>
              s.user?.kind === 'agent' && Array.isArray(s.selection) && s.selection.includes(added.object.id),
          ),
      10_000,
      'agent selection',
    );

    const scene = await ok('get_scene', { project: id });
    expect(scene.units).toMatchObject({ up_axis: 'Z', length: 'meters' });
    const ball = scene.objects.find((o: any) => o.name === 'Ball');
    expect(ball.world_bounds.center).toEqual([0, 0, 3]);
    expect(ball.world_bounds.size[2]).toBeCloseTo(1, 3);
    expect(ball.data.kind).toBe('mesh');
    expect(scene.active_camera.name).toBe('Camera');

    // the human edits too; the agent sees it
    human.scene.addObject({ type: 'EMPTY', name: 'Human empty' });
    await eventually(async () =>
      (await ok('get_scene', { project: 'Agent scene' })).objects.some((o: any) => o.name === 'Human empty'),
    );

    const clients = await ok('get_connected_clients', { project: id });
    expect(clients.connections).toHaveLength(1);
    const kinds = clients.presence.map((p: any) => `${p.kind}:${p.name}`).sort();
    expect(kinds).toEqual(['agent:AI agent (test-agent)', 'human:Human']);
  });

  it('transforms, duplicates, parents and deletes objects; manages materials', async () => {
    const { id } = await ok('create_project', { name: 'Ops' });
    await ok('transform_object', {
      project: id,
      object: 'Cube',
      location: [1, 2, 3],
      rotation_degrees: [0, 0, 90],
    });
    let cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.location).toEqual([1, 2, 3]);
    expect(cube.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 4);
    await ok('transform_object', {
      project: id,
      objects: ['Cube'],
      location: [1, 0, 0],
      scale: [2, 2, 2],
      relative: true,
    });
    cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.location).toEqual([2, 2, 3]);
    expect(cube.scale).toEqual([2, 2, 2]);

    const dup = await ok('duplicate_object', {
      project: id,
      object: 'Cube',
      offset: [0, 3, 0],
      name: 'Cube copy',
    });
    expect(dup.objects[0]).toMatchObject({ name: 'Cube copy', location: [2, 5, 3] });
    await ok('set_parent', { project: id, object: 'Cube copy', parent: 'Cube' });
    const copy = await ok('get_object', { project: id, object: 'Cube copy' });
    expect(copy.parent).toBe('Cube');
    expect(copy.world_location).toEqual([2, 5, 3]);

    const mat = await ok('set_material', {
      project: id,
      object: 'Cube copy',
      name: 'Red paint',
      base_color: [1, 0, 0],
      roughness: 0.2,
      metallic: 1,
    });
    expect(mat.created).toBe(true);
    expect(mat.material).toMatchObject({
      name: 'Red paint',
      base_color: [1, 0, 0, 1],
      roughness: 0.2,
      metallic: 1,
    });
    const reuse = await ok('set_material', { project: id, object: 'Cube', material: 'Red paint' });
    expect(reuse.created).toBe(false);
    const scene = await ok('get_scene', { project: id });
    expect(scene.materials.find((m: any) => m.name === 'Red paint').users.sort()).toEqual([
      'Cube',
      'Cube copy',
    ]);

    const err = await fails('transform_object', { project: id, object: 'Nope', location: [0, 0, 0] });
    expect(err).toMatch(/Object 'Nope' not found/);
    expect(err).toMatch(/Cube/);

    await ok('delete_objects', { project: id, objects: ['Cube copy', 'Light'] });
    const after = await ok('get_scene', { project: id });
    expect(after.objects.map((o: any) => o.name).sort()).toEqual(['Camera', 'Cube']);
  });

  it('runs operators with selection, creates meshes, keyframes and settings', async () => {
    const { id } = await ok('create_project', { name: 'Ops 2', empty: true });
    const ops = await ok('list_operators', { category: 'Add' });
    expect(ops.operators.map((o: any) => o.id)).toContain('mesh.primitive_cube_add');
    expect(ops.operators[0].parameters).toBeTruthy();
    const all = await ok('list_operators');
    expect(all.count).toBeGreaterThan(30);
    expect(all.hint).toBeTruthy();

    const res = await ok('run_operator', {
      project: id,
      operator: 'mesh.primitive_cylinder_add',
      params: { vertices: 8, name: 'Pillar' },
    });
    expect(res.ok).toBe(true);
    expect(res.selection.selected).toEqual(['Pillar']);
    const moved = await ok('run_operator', {
      project: id,
      operator: 'transform.translate',
      params: { value: [0, 0, 5] },
      selection: { objects: ['Pillar'] },
    });
    expect(moved.ok).toBe(true);
    expect((await ok('get_object', { project: id, object: 'Pillar' })).location).toEqual([0, 0, 5]);
    const unknown = await fails('run_operator', { project: id, operator: 'mesh.primitive_cube_ad' });
    expect(unknown).toMatch(/Unknown operator/);
    expect(unknown).toMatch(/mesh.primitive_cube_add/);
    const pollFail = await fails('run_operator', {
      project: id,
      operator: 'object.join',
      selection: { objects: ['Pillar'] },
    });
    expect(pollFail).toMatch(/object.join failed/);

    const mesh = await ok('create_mesh', {
      project: id,
      name: 'Tri',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      faces: [[0, 1, 2]],
      location: [5, 0, 0],
    });
    expect(mesh.mesh).toMatchObject({ vertices: 3, faces: 1 });

    // edit mode: move one face of a cube up with transform.translate
    await ok('add_object', { project: id, type: 'cube', name: 'Box', params: { size: 2 } });
    const edited = await ok('edit_mesh', {
      project: id,
      object: 'Box',
      operator: 'transform.translate',
      params: { value: [0, 0, 1] },
      selection: { faces: [0] },
    });
    expect(edited.ok).toBe(true);
    const box = await ok('get_object', { project: id, object: 'Box' });
    expect(box.world_bounds.size[2]).toBeCloseTo(3, 4);

    const keyed = await ok('insert_keyframe', {
      project: id,
      object: 'Pillar',
      property: 'location',
      frame: 10,
      value: [0, 0, 0],
    });
    expect(keyed.inserted).toBe(3);
    await ok('insert_keyframe', { project: id, object: 'Pillar', property: 'location', frame: 20 });
    const pillar = await ok('get_object', { project: id, object: 'Pillar' });
    expect(pillar.animation.map((c: any) => `${c.path}[${c.index}]:${c.keyframes.length}`)).toEqual([
      'location[0]:2',
      'location[1]:2',
      'location[2]:2',
    ]);
    expect(
      await fails('insert_keyframe', { project: id, object: 'Pillar', property: 'mass', frame: 1 }),
    ).toMatch(/not animatable/);

    const settings = await ok('set_scene_settings', {
      project: id,
      frame_end: 120,
      fps: 30,
      resolution_x: 640,
      resolution_y: 480,
      world_color: [0.1, 0.2, 0.3],
      frame_current: 15,
    });
    expect(settings.scene).toMatchObject({ frame_end: 120, fps: 30 });
    expect(settings.render).toMatchObject({ resolution_x: 640, resolution_y: 480 });
    expect(settings.world.color).toEqual([0.1, 0.2, 0.3]);
    expect(settings.frame_current).toBe(15);

    await ok('add_object', {
      project: id,
      type: 'camera',
      name: 'Cam 2',
      location: [0, -10, 2],
      rotation_degrees: [80, 0, 0],
    });
    const cam = await ok('set_active_camera', { project: id, camera: 'Cam 2' });
    expect(cam.active_camera.name).toBe('Cam 2');
    expect(await fails('set_active_camera', { project: id, camera: 'Box' })).toMatch(/not a camera/);
    const light = await ok('add_object', {
      project: id,
      type: 'light',
      light_type: 'SUN',
      name: 'Sun',
      params: { energy: 3 },
    });
    expect(light.object.type).toBe('LIGHT');
    const sun = await ok('get_object', { project: id, object: 'Sun' });
    expect(sun.data).toMatchObject({ kind: 'light', type: 'SUN', energy: 3 });
  });

  it('undoes and redoes only the agent changes; batch is one undo step', async () => {
    const { id } = await ok('create_project', { name: 'Undo', empty: true });
    const human = syncClient(id, { name: 'Undo human' });
    await human.connect();
    await ok('add_object', { project: id, type: 'cube', name: 'A' });
    human.scene.addObject({ type: 'EMPTY', name: 'Human thing' });
    await eventually(async () => (await ok('get_scene', { project: id })).objects.length === 2);
    await ok('add_object', { project: id, type: 'plane', name: 'B' });
    const names = async () => (await ok('get_scene', { project: id })).objects.map((o: any) => o.name).sort();
    expect(await names()).toEqual(['A', 'B', 'Human thing']);

    expect(await ok('undo', { project: id })).toMatchObject({ undone: 1, can_undo: true, can_redo: true });
    expect(await names()).toEqual(['A', 'Human thing']);
    await human.waitFor(() => !human.scene.findObjectByName('B'), 10_000, 'undo synced');
    expect(await ok('undo', { project: id, steps: 5 })).toMatchObject({ undone: 1, can_undo: false });
    expect(await names()).toEqual(['Human thing']);
    expect(await ok('redo', { project: id, steps: 2 })).toMatchObject({ redone: 2, can_redo: false });
    expect(await names()).toEqual(['A', 'B', 'Human thing']);

    const batch = await ok('batch', {
      project: id,
      operations: [
        { operator: 'mesh.primitive_cube_add', params: { name: 'C1', location: [0, 0, 1] } },
        { operator: 'mesh.primitive_cube_add', params: { name: 'C2', location: [0, 0, 2] } },
        { operator: 'transform.translate', params: { value: [1, 0, 0] } },
      ],
    });
    expect(batch).toMatchObject({ ok: true, executed: 3, failed: 0 });
    expect(await names()).toEqual(['A', 'B', 'C1', 'C2', 'Human thing']);
    expect((await ok('get_object', { project: id, object: 'C2' })).location).toEqual([1, 0, 2]);
    expect(await ok('undo', { project: id })).toMatchObject({ undone: 1 });
    expect(await names()).toEqual(['A', 'B', 'Human thing']);

    const failing = await call('batch', {
      project: id,
      operations: [
        { operator: 'mesh.primitive_cube_add', params: { name: 'D' } },
        { operator: 'nope.nothing' },
        { operator: 'mesh.primitive_cube_add' },
      ],
    });
    expect(failing.raw.isError).toBe(true);
    expect(failing.raw.content[0].text).toMatch(/1 of 3 operation\(s\) failed/);
    expect(await names()).toEqual(['A', 'B', 'D', 'Human thing']);
  });

  it.skipIf(!hasSubsurf)('adds, updates, applies and removes modifiers', async () => {
    const { id } = await ok('create_project', { name: 'Mods' });
    const added = await ok('add_modifier', {
      project: id,
      object: 'Cube',
      type: 'SUBSURF',
      params: { levels: 1 },
    });
    expect(added.modifier).toMatchObject({ type: 'SUBSURF' });
    // registered operators are the single entry point; the document fallback is only used without them
    expect(added.via).toBe(hasModifierOperators ? 'operator' : 'document');
    expect(added.modifier.params.levels).toBe(1);
    let cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.modifiers).toHaveLength(1);
    expect(cube.data.evaluated.faces).toBeGreaterThan(6);
    const name = added.modifier.name;
    const updated = await ok('update_modifier', {
      project: id,
      object: 'Cube',
      modifier: name,
      params: { levels: 2 },
      show_render: false,
    });
    expect(updated.modifier.params.levels).toBe(2);
    expect(updated.modifier.show_render).toBe(false);
    expect(updated.via).toBe(hasModifierOperators ? 'operator' : 'document');
    cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.data.evaluated.faces).toBe(96);
    const applied = await ok('apply_modifier', { project: id, object: 'Cube', modifier: name });
    expect(applied.mesh.faces).toBe(96);
    cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.modifiers).toHaveLength(0);
    await ok('add_modifier', { project: id, object: 'Cube', type: 'SUBSURF', name: 'Smooth it' });
    const removed = await ok('remove_modifier', { project: id, object: 'Cube', modifier: 'Smooth it' });
    expect(removed.stack).toEqual([]);
    expect(await fails('add_modifier', { project: id, object: 'Cube', type: 'NOT_A_MODIFIER' })).toMatch(
      /Unknown modifier type/,
    );
    expect(await fails('remove_modifier', { project: id, object: 'Cube', modifier: 'ghost' })).toMatch(
      /not found/,
    );
  });

  it.skipIf(!hasExtrude)('edits meshes with mesh.* operators', async () => {
    const { id } = await ok('create_project', { name: 'Extrude' });
    const res = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.extrude_region_move',
      params: { value: [0, 0, 1] },
      selection: { faces: [0] },
    });
    expect(res.ok).toBe(true);
    expect(res.mesh.faces).toBe(10);
    const cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.mode ?? 'OBJECT').toBe('OBJECT');
    expect(cube.data.faces).toBe(10);
  });

  it('renders through a connected browser editor (RPC) and reports the renderer', async () => {
    const { id } = await ok('create_project', { name: 'Render' });
    const browser = syncClient(id, {
      name: 'Browser',
      capabilities: ['render', 'ui'],
      rpcHandler: (method, params) => {
        if (method === 'render')
          return {
            mime: 'image/png',
            data_base64: TINY_PNG,
            width: (params as any).width,
            height: (params as any).height,
          };
        if (method === 'ui') return { done: (params as any).command };
        throw new Error('unknown');
      },
    });
    await browser.connect();
    await eventually(() => server.handle.rooms.get(id)?.rpcCandidates('render').length === 1);
    const { raw } = await call('render_image', { project: id, width: 320, height: 240 });
    expect(raw.isError).toBeFalsy();
    const image = raw.content.find((c) => c.type === 'image')!;
    expect(image).toMatchObject({ mimeType: 'image/png', data: TINY_PNG });
    const info = JSON.parse(raw.content.find((c) => c.type === 'text')!.text!);
    expect(info).toMatchObject({ renderer: 'browser', client: 'Browser', width: 320, height: 240 });
    expect(browser.rpcRequests.at(-1)).toMatchObject({
      method: 'render',
      params: { width: 320, height: 240 },
    });

    const cmd = await ok('editor_command', { project: id, command: 'view.frame_all' });
    expect(cmd).toEqual({ command: 'view.frame_all', result: { done: 'view.frame_all' } });
    const plain = await ok('create_project', { name: 'No editors' });
    expect(await fails('editor_command', { project: plain.id, command: 'view.frame_all' })).toMatch(
      /No browser editor/,
    );
    expect(await fails('render_image', { project: plain.id, renderer: 'browser' })).toMatch(
      /no connected browser editor/,
    );
  });

  it.skipIf(!canRender)('renders with the software renderer when no editor is connected', async () => {
    const { id } = await ok('create_project', { name: 'Software render' });
    const { raw } = await call('render_image', { project: id, width: 64, height: 48 });
    expect(raw.isError).toBeFalsy();
    const image = raw.content.find((c) => c.type === 'image')!;
    expect(image.mimeType).toBe('image/png');
    expect(Buffer.from(image.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(JSON.parse(raw.content.find((c) => c.type === 'text')!.text!)).toMatchObject({
      renderer: 'software',
      width: 64,
      height: 48,
    });
    const http = await fetch(`${server.url}/api/projects/${id}/render.png?width=32&height=32`);
    expect(http.status).toBe(200);
    expect(http.headers.get('content-type')).toBe('image/png');
  });

  it.skipIf(!canExport)('exports scenes as base64 resources with a download link', async () => {
    const { id } = await ok('create_project', { name: 'Export me' });
    const { raw } = await call('export_scene', { project: id, format: 'obj' });
    expect(raw.isError).toBeFalsy();
    const info = JSON.parse(raw.content[0].text!);
    expect(info).toMatchObject({ format: 'obj', filename: 'Export_me.obj' });
    const resource = raw.content.find((c) => c.type === 'resource')!;
    expect(Buffer.from(resource.resource.blob, 'base64').toString('utf8')).toMatch(/^v /m);
    const link = raw.content.find((c) => c.type === 'resource_link')!;
    const dl = await fetch(link.uri!);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/attachment; filename="Export_me.obj"/);
  });

  it.skipIf(!canImport)('imports models from base64 data', async () => {
    const { id } = await ok('create_project', { name: 'Import', empty: true });
    const obj = 'o Tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
    const res = await ok('import_model', {
      project: id,
      format: 'obj',
      data_base64: Buffer.from(obj).toString('base64'),
    });
    expect(res.objects.length).toBeGreaterThan(0);
    expect((await ok('get_scene', { project: id })).counts.objects).toBeGreaterThan(0);
  });

  it('reports unavailable import/export/render features as tool errors', async () => {
    const { id } = await ok('create_project', { name: 'Features' });
    if (!canExport)
      expect(await fails('export_scene', { project: id, format: 'glb' })).toMatch(/not available/);
    if (!canImport)
      expect(await fails('import_model', { project: id, format: 'obj', data_base64: 'dg==' })).toMatch(
        /not available/,
      );
    if (!canRender)
      expect(await fails('render_image', { project: id, renderer: 'software' })).toMatch(/not available/);
    expect(await fails('import_model', { project: id, url: 'file:///etc/passwd' })).toMatch(
      /only http and https/,
    );
    expect(await fails('import_model', { project: id })).toMatch(/exactly one of/);
  });

  it('exposes project scenes as resources and manages projects', async () => {
    const { id } = await ok('create_project', { name: 'Resource project' });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(`project://${id}/scene`);
    const read = await client.readResource({ uri: `project://${id}/scene` });
    const scene = JSON.parse((read.contents[0] as { text: string }).text);
    expect(scene.project).toMatchObject({ id, name: 'Resource project' });

    const listed = await ok('list_projects');
    expect(listed.projects.some((p: any) => p.id === id)).toBe(true);
    expect(await ok('rename_project', { project: id, name: 'Renamed project' })).toEqual({
      id,
      name: 'Renamed project',
    });
    expect((await ok('get_project', { project: 'Renamed project' })).name).toBe('Renamed project');
    expect(await fails('get_project', { project: 'Does not exist' })).toMatch(/not found/);
    expect(await fails('delete_project', { project: id })).toMatch(/confirm/i);
    expect(await ok('delete_project', { project: id, confirm: true })).toEqual({ deleted: id });
    expect((await api(server.url, `/api/projects/${id}`)).status).toBe(404);
  });

  it('records tool metrics and keeps sessions isolated', async () => {
    const metrics = await server.handle.metrics.render();
    expect(metrics).toMatch(/mcp_tool_calls_total\{tool="add_object",status="ok"\} \d+/);
    expect(metrics).toMatch(/mcp_tool_calls_total\{tool="get_project",status="error"\} \d+/);
    expect(metrics).toMatch(/mcp_tool_duration_seconds_count\{tool="get_scene"\} \d+/);
    expect(metrics).toMatch(/mcp_sessions 1/);

    // a second agent has its own undo history
    const other = new Client({ name: 'second-agent', version: '1' });
    const otherTransport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
    await other.connect(otherTransport);
    const created = JSON.parse(
      (
        (await other.callTool({
          name: 'create_project',
          arguments: { name: 'Shared', empty: true },
        })) as ToolResult
      ).content[0].text!,
    );
    await ok('add_object', { project: created.id, type: 'cube', name: 'Mine' });
    const undo = JSON.parse(
      ((await other.callTool({ name: 'undo', arguments: { project: created.id } })) as ToolResult).content[0]
        .text!,
    );
    expect(undo.undone).toBe(0);
    expect((await ok('get_scene', { project: created.id })).objects.map((o: any) => o.name)).toEqual([
      'Mine',
    ]);
    await otherTransport.terminateSession();
    await other.close();
    await eventually(
      async () => /mcp_sessions 1/.test(await server.handle.metrics.render()),
      10_000,
      'session closed',
    );
  });
});
