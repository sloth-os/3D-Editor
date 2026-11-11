import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectFileStore, WebDAVClient } from '@3d-editor/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  DELETED_ELSEWHERE_NOTE,
  LIST_FAILED_NOTE,
  LIST_PARTIAL_NOTE,
  PROJECT_READ_MAX_AGE_MS,
} from '../../src/mcp/project-storage';
import { api, makeTempDir, startServer, type TestServer } from '../helpers/app';
import { mkcolPath, startWebDAV } from '../helpers/webdav';

/*
 * Storage that other writers share, as agents see it through the project tools: a project deleted
 * from storage by another server while an agent works on it here (the room stays open while it is
 * in use, and its next change stores the project again), and a listing of storage that fails
 * (only the projects this server has loaded are listed). Both used to show nothing: the agent kept
 * working without knowing, and the server only logged them. A room that only agents use read
 * storage only when it saved, so get_project reads it before it answers.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
/** scripts/mcp.mjs, the MCP client of agents and people (a CLI and a module). */
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../scripts/mcp.mjs');

/** A raw tool result: its content and whether it failed. */
type Raw = { content: { type: string; text?: string }[]; isError?: boolean };

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

  /*
   * Storage lists the projects folder, but reading the project.json of one of them fails:
   * list_projects left that project out without a word, so agents took it for one that does not
   * exist. It now says that listing storage failed, as when storage cannot list the folder.
   */
  it('say in list_projects that listing storage failed when reading a project.json fails', async () => {
    const agent = await connect(one);
    const other = await connect(two);
    const { id: loaded } = await ok(agent, 'create_project', { name: 'Loaded on one', empty: true });
    const { id: stored } = await ok(other, 'create_project', { name: 'Only stored for one', empty: true });
    const ids = (r: { projects: { id: string }[] }) => r.projects.map((p) => p.id);
    expect(ids(await ok(agent, 'list_projects'))).toEqual(expect.arrayContaining([loaded, stored]));
    const fs = one.handle.rooms.persistence.store!.fs;
    const read = fs.read.bind(fs);
    fs.read = async (path, opts) => {
      if (path.endsWith(`/${stored}/project.json`)) throw new Error('storage offline');
      return read(path, opts);
    };
    try {
      const listed = await ok(agent, 'list_projects');
      expect(listed.storage_listing_failed).toBe(true);
      expect(listed.note).toBe(LIST_PARTIAL_NOTE);
      expect(ids(listed)).toContain(loaded);
      expect(ids(listed)).not.toContain(stored);
    } finally {
      fs.read = read;
    }
    expect(ids(await ok(agent, 'list_projects'))).toContain(stored);
  });

  /*
   * One project.json that cannot be read (a file the server may not read, a 403 for one file) hid
   * every project that is only in storage: the server listed only the projects it had loaded, so
   * tools found none of the others by name ("not found. Known projects: …"), and create_project
   * made a second project with the name of one of them. Only the project whose project.json cannot
   * be read is missing now, and a name that nothing matches says why.
   */
  it('list, find and keep the names of the stored projects whose project.json was read when another read fails', async () => {
    const agent = await connect(one);
    const other = await connect(two);
    const { id: loaded } = await ok(agent, 'create_project', { name: 'Partly loaded', empty: true });
    const { id: readable } = await ok(other, 'create_project', { name: 'Readable stored', empty: true });
    const { id: broken } = await ok(other, 'create_project', { name: 'Broken stored', empty: true });
    await two.handle.rooms.flushAll();
    const fs = one.handle.rooms.persistence.store!.fs;
    const read = fs.read.bind(fs);
    fs.read = async (path, opts) => {
      if (path.endsWith(`/${broken}/project.json`)) throw new Error('403 Forbidden');
      return read(path, opts);
    };
    try {
      const listed = await ok(agent, 'list_projects');
      expect(listed).toMatchObject({ storage_listing_failed: true, note: LIST_PARTIAL_NOTE });
      const ids = listed.projects.map((p: { id: string }) => p.id);
      expect(ids).toEqual(expect.arrayContaining([loaded, readable]));
      expect(ids).not.toContain(broken);
      expect(await ok(agent, 'get_project', { project: 'readable stored' })).toMatchObject({ id: readable });
      await expect(ok(agent, 'create_project', { name: 'Readable Stored', empty: true })).rejects.toThrow(
        `A project named 'Readable stored' already exists (id ${readable})`,
      );
      const error = await ok(agent, 'get_scene', { project: 'Broken stored' }).catch(
        (err: Error) => err.message,
      );
      expect(error).toMatch(/^get_scene failed: Project 'Broken stored' not found\. Known projects: /);
      expect(error).toContain(
        "Reading the project.json of some projects in storage failed (the server logged 'listing projects failed'), so a project among those is not found by name now: try again once list_projects no longer has storage_listing_failed: true.",
      );
    } finally {
      fs.read = read;
    }
    expect(await ok(agent, 'get_project', { project: 'Broken stored' })).toMatchObject({ id: broken });
  });

  /*
   * A tool that names a project this server has loaded found it only after listing storage: with
   * storage that does not answer, another agent's get_project 'lighthouse' took 35 s (30 s of them
   * listing storage). It waits 5 s for the listing now (the names of the projects in storage are
   * compared too), then finds the loaded project; the calls that come while that listing goes on do
   * not wait for it. A name that nothing matches says that listing storage failed (it said 'There
   * are no projects yet' when nothing was loaded).
   */
  it('find a loaded project by name when listing storage does not answer within 5 s, and say when listing storage failed', async () => {
    const agent = await connect(one);
    const other = await connect(one);
    const { id } = await ok(agent, 'create_project', { name: 'Harbour light', empty: true });
    const fs = one.handle.rooms.persistence.store!.fs;
    const list = fs.list.bind(fs);
    let listings = 0;
    let answer!: () => void;
    const unanswered = new Promise<void>((resolve) => (answer = resolve));
    fs.list = async (...args: Parameters<typeof list>) => {
      listings++;
      await unanswered;
      return list(...args);
    };
    try {
      const started = Date.now();
      expect(await ok(other, 'get_project', { project: 'harbour LIGHT' })).toMatchObject({
        id,
        name: 'Harbour light',
      });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4900);
      expect(listings).toBe(1);
      const found = ok(agent, 'get_project', { project: 'Harbour light' });
      expect(await Promise.race([found, sleep(2000).then(() => 'still waiting')])).toMatchObject({ id });
      expect(listings).toBe(1);
    } finally {
      answer();
    }
    try {
      fs.list = async () => {
        throw new Error('storage offline');
      };
      await expect(ok(other, 'get_scene', { project: 'No such harbour' })).rejects.toThrow(
        `get_scene failed: Project 'No such harbour' not found. Known projects: `,
      );
      const error = await ok(other, 'get_scene', { project: 'No such harbour' }).catch(
        (err: Error) => err.message,
      );
      expect(error).toContain(
        "Listing the projects in storage failed (the server logged 'listing projects failed'), so a project that is only in storage is not found by name now: try again once list_projects no longer has storage_listing_failed: true.",
      );
      expect(error).not.toContain('There are no projects yet');
    } finally {
      fs.list = list;
    }
  });

  /*
   * A call that found its project by a name compared with the loaded projects only (here: listing
   * storage failed) says so in its result (`project_note`, tools.ts withProjectNotes): the notes of
   * AgentSession.findProject reached no result, so an agent did not learn that a project that is
   * only in storage may have that name, and delete_project deleted the loaded project by such a
   * name. It deletes nothing now, and says which id to pass. Round 11's first fix added the note as
   * a text of its own after the JSON of a result with a file (scripts/mcp.mjs then returned the two
   * texts as one string, not the result object), and left it out of failures: an agent whose call
   * failed in that project was not told that another project may have the name.
   */
  it('say in the result when a name was compared with the loaded projects only, and delete nothing by it', async () => {
    const agent = await connect(one);
    const { id } = await ok(agent, 'create_project', { name: 'Harbour note', empty: true });
    await ok(agent, 'add_object', { project: id, type: 'cube', name: 'Pier' });
    const fs = one.handle.rooms.persistence.store!.fs;
    const list = fs.list.bind(fs);
    const note =
      "Project 'Harbour note' was found by name, but listing the projects in storage failed (the server " +
      "logged 'listing projects failed'), so only the projects this server has loaded were compared: a " +
      `project that is only in storage may have this name too. Pass the id ${id} to name this project ` +
      'without a lookup.';
    fs.list = async () => {
      throw new Error('storage offline');
    };
    try {
      // a result object gets the field, and so does the JSON that comes with a file: one text
      expect(await ok(agent, 'get_project', { project: 'Harbour note' })).toMatchObject({
        id,
        project_note: note,
      });
      const exported = (await agent.callTool({
        name: 'export_scene',
        arguments: { project: 'Harbour note', format: 'stl' },
      })) as Raw;
      expect(exported.isError).toBeFalsy();
      const texts = exported.content.filter((c) => c.type === 'text');
      expect(texts).toHaveLength(1);
      expect(JSON.parse(texts[0].text!)).toMatchObject({ format: 'stl', project_note: note });
      // scripts/mcp.mjs returns that JSON as the result's `text` object
      const { stdout } = await run(
        process.execPath,
        [CLI, 'call', 'export_scene', JSON.stringify({ project: 'Harbour note', format: 'stl' })],
        { env: { ...process.env, MCP_URL: `${one.url}/mcp` }, timeout: 30_000 },
      );
      expect(JSON.parse(stdout).result.text).toMatchObject({ format: 'stl', project_note: note });
      // a failure: in the JSON after its message, or in a JSON of its own after a plain message
      const operator = (await agent.callTool({
        name: 'run_operator',
        arguments: { project: 'Harbour note', operator: 'object.select_all', params: { action: 'NOPE' } },
      })) as Raw;
      expect(operator.isError).toBe(true);
      const [opMessage, ...opJson] = operator.content[0].text!.split('\n');
      expect(opMessage).toMatch(/^object\.select_all failed: Invalid parameters for object\.select_all: /);
      expect(JSON.parse(opJson.join('\n'))).toMatchObject({
        ok: false,
        code: 'INVALID_PARAMS',
        project_note: note,
      });
      const missing = (await agent.callTool({
        name: 'get_object',
        arguments: { project: 'Harbour note', object: 'No such pier' },
      })) as Raw;
      expect(missing.isError).toBe(true);
      const [message, ...json] = missing.content[0].text!.split('\n');
      expect(message).toMatch(/^Object 'No such pier' not found in project 'Harbour note'/);
      expect(JSON.parse(json.join('\n'))).toEqual({ project_note: note });
      // by its id, no note
      expect(await ok(agent, 'get_project', { project: id })).not.toHaveProperty('project_note');
      // delete_project refuses with the note as its message (not repeated as JSON)
      const refused = (await agent.callTool({
        name: 'delete_project',
        arguments: { project: 'Harbour note', confirm: true },
      })) as Raw;
      expect(refused).toMatchObject({ isError: true });
      expect(refused.content).toEqual([{ type: 'text', text: `delete_project deleted nothing: ${note}` }]);
      expect(await ok(agent, 'get_project', { project: id })).toMatchObject({ id, name: 'Harbour note' });
    } finally {
      fs.list = list;
    }
    // compared with every project again: found without a note, and deleted
    expect(await ok(agent, 'get_project', { project: 'Harbour note' })).not.toHaveProperty('project_note');
    expect(await ok(agent, 'delete_project', { project: 'Harbour note', confirm: true })).toEqual({
      deleted: id,
    });
  });

  /*
   * Names are compared with the projects this server has loaded and those in storage together (the
   * projects made here and by another server, as a browser makes them, whose names nobody checks):
   * round 10 compared the names of the loaded projects first, so a loaded 'Dup' was found although a
   * 'Dup' in storage made the name ambiguous, and a loaded 'lighthouse' (a match ignoring letter
   * case) won over 'Lighthouse' in storage (an exact match).
   */
  it('compare a name with the projects in storage too', async () => {
    const agent = await connect(one);
    const other = await connect(one);
    const madeHere = async (name: string) => (await ok(agent, 'create_project', { name, empty: true })).id;
    const madeElsewhere = async (name: string) => {
      const id = crypto.randomUUID();
      const room = (await two.handle.rooms.open(id, { create: true }))!;
      room.scene.setName(name);
      room.scene.addObject({ type: 'EMPTY', name: 'Content' });
      await room.flush();
      return id;
    };
    const dup = await madeHere('Twice named');
    const dupElsewhere = await madeElsewhere('Twice named');
    const lower = await madeHere('lighthouse beam');
    const upper = await madeElsewhere('Lighthouse beam');
    expect(one.handle.rooms.get(dupElsewhere)).toBeUndefined();

    for (const client of [agent, other]) {
      const error = await ok(client, 'get_scene', { project: 'Twice named' }).catch(
        (err: Error) => err.message,
      );
      expect(error).toMatch(/^get_scene failed: Several projects are named 'Twice named': /);
      expect(error).toContain(dup);
      expect(error).toContain(dupElsewhere);
    }
    expect(await ok(other, 'get_project', { project: 'Lighthouse beam' })).toMatchObject({
      id: upper,
      name: 'Lighthouse beam',
    });
    expect(await ok(other, 'get_project', { project: 'lighthouse beam' })).toMatchObject({ id: lower });
    expect(await ok(agent, 'get_project', { project: dup })).toMatchObject({ id: dup });
  });

  /*
   * A lookup by name read the project.json of every stored project at every call (the listing of
   * list_projects): 202 WebDAV requests per call with 200 projects, 47 ms per call on the disk. It
   * lists the projects folder once per lookup now and reads only the project.json files that changed
   * since this server last read them (on the disk: another ETag of the file); a rename by another
   * server is compared at the next lookup.
   */
  it('look a name up with one listing of storage, reading only the project.json files that changed', async () => {
    const agent = await connect(one);
    const other = await connect(two);
    const elsewhere: string[] = [];
    for (let i = 0; i < 12; i++)
      elsewhere.push((await ok(other, 'create_project', { name: `Counted elsewhere ${i}`, empty: true })).id);
    await two.handle.rooms.flushAll();
    const { id } = await ok(agent, 'create_project', { name: 'Counted here', empty: true });
    const fs = one.handle.rooms.persistence.store!.fs;
    const original = { read: fs.read, list: fs.list };
    let lists = 0;
    let infos: string[] = [];
    fs.read = async (path, opts) => {
      if (path.endsWith('/project.json')) infos.push(path);
      return original.read.call(fs, path, opts);
    };
    fs.list = async (dir) => (lists++, original.list.call(fs, dir));
    try {
      expect(await ok(agent, 'get_scene', { project: 'Counted here' })).toMatchObject({ counts: {} });
      // the projects new to this server, once (not the loaded one)
      for (const made of elsewhere) expect(infos).toContain(`/projects/${made}/project.json`);
      expect(infos).not.toContain(`/projects/${id}/project.json`);
      expect(lists).toBe(1);
      infos = [];
      for (let i = 0; i < 3; i++) await ok(agent, 'get_scene', { project: 'counted here' });
      expect(await ok(agent, 'get_project', { project: 'counted elsewhere 4' })).toMatchObject({
        id: elsewhere[4],
      });
      expect(lists).toBe(5);
      // (get_project read the project to load it: its own project.json only)
      expect(infos).toEqual([`/projects/${elsewhere[4]}/project.json`]);
      // another server renames one of its projects: compared at the next lookup
      await ok(other, 'rename_project', { project: elsewhere[7], name: 'Renamed elsewhere' });
      await two.handle.rooms.flushAll();
      infos = [];
      expect(await ok(agent, 'get_project', { project: 'renamed elsewhere' })).toMatchObject({
        id: elsewhere[7],
        name: 'Renamed elsewhere',
      });
      expect(infos.filter((p) => p === `/projects/${elsewhere[7]}/project.json`).length).toBeGreaterThan(0);
      expect(infos.every((p) => p === `/projects/${elsewhere[7]}/project.json`)).toBe(true);
    } finally {
      Object.assign(fs, original);
    }
  });

  /*
   * With WebDAV storage and 200 projects, a lookup by name made 202 requests (one PROPFIND, then a
   * GET of every project.json) and took 206 ms per call through a server that answered in 20 ms. It
   * makes one PROPFIND per call now: the folders' ETags in it tell which project.json changed.
   */
  it('look a name up with one PROPFIND on WebDAV storage', async () => {
    const requests: string[] = [];
    const dav = await startWebDAV({ onRequest: (req) => void requests.push(`${req.method} ${req.path}`) });
    await mkcolPath(dav, '/files/alice');
    const base = `${dav.origin}/files/alice`;
    const direct = new ProjectFileStore(
      new WebDAVClient({ url: base, username: dav.username, password: dav.password }),
      '/names',
    );
    for (let i = 0; i < 40; i++)
      await direct.saveInfo({
        id: crypto.randomUUID(),
        name: `Stored ${i}`,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        schema_version: 1,
      });
    const server = await startServer({
      WEBDAV_URL: base,
      WEBDAV_USERNAME: dav.username,
      WEBDAV_PASSWORD: dav.password,
      WEBDAV_BASE_PATH: '/names',
    });
    try {
      const agent = await connect(server);
      const { id } = await ok(agent, 'create_project', { name: 'Harbour light', empty: true });
      await ok(agent, 'get_scene', { project: 'Harbour light' });
      const propfinds = (from: number) =>
        requests.slice(from).filter((r) => r === 'PROPFIND /files/alice/names/projects').length;
      const infoGets = (from: number) =>
        requests.slice(from).filter((r) => /^GET .*\/project\.json$/.test(r)).length;
      const from = requests.length;
      for (let i = 0; i < 5; i++) await ok(agent, 'get_scene', { project: 'harbour light' });
      expect([propfinds(from), infoGets(from)]).toEqual([5, 0]);
      const byId = requests.length;
      await ok(agent, 'get_scene', { project: id });
      expect(requests.length).toBe(byId);
    } finally {
      await server.close();
      await server.cleanup();
      await dav.stop();
    }
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

  /*
   * Tools take a project's id or name and try the id first, and a name such as 'Lighthouse' is a
   * valid id too: while storage failed, asking storage about that id failed every call that named a
   * loaded project so ('get_scene failed: could not read project Lighthouse from storage (...)'),
   * also for the agent working on it. The name now finds the loaded project.
   */
  it('find a loaded project by a name that could be an id while storage fails', async () => {
    const agent = await connect(one);
    const other = await connect(one);
    const { id } = await ok(agent, 'create_project', { name: 'Lighthouse', empty: true });
    const fs = one.handle.rooms.persistence.store!.fs;
    const read = fs.read.bind(fs);
    const list = fs.list.bind(fs);
    fs.read = async () => {
      throw new Error('storage offline');
    };
    fs.list = async () => {
      throw new Error('storage offline');
    };
    try {
      expect((await ok(agent, 'get_scene', { project: 'Lighthouse' })).project).toMatchObject({ id });
      expect(await ok(other, 'get_project', { project: 'lighthouse' })).toMatchObject({
        id,
        name: 'Lighthouse',
      });
      await ok(agent, 'run_operator', { project: 'Lighthouse', operator: 'object.empty_add', params: {} });
      expect(one.handle.rooms.get(id)!.scene.listObjects()).toHaveLength(1);
      // a name no loaded project has: storage cannot tell whether a project has that id
      await expect(ok(agent, 'get_scene', { project: 'Harbour' })).rejects.toThrow(
        'get_scene failed: could not read project Harbour from storage (storage offline)',
      );
    } finally {
      fs.read = read;
      fs.list = list;
    }
  });

  /*
   * delete_project forgot the agent's undo history and editor state in the project before it asked
   * storage to delete it: when storage refused, the project stayed open here, but the agent's last
   * changes could no longer be undone.
   */
  it('delete_project keeps the agent its undo history when storage refuses the deletion', async () => {
    const agent = await connect(one);
    const { id } = await ok(agent, 'create_project', { name: 'Refused deletion', empty: true });
    await ok(agent, 'add_object', { project: id, type: 'cube', name: 'Kept' });
    await one.handle.rooms.get(id)!.flush();
    const fs = one.handle.rooms.persistence.store!.fs;
    const remove = fs.remove.bind(fs);
    fs.remove = async () => {
      throw new Error('storage refused');
    };
    try {
      await expect(ok(agent, 'delete_project', { project: id, confirm: true })).rejects.toThrow(
        `delete_project failed: could not delete project ${id} from storage (storage refused)`,
      );
    } finally {
      fs.remove = remove;
    }
    expect(await ok(agent, 'undo', { project: id })).toMatchObject({ undone: 1 });
    const names = (await ok(agent, 'get_scene', { project: id })).objects.map(
      (o: { name: string }) => o.name,
    );
    expect(names).not.toContain('Kept');
  });

  /*
   * The delete_project description says how long the call can take with WebDAV storage by the
   * requests it makes, one after another: for a project this server has not loaded, it reads its
   * project.json twice (to resolve the project, then again when it deletes it) and deletes it.
   */
  it('delete_project of a project this server has not loaded makes the storage requests its description counts', async () => {
    const agent = await connect(one);
    const other = await connect(two);
    const { id } = await ok(agent, 'create_project', { name: 'Deleted from the other server', empty: true });
    await one.handle.rooms.get(id)!.flush();
    expect(two.handle.rooms.get(id)).toBeUndefined();
    const fs = two.handle.rooms.persistence.store!.fs;
    const original = { read: fs.read, remove: fs.remove, list: fs.list, write: fs.write };
    const requests: string[] = [];
    fs.read = async (path, opts) => (requests.push(`read ${path}`), original.read.call(fs, path, opts));
    fs.remove = async (path) => (requests.push(`remove ${path}`), original.remove.call(fs, path));
    fs.list = async (dir) => (requests.push(`list ${dir}`), original.list.call(fs, dir));
    fs.write = async (path, data, opts) => (
      requests.push(`write ${path}`),
      original.write.call(fs, path, data, opts)
    );
    try {
      expect(await ok(other, 'delete_project', { project: id, confirm: true })).toEqual({ deleted: id });
    } finally {
      Object.assign(fs, original);
    }
    expect(requests).toEqual([
      `read /projects/${id}/project.json`,
      `read /projects/${id}/project.json`,
      `remove /projects/${id}`,
    ]);
    const tools = (await other.listTools()).tools;
    expect(tools.find((t) => t.name === 'delete_project')!.description).toContain(
      'up to three requests one after another for one that is not (its project.json, read twice, then ' +
        'the deletion; five when it has no project.json)',
    );
  });

  /*
   * The bound above holds for a project passed by its id: a name is looked up first. A name that could
   * be an id is tried as one (project.json and document.ybin of that id, one after another), and a
   * project this server has not loaded is found by listing storage (the listing, then the
   * project.json of the projects that are new or changed since this server last read them, at once)
   * instead of the first read of its project.json. The description said nothing of it, so deleting
   * by name took up to three more requests than it said (a verifier measured 6 rounds of requests
   * instead of 3 through a WebDAV server that answered in 1 s).
   */
  it('delete_project of a project passed by name looks the name up first, as its description says', async () => {
    const agent = await connect(one);
    const other = await connect(two);
    const slug = await ok(agent, 'create_project', { name: 'harbour-by-slug', empty: true });
    const spaced = await ok(agent, 'create_project', { name: 'Harbour By Name', empty: true });
    await one.handle.rooms.get(slug.id)!.flush();
    await one.handle.rooms.get(spaced.id)!.flush();
    expect(two.handle.rooms.get(slug.id)).toBeUndefined();
    expect(two.handle.rooms.get(spaced.id)).toBeUndefined();
    const fs = two.handle.rooms.persistence.store!.fs;
    const original = { read: fs.read, remove: fs.remove, list: fs.list };
    let requests: string[] = [];
    fs.read = async (path, opts) => (requests.push(`read ${path}`), original.read.call(fs, path, opts));
    fs.remove = async (path) => (requests.push(`remove ${path}`), original.remove.call(fs, path));
    fs.list = async (dir) => (requests.push(`list ${dir}`), original.list.call(fs, dir));
    const listing = (from: number) => {
      // the listing, then the project.json of the projects in storage that are new or changed since
      // this server last read them (at once)
      expect(requests[from]).toMatch(/^list \/projects\/?$/);
      const infos = requests.slice(from + 1, requests.length - 2);
      for (const r of infos) expect(r).toMatch(/^read \/projects\/[^/]+\/project\.json$/);
      return infos;
    };
    try {
      expect(await ok(other, 'delete_project', { project: 'harbour-by-slug', confirm: true })).toEqual({
        deleted: slug.id,
      });
      // tried as an id first: two requests, one after another
      expect(requests.slice(0, 2)).toEqual([
        'read /projects/harbour-by-slug/project.json',
        'read /projects/harbour-by-slug/document.ybin',
      ]);
      expect(listing(2)).toContain(`read /projects/${slug.id}/project.json`);
      expect(requests.slice(-2)).toEqual([
        `read /projects/${slug.id}/project.json`,
        `remove /projects/${slug.id}`,
      ]);

      requests = [];
      expect(await ok(other, 'delete_project', { project: 'Harbour By Name', confirm: true })).toEqual({
        deleted: spaced.id,
      });
      // not an id: the listing in place of the first read of its project.json, which the lookup
      // before read (unchanged since: not read again)
      expect(listing(0)).toEqual([]);
      expect(requests).toEqual([
        'list /projects',
        `read /projects/${spaced.id}/project.json`,
        `remove /projects/${spaced.id}`,
      ]);
    } finally {
      Object.assign(fs, original);
    }
    const description = (await other.listTools()).tools.find(
      (t) => t.name === 'delete_project',
    )!.description!;
    expect(description).toContain(
      "five when it has no project.json), when you pass the project's id. A name is looked up first: one " +
        "that could be an id (letters, digits, '-' and '_') is tried as an id first (up to two more requests " +
        'one after another), then storage is listed',
    );
  });

  /*
   * Storage that accepts connections and never answers: get_project on a project loaded on the
   * server that nobody uses (created by an agent's one-shot session, or with the REST API) waited
   * for the room's read of storage (5 s), and then for its own check of storage as long again (10 s
   * in all), though it says that it waits up to 5 s.
   */
  it('get_project waits once for storage that does not answer', async () => {
    const created = await api(one.url, '/api/projects', { method: 'POST', json: { name: 'Unanswered' } });
    const id = created.body.id as string;
    one.handle.rooms.get(id)!.readAt = 0; // as when its last read is older than 2 s
    const fs = one.handle.rooms.persistence.store!.fs;
    const read = fs.read.bind(fs);
    const etag = fs.etag!.bind(fs);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const held = { reads: 0, etags: 0 };
    const document = `/projects/${id}/document.ybin`;
    fs.read = async (path, opts) => {
      if (path === document) {
        held.reads++;
        await hold;
      }
      return read(path, opts);
    };
    fs.etag = async (path) => {
      if (path === document) {
        held.etags++;
        await hold;
      }
      return etag(path);
    };
    try {
      const agent = await connect(one);
      const t0 = Date.now();
      expect(await ok(agent, 'get_project', { project: id })).toMatchObject({ id, name: 'Unanswered' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(4500); // it waited for the room's read, once
      expect(held).toEqual({ reads: 1, etags: 0 }); // and started no check of its own
    } finally {
      release();
      fs.read = read;
      fs.etag = etag;
    }
  });
});
