import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BROWSER_UI_OPERATORS } from '@3d-editor/core';
import { sharedRenderer } from '../../src/render';
import type { Room } from '../../src/sync/room';
import { eventually, sleep, startServer, type TestServer } from '../helpers/app';
import { SyncTestClient } from '../helpers/sync-client';

/*
 * Every failure of run_operator and edit_mesh is an error result with the message on the first
 * line followed by JSON {ok: false, operator, error, code, selection, …}: also when the selection,
 * the object or an element index cannot be applied (NOT_FOUND for unknown objects, POLL_FAILED for
 * the rest), and the call changes nothing in the agent's editor state. batch decides these codes
 * the same way (by the error's class, not its text). Ids of the browser editor's UI operators say
 * how to run them (editor_command) and what to use instead where the tools offer it; misspelled
 * ones (letter case too) are suggested. Names with line breaks do not break the first line.
 * Editor timeouts say what to do, and stay under an MCP client's default request timeout; an
 * editor still busy with a request the server stopped waiting for is named, and skipped by 'auto'.
 */

let server: TestServer;
let client: Client;
const syncClients: SyncTestClient[] = [];

type ToolResult = {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
};

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function call(
  name: string,
  args: Record<string, unknown> = {},
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void,
) {
  const raw = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
    ...(onprogress ? { onprogress } : {}),
  })) as ToolResult;
  const text = raw.content.map((x) => x.text ?? '').join('\n');
  return { raw, text };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await call(name, args);
  if (r.raw.isError) throw new Error(`${name} failed: ${r.text}`);
  return JSON.parse(r.text);
}

/** A call that must fail: its first line (the message) and the JSON that follows it. */
async function failed(name: string, args: Record<string, unknown>): Promise<{ message: string; json: any }> {
  const r = await call(name, args);
  expect(r.raw.isError, `${name} should fail: ${r.text}`).toBe(true);
  const nl = r.text.indexOf('\n');
  expect(nl, `${name}: the message must be followed by JSON: ${r.text}`).toBeGreaterThan(0);
  return { message: r.text.slice(0, nl), json: JSON.parse(r.text.slice(nl + 1)) };
}

/** The agent's selection, active object, mode and element selection (a call that changes nothing). */
async function state(project: string): Promise<Record<string, unknown>> {
  return (await ok('run_operator', { project, operator: 'scene.stats' })).selection;
}

async function objectNames(project: string): Promise<string[]> {
  return (await ok('get_scene', { project })).objects.map((o: { name: string }) => o.name).sort();
}

/** A browser editor that answers RPCs with `answer` (a never settling promise: it never answers). */
async function editor(project: string, answer: (method: string, params: any) => unknown, name = 'Browser') {
  const before = server.handle.rooms.get(project)?.rpcCandidates('ui').length ?? 0;
  const browser = new SyncTestClient({
    baseUrl: server.url,
    projectId: project,
    name,
    capabilities: ['render', 'ui'],
    rpcHandler: answer,
  });
  syncClients.push(browser);
  await browser.connect();
  await eventually(() => server.handle.rooms.get(project)?.rpcCandidates('ui').length === before + 1);
  return browser;
}

const never = () => new Promise<never>(() => undefined);

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'error-codes-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await Promise.all(syncClients.map((c) => c.destroy()));
  await client?.close();
  await server?.close();
  await server?.cleanup();
  await sharedRenderer().close();
});

describe('run_operator: every failure is the message plus JSON with a code', () => {
  it('a selection that cannot be applied: NOT_FOUND for unknown objects, POLL_FAILED otherwise, nothing changed', async () => {
    const { id } = await ok('create_project', { name: 'Run selections' });
    await ok('add_object', { project: id, type: 'camera', name: 'Not Found Cam', location: [0, -8, 2] });
    // a known state: the light selected and active, Object Mode
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Light'] } });
    const before = await state(id);
    expect(before).toMatchObject({ mode: 'OBJECT', selected: ['Light'], active: 'Light' });
    const names = await objectNames(id);

    const cases: [Record<string, unknown>, string, RegExp][] = [
      [
        { objects: ['Cube', 'Nope'] },
        'NOT_FOUND',
        /^Object 'Nope' not found in project 'Run selections'\. Objects: /,
      ],
      [{ objects: ['Cube'], active: 'Nope' }, 'NOT_FOUND', /^Object 'Nope' not found in project/],
      [{ active: 'Nope' }, 'NOT_FOUND', /^Object 'Nope' not found in project/],
      [
        { objects: ['Camera'], mode: 'EDIT' },
        'POLL_FAILED',
        /^Edit mode needs an active mesh object \(selection\.active\): 'Camera' is a CAMERA object\.$/,
      ],
      // an object name with "not found" in it: the code comes from the error, not from its text
      [
        { objects: ['Not Found Cam'], mode: 'EDIT' },
        'POLL_FAILED',
        /^Edit mode needs an active mesh object \(selection\.active\): 'Not Found Cam' is a CAMERA object\.$/,
      ],
      [
        { objects: [], mode: 'EDIT' },
        'POLL_FAILED',
        /^Edit mode needs an active mesh object \(selection\.active\)\.$/,
      ],
      [
        { objects: ['Cube'], mesh: { faces: [0] } },
        'POLL_FAILED',
        /^selection\.mesh selects vertices, edges or faces in Edit Mode: add mode 'EDIT'/,
      ],
      [
        { objects: ['Cube'], mode: 'OBJECT', mesh: { faces: [0] } },
        'POLL_FAILED',
        /^selection\.mesh selects vertices, edges or faces in Edit Mode/,
      ],
      [
        { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [99] } },
        'POLL_FAILED',
        /^face index 99 out of range \(mesh has 6 faces\)$/,
      ],
      [
        { objects: ['Cube'], mode: 'EDIT', mesh: { verts: [8] } },
        'POLL_FAILED',
        /^vertex index 8 out of range \(mesh has 8 vertices\)$/,
      ],
      [
        { objects: ['Cube'], mode: 'EDIT', mesh: { edges: [[0, 42]] } },
        'POLL_FAILED',
        /^edge \[0, 42\]: vertex index 42 out of range \(mesh has 8 vertices\)$/,
      ],
    ];
    for (const [selection, code, message] of cases) {
      // object.delete would delete the selection if any of it were applied
      const f = await failed('run_operator', { project: id, operator: 'object.delete', selection });
      expect(f.message, JSON.stringify(selection)).toMatch(message);
      expect(f.json, JSON.stringify(selection)).toEqual({
        ok: false,
        operator: 'object.delete',
        error: f.message,
        code,
        selection: before,
      });
      expect(await state(id), JSON.stringify(selection)).toEqual(before);
    }
    expect(await objectNames(id)).toEqual(names);
  });

  it('keeps the Edit Mode element selection when a selection fails in Edit Mode', async () => {
    const { id } = await ok('create_project', { name: 'Run edit selections' });
    await ok('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [0] } },
    });
    const before = await state(id);
    expect(before).toMatchObject({ mode: 'EDIT', active: 'Cube', mesh: { select_mode: 'FACE', faces: 1 } });
    for (const [selection, code] of [
      [{ objects: ['Nope'] }, 'NOT_FOUND'],
      [{ objects: ['Light'], mode: 'EDIT' }, 'POLL_FAILED'],
      [{ mesh: { faces: [6] } }, 'POLL_FAILED'],
      [{ mesh: { verts: [0, 1, 99], select_mode: 'VERT' } }, 'POLL_FAILED'],
    ] as const) {
      const f = await failed('run_operator', { project: id, operator: 'mesh.delete', selection });
      expect(f.json).toMatchObject({ ok: false, operator: 'mesh.delete', error: f.message, code });
      expect(f.json.selection).toEqual(before);
      expect(await state(id)).toEqual(before);
    }
    expect((await ok('get_object', { project: id, object: 'Cube' })).data).toMatchObject({ faces: 6 });
  });

  it('refused operator ids: browser UI operators say how to run them, unknown ids get suggestions', async () => {
    const { id } = await ok('create_project', { name: 'Run refusals' });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Cube'] } });
    const before = await state(id);

    const view = await failed('run_operator', { project: id, operator: 'view3d.view_all' });
    expect(view.message).toBe(
      "'view3d.view_all' is an operator of the browser editor's user interface (viewport, playback, tools, windows): " +
        'only a live editor can run it, not run_operator, batch or edit_mesh. Run it there with editor_command ' +
        "{project, command: 'run_operator', params: {operator: 'view3d.view_all', params: {…}}} " +
        '(get_connected_clients lists the editors that have the project open): it frames every visible object in ' +
        "that editor's viewport, changing the person's view, out of the camera view (editor_command " +
        'view.frame_all does the same).',
    );
    expect(view.json).toEqual({
      ok: false,
      operator: 'view3d.view_all',
      error: view.message,
      code: 'NOT_FOUND',
      selection: before,
    });
    // some name the tool an agent wants instead
    const undo = await failed('run_operator', { project: id, operator: 'ed.undo' });
    expect(undo.json.code).toBe('NOT_FOUND');
    expect(undo.message).toContain("params: {operator: 'ed.undo'");
    expect(undo.message).toMatch(/To undo your own changes use the undo tool/);
    const render = await failed('run_operator', { project: id, operator: 'render.render' });
    expect(render.json.code).toBe('NOT_FOUND');
    expect(render.message).toMatch(/browser editor's user interface.*For an image use render_image/);

    const typo = await failed('run_operator', { project: id, operator: 'mesh.primitive_cube_ad' });
    expect(typo.message).toMatch(
      /^Unknown operator 'mesh\.primitive_cube_ad'\. Did you mean: mesh\.primitive_cube_add\b.*\? Use list_operators\.$/,
    );
    expect(typo.json).toEqual({
      ok: false,
      operator: 'mesh.primitive_cube_ad',
      error: typo.message,
      code: 'NOT_FOUND',
      selection: before,
    });
    expect(typo.message).not.toMatch(/browser editor/);
    // render operators of the core registry stay FAILED (a tool replaces them)
    const sw = await failed('run_operator', { project: id, operator: 'render.render_software' });
    expect(sw.json).toMatchObject({ code: 'FAILED', error: sw.message });
    expect(sw.message).toMatch(/Use the render_image tool instead/);
    expect(await state(id)).toEqual(before);
  });

  it('an unknown project: NOT_FOUND without a selection', async () => {
    const f = await failed('run_operator', { project: 'No such project', operator: 'scene.stats' });
    expect(f.message).toMatch(/^Project 'No such project' not found\./);
    expect(f.json).toEqual({ ok: false, operator: 'scene.stats', error: f.message, code: 'NOT_FOUND' });
  });

  it('an operator failure carries its code, the reports and the selection as before', async () => {
    const { id } = await ok('create_project', { name: 'Run operator failure' });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Light'] } });
    const before = await state(id);
    const f = await failed('run_operator', {
      project: id,
      operator: 'object.modifier_add',
      params: { type: 'NOPE' },
      selection: { objects: ['Cube'] },
    });
    expect(f.message).toMatch(/^object\.modifier_add failed: /);
    expect(f.json).toMatchObject({
      ok: false,
      operator: 'object.modifier_add',
      result: null,
      selection: before,
    });
    expect(f.json.error).toBe(f.message.replace('object.modifier_add failed: ', ''));
    expect(f.json.code).toBe('INVALID_PARAMS');
    expect(Array.isArray(f.json.reports)).toBe(true);
    expect(await state(id)).toEqual(before);
  });
});

