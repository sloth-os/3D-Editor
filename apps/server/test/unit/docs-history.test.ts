import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SceneDoc, createGrid } from '@3d-editor/core';
import {
  AgentHistory,
  BUDGET_BYTES_PER_ITEM,
  DEFAULT_HISTORY_LIMITS,
  KEPT_CONTAINER_ITEM_BYTES,
} from '../../src/mcp/history';
import { registerTools, type ToolContext } from '../../src/mcp/tools';
import {
  HISTORY_ADVICE,
  HISTORY_SAVE_BYTES_PER_BYTE,
  HISTORY_SAVE_BYTES_PER_ITEM,
  heldByHistories,
  projectGrowthRefusal,
} from '../../src/render/memory';

/*
 * The docs say what the agents' undo histories keep, how the server's memory checks count it and
 * when it is freed, in the words of the refusals (render/memory.ts) and with the limits of the code
 * (mcp/history.ts, config.ts, mcp/hub.ts).
 */

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** A file of the repository, by its path from the root. */
const repo = (rel: string) => file(`../../../../${rel}`);
const source = (rel: string) => file(`../../src/${rel}`);
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');
const mcp = flat(repo('docs/mcp.md'));
const architecture = flat(repo('docs/architecture.md'));
const guide = flat(repo('docs/agent-guide.md'));
const MB = 1024 * 1024;

const opened: SceneDoc[] = [];
const histories: AgentHistory[] = [];
afterEach(() => {
  for (const h of histories.splice(0)) h.destroy();
  for (const d of opened.splice(0)) d.ydoc.destroy();
});

/** A grid whose vertex groups an agent replaced five times, a step each (its history keeps ~1.6 MB). */
function projectWithHistory(): { doc: SceneDoc; history: AgentHistory } {
  const doc = SceneDoc.create({ name: 'Docs', empty: true });
  opened.push(doc);
  const mesh = doc.addMesh('Grid', createGrid({ x_subdivisions: 50, y_subdivisions: 50 }));
  doc.addObject({ type: 'MESH', name: 'Grid', data: mesh });
  const origin = { type: 'mcp', session: 'docs' };
  const history = new AgentHistory(doc.ydoc, doc.sharedTypes(), origin);
  histories.push(history);
  const agent = new SceneDoc(doc.ydoc, origin);
  for (let s = 0; s <= 5; s++) {
    history.undo.stopCapturing();
    const groups = [0, 1, 2, 3].map((g) => ({ name: `G${g}`, weights: new Uint8Array(80_000).fill(s + 1) }));
    agent.setVertexGroups(mesh, groups);
    history.maintain();
  }
  return { doc, history };
}

