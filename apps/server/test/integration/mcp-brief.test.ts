import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, type TestServer } from '../helpers/app';

/*
 * desk_stage_brief and desk_shot_results over MCP (the desk embed protocol v1's SceneBrief, the
 * open.json fixture): a brief staged in a new project named after it, the same scene updated in that
 * project (one undo step each), a brief of another scene and an invalid one refused, the shots'
 * results in brief order, and no project left behind by a brief that fails to stage.
 */

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../packages/core/test/fixtures/desk-embed/${name}`, import.meta.url),
      'utf8',
    ),
  );
const openScene = () => structuredClone(fixture('open.json').scene);

/** A brief no server holds: 200 shots of ten minutes at 120 fps, each a tracking camera. */
function tooLong(id: string, name: string, shot: string) {
  const brief = openScene();
  brief.id = id;
  brief.name = name;
  brief.fps = 120;
  brief.shots = Array.from({ length: 200 }, (_, i) => ({
    ...brief.shots[0],
    id: `sht_${shot}${String(i).padStart(4, '0')}`,
    index: i,
    durationSec: 600,
    move: 'tracking_follow',
    layout: [],
  }));
  return brief;
}

let server: TestServer;
let client: Client;

type ToolResult = { content: { type: string; text?: string }[]; isError?: boolean };

async function call(name: string, args: Record<string, unknown>) {
  const raw = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  })) as ToolResult;
  const text = raw.content.map((x) => x.text ?? '').join('\n');
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error text */
  }
  return { isError: !!raw.isError, text, json };
}

async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const r = await call(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.json;
}

beforeAll(async () => {
  server = await startServer({ SYNC_PERSISTENCE: 'memory' });
  client = new Client({ name: 'brief-agent', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  await server?.cleanup();
});

describe('desk_stage_brief and desk_shot_results', () => {
  let project = '';

  it('stage a brief in a new project named after it, the host ids kept', async () => {
    const r = await ok('desk_stage_brief', { brief: openScene() });
    expect(r.project.name).toBe('Kite Day: the meadow');
    expect(r.action).toBe('staged');
    expect(r.scene_id).toBe('clp_0123456789abcdef');
    expect(r.shots.map((s: any) => [s.shotId, s.frames])).toEqual([
      ['sht_0123456789aaaa', 72],
      ['sht_0123456789bbbb', 60],
    ]);
    expect(r.cast.map((c: any) => [c.castId, c.kind])).toEqual([
      ['chr_0123456789mira', 'child'],
      ['chr_0123456789pipd', 'dog'],
    ]);
    expect(r.changes).toBeNull();
    expect(r.issues.filter((i: any) => i.severity === 'error')).toEqual([]);
    project = r.project.id;
    // a second brief without project would take the same name: refused
    const again = await call('desk_stage_brief', { brief: openScene() });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/pass project to stage the brief in it/);
  });

  it('report each staged shot in brief order, or the shots asked for', async () => {
    const r = await ok('desk_shot_results', { project });
    expect(
      r.shots.map((s: any) => [s.shotId, s.frames, s.durationSec, s.camera.lensMm, s.camera.move]),
    ).toEqual([
      ['sht_0123456789aaaa', 72, 3, expect.any(Number), 'tracking_follow'],
      ['sht_0123456789bbbb', 60, 2.5, 85, 'push_in'],
    ]);
    expect(r.shots[0].line).toMatch(/Mira is left of frame/);
    expect(r.shots[0].planAgrees).toBe(true);
    expect(r.shots[1].planAgrees).toBeNull();
    const one = await ok('desk_shot_results', { project, shots: ['sht_0123456789bbbb'] });
    expect(one.shots.map((s: any) => s.shotId)).toEqual(['sht_0123456789bbbb']);
    const unknown = await call('desk_shot_results', { project, shots: ['sht_nope'] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/shot 'sht_nope' is not a shot of the brief staged in the project/);
  });

  it('update the project staged from the same scene, as one undo step', async () => {
    const next = openScene();
    next.shots[1].durationSec = 3.5;
    next.shots.push({
      ...next.shots[1],
      id: 'sht_0123456789cccc',
      index: 2,
      durationSec: 2,
      description: 'Medium: Pip barks at the pond.',
      castIds: ['chr_0123456789pipd'],
      framing: 'medium',
      move: null,
      lensMm: null,
    });
    const r = await ok('desk_stage_brief', { project, brief: next });
    expect(r.action).toBe('updated');
    expect(r.changes).toEqual(fixture('opened-changed.json').changes);
    expect(r.shots.map((s: any) => s.frames)).toEqual([72, 84, 48]);
    expect(r.solved).toEqual(['sht_0123456789cccc']);
    await ok('undo', { project });
    const back = await ok('desk_shot_results', { project });
    expect(back.shots.map((s: any) => s.frames)).toEqual([72, 60]);
  });

  it('refuse a brief of another scene in a staged project, and a brief that does not validate', async () => {
    const other = await call('desk_stage_brief', { project, brief: { ...openScene(), id: 'clp_other' } });
    expect(other.isError).toBe(true);
    expect(other.text).toMatch(/is staged from scene 'clp_0123456789abcdef', not 'clp_other'/);
    const odd = await call('desk_stage_brief', { brief: fixture('invalid/open-odd-width.json').scene });
    expect(odd.isError).toBe(true);
    expect(odd.text).toMatch(/^invalid brief: /);
  });

  it('leave no project behind when staging a brief fails, so that the same brief can be staged again', async () => {
    const projects = async () =>
      ((await ok('list_projects', {})).projects as { name: string }[]).map((p) => p.name);
    const r = await call('desk_stage_brief', {
      brief: tooLong('clp_toolongtostage', 'Too long to stage', 'toolong'),
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^not run on the server: /);
    // what to lower: its frames (shots × length × frame rate) are what take the memory here
    expect(r.text).toContain(
      "Lower the number and length of the brief's shots (or its frame rate), and the number of its cast members, kites and balloons",
    );
    expect(r.text).toMatch(/"code":\s*"OUT_OF_MEMORY"/);
    expect(r.text).not.toMatch(/made for the brief stays/);
    // the project made for the brief went with the failure: its name is free for the next try
    expect(await projects()).not.toContain('Too long to stage');
    const fits = openScene();
    fits.id = 'clp_toolongtostage';
    fits.name = 'Too long to stage';
    const again = await ok('desk_stage_brief', { brief: fits });
    expect(again).toMatchObject({ action: 'staged', project: { name: 'Too long to stage' } });
    expect((await projects()).filter((n) => n === 'Too long to stage')).toHaveLength(1);
  });

  it('name the project made for a brief that failed to stage when storage does not delete it', async () => {
    const huge = tooLong('clp_keptafterrefusal', 'Kept after a refused deletion', 'kept');
    const rooms = server.handle.rooms;
    const deleteProject = rooms.deleteProject;
    rooms.deleteProject = async () => {
      throw new Error('storage refused');
    };
    let r: Awaited<ReturnType<typeof call>>;
    try {
      r = await call('desk_stage_brief', { brief: huge });
    } finally {
      rooms.deleteProject = deleteProject;
    }
    expect(r.isError).toBe(true);
    const listed = (await ok('list_projects', {})).projects as { id: string; name: string }[];
    const kept = listed.find((p) => p.name === 'Kept after a refused deletion')!;
    expect(kept).toBeDefined();
    expect(r.text).toContain(
      `(the project 'Kept after a refused deletion' (${kept.id}) made for the brief stays: pass it as project to stage the brief in it, or delete it)`,
    );
    expect(r.text).toMatch(/"code":\s*"OUT_OF_MEMORY"/);
    // as the error says: the brief stages in that project
    const fits = openScene();
    fits.id = 'clp_keptafterrefusal';
    fits.name = 'Kept after a refused deletion';
    expect(await ok('desk_stage_brief', { project: kept.id, brief: fits })).toMatchObject({
      action: 'staged',
      project: { id: kept.id },
    });
  });
});