describe('edit_mesh: every failure is the message plus JSON with a code', () => {
  it('unknown object, non-mesh object, element index out of range, refused ids: nothing changed', async () => {
    const { id } = await ok('create_project', { name: 'Edit failures' });
    await ok('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [2] } },
    });
    const before = await state(id);
    expect(before).toMatchObject({ mode: 'EDIT', active: 'Cube', mesh: { faces: 1 } });

    const cases: [Record<string, unknown>, string, RegExp][] = [
      [
        { object: 'Nope', operator: 'mesh.subdivide' },
        'NOT_FOUND',
        /^Object 'Nope' not found in project 'Edit failures'\. Objects: /,
      ],
      [{ object: 'Camera', operator: 'mesh.subdivide' }, 'POLL_FAILED', /^'Camera' is not a mesh object\.$/],
      [{ object: 'Light', operator: 'mesh.subdivide' }, 'POLL_FAILED', /^'Light' is not a mesh object\.$/],
      [
        { object: 'Cube', operator: 'mesh.subdivide', selection: { faces: [42] } },
        'POLL_FAILED',
        /^face index 42 out of range \(mesh has 6 faces\)$/,
      ],
      [
        { object: 'Cube', operator: 'mesh.subdivide', selection: { verts: [0, 8] } },
        'POLL_FAILED',
        /^vertex index 8 out of range \(mesh has 8 vertices\)$/,
      ],
      [
        { object: 'Cube', operator: 'mesh.subdivide', selection: { edges: [[0, 9]] } },
        'POLL_FAILED',
        /^edge \[0, 9\]: vertex index 9 out of range \(mesh has 8 vertices\)$/,
      ],
      [
        { object: 'Cube', operator: 'view3d.view_selected' },
        'NOT_FOUND',
        /^'view3d\.view_selected' is an operator of the browser editor's user interface .*editor_command \{project, command: 'run_operator', params: \{operator: 'view3d\.view_selected', params: \{…\}\}\}/,
      ],
      [
        { object: 'Cube', operator: 'mesh.subdivid' },
        'NOT_FOUND',
        /^Unknown operator 'mesh\.subdivid'\. Did you mean: mesh\.subdivide\b/,
      ],
    ];
    for (const [args, code, message] of cases) {
      const f = await failed('edit_mesh', { project: id, ...args });
      expect(f.message, JSON.stringify(args)).toMatch(message);
      expect(f.json, JSON.stringify(args)).toEqual({
        ok: false,
        operator: args.operator,
        error: f.message,
        code,
        selection: before,
      });
      expect(await state(id), JSON.stringify(args)).toEqual(before);
    }
    // an operator failure also carries the selection (as before the call)
    const op = await failed('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.extrude_region_move',
      params: { valeu: [0, 0, 1] },
    });
    expect(op.message).toMatch(/^mesh\.extrude_region_move failed: Invalid parameters/);
    expect(op.json).toMatchObject({ ok: false, code: 'INVALID_PARAMS', selection: before });
    expect(op.json).toHaveProperty('mesh');
    expect(await state(id)).toEqual(before);
    expect((await ok('get_object', { project: id, object: 'Cube' })).data).toMatchObject({ faces: 6 });

    const project = await failed('edit_mesh', {
      project: 'No such project',
      object: 'Cube',
      operator: 'mesh.subdivide',
    });
    expect(project.json).toEqual({
      ok: false,
      operator: 'mesh.subdivide',
      error: project.message,
      code: 'NOT_FOUND',
    });
  });
});

describe('batch decides the codes by the error, like run_operator', () => {
  it('per operation: selection errors, browser UI operators and unknown ids', async () => {
    const { id } = await ok('create_project', { name: 'Batch codes' });
    await ok('add_object', { project: id, type: 'camera', name: 'Not Found Cam', location: [0, -8, 2] });
    const names = await objectNames(id);
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: [
        { operator: 'scene.stats', selection: { objects: ['Light'] } },
        { operator: 'object.delete', selection: { objects: ['Cube', 'Nope'] } },
        { operator: 'object.delete', selection: { objects: ['Cube'], active: 'Nope' } },
        // "not found" in an object's name does not make it NOT_FOUND
        { operator: 'scene.stats', selection: { objects: ['Not Found Cam'], mode: 'EDIT' } },
        { operator: 'scene.stats', selection: { objects: ['Cube'], mesh: { faces: [0] } } },
        { operator: 'scene.stats', selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [99] } } },
        { operator: 'view3d.view_all' },
        { operator: 'mesh.primitive_cube_ad' },
        { operator: 'scene.stats' },
      ],
    });
    expect(res.raw.isError).toBe(true);
    const nl = res.text.indexOf('\n');
    expect(res.text.slice(0, nl)).toBe('7 of 9 operation(s) failed');
    const out = JSON.parse(res.text.slice(nl + 1));
    expect(out.results.map((r: { code?: string }) => r.code ?? null)).toEqual([
      null,
      'NOT_FOUND',
      'NOT_FOUND',
      'POLL_FAILED',
      'POLL_FAILED',
      'POLL_FAILED',
      'NOT_FOUND',
      'NOT_FOUND',
      null,
    ]);
    expect(out.results[1].error).toMatch(/^selection: Object 'Nope' not found in project 'Batch codes'/);
    expect(out.results[3].error).toBe(
      "selection: Edit mode needs an active mesh object (selection.active): 'Not Found Cam' is a CAMERA object.",
    );
    expect(out.results[5].error).toBe('selection: face index 99 out of range (mesh has 6 faces)');
    expect(out.results[6].error).toMatch(
      /^'view3d\.view_all' is an operator of the browser editor's user interface .*editor_command/,
    );
    expect(out.results[7].error).toMatch(
      /^Unknown operator 'mesh\.primitive_cube_ad'\. Did you mean: mesh\.primitive_cube_add\b/,
    );
    // the failed operations kept nothing: the selection of the first one, nothing deleted
    expect(out.selection).toMatchObject({ mode: 'OBJECT', selected: ['Light'], active: 'Light' });
    expect(await state(id)).toEqual(out.selection);
    expect(await objectNames(id)).toEqual(names);
  });

  it('names every browser UI operator as one', async () => {
    const { id } = await ok('create_project', { name: 'Batch browser ops', empty: true });
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: BROWSER_UI_OPERATORS.map((operator) => ({ operator })),
    });
    const out = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1));
    expect(out.failed).toBe(BROWSER_UI_OPERATORS.length);
    for (const r of out.results) {
      expect(r.code, r.operator).toBe('NOT_FOUND');
      expect(r.error, r.operator).toContain(
        `editor_command {project, command: 'run_operator', params: {operator: '${r.operator}', params: {…}}}`,
      );
    }
  });

  it('a call that fails as a whole (unknown project) has the message, then the JSON with a code', async () => {
    const f = await failed('batch', {
      project: 'No such project',
      operations: [{ operator: 'scene.stats' }],
    });
    expect(f.message).toMatch(/^Project 'No such project' not found\./);
    expect(f.json).toEqual({
      ok: false,
      executed: 0,
      failed: 0,
      results: [],
      error: f.message,
      code: 'NOT_FOUND',
    });
  });
});