describe("docs: what the agents' undo histories keep", () => {
  it('quote the share and the save clause of the refusals as render/memory.ts writes them', () => {
    const { doc } = projectWithHistory();
    expect(heldByHistories(doc).kept).toBeGreaterThan(MB);
    const refusal = projectGrowthRefusal(doc, 100 * MB, 0, { heapLimit: () => 300 * MB })!;
    const share = /\(now [\d,.]+ MB with 1 object, [\d,]+ MB of it kept by agents' undo histories\)/.exec(
      refusal,
    )?.[0];
    expect(share, refusal).toBeDefined();
    const save = `, ${HISTORY_SAVE_BYTES_PER_BYTE} times what agents' undo histories keep and ${HISTORY_SAVE_BYTES_PER_ITEM.toLocaleString('en-US')} bytes for each replaced value they keep)`;
    expect(refusal).toContain(save);
    // the same words in the docs, with the numbers left out
    const quoted = share!.replace('1 object', '… objects').replace(/[\d,.]+ MB/g, '… MB');
    expect(quoted).toBe("(now … MB with … objects, … MB of it kept by agents' undo histories)");
    expect(architecture).toContain(quoted);
    expect(mcp).toContain(quoted);
    expect(architecture).toContain(`\`${save.slice(0, -1)}\` whenever they keep something`);
    expect(mcp).toContain(`(…${save.slice(0, save.indexOf(' and '))} and …)…\``);
    expect(mcp).toContain(
      `and for a save of the project, which carries it, six times its bytes and ${HISTORY_SAVE_BYTES_PER_ITEM.toLocaleString('en-US')} bytes for each replaced value they keep`,
    );
    expect(mcp).toContain("(`… MB of it kept by agents' undo histories`, see [Errors](#errors))");
    // the advice that ends an operator's refusal naming the share, word for word
    expect(mcp).toContain(
      `An operator's refusal that names it, and the refusal of a browser editor's changes, ends \`${HISTORY_ADVICE}\`;`,
    );
    expect(architecture).toContain(
      `an operator's refusal ends with when it is freed: \`${HISTORY_ADVICE}\`.`,
    );
    expect(guide).toContain(
      `An \`OUT_OF_MEMORY\` refusal names it from 1 MB (\`${quoted.slice(quoted.indexOf('… MB of it'), -1)}\`) and says how it is freed.`,
    );
  });

  it('give the limits of the code, that the newest step is kept, and when a history is freed', () => {
    expect(DEFAULT_HISTORY_LIMITS).toEqual({ maxSteps: 100, maxBytes: 64 * MB });
    const config = source('config.ts');
    expect(config).toContain('MCP_UNDO_STEPS: z.coerce.number().int().min(1).max(10000).default(100),');
    expect(config).toContain('MCP_UNDO_MEMORY_MB: z.coerce.number().min(0).max(65536).default(64),');
    // agent identities (and their histories) end 6 hours after their last session, and beyond 200
    // the least recently used without a session end first
    expect(source('mcp/hub.ts')).toContain('this.identityTtlMs = opts.identityTtlMs ?? 6 * 60 * 60 * 1000;');
    expect(source('mcp/hub.ts')).toContain('const max = Math.max(1, this.opts.maxIdentities ?? 200);');
    expect(source('mcp/hub.ts')).toContain('.filter((x) => x.sessions <= 0 && x !== id)');
    // so a refusal's advice says both
    expect(HISTORY_ADVICE).toContain(
      "is freed when the agent's session ends (for an agent id, 6 hours after its last session, or earlier " +
        'when the server keeps more than 200 agent ids and this one is the least recently used without a session)',
    );
    expect(mcp).toContain(
      'it keeps the last 100 steps and at most 64 MB of replaced or deleted data (the server settings ' +
        '`MCP_UNDO_STEPS` and `MCP_UNDO_MEMORY_MB`;',
    );
    expect(mcp).toContain(
      'Older steps are dropped and what they kept is freed, the newest one is always kept',
    );
    // the limit counts each replaced value with its share of a save (64 MB: 210,000 moved locations)
    expect(mcp).toContain(
      `So the limit counts each replaced value with ${BUDGET_BYTES_PER_ITEM} bytes more than its own (its share of a ` +
        'save), and a history adds at most six times the limit to a save, also with many small values: 64 MB hold ' +
        '210,000 replaced locations of 152 bytes (30 MB), whose save takes about 383 MB more.',
    );
    expect(mcp).toContain(
      `per agent and project, each replaced value counted with ${BUDGET_BYTES_PER_ITEM} bytes more, and always its newest step)`,
    );
    expect(mcp).toContain(
      'It is freed when the history ends: when the session ends, or for an agent id 6 hours after its ' +
        'last session (or earlier when the server keeps more than 200 agent ids and this one is the least ' +
        'recently used without a session), and when the project is unloaded or deleted.',
    );
    expect(mcp).toContain(
      '| Undo history | 100 steps and 64 MB of replaced or deleted data per agent and project ' +
        `(\`MCP_UNDO_STEPS\`, \`MCP_UNDO_MEMORY_MB\`; each replaced value counted with ${BUDGET_BYTES_PER_ITEM} bytes more; ` +
        "the newest step always kept), counted in the project's memory limit |",
    );
    expect(architecture).toContain(
      'at most `MCP_UNDO_MEMORY_MB` per agent and project and always its newest step, freed when the ' +
        "agent's session or agent id ends",
    );
    // deleted objects kept for undo's links, per item
    expect(KEPT_CONTAINER_ITEM_BYTES).toBe(280);
    expect(mcp).toContain('leave placeholders behind (280 bytes for the object and each of its fields)');
    expect(mcp).toContain('while a step can reach them (280 bytes for each of their items)');
    expect(architecture).toContain('The memory checks count them at 280 bytes for each item they keep');
    expect(architecture).toContain("and deleted objects kept for undo's links, 280 bytes per item)");
    expect(guide).toContain(
      'at most 64 MB of replaced or deleted data (server defaults; each replaced value counts with ' +
        `${BUDGET_BYTES_PER_ITEM} bytes more)`,
    );
    expect(guide).toContain(
      'counts in the memory the server keeps for the project until your session ends (with an agent id, ' +
        '6 hours after your last session, or earlier when the server keeps more than 200 agent ids and ' +
        'yours is the least recently used without a session).',
    );
    const readme = repo('README.md')
      .split('\n')
      .find((l) => l.startsWith('| `MCP_UNDO_MEMORY_MB`'));
    expect(flat(readme ?? '')).toContain(
      `in MB (${BUDGET_BYTES_PER_ITEM} bytes more per value); older steps are dropped beyond it, never the newest. ` +
        "It counts in the project's memory limit and is freed when the session or agent id ends",
    );
  });

  it("the undo and redo tools say when the history ends and that it counts in the project's memory", async () => {
    const server = new McpServer({ name: 'docs-history', version: '0' });
    // registration reads only the history limits (the handlers use the rest of the context)
    registerTools(server, { historyLimits: { maxSteps: 7, maxBytes: 3 * MB } } as unknown as ToolContext);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-history', version: '0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    try {
      const { tools } = await client.listTools();
      for (const name of ['undo', 'redo']) {
        const description = tools.find((t) => t.name === name)?.description ?? '';
        expect(description, name).toContain(
          'It ends, and what it keeps is freed, when the session ends (for an agent id, 6 hours after ' +
            'its last session, or earlier when the server keeps more than 200 agent ids and this one is the ' +
            'least recently used without a session), when the project is unloaded or deleted, or when the ' +
            'server restarts.',
        );
        expect(description, name).toContain(
          'It keeps the last 7 steps per project and at most 3 MB of replaced or deleted data, each replaced ' +
            `value counted with ${BUDGET_BYTES_PER_ITEM} bytes more for what a save of the project takes for it ` +
            '(older steps are dropped; the newest step is always kept). What it keeps, also the objects the ' +
            "agent deleted, counts in the project's memory limit.",
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
