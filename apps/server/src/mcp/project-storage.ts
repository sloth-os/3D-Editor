import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProjectFileStore } from '@3d-editor/core';
import type { ProjectListing, Room } from '../sync/room';
import type { RoomManager } from '../sync/room-manager';

/*
 * What the project tools tell agents about storage that other writers share: a project deleted
 * from storage elsewhere while this server has it open (Room.deletedFromStorage), and a listing of
 * the projects in storage that failed (RoomManager.listProjects then lists the projects this
 * server has loaded). docs/storage-and-sync.md (Deleted projects) has the rules.
 */

/**
 * The sentence of get_project (`deleted_from_storage_note`) about a project whose room found it
 * deleted from storage by another writer when it last read storage (Room.deletedFromStorage):
 * the room stays open while editors or agents use it, and its next change stores the whole
 * project again (Room.save with `create`); a room nobody uses is closed (RoomManager.abandoned).
 */
export const DELETED_ELSEWHERE_NOTE =
  'Another writer (a server sharing this storage, or a browser syncing with it) deleted this project ' +
  'from storage after this server had loaded or saved it. This server keeps it open while editors ' +
  'or agents use it here, and the next change made here stores the whole project in storage ' +
  'again; without a change it stays deleted, and this server closes it once nobody uses it.';

/** The `note` of list_projects when listing the projects in storage failed. */
export const LIST_FAILED_NOTE =
  "Listing the projects in storage failed (the server logged 'listing projects failed'), so only " +
  'the projects this server has loaded are listed; projects that are only in storage are missing ' +
  'until a later list_projects lists storage again.';

/**
 * get_project checks storage before it answers unless the room read it within this time (like
 * RoomManager's reads of rooms nobody uses), so that it can say that another writer deleted the
 * project: a room that agents use reads storage only when it saves, and one that editors use once
 * a minute (RoomManager.refreshActive).
 */
export const PROJECT_READ_MAX_AGE_MS = 2000;
/**
 * How long get_project waits for that check; it goes on, and the next get_project does not wait
 * for it again (storage that does not answer takes 30 s per request).
 */
export const PROJECT_READ_WAIT_MS = 5000;

/** The checks of storage that get_project started, by room (see {@link readBeforeAnswer}). */
const checks = new WeakMap<Room, { done: Promise<void>; late: boolean }>();

/**
 * Checks storage before get_project answers, unless the room read it within
 * {@link PROJECT_READ_MAX_AGE_MS}: whether the project's document is stored (ProjectFileStore
 * hasDocument: an ETag, one stat or request), and when that changed since the room last read
 * storage (another writer deleted the project, or stored it again), the room reads it (Room.refresh,
 * which sets Room.deletedFromStorage or merges what the other writer stored). Waits at most
 * {@link PROJECT_READ_WAIT_MS}, and not at all for a check that a get_project already stopped
 * waiting for. A failed check leaves the room as it was.
 */
export async function readBeforeAnswer(
  room: Room,
  store: ProjectFileStore | null,
  now = Date.now(),
): Promise<void> {
  if (!store || room.destroyed) return;
  let check = checks.get(room);
  if (!check) {
    if (now - room.readAt < PROJECT_READ_MAX_AGE_MS) return;
    const started = {
      late: false,
      done: (async () => {
        const stored = await store.hasDocument(room.id);
        if (stored ? room.deletedFromStorage : room.documentStored) await room.refresh();
      })()
        .catch(() => undefined)
        .finally(() => {
          if (checks.get(room) === started) checks.delete(room);
        }),
    };
    check = started;
    checks.set(room, check);
  }
  if (check.late) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), PROJECT_READ_WAIT_MS);
    timer.unref?.();
  });
  if (await Promise.race([check.done.then(() => false), late])) check.late = true;
  clearTimeout(timer);
}

/** The listing of storage that the current list_projects call made (see {@link listProjects}). */
const listing = new AsyncLocalStorage<{ failed: boolean }>();
/** Stores whose listProjects reports its failures to {@link listing}. */
const watched = new WeakSet<ProjectFileStore>();

/**
 * RoomManager.listProjects with whether its listing of storage failed. RoomManager.listProjects
 * only logs and counts a failure ('listing projects failed', metric persistence op 'list' status
 * 'error') and then lists the projects this server has loaded; the store's listProjects is wrapped
 * once so that a failure is recorded for the call whose listing failed (its async context), not
 * for another request's listing that failed at the same time.
 */
export async function listProjects(
  rooms: RoomManager,
): Promise<{ projects: ProjectListing[]; failed: boolean }> {
  const store = rooms.persistence.store;
  if (store && !watched.has(store)) {
    watched.add(store);
    const list = store.listProjects.bind(store);
    store.listProjects = async () => {
      try {
        return await list();
      } catch (err) {
        const call = listing.getStore();
        if (call) call.failed = true;
        throw err;
      }
    };
  }
  const call = { failed: false };
  const projects = await listing.run(call, () => rooms.listProjects());
  return { projects, failed: call.failed };
}
