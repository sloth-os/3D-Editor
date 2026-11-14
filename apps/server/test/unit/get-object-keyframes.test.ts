import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SceneDoc,
  createActor,
  createCube,
  evaluateFCurve,
  moveAlongPath,
  type FCurve,
} from '@3d-editor/core';
import { MCP_INSTRUCTIONS } from '../../src/mcp/instructions';
import {
  AUTO_KEYFRAMES,
  DEFAULT_KEYFRAME_PAGE,
  MAX_KEYFRAME_PAGE,
  describeObject,
  round,
} from '../../src/mcp/scene-summary';
import { registerTools, type ToolContext } from '../../src/mcp/tools';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog } from '../../src/observability/log';

/*
 * get_object's animation channels: a desk actor's walk keys its 36–38 channels at every step and a
 * baked tether or simulation keys every frame, so listing up to 100 keys per channel made one
 * get_object of an actor 100–200 KB. By default (keyframes 'auto') a channel keyed by hand (at most
 * AUTO_KEYFRAMES keys) lists its keys and a longer one is summarized (keyframe_count, first_frame,
 * last_frame, value_at_frame); 'full' pages every channel's keys, 'summary' summarizes all of them
 * and 'none' leaves them out.
 */

type Channel = {
  path: string;
  index: number;
  keyframe_count: number;
  keyframes?: { frame: number; value: number; interpolation: string }[];
  first_frame?: number | null;
  last_frame?: number | null;
  value_at_frame?: number | null;
};
type Description = Record<string, unknown> & { animation?: Channel[] };

/** A walking actor (dense gait keys) and a cube keyed by hand at three frames. */
function scene() {
  const doc = SceneDoc.create({ empty: true });
  doc.updateScene({ fps: 24, frame_start: 1, frame_end: 400 });
  const ada = createActor(doc, { kind: 'adult', name: 'Ada', location: [-4, -1, 0] });
  moveAlongPath(
    doc,
    ada.actor,
    [
      [-4, -1, 0],
      [4, -1, 0],
      [4, 6, 0],
    ],
    { frame_start: 10, speed_mps: 1.3 },
  );
  const cube = doc.addObject({
    type: 'MESH',
    name: 'Cube',
    data: doc.addMesh('Cube', createCube({ size: 1 })),
  });
  const keyed: FCurve = {
    target_type: 'object',
    target_id: cube,
    path: 'location',
    index: 2,
    keyframes: [1, 50, 100].map((frame, i) => ({ frame, value: i * 0.5, interpolation: 'BEZIER' })),
    extrapolation: 'CONSTANT',
    mute: false,
  };
  doc.setFCurve(keyed);
  return { doc, ada: doc.getObject(ada.actor)!, cube: doc.getObject(cube)! };
}

const describe_ = (doc: SceneDoc, id: string, frame: number, keys = {}) =>
  describeObject(doc, doc.getObject(id)!, frame, undefined, keys) as unknown as Description;

describe('get_object animation channels', () => {
  it("summarizes a walking actor's dense channels by default: a few KB instead of ~200 KB", () => {
    const { doc, ada } = scene();
    const full = describe_(doc, ada.id, 120, { keyframes: 'full' });
    const auto = describe_(doc, ada.id, 120);
    const dense = full.animation!.filter((c) => c.keyframe_count > AUTO_KEYFRAMES);
    expect(dense.length).toBeGreaterThan(5);
    // every channel is still there, with its key count
    expect(auto.animation!.map((c) => `${c.path}[${c.index}]:${c.keyframe_count}`)).toEqual(
      full.animation!.map((c) => `${c.path}[${c.index}]:${c.keyframe_count}`),
    );
    expect(JSON.stringify(full).length).toBeGreaterThan(60_000);
    expect(JSON.stringify(auto).length).toBeLessThan(20_000);
    const fcurves = doc.listFCurves(ada.id);
    for (const c of auto.animation!) {
      if (c.keyframe_count <= AUTO_KEYFRAMES) {
        expect(c.keyframes, c.path).toHaveLength(c.keyframe_count);
        continue;
      }
      expect(c.keyframes, c.path).toBeUndefined();
      const f = fcurves.find((x) => x.path === c.path && x.index === c.index)!;
      const frames = f.keyframes.map((k) => k.frame);
      expect(c.first_frame).toBe(Math.min(...frames));
      expect(c.last_frame).toBe(Math.max(...frames));
      // the channel's own value at the described frame
      expect(c.value_at_frame).toBe(round(evaluateFCurve(f, 120)!, 6));
    }
    expect(auto.animation_note).toBe(
      `${dense.length} channel(s) with more than ${AUTO_KEYFRAMES} keys are summarized (keyframe_count, first_frame, last_frame, value_at_frame): keyframes 'full' lists their keys (keyframe_offset and keyframe_limit page them)`,
    );
  });

  it('lists the keys of a channel keyed by hand, as before', () => {
    const { doc, cube } = scene();
    const d = describe_(doc, cube.id, 1);
    expect(d.animation).toEqual([
      {
        path: 'location',
        index: 2,
        keyframe_count: 3,
        keyframes: [
          { frame: 1, value: 0, interpolation: 'BEZIER' },
          { frame: 50, value: 0.5, interpolation: 'BEZIER' },
          { frame: 100, value: 1, interpolation: 'BEZIER' },
        ],
      },
    ]);
    expect(d).not.toHaveProperty('animation_note');
  });

  it("pages every channel's keys with keyframes 'full'", () => {
    const { doc, ada } = scene();
    const longest = Math.max(...doc.listFCurves(ada.id).map((f) => f.keyframes.length));
    expect(longest).toBeGreaterThan(DEFAULT_KEYFRAME_PAGE / 4);
    const first = describe_(doc, ada.id, 1, { keyframes: 'full', limit: 10 });
    for (const c of first.animation!) expect(c.keyframes!.length).toBe(Math.min(10, c.keyframe_count));
    expect(first.keyframe_next_offset).toBe(10);
    const next = describe_(doc, ada.id, 1, { keyframes: 'full', offset: 10, limit: 10 });
    const loc = (d: Description) => d.animation!.find((c) => c.path === 'location' && c.index === 0)!;
    const keys = doc
      .listFCurves(ada.id)
      .find((f) => f.path === 'location' && f.index === 0)!
      .keyframes.map((k) => k.frame);
    expect(loc(first).keyframes!.map((k) => k.frame)).toEqual(keys.slice(0, 10));
    expect(loc(next).keyframes!.map((k) => k.frame)).toEqual(keys.slice(10, 20));
    // the last page says no more
    const last = describe_(doc, ada.id, 1, { keyframes: 'full', offset: longest - 1, limit: 10 });
    expect(last).not.toHaveProperty('keyframe_next_offset');
    expect(first).not.toHaveProperty('animation_note');
  });

  it("summarizes every channel with 'summary' and leaves them out with 'none'", () => {
    const { doc, cube, ada } = scene();
    const s = describe_(doc, cube.id, 75, { keyframes: 'summary' });
    expect(s.animation).toEqual([
      {
        path: 'location',
        index: 2,
        keyframe_count: 3,
        first_frame: 1,
        last_frame: 100,
        value_at_frame: s.animation![0].value_at_frame,
      },
    ]);
    expect(s.animation![0].value_at_frame).toBeGreaterThan(0.5);
    expect(s.animation![0].value_at_frame).toBeLessThan(1);
    const none = describe_(doc, ada.id, 75, { keyframes: 'none' });
    expect(none).not.toHaveProperty('animation');
    expect(none.animation_channels).toBe(doc.listFCurves(ada.id).length);
  });
});

