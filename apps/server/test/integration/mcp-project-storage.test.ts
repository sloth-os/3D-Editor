import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  DELETED_ELSEWHERE_NOTE,
  LIST_FAILED_NOTE,
  LIST_PARTIAL_NOTE,
  PROJECT_READ_MAX_AGE_MS,
} from '../../src/mcp/project-storage';
import { api, makeTempDir, startServer, type TestServer } from '../helpers/app';

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
   * listing storage). Names of loaded projects are matched first now; a name that nothing matches
   * says that listing storage failed (it said 'There are no projects yet' when nothing was loaded).
   */
  it('find a loaded project by name without listing storage, and say when listing storage failed', async () => {
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
      const found = ok(other, 'get_project', { project: 'harbour LIGHT' });
      const late = sleep(3000).then(() => 'still waiting');
      expect(await Promise.race([found, late])).toMatchObject({ id, name: 'Harbour light' });
      expect(listings).toBe(0);
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
      answer();
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
   * project this server has not loaded is found by listing storage (the listing, then every
   * project.json at once) instead of the first read of its project.json. The description said
   * nothing of it, so deleting by name took up to three more requests than it said (a verifier
   * measured 6 rounds of requests instead of 3 through a WebDAV server that answered in 1 s).
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
      // the listing, then the project.json of every project in storage (at once), this one's too
      expect(requests[from]).toMatch(/^list \/projects\/?$/);
      const infos = requests.slice(from + 1, requests.length - 2);
      expect(infos.length).toBeGreaterThan(0);
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
      // not an id: the listing in place of the first read of its project.json
      expect(listing(0)).toContain(`read /projects/${spaced.id}/project.json`);
      expect(requests.slice(-2)).toEqual([
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
        'one after another; at most 5 s when this server has loaded a project of that name), and a project ' +
        "this server has not loaded is found by listing storage (one request, then every project's " +
        'project.json at once) instead of the first read of its project.json.',
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
