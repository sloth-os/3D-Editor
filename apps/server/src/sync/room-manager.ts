import * as Y from 'yjs';
import {
  IncompleteListingError,
  PROJECT_DELETED_CLOSE_CODE,
  SceneDoc,
  isValidProjectId,
  newUuid,
  type FileEntry,
  type ProjectFileStore,
  type ProjectInfo,
} from '@3d-editor/core';
import type { Persistence } from '../persistence';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import { errorMessage, withSpan } from '../observability/tracing';
import { trackOpenRoom } from '../render/memory';
import { Room, STORAGE_ORIGIN, settlesBefore, type DeletionOutcome, type ProjectListing } from './room';
import { ProjectMemoryError, loadRefusal, type GrowthCheck, type HeapProbe } from './project-memory';
import { measureUpdate, yjsReadError, type UpdateSize } from './update-size';

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

export interface RoomManagerOptions {
  persistence: Persistence;
  metrics: ServerMetrics;
  log: Log;
  /** Idle rooms (no connections, no MCP session) are evicted after this time. */
  ttlMs: number;
  debounceMs: number;
  serverVersion: string;
  /** How often idle rooms are checked (default: derived from ttlMs). */
  sweepIntervalMs?: number;
  /**
   * How often rooms with connected editors merge changes from storage made by others
   * (other servers, devices saving to WebDAV directly), and rooms that wrote to WebDAV read their
   * write back (Room.needsReadBack). Default 60 s; 0 disables.
   */
  refreshIntervalMs?: number;
  /**
   * How long a request waits for storage before it answers without it, while the read goes on
   * (default 5 s): opening a loaded room nobody uses hands out the room as it is (see
   * RoomManager.readUnused), and a project deleted here within the hour counts as still deleted
   * (see RoomManager.stillDeleted). Storage that does not answer (its requests time out after 30 s
   * each) must not hold up every request that opens a project.
   */
  openReadWaitMs?: number;
  /**
   * How long a shutdown ({@link RoomManager.close}) waits for storage to save the loaded projects
   * (default {@link SHUTDOWN_SAVE_WAIT_MS}; a shutdown sets it from SHUTDOWN_TIMEOUT_SECONDS, see
   * RoomManager.setShutdownWait).
   */
  shutdownWaitMs?: number;
  /**
   * Asked before a change a sync client sends is applied, when it adds to its project (default: the
   * check of operators that add to a project, see Room.handleMessage).
   */
  growthCheck?: GrowthCheck;
  /** The heap a stored project's load is held against (default: this process's; see load). */
  heap?: HeapProbe;
}

const TOMBSTONE_TTL_MS = 60 * 60 * 1000;
/**
 * How long a shutdown waits for storage to save the loaded projects, by default: the save wait of
 * the default SHUTDOWN_TIMEOUT_SECONDS (9 s, see config.ts shutdownSaveWait): Docker stops a
 * container 10 s after SIGTERM, and the server exits by itself before that (shutdown.ts). Storage
 * that does not answer (WebDAV: 30 s per request) used to hold the shutdown until main.ts gave up
 * after 20 s.
 */
export const SHUTDOWN_SAVE_WAIT_MS = 7000;

/**
 * A read of storage that goes on while the requests that wait for it answer without it after
 * {@link RoomManagerOptions.openReadWaitMs} (see RoomManager.waitFor).
 */
interface StorageRead {
  done: Promise<void>;
  /** A request stopped waiting for it: storage did not answer in time. */
  late: boolean;
}
/**
 * A loaded room nobody uses reads storage again before it is opened, unless it read it within this
 * time (so that the request that resolves a project and the one that opens it read it once).
 */
const UNUSED_ROOM_READ_MS = 2000;

/**
 * How long a lookup of a project by name ({@link RoomManager.listNames}) goes on using the name it
 * read from a stored project's project.json while storage lists the project's folder unchanged: a
 * WebDAV server whose folders keep their ETag and modification time when a file in them is written
 * again (one that writes files in place) tells no change, so a project renamed by another writer is
 * read again after this time at the latest.
 */
export const STORED_NAME_MAX_AGE_MS = 60_000;

/** A stored project's name as a lookup by name last read it (see RoomManager.listNames). */
interface StoredName {
  /** The name its project.json gives; null when it has none (or one that is not a JSON object). */
  name: string | null;
  updated_at: string;
  /**
   * What storage reported for the project when it was read: its folder's ETag or modification time
   * in the listing, or else the ETag of its project.json (null: there is none; undefined: storage
   * reported nothing, then the project.json is read at every lookup).
   */
  tag: string | null | undefined;
  readAt: number;
}

/** A project that a lookup by name compares names with (see RoomManager.namesOf). */
export interface NamedProject {
  id: string;
  name: string;
  updated_at: string;
}

/** What a listing of storage for a lookup by name found (see RoomManager.listNames). */
export interface StoredNames {
  /**
   * The projects storage listed that this server had not loaded, and not deleted, with the names
   * their project.json gives (a folder without one lists no project, as in list_projects).
   */
  stored: NamedProject[];
  /** The project folders storage listed, by id; null when listing storage failed (or no storage). */
  listed: Set<string> | null;
  /** Listing storage failed, or reading the project.json of some projects did (`partial`). */
  failed: boolean;
  /** Storage listed its projects, but reading the project.json of some of them failed. */
  partial: boolean;
}