describe('get_object tool', () => {
  async function withTool<T>(doc: SceneDoc, fn: (client: Client) => Promise<T>): Promise<T> {
    const project = { id: 'p1', scene: doc, state: { frame: 120 } };
    const ctx = {
      historyLimits: { maxSteps: 10, maxBytes: 1 << 20 },
      metrics: new ServerMetrics({ defaultMetrics: false }),
      log: silentLog,
      agent: { id: 'agent-1', project: async () => project },
    } as unknown as ToolContext;
    const server = new McpServer({ name: 'get-object', version: '0' });
    registerTools(server, ctx);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'get-object', version: '0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      return await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }
  const call = async (client: Client, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name: 'get_object', arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = res.content.map((c) => c.text).join('\n');
    return { isError: !!res.isError, text, body: res.isError ? null : (JSON.parse(text) as Description) };
  };

  it('takes keyframes, keyframe_offset and keyframe_limit, and summarizes dense channels by default', async () => {
    const { doc } = scene();
    await withTool(doc, async (client) => {
      const auto = await call(client, { project: 'p1', object: 'Ada' });
      expect(auto.isError).toBe(false);
      // as compact JSON, as the review measured it (the tool's text is indented)
      expect(JSON.stringify(auto.body).length).toBeLessThan(20_000);
      expect(auto.body!.animation_note).toMatch(/keyframes 'full' lists their keys/);
      const page = await call(client, {
        project: 'p1',
        object: 'Ada',
        keyframes: 'full',
        keyframe_offset: 5,
        keyframe_limit: 3,
      });
      expect(page.body!.animation!.every((c) => c.keyframes!.length <= 3)).toBe(true);
      expect(page.body!.keyframe_next_offset).toBe(8);
      const none = await call(client, { project: 'p1', object: 'Ada', keyframes: 'none' });
      expect(none.body).not.toHaveProperty('animation');
      expect((await call(client, { project: 'p1', object: 'Ada', keyframes: 'all' })).isError).toBe(true);
      expect((await call(client, { project: 'p1', object: 'Ada', keyframe_limit: 0 })).isError).toBe(true);
      const { tools } = await client.listTools();
      const get = tools.find((t) => t.name === 'get_object')!;
      expect(Object.keys(get.inputSchema.properties!)).toEqual(
        expect.arrayContaining(['keyframes', 'keyframe_offset', 'keyframe_limit']),
      );
      expect(get.description).toContain(
        `a channel with at most ${AUTO_KEYFRAMES} keys lists them, a longer one, such as a walk keyed at every step or a baked simulation, gives keyframe_count, first_frame, last_frame and value_at_frame`,
      );
    });
  });

  it('docs/mcp.md gives the arguments and the summary as the code has them', () => {
    const mcp = readFileSync(fileURLToPath(new URL('../../../../docs/mcp.md', import.meta.url)), 'utf8');
    const flat = mcp.replace(/\s+/g, ' ');
    expect(flat).toContain(
      `\`keyframe_offset\` and \`keyframe_limit\` (1–${MAX_KEYFRAME_PAGE}, default ${DEFAULT_KEYFRAME_PAGE}: the page of each channel's keys that \`full\` lists)`,
    );
    expect(flat).toContain(
      `An animation channel with at most ${AUTO_KEYFRAMES} keys lists them; a longer one (a walk keyed at every step, a baked simulation or tether) gives \`keyframe_count\`, \`first_frame\`, \`last_frame\` and \`value_at_frame\` instead`,
    );
    expect(flat).not.toContain('F-curves with up to 100 keyframes each');
  });

  it('the instructions say that dense channels are summarized and how to list them', () => {
    expect(MCP_INSTRUCTIONS).toContain(
      `get_object lists the keys of channels with at most ${AUTO_KEYFRAMES} keys and summarizes longer ones (walks, bakes): keyframes 'full' lists them`,
    );
  });
});
