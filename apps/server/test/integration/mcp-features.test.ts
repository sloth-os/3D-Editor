import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decodePNG } from '@3d-editor/core';
import { sharedRenderer } from '../../src/render';
import { api, startServer, type TestServer } from '../helpers/app';

/*
 * MCP tools with the features added on top of the mesh editor: curves and text, constraints,
 * particle scattering, armatures with IK and skinning, shape keys, drivers, rigid body physics,
 * path traced renders on render worker threads and animation renders.
 */

let server: TestServer;
let client: Client;
// the process-wide renderer (used by the MCP tools and the REST API) with two worker threads
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

async function call(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ raw: ToolResult; json: any }> {
  const raw = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })) as ToolResult;
  const text = raw.content.find((c) => c.type === 'text')?.text;
  const parse = (t: string | undefined): any => {
    try {
      return t ? JSON.parse(t) : null;
    } catch {
      return t;
    }
  };
  return { raw, json: parse(text) };
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

const op = (project: string, operator: string, params: Record<string, unknown> = {}) =>
  ok('run_operator', { project, operator, params });

const objectOf = (scene: any, name: string) => scene.objects.find((o: any) => o.name === name);

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'feature-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('MCP feature integration', () => {
  it('describes curves and text, keys curve data and edits modifier stacks of curves', async () => {
    const { id } = await ok('create_project', { name: 'Curves', empty: true });
    await op(id, 'curve.primitive_bezier_curve_add', { name: 'Path', bevel_depth: 0.05 });
    await op(id, 'object.text_add', { name: 'Title', body: 'Hello MCP', extrude: 0.05, location: [0, 2, 0] });
    await op(id, 'curve.primitive_bezier_circle_add', { name: 'Profile', radius: 0.1 });
    await op(id, 'curve.primitive_poly_add', {
      name: 'Rail',
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [2, 2, 0],
      ],
    });
    await op(id, 'curve.properties_set', { object: 'Rail', bevel_mode: 'OBJECT', bevel_object: 'Profile' });

    const label = await ok('add_object', {
      project: id,
      type: 'text',
      name: 'Label',
      params: { body: 'Hi', size: 0.5 },
      location: [0, -2, 0],
    });
    expect(label.object).toMatchObject({ name: 'Label', type: 'FONT', location: [0, -2, 0] });
    let scene = await ok('get_scene', { project: id });
    expect(scene.counts.by_type).toMatchObject({ CURVE: 3, FONT: 2 });
    const path = objectOf(scene, 'Path');
    expect(path.data).toMatchObject({ kind: 'curve', splines: 1, points: 2, bevel_depth: 0.05 });
    expect(path.data.spline_types).toEqual({ BEZIER: 1 });
    expect(path.data.evaluated.faces).toBeGreaterThan(0);
    const title = objectOf(scene, 'Title');
    expect(title.data).toMatchObject({ kind: 'text', body: 'Hello MCP', extrude: 0.05 });
    expect(objectOf(scene, 'Rail').data.bevel_object).toBe('Profile');

    // a deleted bevel object is reported as an evaluation problem of the curve
    await ok('delete_objects', { project: id, objects: ['Profile'] });
    scene = await ok('get_scene', { project: id });
    expect(scene.problems.some((p: any) => p.source === 'curve' && p.object === 'Rail')).toBe(true);
    expect(objectOf(scene, 'Rail').problems[0]).toMatch(/bevel object/);

    // modifiers on text objects (document edits: the core operators only take meshes)
    const before = objectOf(scene, 'Title').data.evaluated.faces;
    const added = await ok('add_modifier', {
      project: id,
      object: 'Title',
      type: 'ARRAY',
      params: { count: 3 },
    });
    expect(added.modifier).toMatchObject({ type: 'ARRAY', params: { count: 3 } });
    let titleObj = await ok('get_object', { project: id, object: 'Title' });
    expect(titleObj.data.evaluated.faces).toBe(before * 3);
    await ok('update_modifier', {
      project: id,
      object: 'Title',
      modifier: added.modifier.name,
      params: { count: 2 },
    });
    titleObj = await ok('get_object', { project: id, object: 'Title' });
    expect(titleObj.data.evaluated.faces).toBe(before * 2);
    expect(
      await fails('apply_modifier', { project: id, object: 'Title', modifier: added.modifier.name }),
    ).toMatch(/object\.convert/);
    await ok('remove_modifier', { project: id, object: 'Title', modifier: added.modifier.name });
    expect((await ok('get_object', { project: id, object: 'Title' })).modifiers).toEqual([]);

    // materials on text objects
    const sign = await ok('set_material', {
      project: id,
      object: 'Title',
      name: 'Sign',
      base_color: [1, 0, 0],
    });
    expect(sign.material).toMatchObject({ name: 'Sign', base_color: [1, 0, 0, 1] });
    expect((await ok('get_object', { project: id, object: 'Title' })).materials[0].material.name).toBe(
      'Sign',
    );

    // a curve that grows: key the bevel factor of the curve data
    await ok('insert_keyframe', {
      project: id,
      object: 'Path',
      property: 'data.bevel_factor_end',
      frame: 1,
      value: 0,
    });
    const keyed = await ok('insert_keyframe', {
      project: id,
      object: 'Path',
      property: 'data.bevel_factor_end',
      frame: 20,
      value: 1,
    });
    expect(keyed).toMatchObject({ inserted: 1, target_type: 'curve' });
    const mid = await ok('get_object', { project: id, object: 'Path', frame: 10 });
    expect(mid.animation.map((a: any) => `${a.target_type}:${a.path}`)).toContain('curve:bevel_factor_end');
    expect(mid.data.bevel_factor[1]).toBeGreaterThan(0);
    expect(mid.data.bevel_factor[1]).toBeLessThan(1);
    expect(
      await fails('insert_keyframe', { project: id, object: 'Path', property: 'data.nothing', frame: 1 }),
    ).toMatch(/not animatable on curve/);
  });

  it('reports constraints with targets, influence keys and dependency cycles', async () => {
    const { id } = await ok('create_project', { name: 'Constraints', empty: true });
    await ok('add_object', { project: id, type: 'cube', name: 'Box' });
    await ok('add_object', { project: id, type: 'empty', name: 'Target', location: [4, 0, 0] });
    await ok('add_object', { project: id, type: 'camera', name: 'Cam', location: [0, -8, 2] });
    await op(id, 'object.constraint_add', { object: 'Cam', type: 'TRACK_TO', target: 'Box' });
    await op(id, 'object.constraint_add', { object: 'Box', type: 'COPY_LOCATION', target: 'Target' });
    await ok('insert_keyframe', {
      project: id,
      object: 'Box',
      property: 'constraints["Copy Location"].influence',
      frame: 1,
      value: 0,
    });
    await ok('insert_keyframe', {
      project: id,
      object: 'Box',
      property: 'constraints["Copy Location"].influence',
      frame: 11,
      value: 1,
      interpolation: 'LINEAR',
    });
    let scene = await ok('get_scene', { project: id, frame: 6 });
    const cam = objectOf(scene, 'Cam');
    expect(cam.constraints).toEqual([{ name: 'Track To', type: 'TRACK_TO', targets: ['Box'], influence: 1 }]);
    const box = objectOf(scene, 'Box');
    expect(box.constraints[0]).toMatchObject({ type: 'COPY_LOCATION', targets: ['Target'] });
    expect(box.world_bounds.center[0]).toBeCloseTo(2, 1);
    expect(box.animated).toContain('constraints["Copy Location"].influence[0]');

    // a cycle (once the keyed influence is above 0): Target copies Box which copies Target
    await op(id, 'object.constraint_add', { object: 'Target', type: 'COPY_LOCATION', target: 'Box' });
    scene = await ok('get_scene', { project: id, frame: 11 });
    const errors = [...objectOf(scene, 'Target').constraints, ...objectOf(scene, 'Box').constraints].flatMap(
      (c: any) => c.errors ?? [],
    );
    expect(errors.join(' ')).toMatch(/cycle/);
    const detail = await ok('get_object', { project: id, object: 'Box' });
    expect(detail.constraints[0]).toMatchObject({ type: 'COPY_LOCATION', params: expect.any(Object) });
  });

  it('shows particle scatters as instance counts and lists operators by feature group', async () => {
    const { id } = await ok('create_project', { name: 'Scatter', empty: true });
    await ok('add_object', { project: id, type: 'plane', name: 'Ground', params: { size: 10 } });
    await ok('add_object', {
      project: id,
      type: 'cube',
      name: 'Rock',
      params: { size: 0.2 },
      location: [0, 0, 5],
    });
    const scatter = await op(id, 'object.scatter_add', {
      surface: 'Ground',
      objects: ['Rock'],
      count: 25,
      seed: 3,
    });
    expect(scatter.ok).toBe(true);
    const scene = await ok('get_scene', { project: id });
    expect(scene.counts.instances).toBe(25);
    const ground = objectOf(scene, 'Ground');
    expect(ground.instances).toBe(25);
    expect(ground.particle_systems[0]).toMatchObject({
      count: 25,
      instance_type: 'OBJECT',
      instance_object: 'Rock',
      instances: 25,
    });

    const groups = await ok('list_operators', { category: 'Instancing' });
    expect(groups.operators.map((o: any) => o.id)).toEqual(
      expect.arrayContaining([
        'object.scatter_add',
        'object.particle_system_add',
        'object.collection_instance_add',
      ]),
    );
    expect(groups.operators[0].parameters).toBeTruthy();
    const constraints = await ok('list_operators', { category: 'constraint' });
    expect(constraints.operators.map((o: any) => o.id)).toEqual(
      expect.arrayContaining(['object.constraint_add', 'object.track_set', 'pose.ik_add']),
    );
    const physics = await ok('list_operators', { category: 'Physics' });
    expect(physics.operators.map((o: any) => o.id)).toContain('rigidbody.bake_to_keyframes');
    expect(physics.groups).toEqual(
      expect.arrayContaining(['Rigging', 'Shape Keys', 'Drivers', 'Generators']),
    );
    expect(await fails('list_operators', { category: 'Nonsense' })).toMatch(
      /Unknown category.*Feature groups/s,
    );
  });

  it('rigs a mesh: armature, automatic weights, IK, pose keys, shape keys and drivers', async () => {
    const { id } = await ok('create_project', { name: 'Rig', empty: true });
    await ok('add_object', {
      project: id,
      type: 'cylinder',
      name: 'Arm',
      params: { vertices: 8, depth: 2, radius: 0.2 },
      location: [0, 0, 1],
    });
    await ok('edit_mesh', {
      project: id,
      object: 'Arm',
      operator: 'mesh.subdivide',
      params: { number_cuts: 3 },
    });
    await op(id, 'object.armature_add', { name: 'Rig', bone_name: 'Root' });
    await op(id, 'armature.bone_remove', { object: 'Rig', bones: ['Root'] });
    await op(id, 'armature.chain_add', {
      object: 'Rig',
      points: [
        [0, 0, 0],
        [0, 0, 1],
        [0, 0, 2],
      ],
      name: 'Seg',
    });
    await op(id, 'object.parent_to', { objects: ['Arm'], parent: 'Rig', type: 'ARMATURE_AUTO' });
    await ok('add_object', { project: id, type: 'empty', name: 'Goal', location: [1.2, 0, 1.2] });
    await op(id, 'pose.ik_add', { object: 'Rig', bone: 'Seg.001', target: 'Goal', chain_count: 2 });

    const scene = await ok('get_scene', { project: id });
    const rig = objectOf(scene, 'Rig');
    expect(rig.data).toMatchObject({ kind: 'armature', pose_position: 'POSE' });
    expect(rig.data.bones).toEqual(expect.arrayContaining(['Seg', 'Seg.001 < Seg']));
    expect(rig.data.ik_bones).toEqual(['Seg.001']);
    const arm = objectOf(scene, 'Arm');
    expect(arm.parent).toBe('Rig');
    expect(arm.data.vertex_groups).toEqual(expect.arrayContaining(['Seg', 'Seg.001']));
    expect(arm.modifiers).toEqual([expect.objectContaining({ type: 'ARMATURE', object: 'Rig' })]);
    // the IK chain bends the skinned mesh towards the goal
    expect(arm.world_bounds.max[0]).toBeGreaterThan(0.5);
    const detail = await ok('get_object', { project: id, object: 'Rig' });
    const tip = detail.data.bones.find((b: any) => b.name === 'Seg.001');
    expect(tip.posed_tail_world[0]).toBeGreaterThan(0.5);

    // pose bone keys (channels that were never posed are created), with an interpolation
    const k = await ok('insert_keyframe', {
      project: id,
      object: 'Rig',
      property: 'pose.bones["Seg"].rotation_euler',
      frame: 10,
      value: [0.3, 0, 0],
      interpolation: 'LINEAR',
    });
    expect(k).toMatchObject({ inserted: 3, target_type: 'object' });
    const rigObj = await ok('get_object', { project: id, object: 'Rig' });
    const curve = rigObj.animation.find(
      (a: any) => a.path === 'pose.bones["Seg"].rotation_euler' && a.index === 0,
    );
    expect(curve.keyframes).toEqual([{ frame: 10, value: 0.3, interpolation: 'LINEAR' }]);

    // an ARMATURE modifier added by name stores the armature's id
    await ok('add_object', {
      project: id,
      type: 'cube',
      name: 'Hand',
      params: { size: 0.3 },
      location: [0, 0, 2],
    });
    const mod = await ok('add_modifier', {
      project: id,
      object: 'Hand',
      type: 'ARMATURE',
      params: { object: 'Rig' },
    });
    expect(mod.via).toBe('operator');
    expect(mod.modifier.params.object).toBe(rig.id);
    expect(
      await fails('add_modifier', {
        project: id,
        object: 'Hand',
        type: 'ARMATURE',
        params: { object: 'Nope' },
      }),
    ).toMatch(/Object 'Nope'/);

    // shape keys: a key, keyed values, shown with their current value
    await op(id, 'object.shape_key_add', { object: 'Hand', name: 'Squash' });
    await ok('insert_keyframe', {
      project: id,
      object: 'Hand',
      property: 'shape_keys["Squash"].value',
      frame: 1,
      value: 0,
    });
    await ok('insert_keyframe', {
      project: id,
      object: 'Hand',
      property: 'data.shape_keys["Squash"].value',
      frame: 21,
      value: 1,
      interpolation: 'LINEAR',
    });
    const hand = await ok('get_object', { project: id, object: 'Hand', frame: 11 });
    expect(hand.data.shape_keys).toEqual([expect.objectContaining({ name: 'Squash' })]);
    expect(
      hand.animation.some((a: any) => a.target_type === 'mesh' && a.path === 'shape_keys["Squash"].value'),
    ).toBe(true);

    // drivers are listed with their expression
    await op(id, 'anim.driver_add', {
      target: 'Goal',
      path: 'location',
      index: 2,
      expression: '1 + sin(frame / 10)',
    });
    const goal = objectOf(await ok('get_scene', { project: id }), 'Goal');
    expect(goal.drivers).toEqual([{ path: 'location[2]', expression: '1 + sin(frame / 10)' }]);
  });

  it('simulates rigid bodies, sets physics and world settings and bakes the motion', async () => {
    const { id } = await ok('create_project', { name: 'Physics', empty: true });
    await ok('add_object', { project: id, type: 'plane', name: 'Floor', params: { size: 20 } });
    await ok('add_object', {
      project: id,
      type: 'cube',
      name: 'Crate',
      params: { size: 1 },
      location: [0, 0, 4],
    });
    await op(id, 'rigidbody.object_add', { objects: ['Floor'], type: 'PASSIVE', collision_shape: 'BOX' });
    await op(id, 'rigidbody.object_add', { objects: ['Crate'], type: 'ACTIVE', mass: 2 });
    const settings = await ok('set_scene_settings', {
      project: id,
      frame_end: 40,
      rigidbody_frame_end: 40,
      gravity: [0, 0, -9.81],
      substeps_per_frame: 5,
      sky_preset: 'CLEAR_DAY',
      mist_distance: 200,
      engine: 'PATHTRACER',
      samples: 8,
      max_bounces: 3,
      use_denoising: false,
    });
    expect(settings.scene.rigidbody_world).toMatchObject({
      frame_end: 40,
      substeps_per_frame: 5,
      enabled: true,
    });
    expect(settings.scene.gravity).toEqual([0, 0, -9.81]);
    expect(settings.world.environment).toBe('SKY');
    expect(settings.world.sky).toBeTruthy();
    expect(settings.world.mist_density).toBeGreaterThan(0);
    expect(settings.render).toMatchObject({
      engine: 'PATHTRACER',
      samples: 8,
      max_bounces: 3,
      use_denoising: false,
    });

    const late = await ok('get_scene', { project: id, frame: 40 });
    const crate = objectOf(late, 'Crate');
    expect(crate.rigid_body).toMatchObject({ type: 'ACTIVE', mass: 2 });
    expect(crate.simulated).toBe(true);
    expect(crate.world_bounds.center[2]).toBeLessThan(1);
    expect(late.counts.rigid_bodies).toBe(2);
    expect(late.scene.rigidbody_world.frame_end).toBe(40);

    await op(id, 'rigidbody.bake_to_keyframes', { objects: ['Crate'], frame_start: 1, frame_end: 40 });
    const baked = await ok('get_object', { project: id, object: 'Crate', frame: 40 });
    expect(baked.rigid_body).toBeUndefined();
    expect(baked.animation.length).toBeGreaterThan(0);
    expect(baked.world_bounds.center[2]).toBeLessThan(1);
    expect((await ok('list_projects')).projects.find((p: any) => p.id === id).stats.by_type).toEqual({
      MESH: 2,
    });
  });

  it('path traces on render threads (MCP and REST) and reports the samples', async () => {
    const { id } = await ok('create_project', { name: 'Path traced' });
    const { raw, json } = await call('render_image', {
      project: id,
      width: 48,
      height: 32,
      engine: 'PATHTRACER',
      samples: 4,
      max_bounces: 2,
    });
    expect(raw.isError).toBeFalsy();
    const image = raw.content.find((c) => c.type === 'image')!;
    const png = decodePNG(Buffer.from(image.data!, 'base64'));
    expect([png.width, png.height]).toEqual([48, 32]);
    const info = JSON.parse(raw.content.find((c) => c.type === 'text')!.text!);
    expect(info).toMatchObject({
      renderer: 'software',
      engine: 'PATHTRACER',
      samples: 4,
      requested_samples: 4,
      threads: 2,
    });
    expect(json).toEqual(info);

    const raster = await call('render_image', { project: id, width: 40, height: 30, engine: 'RASTER' });
    expect(JSON.parse(raster.raw.content.find((c) => c.type === 'text')!.text!)).toMatchObject({
      renderer: 'software',
      engine: 'RASTER',
    });

    const rest = await fetch(
      `${server.url}/api/projects/${id}/render.png?width=32&height=24&engine=PATHTRACER&samples=2&denoise=false`,
    );
    expect(rest.status).toBe(200);
    expect(rest.headers.get('x-render-engine')).toBe('PATHTRACER');
    expect(rest.headers.get('x-render-samples')).toBe('2');
    expect(decodePNG(new Uint8Array(await rest.arrayBuffer())).width).toBe(32);
    const bad = await api(
      server.url,
      `/api/projects/${id}/render.png?engine=PATHTRACER&width=2048&height=2048`,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/too large/);
  });

  it('renders animations as GIF, contact sheets and stored PNG sequences', async () => {
    const { id } = await ok('create_project', { name: 'Animated' });
    await ok('insert_keyframe', {
      project: id,
      object: 'Cube',
      property: 'location',
      frame: 1,
      value: [-2, 0, 0],
    });
    await ok('insert_keyframe', {
      project: id,
      object: 'Cube',
      property: 'location',
      frame: 9,
      value: [2, 0, 0],
    });

    const gif = await call('render_animation', {
      project: id,
      format: 'GIF',
      frame_start: 1,
      frame_end: 9,
      frame_step: 4,
      width: 40,
      height: 30,
      engine: 'RASTER',
    });
    expect(gif.raw.isError).toBeFalsy();
    const gifImage = gif.raw.content.find((c) => c.type === 'image')!;
    expect(gifImage.mimeType).toBe('image/gif');
    expect(Buffer.from(gifImage.data!, 'base64').subarray(0, 6).toString()).toBe('GIF89a');
    const gifInfo = JSON.parse(gif.raw.content.find((c) => c.type === 'text')!.text!);
    expect(gifInfo).toMatchObject({
      format: 'GIF',
      frames: [1, 5, 9],
      frame_count: 3,
      truncated: false,
      width: 40,
    });

    const sheet = await call('render_animation', {
      project: id,
      frame_start: 1,
      frame_end: 9,
      frame_step: 4,
      width: 32,
      height: 24,
      engine: 'PATHTRACER',
      samples: 2,
    });
    expect(sheet.raw.isError).toBeFalsy();
    const sheetInfo = JSON.parse(sheet.raw.content.find((c) => c.type === 'text')!.text!);
    expect(sheetInfo).toMatchObject({
      format: 'CONTACT_SHEET',
      engine: 'PATHTRACER',
      frames: [1, 5, 9],
      threads: 2,
    });
    expect(sheetInfo.sheet).toMatchObject({ columns: 2, rows: 2 });
    const sheetPng = decodePNG(
      Buffer.from(sheet.raw.content.find((c) => c.type === 'image')!.data!, 'base64'),
    );
    expect([sheetPng.width, sheetPng.height]).toEqual([sheetInfo.sheet.width, sheetInfo.sheet.height]);

    const seq = await call('render_animation', {
      project: id,
      format: 'PNG_SEQUENCE',
      frame_start: 1,
      frame_end: 2,
      width: 24,
      height: 16,
      engine: 'RASTER',
      store: true,
    });
    expect(seq.raw.isError).toBeFalsy();
    const resources = seq.raw.content.filter((c) => c.type === 'resource');
    expect(resources.map((r) => r.resource.uri.split('/').pop())).toEqual([
      'frame_0001.png',
      'frame_0002.png',
    ]);
    const links = seq.raw.content.filter((c) => c.type === 'resource_link');
    expect(links).toHaveLength(2);
    const dl = await fetch(links[0].uri!);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(decodePNG(new Uint8Array(await dl.arrayBuffer())).width).toBe(24);

    expect(await fails('render_animation', { project: id, frame_start: 5, frame_end: 1 })).toMatch(
      /before frame_start/,
    );
  });
});