/**
 * Loads projects into memory on demand (from the persistence backend), keeps them while they
 * are in use and evicts idle ones after persisting them.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room | null>>();
  /** Recently deleted project ids (refuses re-creation by reconnecting clients). */
  private readonly tombstones = new Map<string, number>();
  /** The reads of storage that rooms nobody uses run before they are opened (see readUnused). */
  private readonly reading = new WeakMap<Room, StorageRead>();
  /** The checks whether storage holds a deleted project again, by id (see stillDeleted). */
  private readonly checking = new Map<string, StorageRead>();
  /**
   * The checks whether storage holds a project whose id is also the name of a loaded project, by
   * that id, with storage's answer once it gave one (see exists).
   */
  private readonly asking = new Map<string, StorageRead & { found: boolean }>();
  /** The deletions of projects from storage that are in progress, by id (see deleteProject). */
  private readonly deleting = new Map<string, Promise<void>>();
  /**
   * The names of the stored projects this server has not loaded, as lookups by name last read them
   * from their project.json, by id (see listNames).
   */
  private readonly storedNames = new Map<string, StoredName>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly refreshTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private refreshing = false;
  private closed = false;
  /** How long {@link close} waits for storage (see {@link setShutdownWait}). */
  private shutdownWaitMs: number;
  /** The rooms that a shutdown is closing until it has said which stayed unsaved (see close). */
  private closing: Room[] = [];
  private readonly closedListeners = new Set<(room: Room) => void>();

  constructor(private readonly opts: RoomManagerOptions) {
    this.shutdownWaitMs = opts.shutdownWaitMs ?? SHUTDOWN_SAVE_WAIT_MS;
    const interval = opts.sweepIntervalMs ?? Math.max(250, Math.min(60_000, Math.floor(opts.ttlMs / 2)));
    this.sweepTimer = setInterval(() => void this.sweep(), interval);
    this.sweepTimer.unref?.();
    const refreshMs = opts.refreshIntervalMs ?? 60_000;
    if (refreshMs > 0 && opts.persistence.store) {
      this.refreshTimer = setInterval(() => void this.refreshActive(), refreshMs);
      this.refreshTimer.unref?.();
    }
  }

  /**
   * Merges storage changes into rooms that have connected editors, and into rooms that wrote to
   * storage where another writer can replace their write (Room.needsReadBack), one room at a time.
   */
  async refreshActive(): Promise<void> {
    if (this.refreshing || this.closed) return;
    this.refreshing = true;
    try {
      for (const room of this.all()) {
        if (room.conns.size > 0 || room.needsReadBack) await room.refresh();
        if (this.abandoned(room)) await this.closeDeleted(room);
      }
    } finally {
      this.refreshing = false;
    }
  }

  get persistence(): Persistence {
    return this.opts.persistence;
  }

  /**
   * How long a request waits for a read of storage before it answers without it
   * ({@link RoomManagerOptions.openReadWaitMs}, 5 s by default).
   */
  get readWaitMs(): number {
    return this.opts.openReadWaitMs ?? 5000;
  }

  /**
   * Calls `listener` after a loaded room was closed because its project was deleted or because it
   * was evicted while idle, so that whoever kept state for it (MCP undo histories) lets go of its
   * document. Returns the unsubscribe function.
   */
  onRoomClosed(listener: (room: Room) => void): () => void {
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  private emitClosed(room: Room): void {
    // a lookup by name reads its project.json again (the room may have renamed the project, and a
    // folder whose ETag storage does not change with the files in it would not tell, see listNames)
    this.storedNames.delete(room.id);
    for (const listener of [...this.closedListeners]) {
      try {
        listener(room);
      } catch (err) {
        this.opts.log.warn({ err: errorMessage(err), project: room.id }, 'room close listener failed');
      }
    }
  }

  private get store() {
    return this.opts.persistence.store;
  }

  private roomDeps() {
    const { metrics, log, debounceMs, serverVersion, growthCheck } = this.opts;
    return { store: this.store, metrics, log, debounceMs, serverVersion, growthCheck };
  }

  private updateGauge(): void {
    this.opts.metrics.syncRooms.set(this.rooms.size);
  }

  /** A loaded room (without loading it). */
  get(id: string): Room | undefined {
    const r = this.rooms.get(id);
    return r && !r.destroyed ? r : undefined;
  }

  all(): Room[] {
    return [...this.rooms.values()].filter((r) => !r.destroyed);
  }

  /**
   * Whether this server deleted the project, or closed its room after finding it deleted from
   * storage, within the last hour (see {@link stillDeleted}, which also asks storage).
   */
  isDeleted(id: string): boolean {
    const t = this.tombstones.get(id);
    if (t === undefined) return false;
    if (Date.now() - t > TOMBSTONE_TTL_MS) {
      this.tombstones.delete(id);
      return false;
    }
    return true;
  }

  /**
   * {@link isDeleted}, unless storage holds the project's document again: another writer with
   * unsaved changes (a room of another server, a browser) saved it after the deletion. Then the
   * project exists, and this server lists and opens it again. The check of storage is awaited as
   * {@link waitFor} says (no answer in time: still deleted) and goes on; when storage then holds the
   * document, the next request finds the project. One check per project at a time.
   */
  private async stillDeleted(id: string): Promise<boolean> {
    if (!this.isDeleted(id)) return false;
    const store = this.store;
    if (!store) return true;
    let check = this.checking.get(id);
    if (!check) {
      const started: StorageRead = {
        late: false,
        done: store
          .hasDocument(id)
          .catch(() => false)
          .then((stored) => {
            if (stored) this.tombstones.delete(id);
          })
          .finally(() => {
            if (this.checking.get(id) === started) this.checking.delete(id);
          }),
      };
      check = started;
      this.checking.set(id, check);
    }
    await this.waitFor(check);
    return this.isDeleted(id);
  }

  /**
   * Waits for a read of storage for {@link RoomManagerOptions.openReadWaitMs} at most, and not at all
   * once a request stopped waiting for it: a request that asks several times (an MCP tool asks
   * whether a project exists, then opens it or lists the projects) waits once. A read for a loaded
   * `room` is not waited for either while another read for it that a request stopped waiting for
   * goes on (Room.storageLate: get_project's check, readBeforeAnswer, waits for none after
   * readUnused, and the other way round).
   */
  private async waitFor(read: StorageRead, room?: Room): Promise<void> {
    if (read.late || room?.storageLate) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.opts.openReadWaitMs ?? 5000);
      timer.unref?.();
    });
    const finished = read.done.then(
      () => false,
      () => false,
    );
    if (await Promise.race([finished, late])) {
      read.late = true;
      room?.readIsLate(read.done);
    }
    clearTimeout(timer);
  }

  /** A room nobody uses (no editor connected, no MCP session) that has no unsaved changes. */
  private unused(room: Room): boolean {
    return !room.isDirty && room.conns.size === 0 && room.holders.size === 0;
  }

  /**
   * A loaded room whose last read found its project deleted from storage by another writer, which
   * nobody uses and which has no unsaved changes: it is closed like a room of a project deleted
   * here, so that this server lists and opens what storage holds.
   */
  private abandoned(room: Room): boolean {
    return !room.destroyed && room.deletedFromStorage && this.unused(room);
  }

  /**
   * Before a loaded room nobody uses is opened: it reads storage again (another writer may have
   * changed or deleted the project since it last read it), unless it did within
   * {@link UNUSED_ROOM_READ_MS}, and it is closed when its project was deleted elsewhere. Without
   * this, a project deleted elsewhere still opened by id (while not listed), and a change made in
   * it saved it again. The read is awaited as {@link waitFor} says; one read per room at a time.
   */
  private async readUnused(room: Room, force = false): Promise<void> {
    if (!this.store || room.destroyed || !this.unused(room)) return;
    if (!room.deletedFromStorage && (force || Date.now() - room.readAt >= UNUSED_ROOM_READ_MS)) {
      let read = this.reading.get(room);
      if (!read) {
        const started: StorageRead = {
          late: false,
          done: room.refresh().finally(() => this.reading.delete(room)),
        };
        read = started;
        this.reading.set(room, read);
      }
      await this.waitFor(read, room);
    }
    if (this.abandoned(room)) await this.closeDeleted(room);
  }

  /** Closes an abandoned room (see {@link abandoned}) and remembers the deletion for an hour. */
  private async closeDeleted(room: Room): Promise<void> {
    if (this.rooms.get(room.id) !== room) return;
    this.rooms.delete(room.id);
    this.updateGauge();
    // like a deletion here: a browser that still has the project cannot upload it again at once
    this.tombstones.set(room.id, Date.now());
    await room.close({ flush: false, code: PROJECT_DELETED_CLOSE_CODE, reason: 'project deleted' });
    this.emitClosed(room);
    this.opts.log.debug({ project: room.id }, 'closed the room of a project deleted from storage elsewhere');
  }

  /**
   * Returns the room of a project, loading it from storage if needed. With `create`, unknown
   * projects get a new empty room (used by sync connections: browsers may create projects
   * offline and upload them on connect). Returns null for unknown projects and for deleted ones
   * (see {@link stillDeleted}; a loaded room nobody uses reads storage first, see
   * {@link readUnused}). A project that is not loaded is loaded once a deletion of it in progress
   * has finished (see deleteProject). Throws {@link StorageUnavailableError} when storage fails and
   * `create` is false.
   */
  async open(id: string, opts: { create?: boolean } = {}): Promise<Room | null> {
    if (this.closed) throw new Error('server is shutting down');
    if (!isValidProjectId(id)) return null;
    const live = this.get(id);
    if (live) await this.readUnused(live);
    if (await this.stillDeleted(id)) return null;
    if (live && !live.destroyed) {
      live.touch();
      return live;
    }
    const pending = this.loading.get(id);
    if (pending) {
      const r = await pending;
      if (r || !opts.create) return r && !r.destroyed ? r : null;
      return this.open(id, opts);
    }
    // no load while a deletion of the project runs (see deleteProject): after it, the project is
    // deleted, or still stored when storage could not delete it
    if (this.deleting.has(id)) {
      await this.afterDeletion(id);
      return this.open(id, opts);
    }
    const p = this.load(id, !!opts.create).finally(() => this.loading.delete(id));
    this.loading.set(id, p);
    return p;
  }

  private async load(id: string, create: boolean): Promise<Room | null> {
    const store = this.store;
    let update: Uint8Array | null = null;
    let info: ProjectInfo | null = null;
    let persisted = false;
    let failed = false;
    if (store) {
      const { metrics } = this.opts;
      const end = metrics.persistenceDuration.startTimer({ op: 'load' });
      try {
        await withSpan('persistence.load', { 'project.id': id }, async (span) => {
          // the ETag is not used: on WebDAV a plain GET (no PROPFIND requests)
          const doc = await store.loadDocument(id, { etag: false });
          info = await store.loadInfo(id).catch(() => null);
          if (doc) update = doc.update;
          persisted = !!doc || !!info;
          span.setAttribute('persistence.found', persisted);
        });
        metrics.persistenceOps.inc({ op: 'load', status: 'ok' });
      } catch (err) {
        metrics.persistenceOps.inc({ op: 'load', status: 'error' });
        this.opts.log.warn({ err: errorMessage(err), project: id }, 'loading project failed');
        if (!create) throw new StorageUnavailableError(`could not load project ${id}: ${errorMessage(err)}`);
        failed = true;
      } finally {
        end();
      }
    }
    if (this.closed) return null;
    if (!persisted && !create) return null;
    if (update) this.checkLoad(id, update, info);
    const ydoc = new Y.Doc();
    // (a project.json without a document: the empty document has no name, and the room's scene has
    // the stored one, see Room.scene)
    if (update) Y.applyUpdate(ydoc, update, STORAGE_ORIGIN);
    const room = new Room(id, ydoc, this.roomDeps(), {
      info,
      persisted,
      documentStored: !!update,
      readAt: store && !failed ? Date.now() : 0,
      stored: update ?? undefined,
    });
    this.rooms.set(id, room);
    this.updateGauge();
    // the memory checks count it among the open projects (render/memory.ts)
    trackOpenRoom(room.scene);
    // Storage was unreachable: the first save merges whatever is stored (CRDT) into this room.
    if (failed) room.markDirty();
    this.opts.log.debug({ project: id, persisted }, 'room loaded');
    return room;
  }

  /**
   * Throws a {@link ProjectMemoryError} (code OUT_OF_MEMORY) when loading the stored document
   * `update` of project `id`, and saving it once, would not fit into the server's free heap
   * (project-memory.ts loadRefusal), instead of letting the load end the server. A document the
   * measure cannot read is loaded without the check (a warning) when Yjs reads all of it
   * (update-size.ts yjsReadError); one that Yjs cannot read either is not loaded: an error, before
   * Yjs adds the structs it read to a document and fails on the rest.
   */
  private checkLoad(id: string, update: Uint8Array, info: ProjectInfo | null): void {
    let size: UpdateSize;
    try {
      size = measureUpdate(update);
    } catch (err) {
      const unreadable = yjsReadError(update);
      if (unreadable !== null) {
        this.opts.log.warn(
          { project: id, err: unreadable },
          'project not loaded: its stored document cannot be read',
        );
        throw new Error(`could not load project ${id}: its stored document cannot be read (${unreadable})`, {
          cause: err,
        });
      }
      this.opts.log.warn(
        { project: id, bytes: update.byteLength, err: errorMessage(err) },
        'project loaded without the memory check: the measure could not read its stored document',
      );
      return;
    }
    const refused = loadRefusal({ id, name: info?.name ?? id }, size, this.opts.heap);
    if (!refused) return;
    this.opts.log.warn({ project: id, err: refused }, 'project not loaded: the server cannot hold it');
    throw new ProjectMemoryError(refused);
  }

  /**
   * Whether a project exists (loaded, or persisted; a loaded room nobody uses reads storage first).
   * A project that is not loaded is asked about once a deletion of it in progress has finished (see
   * deleteProject). Throws {@link StorageUnavailableError} when storage cannot tell whether a project
   * that is not loaded exists, unless `id` is also the name of a loaded project (see
   * {@link loadedNamed}): MCP tools take a project's id or name and ask about the id first
   * (AgentSession.resolveProjectId), and a name such as 'Lighthouse' is a valid id too. Then storage
   * is awaited as {@link waitFor} says, and when it fails or does not answer in time the answer is
   * false, so that the name finds the loaded project (an error used to fail every call that named a
   * loaded project so while storage failed); it is false at once, without asking storage, while a
   * read for a project of that name that a request stopped waiting for goes on (Room.storageLate).
   * A check that a request stopped waiting for counts as such a read for those projects while it
   * goes on (so that get_project, which reads storage too, waits once). One such check per id at a
   * time.
   */
  async exists(id: string): Promise<boolean> {
    if (!isValidProjectId(id)) return false;
    if (!this.get(id)) await this.afterDeletion(id);
    const named = this.get(id) ? [] : this.loadedNamed(id);
    if (named.length === 0) return this.found(id);
    if (named.some((room) => room.storageLate)) return false;
    let check = this.asking.get(id);
    if (!check) {
      const started: StorageRead & { found: boolean } = {
        late: false,
        found: false,
        done: this.found(id)
          .then(
            (found) => {
              started.found = found;
            },
            () => undefined,
          )
          .finally(() => {
            if (this.asking.get(id) === started) this.asking.delete(id);
          }),
      };
      check = started;
      this.asking.set(id, check);
    }
    await this.waitFor(check);
    if (check.late) for (const room of named) room.readIsLate(check.done);
    return check.found;
  }

  /**
   * The projects this server has loaded and lists (see {@link listProjects}) that are named `name`,
   * ignoring letter case, as MCP tools match names (AgentSession.resolveProjectId compares these
   * alone when the listing of storage fails or does not answer in time).
   */
  loadedNamed(name: string): Room[] {
    const key = name.toLowerCase();
    return this.all().filter(
      (room) =>
        !this.abandoned(room) && (room.persisted || !room.isEmpty()) && room.scene.name.toLowerCase() === key,
    );
  }

  /** {@link exists}, without waiting for a deletion of the project in progress (deleteProject's). */
  private async found(id: string): Promise<boolean> {
    const live = this.get(id);
    if (live) await this.readUnused(live);
    if (await this.stillDeleted(id)) return false;
    if (live && !live.destroyed) return true;
    const store = this.store;
    if (!store) return false;
    // storage that fails (or gets no answer within its timeout) cannot tell: an error says so (it
    // used to read as 'no such project', after up to two timeouts); an unreadable project.json
    // reads as none
    const read = async <T>(stored: Promise<T>): Promise<T | null> => {
      try {
        return await stored;
      } catch (err) {
        if (err instanceof SyntaxError) return null;
        throw new StorageUnavailableError(`could not read project ${id} from storage (${errorMessage(err)})`);
      }
    };
    return !!(await read(store.loadInfo(id))) || !!(await read(store.loadDocument(id, { etag: false })));
  }

  /** Creates a new project with Blender's default scene (or an empty one) and persists it. */
  async createProject(opts: { name: string; empty?: boolean }): Promise<Room> {
    if (this.closed) throw new Error('server is shutting down');
    const id = newUuid();
    const scene = SceneDoc.create({
      name: opts.name,
      empty: opts.empty,
      generator: `3d-editor-server/${this.opts.serverVersion}`,
    });
    const ydoc = scene.ydoc;
    scene.destroy();
    const room = new Room(id, ydoc, this.roomDeps(), { persisted: false });
    this.rooms.set(id, room);
    this.updateGauge();
    trackOpenRoom(room.scene);
    room.markDirty();
    await room.flush();
    return room;
  }

  /**
   * Persisted projects merged with live rooms (most recently updated first). When listing storage
   * fails, the projects this server has loaded are listed; when only reading some project.json
   * files fails (IncompleteListingError), the projects that were read are listed too: their names
   * stay taken (project-names.ts) and tools find them by name (it used to list only the loaded ones
   * then, so that one unreadable project.json hid every other project that is only in storage).
   * Either way it logs 'listing projects failed' and counts a failed listing.
   */
  async listProjects(): Promise<ProjectListing[]> {
    const byId = new Map<string, ProjectListing>();
    const store = this.store;
    /** The projects storage lists (null when listing them failed: then every loaded one is listed). */
    let stored: Set<string> | null = null;
    if (store) {
      const { metrics } = this.opts;
      const end = metrics.persistenceDuration.startTimer({ op: 'list' });
      try {
        let infos: ProjectInfo[] | null = null;
        const listedAt = Date.now();
        try {
          infos = await withSpan('persistence.list', {}, () => store.listProjects());
          stored = new Set(infos.map((info) => info.id));
          metrics.persistenceOps.inc({ op: 'list', status: 'ok' });
        } catch (err) {
          metrics.persistenceOps.inc({ op: 'list', status: 'error' });
          this.opts.log.warn({ err: errorMessage(err) }, 'listing projects failed');
          if (err instanceof IncompleteListingError) {
            infos = err.listed;
            // (storage lists those it could not read: none of them was deleted elsewhere)
            stored = new Set([...infos.map((info) => info.id), ...err.unread]);
          }
        }
        if (infos) {
          this.refreshStoredNames(infos, listedAt);
          const deleted = await Promise.all(infos.map((info) => this.stillDeleted(info.id)));
          infos.forEach((info, i) => {
            if (!deleted[i]) byId.set(info.id, { ...info, peers: 0, live: false });
          });
        }
      } finally {
        end();
      }
    }
    if (store && stored) await this.checkUnlisted(store, stored);
    for (const room of this.all()) {
      if (this.abandoned(room)) continue;
      if (!room.persisted && room.isEmpty() && !byId.has(room.id)) continue;
      byId.set(room.id, room.listing());
    }
    return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /**
   * The names a lookup by name compares ({@link listNames}) from the project.json files that
   * list_projects read (`infos`, read from `listedAt` on): a project another writer renamed is found
   * by its new name at once after list_projects lists it, also where storage tells no change of its
   * folder (else after {@link STORED_NAME_MAX_AGE_MS} at the latest). A name read after `listedAt`
   * is kept.
   */
  private refreshStoredNames(infos: ProjectInfo[], listedAt: number): void {
    for (const info of infos) {
      const known = this.storedNames.get(info.id);
      if (!known || known.readAt > listedAt) continue;
      this.storedNames.set(info.id, {
        ...known,
        name: info.name ?? null,
        updated_at: info.updated_at ?? '',
        readAt: listedAt,
      });
    }
  }

  /**
   * A loaded room nobody uses whose project storage does not list (`listed`), though the room found
   * its document stored: deleted elsewhere since the room last read it (then the room reads it
   * again, and is closed), unless storage still has the document (an unreadable project.json). The
   * check is awaited as waitFor says (no answer in time: still stored).
   */
  private async checkUnlisted(store: ProjectFileStore, listed: Set<string>): Promise<void> {
    const unlisted = this.all().filter((r) => this.unused(r) && r.documentStored && !listed.has(r.id));
    await Promise.all(
      unlisted.map(async (room) => {
        let gone = false;
        const check: StorageRead = {
          late: false,
          done: store.hasDocument(room.id).then(
            (has) => {
              gone = !has;
            },
            () => undefined,
          ),
        };
        await this.waitFor(check, room);
        if (gone) await this.readUnused(room, true);
      }),
    );
  }

  /**
   * Lists storage for a lookup of a project by name (AgentSession.findProject, which compares the
   * projects of {@link namesOf}: these and the loaded ones, as list_projects lists them), with one
   * listing of the projects folder (WebDAV: one PROPFIND; the disk: one directory read). It reads
   * the project.json of a stored project this server has not loaded only when it has not read it
   * before, when the listing reports another ETag or modification time for its folder than when it
   * read it (where the listing reports neither for folders, as the disk's does: another ETag of its
   * project.json, a stat each), when it read it {@link STORED_NAME_MAX_AGE_MS} ago or more, or when
   * it found no name then (no project.json yet); list_projects's listing gives it the names it reads
   * (refreshStoredNames). A lookup by name read every project.json at every call before: 202
   * requests per call with 200 projects on WebDAV. A project this server loads is read again once
   * it is closed (it may have been renamed here). Projects deleted here are left out (stillDeleted),
   * and loaded rooms nobody uses that storage does not list are checked as list_projects checks
   * them. Listing storage failing, and reading some project.json files failing (those projects are
   * left out), are logged ('listing projects failed') and counted as list_projects's are.
   */
  async listNames(): Promise<StoredNames> {
    const store = this.store;
    if (!store) return { stored: [], listed: null, failed: false, partial: false };
    const { metrics, log } = this.opts;
    const end = metrics.persistenceDuration.startTimer({ op: 'list' });
    try {
      let entries: FileEntry[];
      try {
        entries = await withSpan('persistence.list', {}, () => store.fs.list(store.projectsDir()));
      } catch (err) {
        metrics.persistenceOps.inc({ op: 'list', status: 'error' });
        log.warn({ err: errorMessage(err) }, 'listing projects failed');
        return { stored: [], listed: null, failed: true, partial: false };
      }
      const folders = entries.filter((e) => e.isDir && isValidProjectId(e.name));
      const listed = new Set(folders.map((e) => e.name));
      for (const id of [...this.storedNames.keys()]) if (!listed.has(id)) this.storedNames.delete(id);
      const now = Date.now();
      const stored: NamedProject[] = [];
      const failures: unknown[] = [];
      await Promise.all(
        folders.map(async (entry) => {
          const room = this.get(entry.name);
          // a loaded project is compared by the name it has now (namesOf)
          if ((room && !this.abandoned(room)) || (await this.stillDeleted(entry.name))) return;
          try {
            const known = await this.storedName(store, entry, now);
            if (known.name !== null)
              stored.push({ id: entry.name, name: known.name, updated_at: known.updated_at });
          } catch (err) {
            failures.push(err);
          }
        }),
      );
      await this.checkUnlisted(store, listed);
      if (failures.length > 0) {
        metrics.persistenceOps.inc({ op: 'list', status: 'error' });
        const reason = errorMessage(failures[0]);
        log.warn(
          {
            err: `could not read the project.json of ${failures.length} of ${folders.length} stored projects (${reason})`,
          },
          'listing projects failed',
        );
      } else metrics.persistenceOps.inc({ op: 'list', status: 'ok' });
      return { stored, listed, failed: failures.length > 0, partial: failures.length > 0 };
    } finally {
      end();
    }
  }

  /**
   * The name of a stored project from its project.json, read again only when needed (see
   * {@link listNames}). Throws when reading it fails (a project.json that is not a JSON object
   * gives no name, as in list_projects).
   */
  private async storedName(store: ProjectFileStore, entry: FileEntry, now: number): Promise<StoredName> {
    const id = entry.name;
    const tag =
      entry.etag ??
      entry.lastModified ??
      (store.fs.etag ? await store.fs.etag(store.infoPath(id)) : undefined);
    const known = this.storedNames.get(id);
    // (a missing name is read again at every lookup: a folder whose project.json another writer has
    // not written yet, while it creates the project, gets one without a change the listing reports)
    if (
      known &&
      known.name !== null &&
      tag !== undefined &&
      known.tag === tag &&
      now - known.readAt < STORED_NAME_MAX_AGE_MS
    )
      return known;
    let info: ProjectInfo | null = null;
    try {
      info = await store.loadInfo(id);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    const read: StoredName = {
      name: info?.name ?? null,
      updated_at: info?.updated_at ?? '',
      tag,
      readAt: now,
    };
    this.storedNames.set(id, read);
    return read;
  }

  /**
   * The projects a lookup by name compares names with, as list_projects lists them: the projects of
   * a listing for names ({@link listNames}; also an earlier one) that this server has not loaded or
   * deleted since, and the loaded ones by the names they have now (most recently updated first).
   */
  namesOf(names: StoredNames): NamedProject[] {
    const byId = new Map<string, NamedProject>();
    for (const p of names.stored) if (!this.isDeleted(p.id)) byId.set(p.id, p);
    for (const room of this.all()) {
      if (this.abandoned(room)) continue;
      if (!room.persisted && room.isEmpty() && !names.listed?.has(room.id)) continue;
      byId.set(room.id, {
        id: room.id,
        name: room.scene.name,
        updated_at: new Date(room.lastModified).toISOString(),
      });
    }
    return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Listing entry for one project (null if unknown). */
  async describe(id: string): Promise<ProjectListing | null> {
    const room = await this.open(id);
    return room ? room.listing() : null;
  }

  /**
   * Deletes a project: removes its stored files, then closes its room with
   * {@link PROJECT_DELETED_CLOSE_CODE} (browsers stop connecting to it) and remembers the deletion
   * for an hour. Until storage deleted the project, the room serves its editors and agents, and
   * from then on it writes nothing (Room.deleteFromStorage). Before it asks storage, it waits for
   * the project's earlier reads and writes of storage (a load of it, a read of storage, saves)
   * {@link RoomManagerOptions.openReadWaitMs} at most in all, and for none while one that a request
   * stopped waiting for goes on (Room.storageLate): when they have not finished, nothing is deleted
   * (then or later). One deletion of a project runs at a time (another one asked for meanwhile
   * waits for it, and after one that deleted the project finds it deleted), and requests that would
   * load the project from storage wait for it. When storage fails to delete the project, or nothing
   * was deleted, the room goes on serving, nothing is remembered, and a
   * {@link StorageUnavailableError} is thrown.
   */
  deleteProject(id: string): Promise<boolean> {
    if (!isValidProjectId(id)) return Promise.resolve(false);
    const earlier = this.deleting.get(id) ?? Promise.resolve();
    const deletion = earlier
      .then(() => this.deleteNow(id))
      .finally(() => {
        if (this.deleting.get(id) === settled) this.deleting.delete(id);
      });
    const settled = deletion.then(
      () => undefined,
      () => undefined,
    );
    this.deleting.set(id, settled);
    return deletion;
  }

  /** {@link deleteProject}, once the deletions of the project asked for before have finished. */
  private async deleteNow(id: string): Promise<boolean> {
    const waitMs = this.opts.openReadWaitMs ?? 5000;
    const deadline = Date.now() + waitMs;
    // (a load that started before the deletion: the ones asked for later wait for it, see open)
    const loading = this.loading.get(id);
    if (loading && !(await settlesBefore(loading, deadline))) throw this.notDeleted(id, null, 'timed out');
    let existed: boolean;
    try {
      existed = await this.found(id);
    } catch (err) {
      // storage cannot tell whether the project exists (StorageUnavailableError): logged and
      // counted as every failed deletion is, once (REST DELETE answers 503 without logging it again)
      this.opts.metrics.persistenceOps.inc({ op: 'delete', status: 'error' });
      this.opts.log.warn({ err: errorMessage(err), project: id }, 'deleting project failed');
      throw err;
    }
    const store = this.store;
    if (store && existed) await this.deleteStored(store, id, this.get(id), deadline);
    if (existed) this.tombstones.set(id, Date.now());
    const room = this.rooms.get(id);
    if (room) {
      this.rooms.delete(id);
      this.updateGauge();
      await room.close({ flush: false, code: PROJECT_DELETED_CLOSE_CODE, reason: 'project deleted' });
      this.emitClosed(room);
    }
    return existed;
  }

  /**
   * Deletes a project's stored files, between the reads and writes of storage of its room when it
   * is loaded (which it waits for until `deadline` at most).
   */
  private async deleteStored(
    store: ProjectFileStore,
    id: string,
    room: Room | undefined,
    deadline: number,
  ): Promise<void> {
    const { metrics, log } = this.opts;
    const end = metrics.persistenceDuration.startTimer({ op: 'delete' });
    const remove = () => withSpan('persistence.delete', { 'project.id': id }, () => store.deleteProject(id));
    let outcome: DeletionOutcome = 'deleted';
    try {
      if (room) outcome = await room.deleteFromStorage(remove, deadline - Date.now());
      else await remove();
    } catch (err) {
      metrics.persistenceOps.inc({ op: 'delete', status: 'error' });
      log.warn({ err: errorMessage(err), project: id }, 'deleting project failed');
      const kept = room
        ? 'the project stays open on this server for its editors and agents, and storage may still hold all or part of it'
        : 'storage may still hold all or part of it';
      throw new StorageUnavailableError(
        `could not delete project ${id} from storage (${errorMessage(err)}); ${kept}: delete it again`,
      );
    } finally {
      end();
    }
    if (outcome !== 'deleted') throw this.notDeleted(id, room, outcome);
    metrics.persistenceOps.inc({ op: 'delete', status: 'ok' });
  }

  /**
   * The error of a deletion that did not start: the project's earlier reads and writes of storage
   * (`room`'s, or a load of the project) had not finished (see deleteProject), when the deletion's
   * wait ended ('timed out'), or when it asked, while a read of the project that a request stopped
   * waiting for went on ('storage late': the deletion did not wait).
   */
  private notDeleted(
    id: string,
    room: Room | null | undefined,
    why: Exclude<DeletionOutcome, 'deleted'>,
  ): StorageUnavailableError {
    const waitMs = this.opts.openReadWaitMs ?? 5000;
    const reason =
      why === 'timed out'
        ? `storage did not finish this project's earlier reads and writes within ${waitMs / 1000} s`
        : `storage has not finished a read of this project that a request stopped waiting for after ${waitMs / 1000} s`;
    this.opts.metrics.persistenceOps.inc({ op: 'delete', status: 'error' });
    this.opts.log.warn({ err: reason, project: id }, 'deleting project failed');
    const kept = room ? ', and the project stays open on this server for its editors and agents' : '';
    return new StorageUnavailableError(
      `could not delete project ${id} from storage (${reason}); nothing was deleted${kept}: delete it again`,
    );
  }

  /**
   * Waits for a deletion of the project that is in progress (see deleteProject), so that a request
   * does not load the project while storage deletes it.
   */
  private async afterDeletion(id: string): Promise<void> {
    await this.deleting.get(id);
  }

  /**
   * Evicts idle rooms, persisting them first: a room whose write another writer can have replaced
   * since (Room.needsReadBack) refreshes, which writes its changes again when they are missing.
   */
  async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping || this.closed) return;
    this.sweeping = true;
    try {
      for (const room of this.all()) {
        if (this.abandoned(room)) {
          await this.closeDeleted(room);
          continue;
        }
        if (!room.isIdle(now, this.opts.ttlMs)) continue;
        await (room.needsReadBack ? room.refresh() : room.flush());
        if (this.abandoned(room)) {
          await this.closeDeleted(room);
          continue;
        }
        // Keep rooms whose changes could not be saved, rooms that could not read storage to find
        // their last write there (the refresh failed: it may have been replaced), and rooms that
        // got used meanwhile.
        if ((room.isDirty || room.needsReadBack) && this.store) continue;
        if (room.destroyed || !room.isIdle(Date.now(), this.opts.ttlMs) || this.rooms.get(room.id) !== room)
          continue;
        this.rooms.delete(room.id);
        this.updateGauge();
        await room.close({ flush: false });
        this.emitClosed(room);
        this.opts.log.debug({ project: room.id }, 'evicted idle room');
      }
      for (const [id, t] of this.tombstones) if (now - t > TOMBSTONE_TTL_MS) this.tombstones.delete(id);
    } finally {
      this.sweeping = false;
    }
  }

  /** Persists every loaded room. */
  async flushAll(): Promise<void> {
    await Promise.all(this.all().map((r) => r.flush()));
  }

  /**
   * The loaded projects with changes that storage may not hold (Room.hasUnsavedChanges), also those
   * a shutdown is closing until it has said which stayed unsaved: the shutdown (shutdown.ts) names
   * them when it runs out of time first.
   */
  unsaved(): { id: string; name: string }[] {
    return [...this.rooms.values(), ...this.closing]
      .filter((room) => room.hasUnsavedChanges)
      .map((room) => ({ id: room.id, name: room.scene.name }));
  }

  /**
   * Sets how long a shutdown ({@link close}) waits for storage: the server's shutdown sets it from
   * SHUTDOWN_TIMEOUT_SECONDS before it closes the app (shutdown.ts), so that the rooms stop waiting
   * before the server exits anyway.
   */
  setShutdownWait(ms: number): void {
    this.shutdownWaitMs = ms;
  }

  /**
   * Persists and closes every room (server shutdown). It waits for storage
   * {@link RoomManagerOptions.shutdownWaitMs} at most (see {@link setShutdownWait}), for loads and
   * saves together: a room whose save failed or has not finished by then is closed without it, and
   * the projects that stayed unsaved are logged at error ('projects not saved at shutdown', with
   * their ids and names): their changes since their last save are lost.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const waitMs = this.shutdownWaitMs;
    const deadline = Date.now() + waitMs;
    // (a load that finishes now adds no room, see load: it is waited for with the saves)
    const loads = Promise.allSettled([...this.loading.values()]);
    const rooms = this.all();
    this.rooms.clear();
    this.closing = rooms;
    const names = rooms.map((room) => room.scene.name);
    const saved = await Promise.all(
      rooms.map((room) =>
        room.close({ flush: true, code: 1001, reason: 'server shutting down', deadline }).catch(() => false),
      ),
    );
    await settlesBefore(loads, deadline);
    this.closing = [];
    this.updateGauge();
    const unsaved = rooms.flatMap((room, i) => (saved[i] ? [] : [{ id: room.id, name: names[i] }]));
    if (unsaved.length > 0)
      this.opts.log.error(
        {
          projects: unsaved,
          reason: `storage did not save their changes within ${waitMs / 1000} s, or refused them: the changes since their last save are lost`,
        },
        'projects not saved at shutdown',
      );
  }
}
