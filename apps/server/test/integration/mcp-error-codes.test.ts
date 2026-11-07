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
        '(get_connected_clients lists the editors that have the project open).',
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
        /To move, rotate or scale use transform\.translate \{value\}, transform\.rotate \{value, orient_axis\} or transform\.resize \{value\} on your selection .*: it starts a move, rotation or scale of the editor's selection that follows the person's mouse\.$/,
      ],
      [
        'edit_mesh',
        { object: 'Cube', operator: 'mesh.loopcut_pick' },
        /To cut a loop use edit_mesh \{object, operator: 'mesh\.loopcut', params: \{edge: \[a, b\], number_cuts\}\}.*: it cuts the edge ring under the person's mouse pointer\.$/,
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
    expect(editor.description).not.toMatch(/as the (person|user) sees it/);
    expect(editor.description).toContain(
      "drawn with materials and lights (RENDERED) whatever the viewport's shading",
    );
    const timeout = (editor.inputSchema.properties as Record<string, { maximum?: number }>).timeout_ms;
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
      "editor_command 'screenshot' failed: the editor did not answer within timeout_ms = 200 ms (at most 55000); " +
        'it may still carry the command out, and its next commands and renders wait until it has. An editor ' +
        'without GPU acceleration (software WebGL, e.g. a headless browser) can take tens of seconds per frame ' +
        "for a heavy scene drawn with materials and lights, as screenshots are whatever the viewport's shading, " +
        'the first time also compiling the shaders: pass a larger timeout_ms (at most 55000); for a quick look ' +
        "use render_image with shading 'SOLID' (grey clay, much faster), and render_image for final images.",
    );
    // other failures keep their message
    expect(await ok('editor_command', { project: id, command: 'view.frame_all' })).toEqual({
      command: 'view.frame_all',
      result: { done: 'view.frame_all' },
    });
    expect(browser.rpcRequests.map((q) => q.method)).toEqual(['ui', 'ui']);
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
    // an editor that finishes everything after 2.5 s: later than the 50 ms the server waits
    const browser = await editor(id, async (method, params) => {
      await sleep(2500);
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
