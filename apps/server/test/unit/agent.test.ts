import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  MemoryFileStore,
  ProjectFileStore,
  createOperatorRegistry,
  newUuid,
  type FileEntry,
} from '@3d-editor/core';
import { RoomManager, STORED_NAME_MAX_AGE_MS } from '../../src/sync/room-manager';
import { AgentSession, collectProjectNotes } from '../../src/mcp/agent';
import { SLOW_LISTING_MAX_AGE_MS, listForName } from '../../src/mcp/project-storage';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog, type Log } from '../../src/observability/log';
import type { Persistence } from '../../src/persistence';

/*
 * How MCP tools find a project by name (AgentSession.resolveProjectId): docs/mcp.md says a project
 * argument takes an id or the exact name, a name ignoring letter case only when no project has the
 * exact one, and that several projects with the name are an error that lists their ids. That holds
 * for the projects this server has loaded and those in storage together.
 */

/**
 * MemoryFileStore whose listings of folders can be held (storage that does not answer) or made to
 * fail, whose reads of some files fail (a project.json the server may not read), and whose reads
 * of project.json files can be held.
 */
class NamesStore extends MemoryFileStore {
  holdList: Promise<void> | null = null;
  failList = false;
  lists = 0;
  /** Listings answer after this time (storage that lists its projects slowly). */
  listDelayMs = 0;
  holdInfo: Promise<void> | null = null;
  /** Reads of project.json files answer after this time (storage that answers slowly). */
  infoDelayMs = 0;
  /** Reads of project.json files. */
  infoReads = 0;
  /**
   * The ETag the listing reports for every project folder, like a WebDAV server's PROPFIND (unset:
   * none, like the server's disk); by folder name in `folderTags`, else `folderTag`.
   */
  folderTag: string | undefined;
  readonly folderTags = new Map<string, string>();
  /** The modification time the listing reports for a project folder, by name (and no ETag). */
  readonly folderModified = new Map<string, string>();
  readonly failing = new Set<string>();
  override async list(dir: string): Promise<FileEntry[]> {
    this.lists++;
    if (this.holdList) await this.holdList;
    if (this.listDelayMs) await new Promise((resolve) => setTimeout(resolve, this.listDelayMs));
    if (this.failList) throw new Error('storage offline');
    const entries = await super.list(dir);
    return entries.map((e) => {
      const lastModified = e.isDir ? this.folderModified.get(e.name) : undefined;
      if (lastModified) return { ...e, lastModified };
      const etag = e.isDir ? (this.folderTags.get(e.name) ?? this.folderTag) : undefined;
      return etag ? { ...e, etag } : e;
    });
  }
  override async read(path: string) {
    if (this.failing.has(path)) throw new Error('403 Forbidden');
    if (path.endsWith('/project.json')) {
      this.infoReads++;
      if (this.holdInfo) await this.holdInfo;
      if (this.infoDelayMs) await new Promise((resolve) => setTimeout(resolve, this.infoDelayMs));
    }
    return super.read(path);
  }
}

const managers: RoomManager[] = [];
const registry = createOperatorRegistry();

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

/** A server (RoomManager) whose projects are in `fs` (none: in memory), and a session of an agent. */
function setup(opts: { fs?: NamesStore | null; openReadWaitMs?: number; ttlMs?: number; log?: Log } = {}) {
  const fs = opts.fs === undefined ? new NamesStore() : opts.fs;
  const store = fs ? new ProjectFileStore(fs, '/') : null;
  const persistence: Persistence = {
    mode: store ? 'disk' : 'memory',
    store,
    location: 'memory',
    check: async () => ({ ok: true }),
  };
  const rooms = new RoomManager({
    persistence,
    metrics: new ServerMetrics({ defaultMetrics: false }),
    log: opts.log ?? silentLog,
    ttlMs: opts.ttlMs ?? 60_000,
    debounceMs: 10,
    serverVersion: 'test',
    sweepIntervalMs: 3_600_000,
    openReadWaitMs: opts.openReadWaitMs,
  });
  managers.push(rooms);
  const session = () => new AgentSession(newUuid(), { rooms, registry, log: silentLog });
  return { rooms, store, session };
}

/** A project that is only in storage (made the way a browser makes one: its name is not checked). */
async function storedOnly(store: ProjectFileStore, name: string): Promise<string> {
  const id = newUuid();
  await store.saveInfo({
    id,
    name,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    schema_version: 1,
  });
  return id;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message of the error `p` rejects with. */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (err: Error) => err.message,
  );

