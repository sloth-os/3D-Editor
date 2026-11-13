import { AsyncLocalStorage } from 'node:async_hooks';
import { IncompleteListingError, type ProjectFileStore } from '@3d-editor/core';
import { settlesBefore, type ProjectListing, type Room } from '../sync/room';
import type { RoomManager, StoredNames } from '../sync/room-manager';

/*
 * What the project tools tell agents about storage that other writers share: a project deleted
 * from storage elsewhere while this server has it open (Room.deletedFromStorage), and a listing of
 * the projects in storage that failed (RoomManager.listProjects then lists the projects this
 * server has loaded, and those whose project.json it read when only some of those reads failed),
 * also when a tool looks up a project by name (listForName). docs/storage-and-sync.md (Deleted
 * projects) has the rules.
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

/**
 * The `note` of list_projects when listing the projects in storage failed (RoomManager.listProjects
 * then lists the projects this server has loaded). Tools find projects by name in that list, and
 * create_project and rename_project check new names against it (project-names.ts).
 */
export const LIST_FAILED_NOTE =
  "Listing the projects in storage failed (the server logged 'listing projects failed'), so only " +
  'the projects this server has loaded are listed; projects that are only in storage are missing ' +
  'until a later list_projects lists storage again. Meanwhile tools do not find those projects by ' +
  'name, and create_project and rename_project do not refuse a name that one of them has.';

/**
 * The `note` of list_projects when storage listed its projects but reading the project.json of some
 * of them failed (IncompleteListingError: RoomManager.listProjects lists the others).
 */
export const LIST_PARTIAL_NOTE =
  "Reading the project.json of some projects in storage failed (the server logged 'listing projects " +
  "failed'), so those projects are missing until a later list_projects reads them; the other " +
  'projects in storage and the projects this server has loaded are listed. Meanwhile tools do not ' +
  'find the missing projects by name, and create_project and rename_project do not refuse a name ' +
  'that one of them has.';

/**
 * get_project checks storage before it answers unless the room read it within this time (like
 * RoomManager's reads of rooms nobody uses), so that it can say that another writer deleted the
 * project: a room that agents use reads storage only when it saves, and one that editors use once
 * a minute (RoomManager.refreshActive).
 */
export const PROJECT_READ_MAX_AGE_MS = 2000;
/**
 * How long get_project waits for that check; it goes on, and the next get_project does not wait
 * for it again (storage that does not answer takes 30 s per request). Nor does a get_project wait
 * for it after waiting as long for another read of the room (Room.storageLate: opening a room
 * nobody uses reads storage first, RoomManager.readUnused, for as long at most): one get_project
 * waits once.
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
 * waiting for, nor while another read of the room that a request stopped waiting for goes on
 * (Room.storageLate). A failed check leaves the room as it was.
 */
export async function readBeforeAnswer(
  room: Room,
  store: ProjectFileStore | null,
  now = Date.now(),
): Promise<void> {
  if (!store || room.destroyed || room.storageLate) return;
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
  if (await Promise.race([check.done.then(() => false), late])) {
    check.late = true;
    room.readIsLate(check.done);
  }
  clearTimeout(timer);
}

/** How the listing of storage that a call made went (see {@link listProjects}). */
interface ListingOutcome {
  /** Listing storage failed, or reading some project.json files did (`partial`). */
  failed: boolean;
  /** Storage listed its projects, but reading the project.json of some of them failed. */
  partial: boolean;
}

/** The listing of storage that the current call made (see {@link listProjects}). */
const listing = new AsyncLocalStorage<ListingOutcome>();
/** Stores whose listProjects reports its failures to {@link listing}. */
const watched = new WeakSet<ProjectFileStore>();

/**
 * RoomManager.listProjects with whether its listing of storage failed. RoomManager.listProjects
 * only logs and counts a failure ('listing projects failed', metric persistence op 'list' status
 * 'error') and then lists the projects this server has loaded, and those whose project.json it
 * read (`partial`); the store's listProjects is wrapped once so that a failure is recorded for the
 * call whose listing failed (its async context), not for another request's listing that failed at
 * the same time.
 */
