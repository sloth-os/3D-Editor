import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, type TestServer } from '../helpers/app';

/*
 * desk_stage_brief and desk_shot_results over MCP (the desk embed protocol v1's SceneBrief, the
 * open.json fixture): a brief staged in a new project named after it, the same scene updated in that
 * project (one undo step each), a brief of another scene and an invalid one refused, and the shots'
 * results in brief order.
 */

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../../../packages/core/test/fixtures/desk-embed/${name}`, import.meta.url),
      'utf8',
    ),
  );
const openScene = () => structuredClone(fixture('open.json').scene);

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
});