/** The error of a name that several projects have, with their ids in either order. */
function several(name: string, ids: string[], after = ''): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const orders = ids.length === 2 ? [ids, [ids[1], ids[0]]] : [ids];
  const list = orders.map((o) => o.map(esc).join(', ')).join('|');
  return new RegExp(
    `^Several projects are named '${esc(name)}': (${list})\\. Pass the project id instead\\.${esc(after)}$`,
  );
}

/** Whether `p` has settled yet, and how (for a fake clock, where `within` would wait forever). */
function track<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
}

/** What `p` resolves to, or 'still waiting' when it takes longer than `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([p, wait(ms).then(() => 'still waiting' as const)]);
}

describe('AgentSession project names', () => {
  /*
   * Round 10 matched the names of the projects this server had loaded before it listed storage: a
   * loaded 'Dup' won silently over a 'Dup' that was only in storage, and a loaded 'lighthouse' (a
   * match ignoring letter case) over 'Lighthouse' in storage (an exact match).
   */
  it('compares a name with the loaded projects and those in storage together', async () => {
    const { rooms, store, session } = setup();
    const agent = session();
    const loadedDup = await rooms.createProject({ name: 'Dup', empty: true });
    const storedDup = await storedOnly(store!, 'Dup');
    const loadedLower = await rooms.createProject({ name: 'lighthouse', empty: true });
    const storedUpper = await storedOnly(store!, 'Lighthouse');

    expect(await failure(agent.findProject('Dup'))).toMatch(several('Dup', [loadedDup.id, storedDup]));
    expect(await failure(agent.findProject('dup'))).toMatch(several('dup', [loadedDup.id, storedDup]));

    expect(await agent.findProject('Lighthouse')).toEqual({ id: storedUpper });
    expect(await agent.findProject('lighthouse')).toEqual({ id: loadedLower.id });
    expect(await failure(agent.findProject('LIGHTHOUSE'))).toMatch(
      several('LIGHTHOUSE', [loadedLower.id, storedUpper]),
    );

    // a project the agent works on is no exception (it was found without a listing of storage)
    await agent.project(loadedDup.id);
    expect(await failure(agent.findProject('Dup'))).toMatch(several('Dup', [loadedDup.id, storedDup]));
    expect(await agent.findProject(loadedDup.id)).toEqual({ id: loadedDup.id });
  });

  /*
   * Storage that does not answer: a name of a loaded project finds it once the wait for storage
   * (openReadWaitMs, 5 s by default) is over, and says that the projects in storage were not
   * compared; the lookups that come while that listing goes on do not wait for it, and a name no
   * loaded project has waits for the listing. (The clock is a fake one: no test waits for real.)
   */
  it('finds a loaded project by name when storage does not list the projects in time, and says so', async () => {
    const fs = new NamesStore();
    const waitMs = 5000;
    const { rooms, session } = setup({ fs, openReadWaitMs: waitMs });
    const harbour = await rooms.createProject({ name: 'Harbour light', empty: true });
    const pier = await rooms.createProject({ name: 'Pier', empty: true });
    let release!: () => void;
    fs.holdList = new Promise((resolve) => (release = resolve));
    const lists = fs.lists;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const unmatched = track(failure(session().findProject('No such harbour')));
    const found = track(collectProjectNotes(() => session().resolveProjectId('harbour LIGHT')));
    await vi.advanceTimersByTimeAsync(waitMs - 1);
    expect(found.done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(found).toEqual({
      done: true,
      value: {
        value: harbour.id,
        notes: [
          `Project 'harbour LIGHT' was found by name, but storage did not answer within 5 s, so only the projects this server has loaded were compared: a project that is only in storage may have this name too. Pass the id ${harbour.id} to name this project without a lookup.`,
        ],
      },
    });
    // the request has waited for storage once: its own check of storage (get_project's) does not
    // wait for that project's reads again while the listing goes on
    expect(harbour.storageLate).toBe(true);
    // the listing goes on: lookups that come now do not wait for it, also of other projects
    const again = track(session().findProject('Harbour light'));
    const other = track(session().findProject('pier'));
    await vi.advanceTimersByTimeAsync(1);
    expect(again).toMatchObject({ done: true, value: { id: harbour.id } });
    expect(other).toMatchObject({ done: true, value: { id: pier.id } });
    expect(fs.lists).toBe(lists + 1);
    // a name that no loaded project has waits for the listing
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unmatched.done).toBe(false);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(unmatched.done).toBe(true);
    expect(unmatched.value).toMatch(
      /^Project 'No such harbour' not found\. Known projects: .*\. Use list_projects or create_project\.$/,
    );
    expect(unmatched.value).toContain(`'Harbour light' (${harbour.id})`);
    expect(unmatched.value).toContain(`'Pier' (${pier.id})`);
    vi.useRealTimers();
    // that listing took longer than the wait: a lookup after it compares the name with what it
    // listed at once, says so, and lists storage again meanwhile
    expect(await collectProjectNotes(() => session().resolveProjectId('harbour light'))).toEqual({
      value: harbour.id,
      notes: [
        `Project 'harbour light' was found by name, but storage took longer than 5 s to list its projects, so the projects in storage were compared as it listed them less than 1 s ago: a project stored or renamed since then may have this name too. Pass the id ${harbour.id} to name this project without a lookup.`,
      ],
    });
    expect(fs.lists).toBe(lists + 2);
    await (
      await listForName(rooms, 0)
    ).finished;
    // that listing answered in time: the next lookup waits for a listing of its own, and needs no note
    expect(await collectProjectNotes(() => session().resolveProjectId('harbour light'))).toEqual({
      value: harbour.id,
      notes: [],
    });
    expect(fs.lists).toBe(lists + 3);
  });

  /*
   * A name that could be an id ('Lighthouse') is asked about as an id first, and that question waits
   * for storage too: the request waits once in all, not once for the id and once more for the
   * listing, also when storage answers the first question slowly.
   */
  it('waits once in all for storage that does not answer about a name that could be an id', async () => {
    const fs = new NamesStore();
    const waitMs = 5000;
    const { rooms, session } = setup({ fs, openReadWaitMs: waitMs });
    const lighthouse = await rooms.createProject({ name: 'Lighthouse', empty: true });
    let release!: () => void;
    const unanswered = new Promise<void>((resolve) => (release = resolve));
    fs.holdInfo = unanswered;
    fs.holdList = unanswered;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const found = track(session().findProject('Lighthouse'));
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(found.done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(found).toEqual({
        done: true,
        value: { id: lighthouse.id, note: expect.stringContaining('storage did not answer within 5 s') },
      });
      // the read for that name goes on: a lookup that comes now waits for storage no more
      const again = track(session().findProject('lighthouse'));
      await vi.advanceTimersByTimeAsync(1);
      expect(again).toMatchObject({ done: true, value: { id: lighthouse.id } });
    } finally {
      release();
    }
  });

  it('waits once in all for storage that answers about a name that could be an id slowly', async () => {
    const fs = new NamesStore();
    const waitMs = 5000;
    const { rooms, session } = setup({ fs, openReadWaitMs: waitMs });
    const lighthouse = await rooms.createProject({ name: 'Lighthouse', empty: true });
    let release!: () => void;
    fs.holdList = new Promise<void>((resolve) => (release = resolve));
    fs.infoDelayMs = 3000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // storage says after 3 s that no project has the id 'Lighthouse'; the listing gets 2 s more
      const found = track(session().findProject('Lighthouse'));
      await vi.advanceTimersByTimeAsync(waitMs - 1);
      expect(found.done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(found).toMatchObject({ done: true, value: { id: lighthouse.id } });
    } finally {
      release();
    }
  });

  it('says which projects it compared when listing storage fails, or reading some project.json files does', async () => {
    const fs = new NamesStore();
    const warnings: { obj: unknown; msg?: string }[] = [];
    const log: Log = { ...silentLog, warn: (obj, msg) => void warnings.push({ obj, msg }) };
    const { rooms, store, session } = setup({ fs, log });
    const agent = session();
    const harbour = await rooms.createProject({ name: 'Harbour light', empty: true });
    const twin = await rooms.createProject({ name: 'Twin', empty: true });
    const twin2 = await rooms.createProject({ name: 'twin', empty: true });
    fs.failList = true;
    const failed =
      "listing the projects in storage failed (the server logged 'listing projects failed'), so only the projects this server has loaded were compared";
    expect(await collectProjectNotes(() => agent.resolveProjectId('Harbour light'))).toEqual({
      value: harbour.id,
      notes: [
        `Project 'Harbour light' was found by name, but ${failed}: a project that is only in storage may have this name too. Pass the id ${harbour.id} to name this project without a lookup.`,
      ],
    });
    expect(await failure(agent.findProject('TWIN'))).toMatch(
      several(
        'TWIN',
        [twin.id, twin2.id],
        " Listing the projects in storage failed (the server logged 'listing projects failed'), so only the projects this server has loaded were compared.",
      ),
    );
    await expect(agent.findProject('No such harbour')).rejects.toThrow(
      "Listing the projects in storage failed (the server logged 'listing projects failed'), so a project that is only in storage is not found by name now",
    );
    // (the server logs it, as the errors say)
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((w) => w.msg === 'listing projects failed')).toBe(true);
    expect(warnings[0].obj).toEqual({ err: 'storage offline' });
    warnings.length = 0;

    // storage lists its projects, but one project.json cannot be read
    fs.failList = false;
    const readable = await storedOnly(store!, 'Readable stored');
    const broken = await storedOnly(store!, 'Broken stored');
    fs.failing.add(store!.infoPath(broken));
    expect(await agent.findProject('readable stored')).toEqual({
      id: readable,
      note: `Project 'readable stored' was found by name, but reading the project.json of some projects in storage failed (the server logged 'listing projects failed'), so those projects were not compared: one of those may have this name too. Pass the id ${readable} to name this project without a lookup.`,
    });
    await expect(agent.findProject('Broken stored')).rejects.toThrow(
      "Reading the project.json of some projects in storage failed (the server logged 'listing projects failed'), so a project among those is not found by name now",
    );
    expect(warnings.map((w) => w.msg)).toEqual(['listing projects failed', 'listing projects failed']);
    expect(warnings[0].obj).toEqual({
      err: 'could not read the project.json of 1 of 5 stored projects (403 Forbidden)',
    });
    fs.failing.clear();
    expect(await agent.findProject('Broken stored')).toEqual({ id: broken });
  });

  /*
   * A lookup by name read every stored project's project.json at every call (the listing of
   * list_projects): 202 WebDAV requests per call with 200 projects. It lists the projects folder once
   * per lookup now, and reads a project.json only when storage reports a change: here, like the
   * server's disk, which reports nothing for folders, by the ETag of the project.json.
   */
  it('lists storage once per lookup, and reads a project.json again only when it changed', async () => {
    const fs = new NamesStore();
    const { rooms, store, session } = setup({ fs });
    const agent = session();
    const loaded = await rooms.createProject({ name: 'Loaded here', empty: true });
    const stored: string[] = [];
    for (let i = 0; i < 20; i++) stored.push(await storedOnly(store!, `Stored ${i}`));
    const renamed = { ...(await store!.loadInfo(stored[3]))!, name: 'Renamed elsewhere' };
    fs.lists = 0;
    fs.infoReads = 0;
    expect(await agent.findProject('Loaded here')).toEqual({ id: loaded.id });
    // each stored project once, the loaded one not at all
    expect([fs.lists, fs.infoReads]).toEqual([1, 20]);
    for (let i = 0; i < 3; i++) expect(await agent.findProject('stored 7')).toEqual({ id: stored[7] });
    expect([fs.lists, fs.infoReads]).toEqual([4, 20]);
    // another writer renames a stored project (writes its project.json again): read at the next lookup
    await store!.saveInfo(renamed);
    expect(await agent.findProject('renamed elsewhere')).toEqual({ id: stored[3] });
    expect([fs.lists, fs.infoReads]).toEqual([5, 21]);
    // (the projects it knows, most recently updated first, as list_projects lists them)
    expect(await failure(agent.findProject('Stored 3'))).toMatch(
      new RegExp(`^Project 'Stored 3' not found\\. Known projects: 'Loaded here' \\(${loaded.id}\\), `),
    );
    // a project another writer makes counts at once, also when a loaded project has its name
    const made = await storedOnly(store!, 'Made elsewhere');
    expect(await agent.findProject('made elsewhere')).toEqual({ id: made });
    const twin = await storedOnly(store!, 'Loaded here');
    expect(await failure(agent.findProject('Loaded here'))).toMatch(
      several('Loaded here', [loaded.id, twin]),
    );
    // and one another writer deletes is gone at once
    await store!.deleteProject(made);
    await expect(agent.findProject('Made elsewhere')).rejects.toThrow("Project 'Made elsewhere' not found.");
  });

  /*
   * A WebDAV listing reports an ETag or a modification time for each project folder: a project.json
   * is read again when that changes (Nextcloud changes a folder's ETag with every file in it). A
   * server whose folders keep them when a file in them is written again (one that writes files in
   * place) tells no change: the name read is compared for STORED_NAME_MAX_AGE_MS at most.
   */
  it('reads a project.json again when the listing reports a change of its folder, and after STORED_NAME_MAX_AGE_MS', async () => {
    const fs = new NamesStore();
    fs.folderTag = '"same"';
    const { store, session } = setup({ fs });
    const agent = session();
    // (names that cannot be ids: a lookup asks storage about an id first)
    const alpha = await storedOnly(store!, 'Alpha site');
    const beta = await storedOnly(store!, 'Beta site');
    const info = (id: string, name: string) => ({
      id,
      name,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      schema_version: 1,
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await agent.findProject('Alpha site')).toEqual({ id: alpha });
    const reads = fs.infoReads;
    await store!.saveInfo(info(alpha, 'Alpha site 2'));
    await store!.saveInfo(info(beta, 'Beta site 2'));
    fs.folderTags.set(beta, '"changed"');
    expect(await agent.findProject('Beta site 2')).toEqual({ id: beta });
    expect(fs.infoReads).toBe(reads + 1);
    // the folder of Alpha tells no change: the name read is compared
    expect(await agent.findProject('Alpha site')).toEqual({ id: alpha });
    expect(fs.infoReads).toBe(reads + 1);
    vi.setSystemTime(Date.now() + STORED_NAME_MAX_AGE_MS);
    expect(await agent.findProject('Alpha site 2')).toEqual({ id: alpha });
    await expect(agent.findProject('Alpha site')).rejects.toThrow("Project 'Alpha site' not found.");
    expect(fs.infoReads).toBe(reads + 3);
    // deleted elsewhere (not listed: what was read of it is dropped), then stored again by another
    // writer under another name, in a folder with the same ETag: read again
    await store!.deleteProject(beta);
    await expect(agent.findProject('Beta site 2')).rejects.toThrow("Project 'Beta site 2' not found.");
    await store!.saveInfo(info(beta, 'Beta site 3'));
    expect(await agent.findProject('Beta site 3')).toEqual({ id: beta });
  });

  /*
   * A WebDAV listing that reports a modification time and no ETag for each project folder: the
   * project.json is read again when that time changes, and not while it stays (here storage has no
   * ETags at all: without the modification time, a lookup would read every project.json each time).
   */
  it('reads a project.json again when the listing reports another modification time of its folder', async () => {
    const fs = new NamesStore();
    Object.defineProperty(fs, 'etag', { value: undefined });
    const { store, session } = setup({ fs });
    const agent = session();
    const delta = await storedOnly(store!, 'Delta site');
    fs.folderModified.set(delta, 'Thu, 01 Jan 2026 00:00:00 GMT');
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await agent.findProject('Delta site')).toEqual({ id: delta });
    const reads = fs.infoReads;
    expect(await agent.findProject('delta site')).toEqual({ id: delta });
    expect(fs.infoReads).toBe(reads);
    // another writer renames it: its folder's modification time changes
    await store!.saveInfo({ ...(await store!.loadInfo(delta))!, name: 'Delta site 2' });
    fs.folderModified.set(delta, 'Thu, 01 Jan 2026 00:05:00 GMT');
    expect(await agent.findProject('Delta site 2')).toEqual({ id: delta });
    expect(fs.infoReads).toBe(reads + 2);
  });

  /*
   * A lookup that listed a project folder whose project.json another writer had not written yet (it
   * creates the project) kept that missing name while storage told no change of the folder: the
   * project was not found by its name for STORED_NAME_MAX_AGE_MS (60 s). A missing name is read
   * again at every lookup.
   */
  it('reads a project.json again that was missing when a lookup listed its folder', async () => {
    const fs = new NamesStore();
    fs.folderTag = '"same"';
    const { store, session } = setup({ fs });
    const agent = session();
    const id = newUuid();
    // the writer stores the document first, then project.json
    await fs.write(store!.docPath(id), Y.encodeStateAsUpdate(new Y.Doc()));
    vi.useFakeTimers({ toFake: ['Date'] });
    await expect(agent.findProject('Being made')).rejects.toThrow("Project 'Being made' not found.");
    const reads = fs.infoReads;
    await store!.saveInfo({
      id,
      name: 'Being made',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      schema_version: 1,
    });
    expect(await agent.findProject('Being made')).toEqual({ id });
    expect(fs.infoReads).toBe(reads + 1);
    // once it has a name, it is compared as before (no read while the folder tells no change)
    expect(await agent.findProject('being made')).toEqual({ id });
    expect(fs.infoReads).toBe(reads + 1);
  });

  /*
   * list_projects reads every project.json: a lookup by name compares the names it read, so a project
   * another writer renamed is found by the name list_projects shows at once, also where storage tells
   * no change of its folder (before, only STORED_NAME_MAX_AGE_MS after the lookup read it).
   */
  it('compares the names list_projects read', async () => {
    const fs = new NamesStore();
    fs.folderTag = '"same"';
    const { rooms, store, session } = setup({ fs });
    const agent = session();
    const gamma = await storedOnly(store!, 'Gamma site');
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await agent.findProject('Gamma site')).toEqual({ id: gamma });
    await store!.saveInfo({ ...(await store!.loadInfo(gamma))!, name: 'Gamma site 2' });
    // the folder tells no change: the name read before is compared
    await expect(agent.findProject('Gamma site 2')).rejects.toThrow("Project 'Gamma site 2' not found.");
    const listed = await rooms.listProjects();
    expect(listed.map((p) => p.name)).toEqual(['Gamma site 2']);
    const reads = fs.infoReads;
    expect(await agent.findProject('Gamma site 2')).toEqual({ id: gamma });
    await expect(agent.findProject('Gamma site')).rejects.toThrow("Project 'Gamma site' not found.");
    expect(fs.infoReads).toBe(reads);
  });

  /*
   * As in list_projects: a loaded project that nobody uses here and that storage no longer lists
   * (another writer deleted it) is read again, closed, and not found by its name.
   */
  it('does not find a loaded project that another writer deleted while nobody used it here', async () => {
    const { rooms, store, session } = setup();
    const gone = await rooms.createProject({ name: 'Deleted elsewhere', empty: true });
    await store!.deleteProject(gone.id);
    await expect(session().findProject('Deleted elsewhere')).rejects.toThrow(
      "Project 'Deleted elsewhere' not found.",
    );
    expect(rooms.get(gone.id)).toBeUndefined();
  });

  /*
   * As in list_projects: a project.json that is not JSON lists no project (the others are compared,
   * with no note), a project deleted here is not compared until another writer stores it again, and
   * a project a browser opened here by a new id is not compared until it holds something.
   */
  it('compares the projects list_projects lists', async () => {
    const fs = new NamesStore();
    const { rooms, store, session } = setup({ fs });
    const agent = session();
    const readable = await storedOnly(store!, 'Readable site');
    const garbled = await storedOnly(store!, 'Garbled site');
    await fs.write(store!.infoPath(garbled), new TextEncoder().encode('not json'));
    expect(await agent.findProject('readable site')).toEqual({ id: readable });
    await expect(agent.findProject('Garbled site')).rejects.toThrow("Project 'Garbled site' not found.");
    // deleted here; then another writer (a browser with the project open) stores it again
    const deleted = await rooms.createProject({ name: 'Deleted here', empty: true });
    const stored = Y.encodeStateAsUpdate(deleted.doc);
    expect(await rooms.deleteProject(deleted.id)).toBe(true);
    await expect(agent.findProject('Deleted here')).rejects.toThrow("Project 'Deleted here' not found.");
    await store!.saveInfo({
      id: deleted.id,
      name: 'Deleted here',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      schema_version: 1,
    });
    await fs.write(store!.docPath(deleted.id), stored);
    expect(await agent.findProject('Deleted here')).toEqual({ id: deleted.id });
    // an empty room of a new id that a browser opened (nothing stored yet): 'Untitled' finds nothing
    await rooms.open(newUuid(), { create: true });
    await expect(agent.findProject('Untitled')).rejects.toThrow("Project 'Untitled' not found.");
  });

  it('reads every project.json at every lookup where storage reports no ETag to compare', async () => {
    const fs = new NamesStore();
    // a store that cannot tell a file's ETag without reading it (FileStore.etag is optional)
    Object.defineProperty(fs, 'etag', { value: undefined });
    const { store, session } = setup({ fs });
    const agent = session();
    for (let i = 0; i < 5; i++) await storedOnly(store!, `Untagged ${i}`);
    const reads = fs.infoReads;
    await agent.findProject('untagged 1');
    await agent.findProject('untagged 2');
    expect(fs.infoReads).toBe(reads + 10);
  });

  /*
   * A project this server loads may be renamed here: once its room is closed, a lookup by name reads
   * its project.json again, also where storage tells no change of its folder.
   */
  it('reads the project.json of a project again once this server has closed it', async () => {
    const fs = new NamesStore();
    fs.folderTag = '"same"';
    const { rooms, store, session } = setup({ fs, ttlMs: 1000 });
    const agent = session();
    const gamma = await storedOnly(store!, 'Gamma site');
    expect(await agent.findProject('Gamma site')).toEqual({ id: gamma });
    const room = (await rooms.open(gamma))!;
    room.scene.setName('Delta site');
    await room.flush();
    expect(await agent.findProject('delta site')).toEqual({ id: gamma });
    // nobody uses it: the server closes it once its ttl (1 s here) is over
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2000);
    await rooms.sweep();
    expect(rooms.get(gamma)).toBeUndefined();
    expect(await agent.findProject('delta site')).toEqual({ id: gamma });
    await expect(agent.findProject('Gamma site')).rejects.toThrow("Project 'Gamma site' not found.");
  });

  /*
   * Storage that lists its projects slowly (6 s) cost every round of listings a whole wait: 5 s every
   * second or third lookup by name. Once a listing took longer than the wait, a lookup compares the
   * name with it at once (for SLOW_LISTING_MAX_AGE_MS) and says so, while a new listing goes on; a
   * name that it does not find (or finds several times) waits for that listing. (The clock is a fake
   * one: no test waits for real.)
   */
  it('compares a name with the last listing at once while storage lists slowly', async () => {
    const fs = new NamesStore();
    const waitMs = 5000;
    const { rooms, store, session } = setup({ fs, openReadWaitMs: waitMs });
    const harbour = await rooms.createProject({ name: 'Harbour light', empty: true });
    const quay = await storedOnly(store!, 'Quay');
    fs.listDelayMs = 6000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = track(session().findProject('Harbour light'));
    await vi.advanceTimersByTimeAsync(waitMs + 1);
    expect(first).toMatchObject({
      done: true,
      value: { id: harbour.id, note: expect.stringContaining('storage did not answer within 5 s') },
    });
    await vi.advanceTimersByTimeAsync(1000);
    // that listing took 6 s: the next lookups answer at once, from what it listed
    const lists = fs.lists;
    const fromLast = track(session().findProject('quay'));
    await vi.advanceTimersByTimeAsync(1);
    expect(fromLast).toEqual({
      done: true,
      value: {
        id: quay,
        note: `Project 'quay' was found by name, but storage took longer than 5 s to list its projects, so the projects in storage were compared as it listed them less than 1 s ago: a project stored or renamed since then may have this name too. Pass the id ${quay} to name this project without a lookup.`,
      },
    });
    expect(fs.lists).toBe(lists + 1);
    // a name that listing does not have waits for the one going on
    const made = await storedOnly(store!, 'Made since');
    const fromNew = track(session().findProject('Made since'));
    await vi.advanceTimersByTimeAsync(5990);
    expect(fromNew.done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(fromNew).toEqual({ done: true, value: { id: made } });
    // a listing older than SLOW_LISTING_MAX_AGE_MS is not compared: the lookup waits again
    await vi.advanceTimersByTimeAsync(SLOW_LISTING_MAX_AGE_MS);
    const waits = track(session().findProject('Harbour light'));
    await vi.advanceTimersByTimeAsync(waitMs - 10);
    expect(waits.done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(waits).toMatchObject({
      done: true,
      value: { note: expect.stringContaining('did not answer within 5 s') },
    });
    // once a listing answers in time, lookups wait for listings of their own again
    fs.listDelayMs = 0;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await session().findProject('Harbour light')).toMatchObject({
      note: expect.stringContaining('took longer'),
    });
    await (
      await listForName(rooms, 0)
    ).finished;
    expect(await session().findProject('Harbour light')).toEqual({ id: harbour.id });
  });

  /*
   * A name that a loaded project has waits 5 s at most in all for storage. While storage lists slowly,
   * one that the last listing did not settle (a project only in storage has it too) waited for the new
   * listing as long as it took (6 s here, 35 s with storage that did not answer): it waits until the
   * deadline, then the last listing answers, here that several projects have the name.
   */
  it('answers a name that a loaded project has within the wait while storage lists slowly', async () => {
    const fs = new NamesStore();
    const waitMs = 5000;
    const { rooms, store, session } = setup({ fs, openReadWaitMs: waitMs });
    const loaded = await rooms.createProject({ name: 'Harbour light', empty: true });
    const stored = await storedOnly(store!, 'Harbour light');
    fs.listDelayMs = 6000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // the first listing takes 6 s: the lookup answers from the loaded projects after 5 s
    const first = track(session().findProject('Harbour light'));
    await vi.advanceTimersByTimeAsync(waitMs + 1);
    expect(first).toMatchObject({ done: true, value: { id: loaded.id } });
    await vi.advanceTimersByTimeAsync(1000);
    // that listing found both: the name is not settled by it, and the new listing takes 6 s again
    const second = track(failure(session().findProject('Harbour light')));
    await vi.advanceTimersByTimeAsync(waitMs - 10);
    expect(second.done).toBe(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(second).toEqual({
      done: true,
      value: `Several projects are named 'Harbour light': ${loaded.id}, ${stored}. Pass the project id instead. Storage took longer than 5 s to list its projects, so the projects in storage were compared as it listed them 5 s ago.`,
    });
    // a name that no loaded project has waits for the new listing (it ends 6 s after it began)
    const made = await storedOnly(store!, 'Made since');
    const fromNew = track(session().findProject('Made since'));
    await vi.advanceTimersByTimeAsync(900);
    expect(fromNew.done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(fromNew).toEqual({ done: true, value: { id: made } });
  });

  /*
   * While storage lists slowly, a listing that fails does not replace the last one that listed
   * storage, and a project deleted here since that listing is not found by it.
   */
  it('keeps comparing with the last listing that listed storage, without the projects deleted since', async () => {
    const fs = new NamesStore();
    const waitMs = 5000;
    const { rooms, store, session } = setup({ fs, openReadWaitMs: waitMs });
    const pier = await storedOnly(store!, 'Pier site');
    const quay = await storedOnly(store!, 'Quay site');
    fs.listDelayMs = 6000;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // the first listing takes 6 s (a name no loaded project has waits for it)
    const first = track(session().findProject('Pier site'));
    await vi.advanceTimersByTimeAsync(6001);
    expect(first).toEqual({ done: true, value: { id: pier } });
    // the next listing fails after 6 s: the lookups compare with the first one
    fs.failList = true;
    expect(await session().findProject('quay site')).toMatchObject({ id: quay });
    await vi.advanceTimersByTimeAsync(6001);
    fs.failList = false;
    expect(await session().findProject('quay site')).toEqual({
      id: quay,
      note: `Project 'quay site' was found by name, but storage took longer than 5 s to list its projects, so the projects in storage were compared as it listed them 6 s ago: a project stored or renamed since then may have this name too. Pass the id ${quay} to name this project without a lookup.`,
    });
    // deleted here: not found by that listing, nor by the one going on
    expect(await rooms.deleteProject(quay)).toBe(true);
    const deleted = track(failure(session().findProject('Quay site')));
    await vi.advanceTimersByTimeAsync(6001);
    expect(deleted).toMatchObject({
      done: true,
      value: expect.stringContaining("Project 'Quay site' not found."),
    });
  });

  /*
   * The wait for storage is RoomManager.readWaitMs: the server's openReadWaitMs (5 s unless set).
   */
  it('waits for storage as long as openReadWaitMs says', async () => {
    const fs = new NamesStore();
    const { rooms, session } = setup({ fs, openReadWaitMs: 2000 });
    const harbour = await rooms.createProject({ name: 'Harbour light', empty: true });
    let release!: () => void;
    fs.holdList = new Promise((resolve) => (release = resolve));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const found = track(session().findProject('Harbour light'));
      await vi.advanceTimersByTimeAsync(1999);
      expect(found.done).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(found).toMatchObject({
        done: true,
        value: { id: harbour.id, note: expect.stringContaining('storage did not answer within 2 s') },
      });
    } finally {
      release();
    }
  });

  it('compares the loaded projects at once without storage', async () => {
    const { rooms, session } = setup({ fs: null });
    const agent = session();
    const solo = await rooms.createProject({ name: 'Solo', empty: true });
    const same = await rooms.createProject({ name: 'Same', empty: true });
    const same2 = await rooms.createProject({ name: 'Same', empty: true });
    expect(await within(agent.findProject('solo'), 100)).toEqual({ id: solo.id });
    expect(await failure(agent.findProject('Same'))).toMatch(several('Same', [same.id, same2.id]));
    await expect(agent.findProject('Nothing')).rejects.toThrow("Project 'Nothing' not found.");
  });
});
