import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  DELETED_ELSEWHERE_NOTE,
  LIST_FAILED_NOTE,
  PROJECT_READ_MAX_AGE_MS,
} from '../../src/mcp/project-storage';
import { makeTempDir, startServer, type TestServer } from '../helpers/app';

/*
 * Storage that other writers share, as agents see it through the project tools: a project deleted
 * from storage by another server while an agent works on it here (the room stays open while it is
 * in use, and its next change stores the project again), and a listing of storage that fails
 * (only the projects this server has loaded are listed). Both used to show nothing: the agent kept
 * working without knowing, and the server only logged them. A room that only agents use read
 * storage only when it saved, so get_project reads it before it answers.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dataDir: string;
let one: TestServer;
let two: TestServer;
const clients: Client[] = [];

async function connect(server: TestServer): Promise<Client> {
  const client = new Client({ name: 'project-storage-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  clients.push(client);
  return client;
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

beforeAll(async () => {
  // two servers sharing one storage (the same DATA_DIR, persisted to disk)
  dataDir = await makeTempDir();
  one = await startServer({ SYNC_PERSISTENCE: 'disk', DATA_DIR: dataDir });
  two = await startServer({ SYNC_PERSISTENCE: 'disk', DATA_DIR: dataDir });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
  await one?.close();
  await two?.close();
  await one?.cleanup();
});

describe('project tools with storage shared by other writers', () => {
  it('say in get_project and list_projects that another server deleted the project, until a change stores it again', async () => {
    const agent = await connect(one);
    const other = await connect(two);
    const { id } = await ok(agent, 'create_project', { name: 'Deleted elsewhere', empty: true });
    await one.handle.rooms.get(id)!.flush();
    expect((await ok(agent, 'get_project', { project: id })).deleted_from_storage).toBeUndefined();

    expect(await ok(other, 'delete_project', { project: id, confirm: true })).toEqual({ deleted: id });
    // get_project reads storage unless the room read it within PROJECT_READ_MAX_AGE_MS (its save)
    await sleep(PROJECT_READ_MAX_AGE_MS);

    const details = await ok(agent, 'get_project', { project: id });
    expect(details.deleted_from_storage).toBe(true);
    expect(details.deleted_from_storage_note).toBe(DELETED_ELSEWHERE_NOTE);
    const listed = (await ok(agent, 'list_projects')).projects.find((p: { id: string }) => p.id === id);
    expect(listed).toMatchObject({ id, loaded: true, deleted_from_storage: true });
    // the other server does not list it
    expect((await ok(other, 'list_projects')).projects.map((p: { id: string }) => p.id)).not.toContain(id);

    // the agent's next change stores the project again
    await ok(agent, 'add_object', { project: id, type: 'cube', name: 'Kept' });
    await one.handle.rooms.get(id)!.flush();
    expect((await ok(agent, 'get_project', { project: id })).deleted_from_storage).toBeUndefined();
    expect(
      (await ok(agent, 'list_projects')).projects.find((p: { id: string }) => p.id === id),
    ).not.toHaveProperty('deleted_from_storage');
    expect((await ok(other, 'list_projects')).projects.map((p: { id: string }) => p.id)).toContain(id);
  });

  it('say in list_projects that listing storage failed, and list the loaded projects', async () => {
    const agent = await connect(one);
    const { id } = await ok(agent, 'create_project', { name: 'Loaded here', empty: true });
    const fs = one.handle.rooms.persistence.store!.fs;
    const list = fs.list.bind(fs);
    fs.list = async () => {
      throw new Error('storage offline');
    };
    try {
      const failed = await ok(agent, 'list_projects');
      expect(failed.storage_listing_failed).toBe(true);
      expect(failed.note).toBe(LIST_FAILED_NOTE);
      expect(failed.projects.map((p: { id: string }) => p.id)).toContain(id);
      expect(failed.projects.every((p: { loaded: boolean }) => p.loaded)).toBe(true);
    } finally {
      fs.list = list;
    }
    const listed = await ok(agent, 'list_projects');
    expect(listed).not.toHaveProperty('storage_listing_failed');
    expect(listed).not.toHaveProperty('note');
    expect(listed.projects.map((p: { id: string }) => p.id)).toContain(id);
  });

  it('say so only in the list_projects whose listing failed, not in one that listed storage meanwhile', async () => {
    const agent = await connect(one);
    const fs = one.handle.rooms.persistence.store!.fs;
    const list = fs.list.bind(fs);
    // the first listing fails while the second one is still running, and the second succeeds; every
    // stored project is loaded here, so both list the same projects
    let calls = 0;
    fs.list = async (...args: Parameters<typeof list>) => {
      const first = ++calls === 1;
      await sleep(first ? 50 : 200);
      if (first) throw new Error('storage offline');
      return list(...args);
    };
    try {
      const results = await Promise.all([ok(agent, 'list_projects'), ok(agent, 'list_projects')]);
      expect(calls).toBe(2);
      expect(results.filter((r) => r.storage_listing_failed === true)).toHaveLength(1);
      expect(results.filter((r) => !('storage_listing_failed' in r) && !('note' in r))).toHaveLength(1);
    } finally {
      fs.list = list;
    }
  });
});
