import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sharedRenderer } from '../../src/render';
import { startServer, type TestServer } from '../helpers/app';

/*
 * Regression tests for the small extras the project agents asked for (phase 3, round 2): vertex
 * colours in get_mesh_data (to verify paint.vertex_color_set_data), unique project names in
 * create_project / rename_project, and read access to the transforms of particle / collection
 * instances (get_instances) without making them real.
 */

let server: TestServer;
let client: Client;

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown> = {}, c = client) {
  const raw = (await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })) as ToolResult;
  const text = raw.content.map((x) => x.text ?? '').join('\n');
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* text */
  }
  return { raw, json, text };
}

async function ok(name: string, args: Record<string, unknown> = {}, c = client): Promise<any> {
  const r = await call(name, args, c);
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
  client = new Client({ name: 'extras-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('MCP extras for agents', () => {
  it('get_mesh_data returns the vertex colours that paint.vertex_color_set_data wrote, in pages', async () => {
    const { id } = await ok('create_project', { name: 'Colours', empty: true });
    await ok('add_object', { project: id, type: 'grid', name: 'Ground' });
    const base = await ok('get_mesh_data', { project: id, object: 'Ground', include: ['vertices'] });
    const n = base.totals.vertices;
    expect(n).toBeGreaterThan(20);

    // no colour layer yet: null with an explanation
    const none = await ok('get_mesh_data', { project: id, object: 'Ground', include: ['colors'] });
    expect(none.colors).toBeNull();
    expect(none.colors_note).toMatch(/no vertex color layer.*paint\.vertex_color_set_data/);

    // colours computed per vertex (from the height-like x coordinate), written in one call
    const colors = base.vertices.map(([x, y]: number[], i: number) => [
      +((x + 1) / 2).toFixed(3),
      +((y + 1) / 2).toFixed(3),
      +((i % 7) / 7).toFixed(3),
      1,
    ]);
    const res = await op(id, 'paint.vertex_color_set_data', { object: 'Ground', colors });
    expect(res.result).toMatchObject({ vertices: n, set: n });

    const all = await ok('get_mesh_data', {
      project: id,
      object: 'Ground',
      include: ['colors'],
      limit: n,
    });
    expect(all.colors).toHaveLength(n);
    expect(all.vertex_range).toEqual({ offset: 0, count: n });
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 4; k++) expect(all.colors[i][k]).toBeCloseTo(colors[i][k], 4);

    // paged like the vertices; the evaluated geometry carries them too
    const page = await ok('get_mesh_data', {
      project: id,
      object: 'Ground',
      include: ['vertices', 'colors'],
      vertex_offset: 10,
      limit: 5,
    });
    expect(page.colors).toEqual(all.colors.slice(10, 15));
    expect(page.vertices).toHaveLength(5);
    expect(page.next.vertex_offset).toBe(15);
    const evaluated = await ok('get_mesh_data', {
      project: id,
      object: 'Ground',
      include: ['colors'],
      source: 'EVALUATED',
      limit: 3,
    });
    expect(evaluated.colors).toEqual(all.colors.slice(0, 3));

    const tool = (await client.listTools()).tools.find((t) => t.name === 'get_mesh_data')!;
    expect(tool.description).toMatch(/vertex colors/);
    expect((tool.inputSchema as any).properties.include.items.enum).toContain('colors');
  });

  it('create_project and rename_project refuse a name another project has (lighthouse-cove v2)', async () => {
    const first = await ok('create_project', { name: 'lc-probe', empty: true });
    const msg = await fails('create_project', { name: 'lc-probe', empty: true });
    expect(msg).toContain(`A project named 'lc-probe' already exists (id ${first.id})`);
    expect(msg).toMatch(/delete_project/);
    // surrounding spaces are trimmed like the stored name
    expect(await fails('create_project', { name: '  lc-probe ' })).toContain(first.id);
    const named = (await ok('list_projects')).projects.filter((p: { name: string }) => p.name === 'lc-probe');
    expect(named.map((p: { id: string }) => p.id)).toEqual([first.id]);
    // by-name references keep working
    await ok('add_object', { project: 'lc-probe', type: 'cube', name: 'C' });

    // two agents racing for one name: exactly one project gets it
    const other = new Client({ name: 'other-agent', version: '1.0.0' });
    await other.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const results = await Promise.all([
        call('create_project', { name: 'Race', empty: true }),
        call('create_project', { name: 'Race', empty: true }, other),
        call('create_project', { name: 'Race', empty: true }),
      ]);
      expect(results.filter((r) => !r.raw.isError)).toHaveLength(1);
      expect(results.filter((r) => r.raw.isError).every((r) => /already exists/.test(r.text))).toBe(true);
    } finally {
      await other.close();
    }

    // rename: not to another project's name; the own name and free names are fine
    const second = await ok('create_project', { name: 'lc-probe 2', empty: true });
    expect(await fails('rename_project', { project: second.id, name: 'lc-probe' })).toContain(first.id);
    expect(await ok('rename_project', { project: second.id, name: 'lc-probe 2' })).toMatchObject({
      name: 'lc-probe 2',
    });
    expect(await ok('rename_project', { project: second.id, name: 'lc-probe 3' })).toMatchObject({
      name: 'lc-probe 3',
    });

    // once the old project is deleted its name is free again
    await ok('delete_project', { project: first.id, confirm: true });
    const again = await ok('create_project', { name: 'lc-probe', empty: true });
    expect(again.id).not.toBe(first.id);
  });

  it('get_instances lists where scattered instances are, matching make-real, without making them real', async () => {
    const { id } = await ok('create_project', { name: 'Scatter check', empty: true });
    await op(id, 'mesh.primitive_plane_add', { size: 20 });
    await op(id, 'object.rename', { object: 'Plane', name: 'Ground' });
    await op(id, 'mesh.primitive_cube_add', { size: 0.4, location: [0, 0, 5] });
    await op(id, 'object.rename', { object: 'Cube', name: 'Rock' });
    await op(id, 'mesh.primitive_ico_sphere_add', { radius: 0.3, location: [0, 3, 5] });
    await op(id, 'object.rename', { object: 'Icosphere', name: 'Pebble' });
    const scatter = await op(id, 'object.scatter_add', {
      surface: 'Ground',
      objects: ['Rock', 'Pebble'],
      name: 'Rocks',
      count: 60,
      min_distance: 1.2,
      seed: 5,
      rotation_random: 0.3,
      size_random: 0.5,
    });
    const placed = scatter.result.instances;
    expect(placed).toBeGreaterThan(20);
    const objectsBefore = (await ok('get_scene', { project: id })).counts.objects;

    const all = await ok('get_instances', { project: id, object: 'Ground' });
    expect(all).toMatchObject({ object: 'Ground', source: 'RENDER', space: 'WORLD', total: placed });
    expect(all.instances).toHaveLength(placed);
    expect(all.truncated).toBeUndefined();
    expect(all.particle_systems).toEqual([
      expect.objectContaining({
        name: 'Rocks',
        instance_type: 'COLLECTION',
        count: 60,
        particles: placed,
        instances: placed,
      }),
    ]);
    const sources = new Set(all.instances.map((i: any) => i.source));
    expect([...sources].sort()).toEqual(['Pebble', 'Rock']);
    const particles = new Set(all.instances.map((i: any) => i.particle));
    expect(particles.size).toBe(placed);
    for (const inst of all.instances) {
      expect(inst.system).toBe('Rocks');
      // on the 20 m plane at z = 0
      expect(Math.abs(inst.location[0])).toBeLessThanOrEqual(10.0001);
      expect(Math.abs(inst.location[1])).toBeLessThanOrEqual(10.0001);
      expect(Math.abs(inst.location[2])).toBeLessThan(1e-3);
      expect(inst.rotation_euler).toHaveLength(3);
      for (const s of inst.scale) expect(s).toBeGreaterThan(0.45);
    }
    // min_distance is honoured: the agent can check spacing from the list
    let closest = Infinity;
    for (let a = 0; a < all.instances.length; a++)
      for (let b = a + 1; b < all.instances.length; b++) {
        const [p, q] = [all.instances[a].location, all.instances[b].location];
        closest = Math.min(closest, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      }
    expect(closest).toBeGreaterThanOrEqual(1.2 - 1e-3);
    const bounds = all.particle_systems[0].location_bounds;
    expect(bounds.min[0]).toBeGreaterThanOrEqual(-10.0001);
    expect(bounds.max[1]).toBeLessThanOrEqual(10.0001);

    // read-only: nothing was added to the scene
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(objectsBefore);

    // pages
    const p1 = await ok('get_instances', { project: id, object: 'Ground', limit: 10 });
    expect(p1.instances).toEqual(all.instances.slice(0, 10));
    expect(p1).toMatchObject({ truncated: true, next: { offset: 10 }, range: { offset: 0, count: 10 } });
    const p2 = await ok('get_instances', { project: id, object: 'Ground', offset: 10, limit: 10 });
    expect(p2.instances).toEqual(all.instances.slice(10, 20));

    // the same transforms the instances get when they are made real
    await op(id, 'object.duplicates_make_real', { objects: ['Ground'] });
    const real = await ok('get_scene', { project: id, max_objects: 500 });
    const made = real.objects.filter((o: any) => /^(Rock|Pebble)\.\d+$/.test(o.name));
    expect(made).toHaveLength(placed);
    const key = (v: number[]) => v.map((x) => x.toFixed(2)).join(',');
    expect(new Set(made.map((o: any) => key(o.location)))).toEqual(
      new Set(all.instances.map((i: any) => key(i.location))),
    );
    await ok('undo', { project: id });
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(objectsBefore);

    // one system by name; unknown names list the systems
    const only = await ok('get_instances', {
      project: id,
      object: 'Ground',
      particle_system: 'Rocks',
      limit: 1,
    });
    expect(only.total).toBe(placed);
    expect(await fails('get_instances', { project: id, object: 'Ground', particle_system: 'Rokcs' })).toMatch(
      /no particle system 'Rokcs'.*'Rocks'/,
    );

    // viewport: display_percentage applies; render: every particle
    await op(id, 'object.particle_system_update', {
      object: 'Ground',
      particle_system: 'Rocks',
      settings: { display_percentage: 50 },
    });
    const viewport = await ok('get_instances', { project: id, object: 'Ground', source: 'VIEWPORT' });
    expect(viewport.total).toBeGreaterThan(0);
    expect(viewport.total).toBeLessThan(placed);
    expect((await ok('get_instances', { project: id, object: 'Ground' })).total).toBe(placed);

    // hidden in renders: listed with a note, no instances
    await op(id, 'object.particle_system_update', {
      object: 'Ground',
      particle_system: 'Rocks',
      show_render: false,
    });
    const hidden = await ok('get_instances', { project: id, object: 'Ground' });
    expect(hidden.total).toBe(0);
    expect(hidden.particle_systems[0]).toMatchObject({ shown: false, instances: 0 });
    expect(hidden.particle_systems[0].note).toMatch(/show_render is off/);

    // objects that generate no instances are explained
    expect(await fails('get_instances', { project: id, object: 'Rock' })).toMatch(
      /generates no instances.*object\.scatter_add/,
    );
  });

  it('batch sets a selection per operation, like run_operator (lighthouse-cove colour check)', async () => {
    const { id } = await ok('create_project', { name: 'Batch selection', empty: true });
    await ok('add_object', { project: id, type: 'cube', name: 'A' });
    await ok('add_object', { project: id, type: 'cube', name: 'B', location: [3, 0, 0] });
    await ok('add_object', { project: id, type: 'cube', name: 'C', location: [6, 0, 0] });
    const r = await ok('batch', {
      project: id,
      operations: [
        { operator: 'object.delete', selection: { objects: ['A'] } },
        { operator: 'export_mesh.stl', params: { use_selection: true }, selection: { objects: ['B'] } },
        // no selection: the previous one stays set
        { operator: 'export_mesh.stl', params: { use_selection: true } },
      ],
    });
    expect(r.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, true, true]);
    expect(r.results[0].result).toEqual({ deleted: 1 });
    // one cube: 12 triangles (binary STL: 84-byte header + 50 bytes per triangle)
    expect(r.results[1].result.size).toBe(84 + 12 * 50);
    expect(r.results[2].result.size).toBe(84 + 12 * 50);
    expect(r.selection).toMatchObject({ selected: ['B'], active: 'B' });
    const names = (await ok('get_scene', { project: id })).objects.map((o: { name: string }) => o.name);
    expect(names.sort()).toEqual(['B', 'C']);
    // one undo step for the whole batch
    await ok('undo', { project: id });
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(3);

    // a selection naming an unknown object fails its operation (NOT_FOUND), nothing runs after it
    const bad = await call('batch', {
      project: id,
      operations: [
        { operator: 'object.delete', selection: { objects: ['Nope'] } },
        { operator: 'object.delete', selection: { objects: ['C'] } },
      ],
    });
    expect(bad.raw.isError).toBe(true);
    const details = JSON.parse(bad.text.slice(bad.text.indexOf('\n') + 1));
    expect(details.results).toHaveLength(1);
    expect(details.results[0]).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(details.results[0].error).toMatch(/^selection: Object 'Nope' not found/);
    expect((await ok('get_scene', { project: id })).counts.objects).toBe(3);
    // and the schema still rejects keys that are neither operator, params nor selection
    expect(
      await fails('batch', { project: id, operations: [{ operator: 'object.delete', selected: ['C'] }] }),
    ).toMatch(/unknown key 'selected' \(did you mean 'selection'\?\)/);
  });

  it('get_instances lists collection instances of an empty', async () => {
    const { id } = await ok('create_project', { name: 'Collection check', empty: true });
    await op(id, 'mesh.primitive_cube_add', { size: 1, location: [1, 0, 0] });
    await op(id, 'mesh.primitive_uv_sphere_add', { radius: 0.5, location: [0, 2, 0] });
    await ok('run_operator', {
      project: id,
      operator: 'object.move_to_collection',
      params: { new_collection_name: 'Kit' },
      selection: { objects: ['Cube', 'Sphere'] },
    });
    await op(id, 'object.collection_instance_add', {
      collection: 'Kit',
      name: 'Kit Instance',
      location: [10, 0, 0],
      rotation: [0, 0, Math.PI / 2],
    });
    const r = await ok('get_instances', { project: id, object: 'Kit Instance' });
    expect(r).toMatchObject({ instance_collection: 'Kit', collection_instances: 2, total: 2 });
    expect(r.particle_systems).toBeUndefined();
    const byName = Object.fromEntries(r.instances.map((i: any) => [i.source, i]));
    expect(byName.Cube.collection).toBe('Kit');
    // rotated 90° about Z around the empty at x = 10: (1, 0, 0) -> (10, 1, 0), (0, 2, 0) -> (8, 0, 0)
    expect(byName.Cube.location.map((v: number) => +v.toFixed(3))).toEqual([10, 1, 0]);
    expect(byName.Sphere.location.map((v: number) => +v.toFixed(3))).toEqual([8, 0, 0]);
    expect(byName.Cube.rotation_euler[2]).toBeCloseTo(Math.PI / 2, 3);
    expect(
      await fails('get_instances', { project: id, object: 'Kit Instance', particle_system: 'x' }),
    ).toMatch(/no particle systems/);
  });
});
