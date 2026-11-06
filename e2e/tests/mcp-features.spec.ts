import { test, expect } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  PLAIN,
  callJson,
  decodePng,
  imageStats,
  mcpConnect,
  mcpEndSession,
  openProject,
  toolImage,
  toolText,
} from './helpers';

/** Creates a project with Blender's startup scene through MCP (names are unique per server). */
async function createProject(client: Client, title: string): Promise<string> {
  const p = await callJson(client, 'create_project', { name: `${title} ${Date.now()}` });
  return p.id as string;
}

/** Calls a tool that must fail and returns its error text. */
async function toolError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean };
  expect(res.isError, `${name} should fail`).toBe(true);
  return toolText(res);
}

/** Keys the default cube from [0, 0, 0] at frame 1 to [3, 0, 1] at frame 10 and ends the scene there. */
async function animateCube(client: Client, project: string): Promise<void> {
  const key = (frame: number, value: number[]) =>
    callJson(client, 'insert_keyframe', { project, object: 'Cube', property: 'location', frame, value });
  await key(1, [0, 0, 0]);
  await key(10, [3, 0, 1]);
  await callJson(client, 'set_scene_settings', { project, frame_end: 10 });
}

test.describe('MCP features', () => {
  test('strict arguments: misspelled names are rejected with suggestions and change nothing', async () => {
    const client = await mcpConnect(PLAIN);
    const project = await createProject(client, 'strict');

    expect(await toolError(client, 'set_scene_settings', { project, sampels: 5 })).toContain(
      "unknown argument 'sampels' (did you mean 'samples'?)",
    );
    const nested = await toolError(client, 'render_image', {
      project,
      view: { position: [5, -5, 3], target: [0, 0, 0], fov: 40 },
    });
    expect(nested).toContain("unknown key 'fov' (did you mean 'lens' or 'fov_degrees'?)");
    expect(nested).toContain('at view');
    const params = await toolError(client, 'add_object', { project, type: 'cube', sizee: 3 });
    expect(params).toContain("unknown argument 'sizee'");
    expect(params).toContain('go inside `params`');
    const batch = await toolError(client, 'batch', {
      project,
      operations: [{ operator: 'mesh.primitive_cube_add', parms: { size: 1 } }],
    });
    expect(batch).toContain("'parms'");

    // operator parameters are checked by the operator registry, at every level
    const op = await toolError(client, 'run_operator', {
      project,
      operator: 'mesh.primitive_cylinder_add',
      params: { raduis: 2 },
    });
    expect(op.split('\n')[0]).toContain("unknown parameter 'raduis' (did you mean 'radius'?)");
    expect(JSON.parse(op.slice(op.indexOf('{')))).toMatchObject({ ok: false, code: 'INVALID_PARAMS' });
    expect(
      await toolError(client, 'run_operator', { project, operator: 'mesh.primitive_cylindr_add' }),
    ).toContain('mesh.primitive_cylinder_add');

    // nothing was applied and nothing can be undone
    const scene = await callJson(client, 'get_scene', { project });
    expect(scene.objects.map((o: { name: string }) => o.name).sort()).toEqual(['Camera', 'Cube', 'Light']);
    expect(scene.render.samples).toBe(64);
    expect(await callJson(client, 'undo', { project })).toMatchObject({ undone: 0, can_undo: false });
    await client.close();
  });

  test('get_mesh_data and get_instances read base, evaluated and instanced geometry', async () => {
    const client = await mcpConnect(PLAIN);
    const project = await createProject(client, 'mesh data');

    const base = await callJson(client, 'get_mesh_data', {
      project,
      object: 'Cube',
      include: ['vertices', 'faces', 'face_normals'],
      space: 'WORLD',
    });
    expect(base).toMatchObject({ source: 'BASE', totals: { vertices: 8, faces: 6, triangles: 12 } });
    expect(base.faces).toHaveLength(6);
    expect(base.face_normals.map((n: number[]) => Math.hypot(...n))).toEqual([1, 1, 1, 1, 1, 1]);

    // world space follows the object, base indices stay; a modifier changes the evaluated mesh only
    await callJson(client, 'transform_object', { project, object: 'Cube', location: [0, 0, 3] });
    await callJson(client, 'add_modifier', {
      project,
      object: 'Cube',
      type: 'SUBSURF',
      params: { levels: 1 },
    });
    const world = await callJson(client, 'get_mesh_data', { project, object: 'Cube', space: 'WORLD' });
    expect(world.totals.vertices).toBe(8);
    expect(world.vertices.map((v: number[]) => v[2]).sort()).toEqual([2, 2, 2, 2, 4, 4, 4, 4]);
    const evaluated = await callJson(client, 'get_mesh_data', {
      project,
      object: 'Cube',
      source: 'EVALUATED',
      include: [],
    });
    expect(evaluated.totals).toMatchObject({ vertices: 26, faces: 24 });

    // a curve's surface, paged
    await callJson(client, 'add_object', {
      project,
      type: 'bezier_curve',
      name: 'Tube',
      params: { bevel_depth: 0.1 },
    });
    const tube = await callJson(client, 'get_mesh_data', { project, object: 'Tube', limit: 5 });
    expect(tube).toMatchObject({
      type: 'CURVE',
      source: 'EVALUATED',
      totals: { vertices: 156, faces: 144, triangles: 288 },
      truncated: true,
      next: { vertex_offset: 5, face_offset: 5 },
    });
    expect(tube.vertices).toHaveLength(5);

    // instances of a collection instance, in world space
    const none = await callJson(client, 'get_instances', { project, object: 'Cube' }).catch((e: Error) => e);
    expect(String(none)).toContain('generates no instances');
    await callJson(client, 'run_operator', {
      project,
      operator: 'object.move_to_collection',
      params: { new_collection_name: 'Props' },
      selection: { objects: ['Cube'] },
    });
    await callJson(client, 'run_operator', {
      project,
      operator: 'object.collection_instance_add',
      params: { collection: 'Props', name: 'PropsInstance', location: [10, 0, 0] },
    });
    const inst = await callJson(client, 'get_instances', { project, object: 'PropsInstance' });
    expect(inst).toMatchObject({ instance_collection: 'Props', collection_instances: 1, total: 1 });
    expect(inst.instances).toEqual([
      expect.objectContaining({
        collection: 'Props',
        source: 'Cube',
        location: [10, 0, 3],
        scale: [1, 1, 1],
      }),
    ]);
    await client.close();
  });

  test('render_image path traces on the server; render_animation makes a contact sheet', async () => {
    const client = await mcpConnect(PLAIN);
    const project = await createProject(client, 'renders');

    const args = {
      project,
      engine: 'PATHTRACER',
      width: 64,
      height: 36,
      samples: 4,
      seed: 7,
      time_limit: 60,
    };
    const res = await client.callTool({ name: 'render_image', arguments: args });
    const png = toolImage(res);
    const meta = JSON.parse(toolText(res));
    expect(meta).toMatchObject({
      renderer: 'software',
      engine: 'PATHTRACER',
      width: 64,
      height: 36,
      samples: 4,
      requested_samples: 4,
    });
    const img = decodePng(png);
    expect([img.width, img.height]).toEqual([64, 36]);
    const stats = imageStats(img);
    expect(stats.std).toBeGreaterThan(5);
    expect(stats.colors).toBeGreaterThan(8);
    // samples are pure functions of pixel, sample and seed: the same request gives the same picture
    const again = toolImage(await client.callTool({ name: 'render_image', arguments: args }));
    expect(Buffer.from(decodePng(again).data).equals(Buffer.from(img.data))).toBe(true);

    await animateCube(client, project);
    const sheet = await client.callTool({
      name: 'render_animation',
      arguments: {
        project,
        format: 'CONTACT_SHEET',
        engine: 'RASTER',
        frame_start: 1,
        frame_end: 10,
        frame_step: 3,
        width: 64,
        height: 36,
      },
    });
    const info = JSON.parse(toolText(sheet));
    expect(info).toMatchObject({
      format: 'CONTACT_SHEET',
      engine: 'RASTER',
      frames: [1, 4, 7, 10],
      frame_count: 4,
      truncated: false,
      width: 64,
      height: 36,
      sheet: { columns: 2, rows: 2 },
    });
    const grid = decodePng(toolImage(sheet));
    expect([grid.width, grid.height]).toEqual([info.sheet.width, info.sheet.height]);
    expect(grid.width).toBeGreaterThanOrEqual(2 * 64);
    expect(grid.height).toBeGreaterThanOrEqual(2 * 36);
    expect(imageStats(grid).std).toBeGreaterThan(5);
    await client.close();
  });

  test('export_scene: a glb of an animated scene carries the animation', async ({ request }) => {
    const client = await mcpConnect(PLAIN);
    const project = await createProject(client, 'export');
    await animateCube(client, project);

    const res = (await client.callTool({ name: 'export_scene', arguments: { project, format: 'glb' } })) as {
      content: { type: string; resource?: { mimeType: string; blob: string } }[];
    };
    const info = JSON.parse(toolText(res));
    expect(info).toMatchObject({ format: 'glb', mime: 'model/gltf-binary', frame: 1, warnings: [] });
    const resource = res.content.find((c) => c.type === 'resource')!.resource!;
    expect(resource.mimeType).toBe('model/gltf-binary');
    const glb = Buffer.from(resource.blob, 'base64');
    expect(glb.length).toBe(info.bytes);

    // GLB: header, JSON chunk, BIN chunk
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
    expect(glb.readUInt32LE(4)).toBe(2);
    const jsonLength = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
    const binStart = 20 + jsonLength + 8;
    const cube = gltf.nodes.findIndex((n: { name: string }) => n.name === 'Cube');
    expect(cube).toBeGreaterThanOrEqual(0);
    const anim = gltf.animations[0];
    const channel = anim.channels.find(
      (c: { target: { node: number; path: string } }) =>
        c.target.node === cube && c.target.path === 'translation',
    );
    expect(channel).toBeDefined();
    // sampled once per frame over the scene range (1..10 at 24 fps)
    const sampler = anim.samplers[channel.sampler];
    const times = gltf.accessors[sampler.input];
    expect(times.count).toBe(10);
    expect(times.max[0] - times.min[0]).toBeCloseTo(9 / 24, 5);
    // the last key is Blender's [3, 0, 1] in glTF's Y-up axes: [3, 1, -0]
    const out = gltf.accessors[sampler.output];
    expect(out.type).toBe('VEC3');
    const view = gltf.bufferViews[out.bufferView];
    const offset = binStart + (view.byteOffset ?? 0) + (out.byteOffset ?? 0) + (out.count - 1) * 12;
    const last = [0, 1, 2].map((i) => glb.readFloatLE(offset + 4 * i));
    expect(last[0]).toBeCloseTo(3, 4);
    expect(last[1]).toBeCloseTo(1, 4);
    expect(last[2]).toBeCloseTo(0, 4);

    // the download link exports the same file again
    const download = await request.get(info.download_url);
    expect(download.ok()).toBe(true);
    expect(Buffer.from(await download.body()).equals(glb)).toBe(true);
    await client.close();
  });

  test('undo across sessions that send the same agent id, seen live in an open editor', async ({ page }) => {
    const setup = await mcpConnect(PLAIN);
    const project = await createProject(setup, 'undo');
    await setup.close();
    await openProject(page, PLAIN, project);
    await expect(page.getByTestId('outliner-Cube')).toBeVisible();

    const agentId = `e2e-cli-${Date.now()}`;
    // a one-shot CLI call: its own session, ended right after
    const first = await mcpConnect(PLAIN, { agentId, name: 'e2e-cli' });
    await callJson(first, 'add_object', { project, type: 'uv_sphere', name: 'Ball' });
    await mcpEndSession(first);
    await expect(page.getByTestId('outliner-Ball')).toBeVisible();

    // another agent cannot undo it
    const other = await mcpConnect(PLAIN, { agentId: `${agentId}-other`, agentIdVia: 'query' });
    const nothing = await callJson(other, 'undo', { project });
    expect(nothing).toMatchObject({ undone: 0, can_undo: false });
    expect(nothing.note).toContain(`${agentId}-other`);
    await mcpEndSession(other);
    await expect(page.getByTestId('outliner-Ball')).toBeVisible();

    // the next call with the same id (here as ?agent=) undoes the previous session's change
    const second = await mcpConnect(PLAIN, { agentId, agentIdVia: 'query', name: 'e2e-cli' });
    expect(await callJson(second, 'undo', { project })).toEqual({
      undone: 1,
      can_undo: false,
      can_redo: true,
    });
    await expect(page.getByTestId('outliner-Ball')).toHaveCount(0);
    expect(await callJson(second, 'redo', { project })).toEqual({
      redone: 1,
      can_undo: true,
      can_redo: false,
    });
    await expect(page.getByTestId('outliner-Ball')).toBeVisible();
    const clients = await callJson(second, 'get_connected_clients', { project });
    expect(clients.presence).toContainEqual(expect.objectContaining({ you: true, agent_id: agentId }));
    await mcpEndSession(second);
  });
});