describe('browser UI operators an agent means as an edit', () => {
  it('name the server operator first, and following that advice works', async () => {
    const { id } = await ok('create_project', { name: 'Browser ops advice' });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Cube'] } });
    const before = await state(id);
    const names = await objectNames(id);
    const cases: [string, Record<string, unknown>, RegExp][] = [
      [
        'run_operator',
        { operator: 'object.duplicate_move', params: { linked: false } },
        /^'object\.duplicate_move' is an operator of the browser editor's user interface .*not run_operator, batch or edit_mesh\. To duplicate objects use object\.duplicate \{linked, offset: \[x, y, z\]\} on your selection \(or the duplicate_object tool\): it copies them and moves the copies by offset in one step\. In a live editor run it with editor_command \{project, command: 'run_operator', params: \{operator: 'object\.duplicate_move', params: \{…\}\}\} \(get_connected_clients lists the editors that have the project open\): it duplicates the editor's selection, then waits for the person to move the copies with the mouse\.$/,
      ],
      [
        'run_operator',
        { operator: 'view3d.transform_modal', params: { mode: 'translate' } },
        /To move, rotate or scale use transform\.translate \{value\}, transform\.rotate \{value, orient_axis\} or transform\.resize \{value\} on your selection .*: it starts a move, rotation or scale \(\{mode: translate, rotate or resize\}\) of the editor's selection that follows the person's mouse until they click\.$/,
      ],
      [
        'edit_mesh',
        { object: 'Cube', operator: 'mesh.loopcut_pick' },
        /To cut a loop use edit_mesh \{object, operator: 'mesh\.loopcut', params: \{edge: \[a, b\], number_cuts\}\}.*: in Edit Mode it cuts the edge ring of the editor's active mesh under the person's mouse pointer, and fails when the pointer is over no edge\.$/,
      ],
    ];
    for (const [tool, args, message] of cases) {
      const f = await failed(tool, { project: id, ...args });
      expect(f.message, String(args.operator)).toMatch(message);
      expect(f.json).toEqual({
        ok: false,
        operator: args.operator,
        error: f.message,
        code: 'NOT_FOUND',
        selection: before,
      });
    }
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: [{ operator: 'object.duplicate_move' }, { operator: 'view3d.transform_modal' }],
    });
    const batch = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1));
    expect(batch.results.map((r: { code: string }) => r.code)).toEqual(['NOT_FOUND', 'NOT_FOUND']);
    expect(batch.results[0].error).toContain(
      'To duplicate objects use object.duplicate {linked, offset: [x, y, z]}',
    );
    expect(batch.results[1].error).toContain('To move, rotate or scale use transform.translate {value}');
    // nothing happened
    expect(await objectNames(id)).toEqual(names);
    expect(await state(id)).toEqual(before);

    // the advice works: a copy moved by the offset, a loop cut by an edge of the base mesh
    const dup = await ok('run_operator', {
      project: id,
      operator: 'object.duplicate',
      params: { offset: [3, 0, 0] },
      selection: { objects: ['Cube'] },
    });
    expect(dup.selection).toMatchObject({ selected: ['Cube.001'], active: 'Cube.001' });
    const copy = await ok('get_object', { project: id, object: 'Cube.001' });
    const cube = await ok('get_object', { project: id, object: 'Cube' });
    expect(copy.location[0] - cube.location[0]).toBeCloseTo(3, 6);
    await ok('run_operator', { project: id, operator: 'transform.translate', params: { value: [0, 2, 0] } });
    expect((await ok('get_object', { project: id, object: 'Cube.001' })).location[1]).toBeCloseTo(
      cube.location[1] + 2,
      6,
    );
    const cut = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.loopcut',
      params: { edge: [0, 1], number_cuts: 1 },
    });
    expect(cut.mesh.faces).toBeGreaterThan(6);
  });

  it('name only tools the server has', async () => {
    const tools = new Set((await client.listTools()).tools.map((t) => t.name));
    const { id } = await ok('create_project', { name: 'Browser ops tools', empty: true });
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: BROWSER_UI_OPERATORS.map((operator) => ({ operator })),
    });
    const text = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1))
      .results.map((r: { error: string }) => r.error)
      .join('\n');
    const named = [
      'undo',
      'redo',
      'duplicate_object',
      'transform_object',
      'edit_mesh',
      'get_mesh_data',
      'set_active_camera',
      'render_image',
      'render_animation',
      'export_scene',
      'import_model',
      'create_project',
      'list_projects',
      'get_project',
      'list_operators',
      'get_object',
      'run_operator',
      'get_connected_clients',
      'editor_command',
    ];
    for (const t of named) {
      expect(tools.has(t), t).toBe(true);
      expect(text, t).toMatch(new RegExp(`\\b${t}\\b`));
    }
  });
});