export async function listProjects(
  rooms: RoomManager,
): Promise<{ projects: ProjectListing[] } & ListingOutcome> {
  const store = rooms.persistence.store;
  if (store && !watched.has(store)) {
    watched.add(store);
    const list = store.listProjects.bind(store);
    store.listProjects = async () => {
      try {
        return await list();
      } catch (err) {
        const call = listing.getStore();
        if (call) {
          call.failed = true;
          call.partial = err instanceof IncompleteListingError;
        }
        throw err;
      }
    };
  }
  const call: ListingOutcome = { failed: false, partial: false };
  const projects = await listing.run(call, () => rooms.listProjects());
  return { projects, ...call };
}

/** A listing of storage that lookups of projects by name share (see {@link listForName}). */
interface NameListing {
  done: Promise<StoredNames>;
  /** A lookup stopped waiting for it: storage did not answer in time. */
  late: boolean;
}

/**
 * The last listing for lookups by name that listed storage (not `failed`) and when it finished, and
 * whether the last listing that finished, whatever it found, took longer than requests wait for
 * storage (RoomManager.readWaitMs): see {@link listForName}.
 */
interface LastNames {
  names: StoredNames | null;
  at: number;
  slow: boolean;
}

/** The listing that lookups of projects by name share while it goes on, by server. */
const nameListings = new WeakMap<RoomManager, NameListing>();
/** The last listings for lookups by name that finished, by server. */
const lastNames = new WeakMap<RoomManager, LastNames>();

/**
 * How old a listing for lookups by name may be that a lookup compares a name with at once while
 * storage lists its projects slowly (see {@link listForName}).
 */
export const SLOW_LISTING_MAX_AGE_MS = 60_000;

/** A listing for lookups by name that a lookup compares with at once (see {@link listForName}). */
export interface EarlierNames {
  names: StoredNames;
  /** How long ago it finished. */
  ageMs: number;
}

/**
 * The listing of storage that a lookup of a project by name compares names with
 * (AgentSession.findProject; RoomManager.listNames: one listing of the projects folder, and the
 * project.json of the stored projects that this server has not loaded and that are new or changed):
 * `answered` when it finished by `deadline`, else null, and `finished` whenever it finishes (storage
 * that does not answer takes 30 s per request on WebDAV). The lookups that come while a listing goes
 * on share it, and once one of them stopped waiting for it, the others do not wait for it until it
 * has finished (`answered` is null at once), as requests wait for other reads of storage
 * (RoomManager.waitFor). When the last listing that finished took longer than requests wait for
 * storage (RoomManager.readWaitMs: storage that lists its projects slowly), a lookup does not wait
 * for one: `earlier` is the last listing that listed storage, when it finished within
 * {@link SLOW_LISTING_MAX_AGE_MS}, and a new listing goes on meanwhile (each round of listings used
 * to cost a lookup the whole wait: 5 s every second or third call while listing took 6 s). Without
 * storage, the projects this server has loaded are all the projects: they are `answered` at once.
 */
export async function listForName(
  rooms: RoomManager,
  deadline: number,
): Promise<{ answered: StoredNames | null; finished: Promise<StoredNames>; earlier?: EarlierNames }> {
  if (!rooms.persistence.store) {
    const names = await rooms.listNames();
    return { answered: names, finished: Promise.resolve(names) };
  }
  let shared = nameListings.get(rooms);
  if (!shared) {
    const startedAt = Date.now();
    const started: NameListing = {
      late: false,
      done: rooms
        .listNames()
        .then((names) => {
          const at = Date.now();
          const before = lastNames.get(rooms);
          // (a listing that failed, also in part, keeps the one before as the last that listed storage)
          const kept = !names.failed ? { names, at } : before ? { names: before.names, at: before.at } : null;
          lastNames.set(rooms, {
            names: kept?.names ?? null,
            at: kept?.at ?? at,
            slow: at - startedAt > rooms.readWaitMs,
          });
          return names;
        })
        .finally(() => {
          if (nameListings.get(rooms) === started) nameListings.delete(rooms);
        }),
    };
    // a lookup that got its answer elsewhere does not wait for this listing
    started.done.catch(() => undefined);
    shared = started;
    nameListings.set(rooms, shared);
  }
  const { done } = shared;
  const now = Date.now();
  const last = lastNames.get(rooms);
  if (last?.slow && last.names && now - last.at <= SLOW_LISTING_MAX_AGE_MS)
    return { answered: null, finished: done, earlier: { names: last.names, ageMs: now - last.at } };
  const waits = !shared.late && deadline > now;
  if (await settlesBefore(done, waits ? deadline : now)) return { answered: await done, finished: done };
  if (waits) shared.late = true;
  return { answered: null, finished: done };
}
