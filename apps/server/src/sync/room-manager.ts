import * as Y from 'yjs';
import { SceneDoc, isValidProjectId, newUuid, type ProjectInfo } from '@3d-editor/core';
import type { Persistence } from '../persistence';
import type { ServerMetrics } from '../observability/metrics';
import type { Log } from '../observability/log';
import { errorMessage, withSpan } from '../observability/tracing';
import { Room, STORAGE_ORIGIN, type ProjectListing } from './room';

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
}

const TOMBSTONE_TTL_MS = 60 * 60 * 1000;

/**
 * Loads projects into memory on demand (from the persistence backend), keeps them while they
 * are in use and evicts idle ones after persisting them.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room | null>>();
  /** Recently deleted project ids (refuses re-creation by reconnecting clients). */
  private readonly tombstones = new Map<string, number>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly refreshTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private refreshing = false;
  private closed = false;
  private readonly closedListeners = new Set<(room: Room) => void>();

  constructor(private readonly opts: RoomManagerOptions) {
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
      for (const room of this.all()) if (room.conns.size > 0 || room.needsReadBack) await room.refresh();
    } finally {
      this.refreshing = false;
    }
  }

  get persistence(): Persistence {
    return this.opts.persistence;
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
    const { metrics, log, debounceMs, serverVersion } = this.opts;
    return { store: this.store, metrics, log, debounceMs, serverVersion };
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
   * Returns the room of a project, loading it from storage if needed. With `create`, unknown
   * projects get a new empty room (used by sync connections: browsers may create projects
   * offline and upload them on connect). Returns null for unknown or deleted projects.
   * Throws {@link StorageUnavailableError} when storage fails and `create` is false.
   */
  async open(id: string, opts: { create?: boolean } = {}): Promise<Room | null> {
    if (this.closed) throw new Error('server is shutting down');
    if (!isValidProjectId(id) || this.isDeleted(id)) return null;
    const live = this.get(id);
    if (live) {
      live.touch();
      return live;
    }
    const pending = this.loading.get(id);
    if (pending) {
      const r = await pending;
      if (r || !opts.create) return r && !r.destroyed ? r : null;
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
    const ydoc = new Y.Doc();
    if (update) Y.applyUpdate(ydoc, update, STORAGE_ORIGIN);
    const room = new Room(id, ydoc, this.roomDeps(), { info, persisted });
    this.rooms.set(id, room);
    this.updateGauge();
    // Storage was unreachable: the first save merges whatever is stored (CRDT) into this room.
    if (failed) room.markDirty();
    this.opts.log.debug({ project: id, persisted }, 'room loaded');
    return room;
  }

  /** Whether a project exists (loaded, or persisted). */
  async exists(id: string): Promise<boolean> {
    if (!isValidProjectId(id) || this.isDeleted(id)) return false;
    if (this.get(id)) return true;
    const store = this.store;
    if (!store) return false;
    return (
      !!(await store.loadInfo(id).catch(() => null)) ||
      !!(await store.loadDocument(id, { etag: false }).catch(() => null))
    );
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
    room.markDirty();
    await room.flush();
    return room;
  }

  /** Persisted projects merged with live rooms (most recently updated first). */
  async listProjects(): Promise<ProjectListing[]> {
    const byId = new Map<string, ProjectListing>();
    const store = this.store;
    if (store) {
      const { metrics } = this.opts;
      const end = metrics.persistenceDuration.startTimer({ op: 'list' });
      try {
        const infos = await withSpan('persistence.list', {}, () => store.listProjects());
        for (const info of infos)
          if (!this.isDeleted(info.id)) byId.set(info.id, { ...info, peers: 0, live: false });
        metrics.persistenceOps.inc({ op: 'list', status: 'ok' });
      } catch (err) {
        metrics.persistenceOps.inc({ op: 'list', status: 'error' });
        this.opts.log.warn({ err: errorMessage(err) }, 'listing projects failed');
      } finally {
        end();
      }
    }
    for (const room of this.all()) {
      if (!room.persisted && room.isEmpty() && !byId.has(room.id)) continue;
      byId.set(room.id, room.listing());
    }
    return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  /** Listing entry for one project (null if unknown). */
  async describe(id: string): Promise<ProjectListing | null> {
    const room = await this.open(id);
    return room ? room.listing() : null;
  }

  /** Deletes a project: disconnects its clients and removes the stored files. */
  async deleteProject(id: string): Promise<boolean> {
    if (!isValidProjectId(id)) return false;
    await this.loading.get(id)?.catch(() => null);
    const existed = await this.exists(id);
    const room = this.rooms.get(id);
    if (room) {
      this.rooms.delete(id);
      this.updateGauge();
      await room.close({ flush: false, code: 4404, reason: 'project deleted' });
      this.emitClosed(room);
    }
    const store = this.store;
    if (store && existed) {
      const { metrics } = this.opts;
      const end = metrics.persistenceDuration.startTimer({ op: 'delete' });
      try {
        await withSpan('persistence.delete', { 'project.id': id }, () => store.deleteProject(id));
        metrics.persistenceOps.inc({ op: 'delete', status: 'ok' });
      } catch (err) {
        metrics.persistenceOps.inc({ op: 'delete', status: 'error' });
        throw err;
      } finally {
        end();
      }
    }
    if (existed) this.tombstones.set(id, Date.now());
    return existed;
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
        if (!room.isIdle(now, this.opts.ttlMs)) continue;
        await (room.needsReadBack ? room.refresh() : room.flush());
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

  /** Persists and closes every room (server shutdown). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await Promise.allSettled([...this.loading.values()]);
    const rooms = this.all();
    this.rooms.clear();
    await Promise.allSettled(
      rooms.map((r) => r.close({ flush: true, code: 1001, reason: 'server shutting down' })),
    );
    this.updateGauge();
  }
}