describe('misspelled browser UI operator ids are suggested', () => {
  const NOTE_THEM =
    "They are operators of the browser editor's user interface: a live editor runs them with editor_command " +
    "{project, command: 'run_operator', params: {operator, params}}. Use list_operators.";

  it('in run_operator, batch and edit_mesh, letter case ignored', async () => {
    const { id } = await ok('create_project', { name: 'Browser op typos' });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Light'] } });
    const before = await state(id);
    const cases: [string, RegExp][] = [
      ['VIEW3D.VIEW_ALL', /^Unknown operator 'VIEW3D\.VIEW_ALL'\. Did you mean: view3d\.view_all, /],
      ['View3D.View_All', /^Unknown operator 'View3D\.View_All'\. Did you mean: view3d\.view_all, /],
      ['view3d.view_al', /^Unknown operator 'view3d\.view_al'\. Did you mean: view3d\.view_all, /],
      ['view3d.viewall', /^Unknown operator 'view3d\.viewall'\. Did you mean: view3d\.view_all, /],
    ];
    for (const [operator, message] of cases) {
      const f = await failed('run_operator', { project: id, operator });
      expect(f.message, operator).toMatch(message);
      expect(f.message, operator).toMatch(
        new RegExp(`\\? ${NOTE_THEM.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      );
      expect(f.json).toEqual({ ok: false, operator, error: f.message, code: 'NOT_FOUND', selection: before });
      const e = await failed('edit_mesh', { project: id, object: 'Cube', operator });
      expect(e.message, operator).toBe(f.message);
      expect(e.json).toMatchObject({ code: 'NOT_FOUND', selection: before });
    }
    const undo = await failed('run_operator', { project: id, operator: 'ed.undoo' });
    expect(undo.message).toBe(
      "Unknown operator 'ed.undoo'. Did you mean: ed.undo, ed.redo? They are operators of the browser editor's " +
        'user interface (instead: the undo tool for ed.undo, the redo tool for ed.redo): a live editor runs them ' +
        "with editor_command {project, command: 'run_operator', params: {operator, params}}. Use list_operators.",
    );
    const play = await failed('run_operator', { project: id, operator: 'screen.animation_pla' });
    expect(play.message).toMatch(
      /^Unknown operator 'screen\.animation_pla'\. Did you mean: screen\.animation_play\b/,
    );
    // a server operator in the wrong case is suggested as before, without a note
    const cube = await failed('run_operator', { project: id, operator: 'MESH.PRIMITIVE_CUBE_ADD' });
    expect(cube.message).toMatch(
      /^Unknown operator 'MESH\.PRIMITIVE_CUBE_ADD'\. Did you mean: mesh\.primitive_cube_add, .*\? Use list_operators\.$/,
    );
    expect(cube.message).not.toMatch(/browser editor/);
    // a mix: the browser operator among the suggestions is named
    const dup = await failed('run_operator', { project: id, operator: 'object.duplicate_movee' });
    expect(dup.message).toMatch(
      /^Unknown operator 'object\.duplicate_movee'\. Did you mean: object\.duplicate_move, mesh\.duplicate_move, object\.duplicate\b.*\? object\.duplicate_move is an operator of the browser editor's user interface \(instead: object\.duplicate \{offset\}\): a live editor runs it with editor_command/,
    );

    // batch answers the same
    const view = await failed('run_operator', { project: id, operator: 'VIEW3D.VIEW_ALL' });
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: [{ operator: 'VIEW3D.VIEW_ALL' }, { operator: 'ed.undoo' }],
    });
    const out = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1));
    expect(out.results).toEqual([
      { operator: 'VIEW3D.VIEW_ALL', ok: false, error: view.message, code: 'NOT_FOUND' },
      { operator: 'ed.undoo', ok: false, error: undo.message, code: 'NOT_FOUND' },
    ]);
    expect(await state(id)).toEqual(before);
  });
});

describe('edges that are not edges of the mesh', () => {
  /** A pair of vertices of the default cube that no edge connects: the diagonal of its first face. */
  async function diagonal(project: string): Promise<[number, number]> {
    const data = await ok('get_mesh_data', { project, object: 'Cube' });
    const face = data.faces[0] as number[];
    return [face[0], face[2]];
  }
  const HINT =
    'an edge joins two vertices that follow each other in one of the faces get_mesh_data lists (the last ' +
    "with the first), or is one of its loose_edges (include: ['loose_edges'])";

  it('are refused in run_operator, batch and edit_mesh, in EDGE and VERT mode, and change nothing', async () => {
    const { id } = await ok('create_project', { name: 'Edge selections' });
    // a known Edit Mode element selection (one face) that a refused selection must keep
    await ok('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [1] } },
    });
    const before = await state(id);
    expect(before).toMatchObject({ mode: 'EDIT', mesh: { select_mode: 'FACE', faces: 1 } });
    const [a, c] = await diagonal(id);
    const message = `edge [${a}, ${c}]: vertices ${a} and ${c} are not connected by an edge of the mesh: ${HINT}`;
    for (const mesh of [{ edges: [[a, c]] }, { edges: [[a, c]], select_mode: 'VERT' }]) {
      // mesh.delete would delete the selected elements if any of the selection were applied
      const f = await failed('run_operator', {
        project: id,
        operator: 'mesh.delete',
        selection: { objects: ['Cube'], mode: 'EDIT', mesh },
      });
      expect(f.message, JSON.stringify(mesh)).toBe(message);
      expect(f.json).toEqual({
        ok: false,
        operator: 'mesh.delete',
        error: message,
        code: 'POLL_FAILED',
        selection: before,
      });
      expect(await state(id)).toEqual(before);
    }
    const res = await call('batch', {
      project: id,
      operations: [
        {
          operator: 'mesh.delete',
          selection: { objects: ['Cube'], mode: 'EDIT', mesh: { edges: [[c, a]] } },
        },
      ],
    });
    expect(res.raw.isError).toBe(true);
    const out = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1));
    expect(out.results).toEqual([
      {
        operator: 'mesh.delete',
        ok: false,
        error: `selection: edge [${c}, ${a}]: vertices ${c} and ${a} are not connected by an edge of the mesh: ${HINT}`,
        code: 'POLL_FAILED',
      },
    ]);
    expect(out.selection).toEqual(before);
    for (const selection of [{ edges: [[a, c]] }, { edges: [[a, c]], all: false }]) {
      for (const select_mode of [undefined, 'VERT', 'EDGE']) {
        const e = await failed('edit_mesh', {
          project: id,
          object: 'Cube',
          operator: 'mesh.delete',
          selection,
          ...(select_mode ? { select_mode } : {}),
        });
        expect(e.message).toBe(message);
        expect(e.json).toEqual({
          ok: false,
          operator: 'mesh.delete',
          error: message,
          code: 'POLL_FAILED',
          selection: before,
        });
      }
    }
    // the same vertex twice
    const same = await failed('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'mesh.delete',
      selection: { edges: [[a, a]] },
    });
    expect(same.message).toBe(`edge [${a}, ${a}] names vertex ${a} twice: ${HINT}`);
    expect(same.json.code).toBe('POLL_FAILED');
    expect(await state(id)).toEqual(before);
    expect((await ok('get_object', { project: id, object: 'Cube' })).data).toMatchObject({
      vertices: 8,
      faces: 6,
    });
    // an edge of the mesh is still fine, in either order
    const face = (await ok('get_mesh_data', { project: id, object: 'Cube' })).faces[0] as number[];
    const edge = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'scene.stats',
      selection: { edges: [[face[1], face[0]]] },
    });
    expect(edge.selection_after).toMatchObject({
      select_mode: 'EDGE',
      verts: [face[0], face[1]].sort((x, y) => x - y),
    });
  });

  it('loose (wire) edges are edges', async () => {
    const { id } = await ok('create_project', { name: 'Wire edges', empty: true });
    await ok('create_mesh', {
      project: id,
      name: 'Wire',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ],
      edges: [
        [0, 1],
        [1, 2],
      ],
    });
    const moved = await ok('edit_mesh', {
      project: id,
      object: 'Wire',
      operator: 'transform.translate',
      params: { value: [0, 0, 1] },
      selection: { edges: [[2, 1]] },
    });
    expect(moved.ok).toBe(true);
    const data = await ok('get_mesh_data', { project: id, object: 'Wire' });
    expect(data.vertices).toEqual([
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 1],
    ]);
    const f = await failed('edit_mesh', {
      project: id,
      object: 'Wire',
      operator: 'transform.translate',
      params: { value: [0, 0, 1] },
      selection: { edges: [[0, 2]] },
    });
    expect(f.message).toBe(`edge [0, 2]: vertices 0 and 2 are not connected by an edge of the mesh: ${HINT}`);
    expect(f.json.code).toBe('POLL_FAILED');
    expect((await ok('get_mesh_data', { project: id, object: 'Wire' })).vertices).toEqual(data.vertices);
  });
});

describe('selection lists that the select mode would not use', () => {
  it('are refused in run_operator, batch and edit_mesh, like all: true with lists, and change nothing', async () => {
    const { id } = await ok('create_project', { name: 'Select mode lists' });
    // a known Edit Mode element selection (one face) that a refused selection must keep
    await ok('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [1] } },
    });
    const before = await state(id);
    expect(before).toMatchObject({ mode: 'EDIT', mesh: { select_mode: 'FACE', faces: 1 } });
    const face = (await ok('get_mesh_data', { project: id, object: 'Cube' })).faces[0] as number[];
    const edge = [face[0], face[1]];
    const VERT = "leave select_mode out (or pass 'VERT') to select";
    const cases: [Record<string, unknown>, string][] = [
      [
        { verts: [0, 1], select_mode: 'FACE' },
        "select_mode 'FACE' selects only the listed faces, so the listed verts would be ignored: list faces " +
          `instead, or ${VERT} the listed vertices`,
      ],
      [
        { verts: [0], faces: [0], select_mode: 'FACE' },
        "select_mode 'FACE' selects only the listed faces, so the listed verts would be ignored: list only " +
          `faces, or ${VERT} the listed vertices with the vertices of the listed faces`,
      ],
      [
        { verts: [0], edges: [edge], faces: [0], select_mode: 'FACE' },
        "select_mode 'FACE' selects only the listed faces, so the listed verts and edges would be ignored: list " +
          `only faces, or ${VERT} the listed vertices with the vertices of the listed edges and faces`,
      ],
      [
        { edges: [edge], faces: [0], select_mode: 'EDGE' },
        "select_mode 'EDGE' selects only the listed edges, so the listed faces would be ignored: list only " +
          `edges, or ${VERT} the vertices of the listed edges and faces`,
      ],
      [
        { verts: [0], faces: [0], select_mode: 'EDGE' },
        "select_mode 'EDGE' selects only the listed edges, so the listed verts and faces would be ignored: list " +
          `edges instead, or ${VERT} the listed vertices with the vertices of the listed faces`,
      ],
      // one list that the mode does not use: leaving select_mode out infers the mode that does
      [
        { faces: [0], select_mode: 'EDGE' },
        "select_mode 'EDGE' selects only the listed edges, so the listed faces would be ignored: list edges " +
          "instead, leave select_mode out (or pass 'FACE') to select the listed faces, or pass 'VERT' to select " +
          'the vertices of the listed faces',
      ],
      [
        { edges: [edge], select_mode: 'FACE' },
        "select_mode 'FACE' selects only the listed faces, so the listed edges would be ignored: list faces " +
          "instead, leave select_mode out (or pass 'EDGE') to select the listed edges, or pass 'VERT' to select " +
          'the vertices of the listed edges',
      ],
      [
        { faces: [0], all: true },
        'all: true selects every element, so the listed faces would change nothing: leave all out to select ' +
          'only the listed elements, or leave the lists out to select everything',
      ],
      [
        { verts: [0], edges: [edge], all: true, select_mode: 'VERT' },
        'all: true selects every element, so the listed verts and edges would change nothing: leave all out to ' +
          'select only the listed elements, or leave the lists out to select everything',
      ],
      // both: one message, and every remedy for the lists also leaves all out (a call that kept
      // all: true would be refused for it)
      [
        { faces: [0], all: true, select_mode: 'EDGE' },
        "select_mode 'EDGE' selects only the listed edges, so the listed faces would be ignored, and all: true " +
          'selects every element, so the lists would change nothing: leave all out and list edges instead, leave ' +
          "all and select_mode out (or leave all out and pass 'FACE') to select the listed faces, leave all out " +
          "and pass 'VERT' to select the vertices of the listed faces, or leave the lists out to select everything",
      ],
      [
        { verts: [0], edges: [edge], all: true, select_mode: 'FACE' },
        "select_mode 'FACE' selects only the listed faces, so the listed verts and edges would be ignored, and " +
          'all: true selects every element, so the lists would change nothing: leave all out and list faces ' +
          "instead, leave all and select_mode out (or leave all out and pass 'VERT') to select the listed " +
          'vertices with the vertices of the listed edges, or leave the lists out to select everything',
      ],
    ];
    for (const [mesh, message] of cases) {
      // mesh.delete would delete the selected elements if any of the selection were applied
      const f = await failed('run_operator', {
        project: id,
        operator: 'mesh.delete',
        selection: { objects: ['Cube'], mode: 'EDIT', mesh },
      });
      expect(f.message, JSON.stringify(mesh)).toBe(message);
      expect(f.json).toEqual({
        ok: false,
        operator: 'mesh.delete',
        error: message,
        code: 'POLL_FAILED',
        selection: before,
      });
      const res = await call('batch', {
        project: id,
        operations: [{ operator: 'mesh.delete', selection: { objects: ['Cube'], mode: 'EDIT', mesh } }],
      });
      expect(res.raw.isError).toBe(true);
      const out = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1));
      expect(out.results).toEqual([
        { operator: 'mesh.delete', ok: false, error: `selection: ${message}`, code: 'POLL_FAILED' },
      ]);
      // edit_mesh takes select_mode next to the selection
      const { select_mode, ...selection } = mesh;
      const e = await failed('edit_mesh', {
        project: id,
        object: 'Cube',
        operator: 'mesh.delete',
        selection,
        ...(select_mode ? { select_mode } : {}),
      });
      expect(e.message).toBe(message);
      expect(e.json).toEqual({
        ok: false,
        operator: 'mesh.delete',
        error: message,
        code: 'POLL_FAILED',
        selection: before,
      });
      expect(await state(id)).toEqual(before);
    }
    expect((await ok('get_object', { project: id, object: 'Cube' })).data).toMatchObject({
      vertices: 8,
      faces: 6,
    });
    // the remedies are what the calls do: without select_mode the mode the message names selects the
    // lists, and so does 'VERT' where the message offers it (with all: true too, below)
    for (const [mesh, message] of cases) {
      if (!message.startsWith('select_mode ') || mesh.all) continue;
      const lists = { ...mesh };
      delete lists.select_mode;
      const left = message.match(/leave select_mode out \(or pass '(\w+)'\)/)?.[1];
      expect(left, message).toBeDefined();
      for (const [select_mode, expected] of [
        [undefined, left],
        ['VERT', 'VERT'],
        [left, left],
      ]) {
        const r = await ok('run_operator', {
          project: id,
          operator: 'scene.stats',
          selection: {
            objects: ['Cube'],
            mode: 'EDIT',
            mesh: { ...lists, ...(select_mode ? { select_mode } : {}) },
          },
        });
        expect(r.selection.mesh.select_mode, `${JSON.stringify(lists)} ${select_mode}`).toBe(expected);
      }
      if (left !== 'VERT') expect(message).toContain("pass 'VERT' to select the vertices of the listed");
    }
    await ok('run_operator', {
      project: id,
      operator: 'scene.stats',
      selection: { objects: ['Cube'], mode: 'EDIT', mesh: { faces: [1] } },
    });
    // the lists each mode uses still select: faces in FACE mode, edges in EDGE mode, all lists in
    // VERT mode (by their vertices), and all: false with lists
    const sorted = (after: { select_mode: string; verts: number[]; faces: number[] }) => ({
      ...after,
      verts: [...after.verts].sort((x, y) => x - y),
    });
    const faces = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'scene.stats',
      selection: { faces: [0], all: false },
      select_mode: 'FACE',
    });
    expect(sorted(faces.selection_after)).toEqual({
      select_mode: 'FACE',
      verts: [...face].sort((x, y) => x - y),
      faces: [0],
    });
    const edges = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'scene.stats',
      selection: { edges: [edge] },
      select_mode: 'EDGE',
    });
    expect(sorted(edges.selection_after)).toEqual({
      select_mode: 'EDGE',
      verts: [...edge].sort((x, y) => x - y),
      faces: [],
    });
    const verts = await ok('edit_mesh', {
      project: id,
      object: 'Cube',
      operator: 'scene.stats',
      selection: { verts: [face[2]], edges: [edge], faces: [] },
      select_mode: 'VERT',
    });
    expect(sorted(verts.selection_after)).toEqual({
      select_mode: 'VERT',
      verts: [face[0], face[1], face[2]].sort((x, y) => x - y),
      faces: [],
    });
  });

  it('name only remedies that the next call accepts as they are, for every combination of all, select_mode and lists', async () => {
    const { id } = await ok('create_project', { name: 'Select mode remedies' });
    const faces = (await ok('get_mesh_data', { project: id, object: 'Cube' })).faces as number[][];
    // a face, an edge of another face and a vertex of neither: each list selects vertices of its own
    const edge = [faces[1][0], faces[1][1]];
    const vert = [0, 1, 2, 3, 4, 5, 6, 7].find((v) => !faces[0].includes(v) && !edge.includes(v))!;
    const LISTS: { verts: number[]; edges: number[][]; faces: number[] } = {
      verts: [vert],
      edges: [edge],
      faces: [0],
    };
    type List = keyof typeof LISTS;
    type Mesh = {
      verts?: number[];
      edges?: number[][];
      faces?: number[];
      all?: boolean;
      select_mode?: string;
    };
    const listsOf = (m: Mesh) => (['verts', 'edges', 'faces'] as const).filter((k) => m[k]);
    const inferred = (m: Mesh) => {
      const lists = listsOf(m).join();
      return lists === 'faces' ? 'FACE' : lists === 'edges' ? 'EDGE' : 'VERT';
    };
    const sorted = (xs: Iterable<number>) => [...new Set(xs)].sort((a, b) => a - b);
    /** What a selection the server accepts selects (mesh/selection.ts: the select mode's rules). */
    function expected(m: Mesh): { select_mode: string; verts: number[]; faces: number[] } {
      const mode = m.select_mode ?? inferred(m);
      if (!listsOf(m).length) {
        const all = m.all !== false;
        return {
          select_mode: mode,
          verts: all ? [0, 1, 2, 3, 4, 5, 6, 7] : [],
          faces: all ? [0, 1, 2, 3, 4, 5] : [],
        };
      }
      const ofEdges = (m.edges ?? []).flat();
      const ofFaces = (m.faces ?? []).flatMap((f) => faces[f]);
      if (mode === 'FACE') return { select_mode: mode, verts: sorted(ofFaces), faces: sorted(m.faces ?? []) };
      if (mode === 'EDGE') return { select_mode: mode, verts: sorted(ofEdges), faces: [] };
      const verts = sorted([...(m.verts ?? []), ...ofEdges, ...ofFaces]);
      return {
        select_mode: mode,
        verts,
        faces: faces.flatMap((f, i) => (f.every((v) => verts.includes(v)) ? [i] : [])),
      };
    }
    /** edit_mesh with the mesh selection `m` (its select_mode next to the selection). */
    async function select(m: Mesh) {
      const { select_mode, ...selection } = m;
      return call('edit_mesh', {
        project: id,
        object: 'Cube',
        operator: 'scene.stats',
        selection,
        ...(select_mode ? { select_mode } : {}),
      });
    }
    /** The remedies of a refusal: after its last ': ', split at ', ' and ', or ' outside parentheses. */
    function remedies(message: string): string[] {
      const text = message.slice(message.lastIndexOf(': ') + 2);
      const out: string[] = [];
      let depth = 0;
      let cur = '';
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
        const sep = depth
          ? null
          : text.startsWith(', or ', i)
            ? ', or '
            : text.startsWith(', ', i)
              ? ', '
              : null;
        if (sep) {
          out.push(cur);
          cur = '';
          i += sep.length - 1;
        } else cur += text[i];
      }
      return [...out, cur];
    }
    /** The call a remedy's action makes of `m`, e.g. "leave all out and pass 'VERT'". */
    function apply(m: Mesh, action: string): Mesh {
      const next = { ...m };
      const prefix = 'leave all out and ';
      const rest = action.startsWith(prefix) ? action.slice(prefix.length) : action;
      if (rest !== action || rest === 'leave all out' || rest === 'leave all and select_mode out')
        delete next.all;
      if (rest === 'leave all out') return next;
      if (rest === 'leave all and select_mode out' || rest === 'leave select_mode out') {
        delete next.select_mode;
        return next;
      }
      if (rest === 'leave the lists out') {
        for (const k of listsOf(m)) delete next[k];
        return next;
      }
      const only = rest.match(/^list only (verts|edges|faces)$/)?.[1];
      const instead = rest.match(/^list (verts|edges|faces) instead$/)?.[1];
      const mode = rest.match(/^pass '(VERT|EDGE|FACE)'$/)?.[1];
      if (only) {
        for (const k of listsOf(m)) if (k !== only) delete next[k];
      } else if (instead) {
        for (const k of listsOf(m)) delete next[k];
        Object.assign(next, { [instead]: LISTS[instead as List] });
      } else if (mode) next.select_mode = mode;
      else throw new Error(`a remedy this test does not know: '${action}'`);
      return next;
    }
    /** What "to select …" promises of the call `m` makes, checked against what the server selects. */
    function promised(m: Mesh, what: string): void {
      const lists = listsOf(m);
      const mode = m.select_mode ?? inferred(m);
      if (what === 'everything') expect(lists).toEqual([]);
      else if (what === 'only the listed elements') expect(lists.length).toBeGreaterThan(0);
      else if (what === 'the listed faces') expect([mode, lists.join()]).toEqual(['FACE', 'faces']);
      else if (what === 'the listed edges') expect([mode, lists.join()]).toEqual(['EDGE', 'edges']);
      else {
        expect(mode, what).toBe('VERT');
        const others = lists.filter((k) => k !== 'verts');
        const of = `the vertices of the listed ${others.join(' and ')}`;
        expect(what).toBe(
          !others.length
            ? 'the listed vertices'
            : lists.includes('verts')
              ? `the listed vertices with ${of}`
              : of,
        );
      }
    }
    let refusals = 0;
    let checked = 0;
    for (const all of [undefined, true, false])
      for (const select_mode of [undefined, 'VERT', 'EDGE', 'FACE'])
        for (let bits = 0; bits < 8; bits++) {
          const m: Mesh = {
            ...(bits & 1 ? { verts: LISTS.verts } : {}),
            ...(bits & 2 ? { edges: LISTS.edges } : {}),
            ...(bits & 4 ? { faces: LISTS.faces } : {}),
            ...(all === undefined ? {} : { all }),
            ...(select_mode ? { select_mode } : {}),
          };
          const label = JSON.stringify(m);
          const lists = listsOf(m);
          const unused = lists.some(
            (k) => (m.select_mode === 'EDGE' && k !== 'edges') || (m.select_mode === 'FACE' && k !== 'faces'),
          );
          const r = await select(m);
          // refused exactly when lists come with all: true or with a mode that does not use them
          expect(!!r.raw.isError, `${label}: ${r.text}`).toBe(lists.length > 0 && (all === true || unused));
          if (!r.raw.isError) {
            const after = JSON.parse(r.text).selection_after;
            expect({ ...after, verts: sorted(after.verts) }, label).toEqual(expected(m));
            continue;
          }
          refusals++;
          const message = r.text.slice(0, r.text.indexOf('\n'));
          expect(JSON.parse(r.text.slice(r.text.indexOf('\n') + 1)).code, label).toBe('POLL_FAILED');
          // both problems are named in one message
          if (unused) expect(message, label).toMatch(/^select_mode '(EDGE|FACE)' selects only the listed/);
          if (all === true) expect(message, label).toContain('all: true selects every element');
          for (const remedy of remedies(message)) {
            const [, action, alternative, what] =
              remedy.match(/^(.+?)(?: \(or (.+)\))?(?: to select (.+))?$/) ?? [];
            for (const a of [action, alternative]) {
              if (!a) continue;
              const next = apply(m, a);
              const again = await select(next);
              expect(
                again.raw.isError,
                `${label} → ${a} (${JSON.stringify(next)}): ${again.text}`,
              ).toBeFalsy();
              const after = JSON.parse(again.text).selection_after;
              expect({ ...after, verts: sorted(after.verts) }, `${label} → ${a}`).toEqual(expected(next));
              if (what) promised(next, what);
              checked++;
            }
          }
        }
    // 7 list sets with all: true in 4 modes, and 6 with EDGE and with FACE for all left out or false
    expect(refusals).toBe(28 + 24);
    expect(checked).toBeGreaterThan(2 * refusals);
    // docs/mcp.md quotes the remedies of a message that names both problems
    const both = await select({ faces: [0], all: true, select_mode: 'EDGE' });
    const message = both.text.slice(0, both.text.indexOf('\n'));
    const doc = readFileSync(fileURLToPath(new URL('../../../../docs/mcp.md', import.meta.url)), 'utf8');
    expect(doc.replace(/\s+/g, ' ')).toContain(`("…: ${message.slice(message.lastIndexOf(': ') + 2)}")`);
  });
});

describe('an editor that leaves the project before it answers', () => {
  it('wm.read_homefile: the error says that the editor switched to the new project, as expected', async () => {
    const { id } = await ok('create_project', { name: 'Editor leaves' });
    // like the web app: wm.read_homefile closes the project the editor has open (createProject)
    // before the operator returns, so its answer is never sent
    const browser: SyncTestClient = await editor(id, async (method, params) => {
      if (method === 'ui' && params.command === 'run_operator') await browser.disconnect();
      return { ok: true };
    });
    const r = await call('editor_command', {
      project: id,
      command: 'run_operator',
      params: { operator: 'wm.read_homefile', params: { name: 'Switched' } },
    });
    expect(r.raw.isError).toBe(true);
    expect(r.text).toBe(
      "editor_command 'run_operator' got no answer for wm.read_homefile, as expected: the editor creates a new " +
        "project ('Switched') and switches to it, which closes its connection to this project before it can " +
        'answer; list_projects lists the new project, get_connected_clients the editors that still have this one open.',
    );
    expect(browser.rpcRequests.map((q) => q.params)).toEqual([
      { command: 'run_operator', params: { operator: 'wm.read_homefile', params: { name: 'Switched' } } },
    ]);
  });

  it('other commands: whether the editor carried them out is unknown', async () => {
    const { id } = await ok('create_project', { name: 'Editor reloads' });
    // the page is closed or reloaded while the editor works on the command
    const browser: SyncTestClient = await editor(id, async () => {
      await browser.disconnect();
      return { ok: true };
    });
    const r = await call('editor_command', { project: id, command: 'view.frame_all' });
    expect(r.raw.isError).toBe(true);
    expect(r.text).toBe(
      "editor_command 'view.frame_all' failed: the editor's connection to this project closed before it answered " +
        '(its page was closed or reloaded, it opened another project or lost its connection, or the server ' +
        'closed the project), so whether it carried the command out is unknown; get_connected_clients lists the ' +
        'editors that have the project open.',
    );
    expect(r.text).not.toContain('client disconnected');
  });
});

describe("browser UI operators that act on the person's editor say so", () => {
  it('wm.read_homefile, wm.share and the other File operators, through run_operator, batch and edit_mesh', async () => {
    const { id } = await ok('create_project', { name: 'Browser file ops' });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Cube'] } });
    const before = await state(id);
    const RUN = (op: string) =>
      `editor_command {project, command: 'run_operator', params: {operator: '${op}', params: {…}}} ` +
      '(get_connected_clients lists the editors that have the project open)';
    const HEAD = (op: string) =>
      `'${op}' is an operator of the browser editor's user interface (viewport, playback, tools, windows): ` +
      'only a live editor can run it, not run_operator, batch or edit_mesh.';
    const home = await failed('run_operator', {
      project: id,
      operator: 'wm.read_homefile',
      params: { name: 'X' },
    });
    expect(home.message).toBe(
      `${HEAD('wm.read_homefile')} To create a project use create_project. In a live editor run it with ` +
        `${RUN('wm.read_homefile')}: it creates a new project ({name, empty}) and switches the person's editor to ` +
        'it, away from the project it had open, which it leaves before it can answer (editor_command says so; ' +
        'list_projects lists the new project).',
    );
    expect(home.json).toEqual({
      ok: false,
      operator: 'wm.read_homefile',
      error: home.message,
      code: 'NOT_FOUND',
      selection: before,
    });
    const share = await failed('edit_mesh', { project: id, object: 'Cube', operator: 'wm.share' });
    expect(share.message).toBe(
      `${HEAD('wm.share')} For the project's link use get_project (editor_url). In a live editor run it with ` +
        `${RUN('wm.share')}: it puts the project's link on the person's clipboard, replacing what they had ` +
        'copied (a browser that refuses the copy shows them the link in a message; an editor page without ' +
        'clipboard access, served over plain HTTP from a host other than localhost, does nothing).',
    );
    const res = await call('batch', {
      project: id,
      stop_on_error: false,
      operations: [
        { operator: 'wm.import' },
        { operator: 'wm.export' },
        { operator: 'wm.open_mainfile' },
        { operator: 'wm.search_menu' },
        { operator: 'wm.save_mainfile' },
      ],
    });
    const out = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1));
    expect(out.results.map((r: { code: string }) => r.code)).toEqual(Array(5).fill('NOT_FOUND'));
    const [imp, exp, open, search, save] = out.results.map((r: { error: string }) => r.error);
    expect(imp).toContain(
      "it asks the browser to open a file chooser on the person's screen, which browsers block unless the person " +
        'has just clicked or pressed a key, so from editor_command it normally opens nothing (and still answers ok).',
    );
    expect(exp).toMatch(/: it opens the Export window on the person's screen\.$/);
    expect(open).toMatch(/: it opens the project browser on the person's screen\.$/);
    expect(search).toMatch(/: it opens the operator search on the person's screen\.$/);
    expect(save).toMatch(/: it makes that editor sync its WebDAV copy at once if it has one/);
    expect(await state(id)).toEqual(before);
  });
});

describe('did-you-mean: completions of the id come first', () => {
  it("'wm.save', 'view3d.view' and 'object.dupli', with each note's advice naming its id", async () => {
    const { id } = await ok('create_project', { name: 'Completions' });
    const save = await failed('run_operator', { project: id, operator: 'wm.save' });
    expect(save.message).toBe(
      "Unknown operator 'wm.save'. Did you mean: wm.save_mainfile, wm.share? They are operators of the browser " +
        "editor's user interface (instead: nothing (the server stores projects) for wm.save_mainfile, get_project " +
        "for wm.share): a live editor runs them with editor_command {project, command: 'run_operator', params: " +
        '{operator, params}}. Use list_operators.',
    );
    expect(save.json.code).toBe('NOT_FOUND');
    const view = await failed('edit_mesh', { project: id, object: 'Cube', operator: 'VIEW3D.View' });
    expect(view.message).toMatch(
      /^Unknown operator 'VIEW3D\.View'\. Did you mean: view3d\.view_all, view3d\.view_axis, view3d\.view_orbit, view3d\.view_camera, view3d\.view_selected, view3d\.view_persportho\b/,
    );
    const res = await call('batch', { project: id, operations: [{ operator: 'object.dupli' }] });
    const dup = JSON.parse(res.text.slice(res.text.indexOf('\n') + 1)).results[0];
    expect(dup.code).toBe('NOT_FOUND');
    expect(dup.error).toMatch(
      /^Unknown operator 'object\.dupli'\. Did you mean: object\.duplicate, object\.duplicate_move, object\.duplicates_make_real, /,
    );
    expect(dup.error).toContain(
      "? object.duplicate_move is an operator of the browser editor's user interface (instead: object.duplicate " +
        '{offset}): a live editor runs it',
    );
    // a single suggestion that does not complete the id names the id its advice is for
    const share = await failed('run_operator', { project: id, operator: 'wm.sahre' });
    expect(share.message).toBe(
      "Unknown operator 'wm.sahre'. Did you mean: wm.share? It is an operator of the browser editor's user " +
        'interface (instead: get_project for wm.share): a live editor runs it with editor_command {project, ' +
        "command: 'run_operator', params: {operator, params}}. Use list_operators.",
    );
  });
});

describe('names with line breaks', () => {
  it('keep the message on the first line and the JSON after it', async () => {
    const { id } = await ok('create_project', { name: 'Line\nbreak project' });
    await ok('add_object', { project: id, type: 'cube', name: 'Bad\nName {x}', location: [4, 0, 0] });
    // U+2028 (LINE SEPARATOR) and a carriage return inside a name
    const odd = `Odd${String.fromCharCode(0x2028)}Em\rpty`;
    await ok('add_object', { project: id, type: 'empty', name: odd });
    await ok('run_operator', { project: id, operator: 'scene.stats', selection: { objects: ['Light'] } });
    const before = await state(id);
    const objects = 'Objects: Bad\\nName {x}, Camera, Cube, Light, Odd\\u2028Em\\rpty.';
    const cases: [string, Record<string, unknown>, string, string][] = [
      [
        'run_operator',
        { operator: 'object.delete', selection: { objects: ['Nope'] } },
        `Object 'Nope' not found in project 'Line\\nbreak project'. ${objects}`,
        'NOT_FOUND',
      ],
      [
        'edit_mesh',
        { object: 'No\npe', operator: 'mesh.subdivide' },
        `Object 'No\\npe' not found in project 'Line\\nbreak project'. ${objects}`,
        'NOT_FOUND',
      ],
      [
        'edit_mesh',
        { object: odd, operator: 'mesh.subdivide' },
        "'Odd\\u2028Em\\rpty' is not a mesh object.",
        'POLL_FAILED',
      ],
      [
        'run_operator',
        { operator: 'mesh.sub\ndivide' },
        "Unknown operator 'mesh.sub\\ndivide'.",
        'NOT_FOUND',
      ],
    ];
    for (const [tool, args, message, code] of cases) {
      const r = await call(tool, { project: id, ...args });
      expect(r.raw.isError).toBe(true);
      const nl = r.text.indexOf('\n');
      const first = r.text.slice(0, nl);
      expect(first.startsWith(message), `${first} / ${message}`).toBe(true);
      const json = JSON.parse(r.text.slice(nl + 1));
      expect(json).toMatchObject({
        ok: false,
        operator: args.operator,
        error: first,
        code,
        selection: before,
      });
    }
    // an operator failure whose message names what the agent passed
    const track = await failed('run_operator', {
      project: id,
      operator: 'object.track_set',
      params: { target: 'Ta\nrget' },
      selection: { objects: ['Cube'] },
    });
    expect(track.message).toBe("object.track_set failed: Target object 'Ta\\nrget' not found");
    expect(track.json).toMatchObject({
      error: "Target object 'Ta\\nrget' not found",
      code: 'NOT_FOUND',
      selection: before,
    });
    // batch: the first line is the count, the JSON parses
    const res = await call('batch', {
      project: id,
      operations: [{ operator: 'object.delete', selection: { objects: ['Nope'] } }],
    });
    const nl = res.text.indexOf('\n');
    expect(res.text.slice(0, nl)).toBe('1 of 1 operation(s) failed');
    expect(JSON.parse(res.text.slice(nl + 1)).results[0]).toEqual({
      operator: 'object.delete',
      ok: false,
      error: `selection: Object 'Nope' not found in project 'Line\\nbreak project'. ${objects}`,
      code: 'NOT_FOUND',
    });
    // an unknown project lists the project names on the first line too
    const project = await failed('run_operator', { project: 'Nope', operator: 'scene.stats' });
    expect(project.message).toMatch(
      /^Project 'Nope' not found\. Known projects: .*'Line\\nbreak project' \(/,
    );
    expect(project.json).toMatchObject({ error: project.message, code: 'NOT_FOUND' });
    expect(await state(id)).toEqual(before);
  });
});

describe('tool descriptions', () => {
  it('match what the tools do', async () => {
    const tools = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
    const run = tools.get('run_operator')!.description!;
    expect(run).toContain(
      'render.render_software and render.render_animation are refused: use render_image / render_animation',
    );
    expect(run).not.toMatch(/render\.\* operators: use/);
    expect(run).toMatch(
      /ids of the browser editor's own UI operators \(view3d\.\*, wm\.\*, screen\.\*, ed\.\*, render\.render …\)/,
    );
    expect(run).toContain("object.duplicate {offset} for Shift+D's object.duplicate_move");
    const editor = tools.get('editor_command')!;
    expect(editor.description).toContain(
      "screenshot {width: pixels (default: the viewport size); height: pixels (default: the viewport size); shading: WIREFRAME | SOLID | MATERIAL | RENDERED (default: the viewport's shading)} — a PNG of the editor's viewport as the person sees it",
    );
    expect(editor.description).toContain("in the viewport's shading or `shading`, without overlays");
    expect(editor.description).not.toMatch(/whatever the (viewport's|editor's) shading/);
    expect(editor.description).toContain("take screenshots with shading 'SOLID' (grey clay, much faster)");
    // the cost of a screenshot: tens of seconds only for the first screenshot or viewport frame in
    // MATERIAL or RENDERED shading after the editor opened the project, which builds and compiles the
    // scene's materials for it; the editor keeps them, also for a screenshot that timed out and through
    // edits of material values, so later ones (and a retry) compile nothing (docs/mcp.md), except
    // that an edit that needs a shader no material had compiles it once in each of these shadings
    const overstated =
      /tens of seconds (per screenshot|for a screenshot in)|each screenshot then builds|while (its|the) viewport shows another/;
    expect(editor.description).not.toMatch(overstated);
    expect(editor.description).toContain(
      "the first screenshot or viewport frame in each of them after the editor opened the project tens of seconds: the editor builds and compiles the scene's materials for that shading and keeps them, so later screenshots in it, and the viewport switching to it, compile nothing",
    );
    // a screenshot costs a frame of its own shading and work of its own (rpc.ts), not one frame
    for (const text of [editor.description, client.getInstructions()!]) expect(text).not.toMatch(/one frame/);
    expect(editor.description).toContain(
      'the viewport switching to it, compile nothing, also after the viewport turned its anti-aliasing off',
    );
    expect(editor.description).toContain(
      "compile nothing, also after the viewport turned its anti-aliasing off (for slow frames or more than a million triangles) and after material edits that change values (colours, roughness, texture settings), while an edit that needs a shader no material had (coat or sheen turned on, a procedural texture on a set of channels that no other material has) makes the next one in each of these two shadings compile it (0.6–4.5 s, or up to 12.9 s for a material with several procedural textures, measured in software WebGL and varying with the machine's load); SOLID and WIREFRAME screenshots wait until the frame the viewport is drawing is done, also one that compiles; a scene with millions of triangles takes seconds per frame in any shading; the other commands wait while the editor's main thread is busy (during a screenshot, seconds after the viewport switched to MATERIAL or RENDERED for the first time, while it builds the scene's materials, and per frame for a scene with millions of triangles)",
    );
    expect(editor.description).toContain(
      'a screenshot that timed out still compiles what it needs and keeps it, so retrying it waits for the rest and compiles nothing again',
    );
    expect(editor.description).not.toMatch(/10–15 s|procedural wood/);
    // no recompile in a second shading after a value edit (the editor keeps the replaced material for
    // every shading it was drawn in), and no example that reuses a shader (transmission in that scene)
    for (const text of [editor.description, client.getInstructions()!])
      expect(text).not.toMatch(/second of these two shadings|1\.2–11\.9|11\.9 s|transmission turned on/);
    expect(client.getInstructions()).not.toMatch(overstated);
    expect(client.getInstructions()).toContain(
      "the first screenshot or viewport frame in each of them after the editor opened the project tens of seconds (it builds and compiles the scene's materials for that shading and keeps them, also when the viewport turns its anti-aliasing off and through material edits that change values; an edit that needs a shader no material had, such as coat or sheen turned on or a procedural texture on a set of channels that no other material has, makes the next one in each of them compile it: 0.6–4.5 s, or up to 12.9 s for a material with several procedural textures, measured in software WebGL and varying with the machine's load), and a scene with millions of triangles seconds per frame in any shading",
    );
    expect(client.getInstructions()).not.toMatch(/10–15 s|procedural wood/);
    // what the editor's UI operators do there, said plainly, and wm.read_homefile's missing answer
    expect(editor.description).not.toContain('when asked for one it says what it does here');
    expect(editor.description).toContain(
      'the run_operator tool refuses them with a message that says what each one does there',
    );
    expect(editor.description).toContain(
      'wm.read_homefile switches that editor to a new project, so it leaves this one before it can answer, and the error says so',
    );
    const timeout = (
      editor.inputSchema.properties as Record<string, { maximum?: number; description?: string }>
    ).timeout_ms;
    expect(timeout.description).not.toMatch(overstated);
    expect(timeout.description).toContain(
      "the first screenshot or viewport frame of a heavy scene in MATERIAL or RENDERED shading takes tens of seconds (the editor builds and compiles that shading's materials and keeps them, so later ones compile nothing), one after a material edit that needs a shader no material had as long as compiling that shader takes (0.6–4.5 s, or up to 12.9 s for a material with several procedural textures, measured in software WebGL and varying with the machine's load), and every screenshot or frame seconds in any shading with millions of triangles",
    );
    expect(timeout.description).not.toMatch(/one frame/);
    expect(timeout.description).toContain('so later ones compile nothing');
    expect(timeout.maximum).toBe(55_000);
    expect(editor.description).toContain('at most 55000');
    expect(tools.get('render_image')!.description).toContain('renderer browser waits up to 55 s');
    // a longer wait than the maximum is refused before anything is sent
    const { id } = await ok('create_project', { name: 'Editor timeout max', empty: true });
    const r = await call('editor_command', { project: id, command: 'get_view', timeout_ms: 60_000 });
    expect(r.raw.isError).toBe(true);
    expect(r.text).toMatch(/timeout_ms/);
  });
});

describe('timeouts of the browser editor', () => {
  it('editor_command names timeout_ms, its maximum and what to do', async () => {
    const { id } = await ok('create_project', { name: 'Editor timeout', empty: true });
    const browser = await editor(id, (method, params) =>
      method === 'ui' && params.command === 'screenshot' ? never() : { done: params.command },
    );
    const r = await call('editor_command', { project: id, command: 'screenshot', timeout_ms: 200 });
    expect(r.raw.isError).toBe(true);
    expect(r.text).toBe(
      "editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 200 ms (at " +
        'most 55000); it may still carry the command out, and its next commands and renders wait ' +
        "until it has. The screenshot is drawn in the viewport's shading, like a frame of the " +
        'viewport. An editor without GPU acceleration (software WebGL, e.g. a headless browser) takes ' +
        'seconds for that with a scene of millions of triangles in any shading (3.3–5.2 s in SOLID ' +
        'with 4 million) and with a heavy scene in MATERIAL or RENDERED shading, and tens of seconds ' +
        'for its first screenshot or frame in one of these two after it opened the project, while it ' +
        "builds and compiles the scene's materials for that shading. After a material edit that needs " +
        'a shader no material had (coat or sheen turned on, a procedural texture on a set of channels ' +
        'that no other material has), its next screenshot or frame in each of these two compiles it ' +
        '(0.6–4.5 s, or up to 12.9 s for a material with several procedural textures). The times ' +
        "given were measured in software WebGL and vary with the machine's load. It keeps what it " +
        'compiled, so a retry waits for the editor to finish and compiles nothing again. Retry with a ' +
        "larger timeout_ms (at most 55000), or pass shading 'SOLID' for the screenshot (grey clay, " +
        "much faster); for a quick look use render_image with shading 'SOLID', and render_image for " +
        'final images.',
    );
    // other failures keep their message
    expect(await ok('editor_command', { project: id, command: 'view.frame_all' })).toEqual({
      command: 'view.frame_all',
      result: { done: 'view.frame_all' },
    });
    expect(browser.rpcRequests.map((q) => q.method)).toEqual(['ui', 'ui']);
  });

  it('screenshot: the shading goes to the editor as given; a timeout advises for it, an unknown one is refused first', async () => {
    const { id } = await ok('create_project', { name: 'Screenshot shading', empty: true });
    const browser = await editor(id, (method, params) =>
      method === 'ui' && params.command === 'screenshot' && params.params.shading !== 'Rendered'
        ? never()
        : { mime: 'image/png', data_base64: TINY_PNG, width: 1, height: 1 },
    );
    // the editor reads the shading letter case ignored: the server passes it on as given
    const image = await call('editor_command', {
      project: id,
      command: 'screenshot',
      params: { shading: 'Rendered', width: 64 },
    });
    expect(image.raw.isError).toBeFalsy();
    expect(image.raw.content[0]).toMatchObject({ type: 'image', data: TINY_PNG, mimeType: 'image/png' });
    expect(browser.rpcRequests.at(-1)?.params).toEqual({
      command: 'screenshot',
      params: { shading: 'Rendered', width: 64 },
    });
    // a timeout of a MATERIAL screenshot names that shading and advises SOLID
    const material = await call('editor_command', {
      project: id,
      command: 'screenshot',
      params: { shading: 'material' },
      timeout_ms: 200,
    });
    expect(material.raw.isError).toBe(true);
    expect(material.text).toContain(
      'until it has. An editor without GPU acceleration (software WebGL, e.g. a headless browser) ' +
        'takes seconds per MATERIAL screenshot of a heavy scene, and tens of seconds for its first ' +
        'MATERIAL screenshot or viewport frame after it opened the project, while it builds and ' +
        "compiles the scene's materials for MATERIAL shading. After a material edit that needs a " +
        'shader no material had (coat or sheen turned on, a procedural texture on a set of channels ' +
        'that no other material has), its next MATERIAL screenshot or viewport frame compiles it ' +
        '(0.6–4.5 s, or up to 12.9 s for a material with several procedural textures). The times ' +
        "given were measured in software WebGL and vary with the machine's load. It keeps what it " +
        'compiled, so a retry waits for the editor to finish and compiles nothing again. Retry with a ' +
        "larger timeout_ms (at most 55000), or pass shading 'SOLID' for the screenshot (grey clay, " +
        'much faster)',
    );
    // a SOLID one is not told to use SOLID
    const solid = await call('editor_command', {
      project: id,
      command: 'screenshot',
      params: { shading: 'SOLID' },
      timeout_ms: 200,
    });
    expect(solid.raw.isError).toBe(true);
    // (the editor is still busy with the MATERIAL screenshot, which the message names first)
    expect(solid.text).toMatch(/sent \d+ s ago\)\. An editor without GPU acceleration/);
    expect(solid.text).toContain(
      'An editor without GPU acceleration (software WebGL, e.g. a headless browser) can take ' +
        'seconds per screenshot of a scene with millions of triangles even in SOLID shading, and a ' +
        'screenshot waits until the frame its viewport is drawing is done. In MATERIAL or RENDERED ' +
        'shading that frame compiles shaders the first time after the editor opened the project (tens ' +
        "of seconds for a heavy scene, while it builds and compiles the scene's materials) and after " +
        'a material edit that needs a shader no material had (coat or sheen turned on, a procedural ' +
        'texture on a set of channels that no other material has: 0.6–4.5 s, or up to 12.9 s for a ' +
        'material with several procedural textures). The times given were measured in software WebGL ' +
        "and vary with the machine's load. It keeps what it compiled, so a retry waits for the editor " +
        'to finish and compiles nothing again. Retry with a larger timeout_ms (at most 55000), or ' +
        "render without the editor: render_image with shading 'SOLID' and renderer 'software' (grey " +
        'clay, rendered on the server, which can run out of memory for millions of triangles).',
    );
    expect(solid.text).not.toContain("pass shading 'SOLID'");
    // an unknown shading never reaches the editor
    const sent = browser.rpcRequests.length;
    const wrong = await call('editor_command', {
      project: id,
      command: 'screenshot',
      params: { shading: 'SOILD' },
    });
    expect(wrong.raw.isError).toBe(true);
    expect(wrong.text).toBe(
      `screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?).`,
    );
    expect(browser.rpcRequests.length).toBe(sent);
  });

  /**
   * Records how long render_image and editor_command wait for the editor of `project` (the room's
   * rpcTo) and makes the request time out after `fast` ms instead; `fast = null` waits for real.
   */
  function recordWaits(project: string) {
    const room = server.handle.rooms.get(project) as Room;
    const waits: number[] = [];
    const real = room.rpcTo.bind(room);
    const ctl = { waits, fast: 50 as number | null, room };
    room.rpcTo = (conn, method, params, timeoutMs) => {
      waits.push(timeoutMs ?? -1);
      return real(conn, method, params, ctl.fast ?? timeoutMs);
    };
    return ctl;
  }

  it('render_image waits 55 s for a browser RASTER image with renderer browser, 15 s with auto', async () => {
    const { id } = await ok('create_project', { name: 'Browser render timeouts' });
    await editor(id, never);
    // the editor never answers: record how long the tool waits, then time out at once
    const { waits } = recordWaits(id);
    const browser = await call('render_image', {
      project: id,
      renderer: 'browser',
      engine: 'RASTER',
      width: 32,
      height: 24,
    });
    expect(browser.raw.isError).toBe(true);
    expect(browser.text).toBe(
      'browser render failed: the editor did not finish the RASTER image within 55 s. It may still be drawing ' +
        'it, and its next renders and commands wait until it has. A heavy scene takes tens of seconds in an ' +
        'editor without GPU acceleration (software WebGL, e.g. a headless browser): render on the server with ' +
        "renderer 'software' (or 'auto'), render a smaller image, or pass shading 'SOLID' (grey clay, faster).",
    );
    expect(waits).toEqual([55_000]);

    // a browser path trace gets time_limit + 30 s; the editor was still busy with the raster image
    const pt = await call('render_image', {
      project: id,
      renderer: 'browser',
      engine: 'PATHTRACER',
      time_limit: 2,
      width: 32,
      height: 24,
    });
    expect(pt.raw.isError).toBe(true);
    expect(pt.text).toMatch(
      /^browser render failed: the editor did not finish path tracing within 32 s \(time_limit 2 s \+ 30 s for loading, compiling and denoising\) \(it was still busy with an earlier request that the server had stopped waiting for: a RASTER render sent \d+ s ago\)\. Its render workers may still be busy with it\. Path trace on the server with renderer 'software' or 'auto' \(all its CPU cores\), or lower time_limit or the image size\.$/,
    );
    expect(waits).toEqual([55_000, 32_000]);

    // a SOLID render is not told to render SOLID (the path trace runs on the editor's render workers
    // and does not hold up its next requests: only the raster image is named)
    const solid = await call('render_image', {
      project: id,
      renderer: 'browser',
      shading: 'SOLID',
      width: 32,
      height: 24,
    });
    expect(solid.text).toMatch(
      /^browser render failed: the editor did not finish the RASTER image within 55 s \(it was still busy with an earlier request that the server had stopped waiting for: a RASTER render sent \d+ s ago\)\. It may still be drawing it/,
    );
    expect(solid.text).toMatch(
      /render on the server with renderer 'software' \(or 'auto'\) or render a smaller image\.$/,
    );
    expect(solid.text).not.toMatch(/shading 'SOLID'/);

    // with no editor at all, renderer browser says so
    const plain = await ok('create_project', { name: 'Browser render none', empty: true });
    expect((await call('render_image', { project: plain.id, renderer: 'browser' })).text).toBe(
      "no connected browser editor can render. Open the project in a browser or use renderer 'software'.",
    );
  });

  it('auto waits 15 s, then renders on the server while the editor is busy with that image or was too slow for it', async () => {
    const { id } = await ok('create_project', { name: 'Auto fallback' });
    // an editor that finishes nothing until the test lets it (after the 'select' below), so it is
    // still busy with the first image for every request before that whatever the machine's load
    // (a fixed 2.5 s ran out before the 'select' when the server's own renders took longer), and
    // answers late: later than the 50 ms the server waits
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const browser = await editor(id, async (method, params) => {
      await finished;
      return method === 'render'
        ? { mime: 'image/png', data_base64: TINY_PNG, width: params.width, height: params.height }
        : { done: params.command };
    });
    const ctl = recordWaits(id);
    const render = async () => {
      const r = await call('render_image', { project: id, engine: 'RASTER', width: 32, height: 24 });
      expect(r.raw.isError, r.text).toBeFalsy();
      return JSON.parse(r.raw.content.find((c) => c.type === 'text')!.text!);
    };
    const first = await render();
    expect(first.renderer).toBe('software');
    expect(first.note).toBe(
      "browser render failed: the editor did not finish the RASTER image within 15 s (renderer 'auto' waits 15 s " +
        "before it renders on the server; renderer 'browser' waits 55 s); it may still be drawing it, and until " +
        "it has, renderer 'auto' renders on the server without asking it",
    );
    expect(ctl.waits).toEqual([15_000]);
    // still drawing: the next auto render does not queue behind it, nothing is sent to the editor
    const second = await render();
    expect(second.renderer).toBe('software');
    expect(second.note).toMatch(
      /^the browser editor is still busy with an earlier request that the server stopped waiting for \(a RASTER render sent \d+ s ago\): renderer 'auto' renders on the server until it has finished$/,
    );
    expect(ctl.waits).toEqual([15_000]);
    expect(browser.rpcRequests).toHaveLength(1);
    // an editor command that times out names what the editor was still busy with
    const select = await call('editor_command', { project: id, command: 'select', params: { objects: [] } });
    expect(select.raw.isError).toBe(true);
    expect(select.text).toMatch(
      /^editor_command 'select' failed: the editor did not answer within timeout_ms = 10000 ms \(at most 55000\); it may still carry the command out, and its next commands and renders wait until it has\. It was still busy with an earlier request that the server had stopped waiting for \(a RASTER render sent \d+ s ago\)\. 'select' waits while the editor draws its viewport/,
    );
    // once the editor has answered both late, auto still renders on the server for a while: the
    // editor was too slow for its last image, and asking it again would only wait in vain
    finish();
    await eventually(() => ctl.room.lateRpcs(ctl.room.pickRpcTarget('render')!).length === 0);
    const fourth = await render();
    expect(fourth.renderer).toBe('software');
    expect(fourth.note).toMatch(
      /^the browser editor answered its last RASTER image after \d+ s, when the server had stopped waiting for it: renderer 'auto' renders on the server and asks that editor again 120 s after that image; renderer 'browser' waits up to 55 s$/,
    );
    expect(ctl.waits).toEqual([15_000, 10_000]);
    expect(browser.rpcRequests).toHaveLength(2);
    // an image in time (renderer browser waits longer) makes auto use the editor again
    ctl.fast = null;
    const explicit = await call('render_image', {
      project: id,
      renderer: 'browser',
      engine: 'RASTER',
      width: 32,
      height: 24,
    });
    expect(explicit.raw.isError, explicit.text).toBeFalsy();
    const fifth = await render();
    expect(fifth.renderer).toBe('browser');
    expect(fifth.note).toBeUndefined();
    expect(ctl.waits).toEqual([15_000, 10_000, 55_000, 15_000]);
  });

  it('renders on an editor that is not busy when several are connected', async () => {
    const { id } = await ok('create_project', { name: 'Two editors' });
    const answer = (method: string, params: any) =>
      method === 'render'
        ? { mime: 'image/png', data_base64: TINY_PNG, width: params.width, height: params.height }
        : { done: params.command };
    const idle = await editor(id, answer, 'Idle editor');
    const slow = await editor(id, never, 'Slow editor');
    const ctl = recordWaits(id);
    // the slow editor does not finish an image: it stays busy with it
    const first = await call('render_image', {
      project: id,
      renderer: 'browser',
      client: 'Slow editor',
      width: 16,
      height: 16,
    });
    expect(first.raw.isError).toBe(true);
    ctl.fast = null;
    for (const renderer of ['auto', 'browser']) {
      const r = await call('render_image', {
        project: id,
        renderer,
        engine: 'RASTER',
        width: 16,
        height: 16,
      });
      expect(r.raw.isError, r.text).toBeFalsy();
      const info = JSON.parse(r.raw.content.find((c) => c.type === 'text')!.text!);
      expect(info).toMatchObject({ renderer: 'browser', client: 'Idle editor' });
      expect(info.note).toBeUndefined();
    }
    expect(slow.rpcRequests).toHaveLength(1);
    expect(idle.rpcRequests).toHaveLength(2);
  });

  it('keeps long browser requests alive with progress notifications', async () => {
    const { id } = await ok('create_project', { name: 'Keep alive', empty: true });
    // an editor that needs a little over one keep-alive interval for everything
    await editor(id, async (method, params) => {
      await sleep(5300);
      return method === 'render'
        ? { mime: 'image/png', data_base64: TINY_PNG, width: params.width, height: params.height }
        : { done: params.command };
    });
    const progress: Record<string, string[]> = { raster: [], pt: [], ui: [] };
    const track = (key: string) => (p: { message?: string }) => progress[key].push(p.message ?? '');
    const [raster, pt, ui] = await Promise.all([
      call(
        'render_image',
        { project: id, renderer: 'browser', engine: 'RASTER', width: 16, height: 16 },
        track('raster'),
      ),
      call(
        'render_image',
        { project: id, renderer: 'browser', engine: 'PATHTRACER', time_limit: 1, width: 16, height: 16 },
        track('pt'),
      ),
      call('editor_command', { project: id, command: 'view.frame_all', timeout_ms: 20_000 }, track('ui')),
    ]);
    expect([raster.raw.isError, pt.raw.isError, ui.raw.isError]).toEqual([undefined, undefined, undefined]);
    // (a loaded machine may answer after a second interval: only the first notification is checked)
    expect(progress.raster[0]).toBe('rendering in the browser editor: 5 s (waiting up to 55 s)');
    // the path tracer's keep-alive is unchanged
    expect(progress.pt[0]).toBe('path tracing in the browser editor: 5 s (time_limit 1 s)');
    expect(progress.ui[0]).toBe('waiting for the editor: 5 s (timeout_ms 20000)');
  });
});
