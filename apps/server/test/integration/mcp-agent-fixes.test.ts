import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sharedRenderer } from '../../src/render';
import { api, eventually, makeTempDir, sleep, startServer, type TestServer } from '../helpers/app';

/*
 * Regression tests for what AI agents ran into while building projects through MCP (phase 3) and
 * for the review of the MCP server: evaluated values with stored ones, problems, instance counts,
 * keyframe paths, render-only operators, modifier schemas, batch reports, mesh data, export
 * warnings, undo across one-shot CLI calls, ghost presences, persistence, disconnects and shutdown.
 */

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = path.join(ROOT, 'scripts', 'mcp.mjs');

let server: TestServer;
let client: Client;
process.env.RENDER_WORKERS = '2';

type Content = { type: string; text?: string; data?: string; mimeType?: string; resource?: any };
type ToolResult = { content: Content[]; isError?: boolean };

async function connect(url: string, name: string, headers?: Record<string, string>) {
  const c = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } });
  await c.connect(transport);
  return { client: c, transport };
}

async function callOn(c: Client, name: string, args: Record<string, unknown> = {}) {
  const raw = (await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
  const text = raw.content.find((x) => x.type === 'text')?.text;
  let json: any = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  return { raw, json, text: raw.content.map((x) => x.text ?? '').join('\n') };
}

async function ok(name: string, args: Record<string, unknown> = {}, c = client): Promise<any> {
  const r = await callOn(c, name, args);
  if (r.raw.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.json;
}

async function fails(name: string, args: Record<string, unknown>, c = client): Promise<string> {
  const r = await callOn(c, name, args);
  expect(r.raw.isError, `${name} should fail: ${r.text}`).toBe(true);
  return r.text;
}

const op = (project: string, operator: string, params: Record<string, unknown> = {}, selection?: unknown) =>
  ok('run_operator', { project, operator, params, ...(selection ? { selection } : {}) });

const objectOf = (scene: any, name: string) => scene.objects.find((o: any) => o.name === name);

/** Runs scripts/mcp.mjs (a one-shot CLI call: one MCP session) and returns its parsed output. */
async function cli(url: string, args: string[], env: Record<string, string> = {}): Promise<any> {
  const { stdout } = await run(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, MCP_URL: `${url}/mcp`, ...env },
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  ({ client } = await connect(server.url, 'fix-agent'));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('MCP fixes for agents', () => {
  it('refuses render operators in run_operator / batch and points to the render tools (review #1, #5)', async () => {
    const { id } = await ok('create_project', { name: 'Refusals' });
    const one = await fails('run_operator', {
      project: id,
      operator: 'render.render_software',
      params: { width: 64, height: 48 },
    });
    expect(one).toMatch(/render_image/);
    expect(one).toMatch(/main thread/);
    const many = await fails('batch', {
      project: id,
      operations: [{ operator: 'render.render_animation', params: {} }],
    });
    expect(many).toMatch(/render_animation/);
    const rendering = await ok('list_operators', { category: 'Rendering' });
    expect(rendering.group.tools).toEqual(expect.arrayContaining(['render_image', 'render_animation']));
    expect(rendering.operators.some((o: any) => o.id.startsWith('render.'))).toBe(false);
    expect(rendering.operators.map((o: any) => o.id)).toEqual(
      expect.arrayContaining(['light.properties_set', 'camera.properties_set']),
    );
    // the registry's Text category and the Text feature group are both searched
    const text = await ok('list_operators', { category: 'Text' });
    expect(text.operators.map((o: any) => o.id)).toEqual(
      expect.arrayContaining(['object.text_add', 'font.text_set']),
    );
    const lights = await ok('list_operators', { category: 'Lights' });
    expect(lights.group.name).toBe('Lights and Cameras');

    // the convert hint selects the object (object.convert acts on the selection)
    await ok('add_object', { project: id, type: 'text', name: 'Title' });
    await ok('add_modifier', { project: id, object: 'Title', type: 'ARRAY' });
    await ok('add_object', { project: id, type: 'bezier_curve', name: 'Path' });
    const hint = await fails('apply_modifier', { project: id, object: 'Title', modifier: 'Array' });
    expect(hint).toContain('"selection": {"objects": ["Title"]}');
  });

  it('insert_keyframe rejects paths that do not resolve instead of keying nothing (review #3)', async () => {
    const { id } = await ok('create_project', { name: 'Paths' });
    await op(id, 'object.constraint_add', { object: 'Camera', type: 'TRACK_TO', target: 'Cube' });
    await ok('add_object', { project: id, type: 'bezier_curve', name: 'Path' });
    await ok('add_modifier', { project: id, object: 'Path', type: 'ARRAY' });
    await op(id, 'object.armature_add', { name: 'Rig' });
    const bad: [string, string, RegExp][] = [
      ['Camera', 'constraints["Nope"].influence', /no "Nope".*Track To/],
      ['Camera', 'constraints["Track To"].bogus', /no property 'bogus'/],
      ['Path', 'modifiers["Nope"].count', /no "Nope"/],
      ['Path', 'modifiers["Array"].bogus', /bogus/],
      ['Cube', 'particle_systems["Nope"].count', /Nope/],
      ['Rig', 'pose.bones["Bone"].constraints["IK"].influence', /IK/],
      ['Cube', 'material.textures.base_color.procedural.scale', /does not exist/],
      ['Path', 'data.splines[5].points[9].co', /no index 5|does not exist/],
    ];
    for (const [object, property, message] of bad) {
      const err = await fails('insert_keyframe', { project: id, object, property, frame: 11, value: 1 });
      expect(err).toMatch(message);
    }
    const scene = await ok('get_object', { project: id, object: 'Camera' });
    expect(scene.animation ?? []).toEqual([]);
    expect(
      await ok('insert_keyframe', {
        project: id,
        object: 'Camera',
        property: 'constraints["Track To"].influence',
        frame: 11,
        value: 0.5,
      }),
    ).toMatchObject({ inserted: 1 });
  });

  it('reports evaluated values at a frame, with the stored values next to them (review #7, phase-3 #1 #8 #13)', async () => {
    const { id } = await ok('create_project', { name: 'Evaluated' });
    await op(id, 'object.armature_add', { name: 'Rig' });
    await op(id, 'object.shape_key_add', { object: 'Cube', name: 'Smile' });
    const key = (object: string, property: string, frame: number, value: number | number[]) =>
      ok('insert_keyframe', { project: id, object, property, frame, value, interpolation: 'LINEAR' });
    await key('Rig', 'pose.bones["Bone"].rotation_euler', 1, [0, 0, 0]);
    await key('Rig', 'pose.bones["Bone"].rotation_euler', 11, [1.2, 0, 0]);
    await key('Cube', 'shape_keys["Smile"].value', 1, 0);
    await key('Cube', 'shape_keys["Smile"].value', 11, 1);
    await key('Cube', 'location', 1, [0, 0, 0]);
    await key('Cube', 'location', 11, [10, 0, 0]);
    await op(id, 'object.constraint_add', { object: 'Camera', type: 'TRACK_TO', target: 'Cube' });
    await key('Camera', 'constraints["Track To"].influence', 1, 1);
    await key('Camera', 'constraints["Track To"].influence', 11, 0);
    // a driven rotation (stored value stays [1.5708, 0, 0])
    await ok('add_object', {
      project: id,
      type: 'light',
      name: 'Beam',
      light_type: 'SPOT',
      rotation: [1.5708, 0, 0],
    });
    await op(id, 'anim.driver_add', {
      target: 'Beam',
      path: 'rotation_euler',
      index: 2,
      expression: '(frame - 1) * tau / 24',
    });
    await key('Beam', 'data.energy', 1, 100);
    await key('Beam', 'data.energy', 11, 300);
    // the keys above were inserted at different values than the stored ones: move the stored ones
    await ok('transform_object', { project: id, object: 'Cube', location: [0, 0, 3] });

    const scene = await ok('get_scene', { project: id, frame: 11 });
    const cube = objectOf(scene, 'Cube');
    expect(cube.location).toEqual([10, 0, 0]);
    expect(cube.stored).toEqual({ location: [0, 0, 3] });
    expect(cube.data.shape_keys).toEqual([{ name: 'Smile', value: 1, stored_value: 0 }]);
    expect(objectOf(scene, 'Rig').data.posed_bones).toBe(1);
    const cam = objectOf(scene, 'Camera');
    expect(cam.constraints[0]).toMatchObject({ influence: 0, stored_influence: 1 });

    const beam = await ok('get_object', { project: id, object: 'Beam', frame: 7 });
    expect(beam.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 3);
    expect(beam.stored).toEqual({ rotation_euler: [1.5708, 0, 0] });
    expect(beam.world_transform.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 3);
    expect(beam.data).toMatchObject({ kind: 'light', light: 'Beam', type: 'SPOT', stored: { energy: 1000 } });
    expect(beam.data.energy).toBeCloseTo(220, 0);
    const rig = await ok('get_object', { project: id, object: 'Rig', frame: 11 });
    expect(rig.data.pose.Bone.rotation_euler[0]).toBeCloseTo(1.2, 4);
    const mid = await ok('get_object', { project: id, object: 'Camera', frame: 6 });
    expect(mid.constraints[0].influence).toBeCloseTo(0.5, 3);
    // constraints move the world transform, not the local one
    const tracked = await ok('get_object', { project: id, object: 'Camera', frame: 1 });
    expect(tracked.world_transform.rotation_euler).not.toEqual(tracked.rotation_euler);
  });

  it('lists constraint and modifier errors as problems, by name (review #8)', async () => {
    const { id } = await ok('create_project', { name: 'Problems' });
    await ok('add_object', { project: id, type: 'cube', name: 'Box' });
    await ok('add_object', { project: id, type: 'uv_sphere', name: 'Target' });
    await op(id, 'object.constraint_add', { object: 'Box', type: 'COPY_LOCATION', target: 'Target' });
    await op(id, 'object.constraint_add', { object: 'Target', type: 'COPY_LOCATION', target: 'Box' });
    await ok('add_modifier', { project: id, object: 'Cube', type: 'ARMATURE', params: { object: 'Box' } });
    // only one object listed: the problems still cover all of them
    const scene = await ok('get_scene', { project: id, max_objects: 1 });
    expect(scene.problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'constraint', message: expect.stringMatching(/cycle/) }),
        expect.objectContaining({ source: 'modifier', object: 'Cube', modifier: 'Armature' }),
      ]),
    );
    const cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(cube.modifier_errors[0]).toMatchObject({ modifier: 'Armature' });
  });

  it('counts the instances renders show and bounds material users (review #9, #12)', async () => {
    const { id } = await ok('create_project', { name: 'Scatter', empty: true });
    await ok('add_object', { project: id, type: 'grid', name: 'Ground', params: { size: 20 } });
    await ok('add_object', { project: id, type: 'ico_sphere', name: 'Pebble' });
    await ok('set_material', { project: id, object: 'Pebble', name: 'Stone' });
    await op(id, 'object.scatter_add', { surface: 'Ground', objects: ['Pebble'], count: 400 });
    await op(id, 'object.particle_system_update', { object: 'Ground', settings: { display_percentage: 10 } });
    let scene = await ok('get_scene', { project: id });
    expect(scene.counts.instances).toBe(400);
    expect(scene.counts.viewport_instances).toBe(40);
    expect(objectOf(scene, 'Ground').particle_systems[0]).toMatchObject({ count: 400, instances: 400 });
    expect(scene.counts.instance_triangles).toBeGreaterThan(0);

    await op(id, 'object.duplicates_make_real', { objects: ['Ground'] });
    scene = await ok('get_scene', { project: id, max_objects: 5 });
    const stone = scene.materials.find((m: any) => m.name === 'Stone');
    expect(stone.users).toHaveLength(24);
    expect(stone.users_total).toBe(401);
  });

  it('forgets the stored renders of a deleted project (review #14)', async () => {
    const { id } = await ok('create_project', { name: 'Stored' });
    const anim = await callOn(client, 'render_animation', {
      project: id,
      format: 'GIF',
      engine: 'RASTER',
      frame_start: 1,
      frame_end: 2,
      width: 32,
      store: true,
    });
    const url = JSON.parse(anim.raw.content.find((c) => c.type === 'text')!.text!).download_urls[0];
    expect((await fetch(url)).status).toBe(200);
    await ok('delete_project', { project: id, confirm: true });
    expect((await fetch(url)).status).toBe(404);
  });

  it('batch returns the reports (warnings) of every operation (phase-3 #28)', async () => {
    const { id } = await ok('create_project', { name: 'Batch' });
    await ok('transform_object', { project: id, object: 'Cube', scale: [2, 1, 1] });
    const single = await op(id, 'material.preset_apply', { preset: 'wood', objects: ['Cube'] });
    expect(single.reports.some((r: any) => r.level === 'WARNING')).toBe(true);
    const out = await ok('batch', {
      project: id,
      operations: [
        { operator: 'material.preset_apply', params: { preset: 'wood', objects: ['Cube'] } },
        { operator: 'object.empty_add', params: { name: 'Marker' } },
      ],
    });
    expect(out.results[0].reports).toEqual(single.reports);
    expect(out.results[1].reports).toBeUndefined();
    expect(out.operations_with_warnings).toBe(1);
  });

  it('passes misspelled operator parameters to the operator, which rejects them (phase-3 #14)', async () => {
    const { id } = await ok('create_project', { name: 'Typos', empty: true });
    const typo = await fails('run_operator', {
      project: id,
      operator: 'mesh.primitive_cylinder_add',
      params: { name: 'TypoCyl', radius: 0.5, dept: 0.2 },
    });
    expect(typo).toMatch(/unknown parameter 'dept' \(did you mean 'depth'\?\)/);
    const batch = await fails('batch', {
      project: id,
      operations: [{ operator: 'object.empty_add', params: { name: 'B2', bogus: 1 } }],
    });
    expect(batch).toMatch(/bogus/);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(0);
  });

  it('counts base and evaluated geometry separately (phase-3 #37)', async () => {
    const { id } = await ok('create_project', { name: 'Counts' });
    await ok('add_modifier', { project: id, object: 'Cube', type: 'SUBSURF', params: { levels: 2 } });
    await ok('add_object', {
      project: id,
      type: 'text',
      name: 'Label',
      params: { body: 'Hi', extrude: 0.1 },
    });
    const { counts } = await ok('get_scene', { project: id });
    expect(counts).toMatchObject({ vertices: 8, faces: 6 });
    expect(counts.evaluated.faces).toBeGreaterThan(96);
    expect(counts.evaluated.vertices).toBeGreaterThan(98);
    const stats = await op(id, 'scene.stats');
    expect(counts.evaluated).toMatchObject({
      vertices: stats.result.geometry.vertices,
      faces: stats.result.geometry.faces,
      triangles: stats.result.geometry.triangles,
    });
  });

  it('gives modifier parameter schemas up front and with every parameter error (phase-3 #2, #39)', async () => {
    const { id } = await ok('create_project', { name: 'Modifiers' });
    const unknown = await fails('add_modifier', {
      project: id,
      object: 'Cube',
      type: 'SCREW',
      params: { bogus: 1, stpes: 4 },
    });
    expect(unknown).toMatch(/Unknown parameters 'bogus', 'stpes'/);
    expect(unknown).toMatch(/'stpes' → 'steps'/);
    expect(unknown).toMatch(/JSON schema/);
    expect(unknown).toContain('"enum":["X","Y","Z"]');
    const invalid = await fails('add_modifier', {
      project: id,
      object: 'Cube',
      type: 'SCREW',
      params: { axis: 'W' },
    });
    expect(invalid).toContain('"enum":["X","Y","Z"]');
    // curve and text stacks (edited without the core operators) reject unknown keys too
    await ok('add_object', { project: id, type: 'text', name: 'Label' });
    expect(
      await fails('add_modifier', { project: id, object: 'Label', type: 'ARRAY', params: { cnt: 3 } }),
    ).toMatch(/'cnt' → 'count'/);
    const mod = await ok('add_modifier', {
      project: id,
      object: 'Cube',
      type: 'SCREW',
      params: { steps: 8 },
    });
    expect(
      await fails('update_modifier', {
        project: id,
        object: 'Cube',
        modifier: mod.modifier.name,
        params: { angel: 1 },
      }),
    ).toMatch(/'angel' → 'angle'/);

    const all = await ok('list_modifier_types');
    expect(all.types.map((t: any) => t.type)).toEqual(expect.arrayContaining(['SCREW', 'SUBSURF', 'BEVEL']));
    const screw = await ok('list_modifier_types', { type: 'screw' });
    expect(screw.types).toHaveLength(1);
    expect(screw.types[0].parameters.properties.axis).toMatchObject({ enum: ['X', 'Y', 'Z'], default: 'Z' });
    const bySub = await ok('list_modifier_types', { type: 'Subdivision Surface' });
    expect(bySub.types[0].type).toBe('SUBSURF');
    expect((await ok('list_operators', { category: 'Modifiers' })).group.tools).toContain(
      'list_modifier_types',
    );
  });

  it('surfaces exporter warnings in the export_scene result (phase-3 #21)', async () => {
    const { id } = await ok('create_project', { name: 'Export' });
    await ok('add_object', { project: id, type: 'light', name: 'Softbox', light_type: 'AREA' });
    const r = await callOn(client, 'export_scene', { project: id, format: 'glb' });
    const info = JSON.parse(r.raw.content.find((c) => c.type === 'text')!.text!);
    expect(info.warnings.join('\n')).toMatch(/Area light 'Softbox'/);
    const obj = await callOn(client, 'export_scene', { project: id, format: 'obj' });
    expect(JSON.parse(obj.raw.content[0].text!).warnings).toEqual([]);
  });

  it('reads mesh geometry in pages, in object or world space, with a heightmap (phase-3 #6)', async () => {
    const { id } = await ok('create_project', { name: 'Mesh data', empty: true });
    await ok('add_object', {
      project: id,
      type: 'grid',
      name: 'Ground',
      params: { x_subdivisions: 10, y_subdivisions: 10, size: 10 },
      location: [100, 0, 2],
    });
    await ok('set_material', { project: id, object: 'Ground', name: 'Grass' });
    await ok('set_material', { project: id, object: 'Ground', name: 'Sand', slot: 1 });
    await ok('edit_mesh', {
      project: id,
      object: 'Ground',
      operator: 'object.material_slot_assign',
      params: { index: 1 },
      selection: { faces: [0, 1] },
    });
    const page = await ok('get_mesh_data', { project: id, object: 'Ground', limit: 50 });
    expect(page.face_materials.slice(0, 3)).toEqual([1, 1, 0]);
    expect(page.totals.vertices).toBeGreaterThan(50);
    expect(page.vertices).toHaveLength(50);
    expect(page.faces).toHaveLength(50);
    expect(page.face_materials).toHaveLength(50);
    expect(page.material_slots).toEqual(['Grass', 'Sand']);
    expect(page.truncated).toBe(true);
    expect(page.next).toEqual({ vertex_offset: 50, face_offset: 50 });
    const rest = await ok('get_mesh_data', {
      project: id,
      object: 'Ground',
      vertex_offset: 50,
      face_offset: 50,
      limit: 20_000,
      include: ['vertices', 'faces'],
    });
    expect(page.vertices.length + rest.vertices.length).toBe(page.totals.vertices);
    expect(rest.next).toBeUndefined();
    // world space adds the object location; normals face up
    const world = await ok('get_mesh_data', {
      project: id,
      object: 'Ground',
      space: 'WORLD',
      include: ['vertices', 'face_normals'],
      limit: 1,
    });
    expect(world.vertices[0][0]).toBeCloseTo(page.vertices[0][0] + 100, 3);
    expect(world.vertices[0][2]).toBeCloseTo(2, 3);
    expect(world.face_normals[0]).toEqual([0, 0, 1]);
    const hm = await ok('get_mesh_data', {
      project: id,
      object: 'Ground',
      include: ['heightmap'],
      heightmap_resolution: 16,
    });
    expect(hm.heightmap.samples).toEqual([16, 16]);
    expect(hm.heightmap.heights[8][8]).toBeCloseTo(2, 3);
    expect(hm.heightmap.min_xy[0]).toBeCloseTo(95, 3);
    // evaluated geometry of a text object; base data needs a mesh
    await ok('add_object', { project: id, type: 'text', name: 'Label', params: { body: 'A', extrude: 0.1 } });
    const text = await ok('get_mesh_data', { project: id, object: 'Label', include: ['vertices'] });
    expect(text.source).toBe('EVALUATED');
    expect(text.totals.faces).toBeGreaterThan(0);
    expect(await fails('get_mesh_data', { project: id, object: 'Label', source: 'BASE' })).toMatch(
      /EVALUATED/,
    );
  });

  it('render_image view: fov_degrees is the vertical angle, lens matches a Blender camera (phase-3 #9, #27)', async () => {
    const tools = (await client.listTools()).tools;
    const view = (tools.find((t) => t.name === 'render_image')!.inputSchema.properties as any).view;
    expect(view.properties.fov_degrees.description).toMatch(/VERTICAL/);
    expect(view.properties.lens.description).toMatch(/mm/);
    const { id } = await ok('create_project', { name: 'Fov' });
    const shot = async (v: Record<string, unknown>) => {
      const r = await callOn(client, 'render_image', {
        project: id,
        width: 120,
        height: 60,
        engine: 'RASTER',
        renderer: 'software',
        view: { position: [6, -6, 4], target: [0, 0, 0], ...v },
      });
      expect(r.raw.isError).toBeFalsy();
      return r.raw.content.find((c) => c.type === 'image')!.data;
    };
    // 50 mm on a 36 mm sensor across the 2:1 image's width: vertical fov = 2·atan(18/50 · 1/2)
    const vertical = (2 * Math.atan((18 / 50) * 0.5) * 180) / Math.PI;
    expect(await shot({ lens: 50 })).toBe(await shot({ fov_degrees: vertical }));
    expect(await shot({ lens: 50 })).not.toBe(
      await shot({ fov_degrees: 2 * Math.atan(18 / 50) * (180 / Math.PI) }),
    );
    expect(
      await fails('render_image', {
        project: id,
        view: { position: [1, 1, 1], target: [0, 0, 0], lens: 50, fov_degrees: 30 },
      }),
    ).toMatch(/either/);
  });

  it('shows light and camera data and edits them by object name (phase-3 #25, #32)', async () => {
    const { id } = await ok('create_project', { name: 'Lights' });
    await ok('add_object', { project: id, type: 'light', name: 'Key', light_type: 'AREA' });
    await op(id, 'light.properties_set', {
      object: 'Key',
      shape: 'RECTANGLE',
      size: 2,
      size_y: 0.5,
      energy: 800,
    });
    await op(id, 'camera.properties_set', { object: 'Camera', dof_use: true, dof_focus_distance: 4 });
    const scene = await ok('get_scene', { project: id });
    expect(objectOf(scene, 'Key').data).toMatchObject({
      kind: 'light',
      light: 'Key',
      type: 'AREA',
      shape: 'RECTANGLE',
      size: 2,
      size_y: 0.5,
      energy: 800,
    });
    expect(objectOf(scene, 'Camera').data).toMatchObject({
      kind: 'camera',
      dof_use: true,
      dof_focus_distance: 4,
    });
    const cam = await ok('get_object', { project: id, object: 'Camera' });
    expect(cam.data.id).toEqual(expect.any(String));
    const tools = (await client.listTools()).tools;
    const describe = (n: string) => tools.find((t) => t.name === n)!.description!;
    expect(describe('add_object')).toMatch(/light\.properties_set/);
    expect(describe('set_scene_settings')).toMatch(/camera\.properties_set/);
    expect(client.getInstructions()).toMatch(/light\.properties_set/);
  });

  it('keeps one undo history across one-shot CLI calls and leaves no ghost presence (phase-3 #38, #41)', async () => {
    const { id } = await ok('create_project', { name: 'CLI history' });
    const added = await cli(server.url, [
      'call',
      'add_object',
      JSON.stringify({ project: id, type: 'uv_sphere', name: 'BA' }),
    ]);
    expect(added.result.object.name).toBe('BA');
    const undone = await cli(server.url, ['call', 'undo', JSON.stringify({ project: id })]);
    expect(undone.result).toMatchObject({ undone: 1, can_redo: true });
    expect((await ok('get_scene', { project: id })).objects.some((o: any) => o.name === 'BA')).toBe(false);
    const redone = await cli(server.url, ['call', 'redo', JSON.stringify({ project: id })]);
    expect(redone.result).toMatchObject({ redone: 1 });
    // another agent id has its own history
    const other = await cli(server.url, ['call', 'undo', JSON.stringify({ project: id })], {
      MCP_AGENT_ID: 'someone-else',
    });
    expect(other.result).toMatchObject({ undone: 0 });
    expect(other.result.note).toMatch(/agent id 'someone-else'/);
    // the CLI ends its sessions (HTTP DELETE): no presence is left behind
    const clients = await ok('get_connected_clients', { project: id });
    expect(clients.presence.map((p: any) => p.name)).toEqual(['AI agent (fix-agent)']);

    // sessions sending the same agent id share the history; a session without one does not
    const a = await connect(server.url, 'a', { 'x-mcp-agent-id': 'agent-a' });
    await ok('add_object', { project: id, type: 'cube', name: 'FromA' }, a.client);
    await a.transport.terminateSession();
    await a.client.close();
    const b = await connect(server.url, 'b', { 'x-mcp-agent-id': 'agent-a' });
    expect(await ok('undo', { project: id }, b.client)).toMatchObject({ undone: 1 });
    await b.client.close();
    const anon = await connect(server.url, 'anon');
    const nothing = await ok('undo', { project: id }, anon.client);
    expect(nothing).toMatchObject({ undone: 0 });
    expect(nothing.note).toMatch(/x-mcp-agent-id/);
    await anon.client.close();
    // malformed ids are refused at initialization
    await expect(connect(server.url, 'bad', { 'x-mcp-agent-id': 'no spaces allowed' })).rejects.toThrow();
  });

  it('hides the presence of a session that went quiet and shows it again with its next call (phase-3 #41)', async () => {
    const quiet = await startServer({}, { mcpPresenceIdleMs: 300 });
    try {
      const watcher = await connect(quiet.url, 'watcher');
      const sleeper = await connect(quiet.url, 'sleeper');
      const { id } = await ok('create_project', { name: 'Presence' }, watcher.client);
      await ok('get_project', { project: id }, sleeper.client);
      const names = async () =>
        (await ok('get_connected_clients', { project: id }, watcher.client)).presence.map((p: any) => p.name);
      expect(await names()).toContain('AI agent (sleeper)');
      // a client that goes away without ending its session (killed agent, CLI without DELETE)
      const sessionId = sleeper.transport.sessionId!;
      await sleeper.client.close();
      await eventually(
        async () => !(await names()).includes('AI agent (sleeper)'),
        8000,
        'the quiet presence to go',
      );
      expect(quiet.handle.mcp!.size).toBe(2);
      // the session is still there: its next request shows the presence again
      const res = await fetch(`${quiet.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-session-id': sessionId,
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: { name: 'get_scene', arguments: { project: id } },
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      expect(await names()).toContain('AI agent (sleeper)');
      await watcher.client.close();
    } finally {
      await quiet.close();
      await quiet.cleanup();
    }
  });

  it('persists projects to DATA_DIR when only DATA_DIR is configured (phase-3 #22)', async () => {
    const dataDir = await makeTempDir();
    let s = await startServer({ SYNC_PERSISTENCE: '', DATA_DIR: dataDir });
    let id: string;
    try {
      const c = await connect(s.url, 'persist');
      ({ id } = await ok('create_project', { name: 'Kept' }, c.client));
      const info = await ok('get_project', { project: id }, c.client);
      expect(info).toMatchObject({ persistence: 'disk', stored_at: dataDir });
      expect(info.persistence_note).toMatch(/survive server restarts/);
      await c.client.close();
    } finally {
      await s.close();
    }
    s = await startServer({ SYNC_PERSISTENCE: '', DATA_DIR: dataDir });
    try {
      const list = await api(s.url, '/api/projects');
      expect(list.body.projects.map((p: any) => p.id)).toContain(id);
    } finally {
      await s.close();
      await s.cleanup();
    }
    // memory mode says so
    const mem = await ok('get_project', { project: (await ok('create_project', { name: 'Volatile' })).id });
    expect(mem.persistence).toBe('memory');
    expect(mem.persistence_note).toMatch(/lost when the server stops/);
  });

  it('cancels the render of a client that disconnects without cancelling (review #6)', async () => {
    const { id } = await ok('create_project', { name: 'Orphan' });
    const pool = sharedRenderer().pool;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { connect } = await import(${JSON.stringify(CLI)});
         const m = await connect(${JSON.stringify(`${server.url}/mcp`)});
         await m.call('render_image', { project: ${JSON.stringify(id)}, engine: 'PATHTRACER', width: 200, height: 150, samples: 4096, time_limit: 60 });`,
      ],
      { stdio: 'ignore' },
    );
    try {
      await eventually(() => pool.activeLongRenders >= 1, 30_000, 'the render to start');
    } finally {
      child.kill('SIGKILL');
    }
    await eventually(() => pool.activeLongRenders === 0, 10_000, 'the orphaned render to stop');
  });

  it('stops REST path traced renders when the server shuts down (review #10)', async () => {
    const s = await startServer({});
    const created = await api(s.url, '/api/projects', { method: 'POST', json: { name: 'Shutdown' } });
    const render = fetch(
      `${s.url}/api/projects/${created.body.id}/render.png?engine=PATHTRACER&width=200&samples=4096&time_limit=120`,
    ).then(
      (r) => r.status,
      () => 'failed',
    );
    await eventually(() => sharedRenderer().pool.activeLongRenders >= 1, 30_000, 'the render to start');
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect([503, 499, 'failed']).toContain(await render);
    await s.cleanup();
    await sleep(10);
  });
});
