import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFileStore } from '@3d-editor/core';
import {
  PROJECT_READ_MAX_AGE_MS,
  PROJECT_READ_WAIT_MS,
  readBeforeAnswer,
} from '../../src/mcp/project-storage';
import type { Room } from '../../src/sync/room';

/*
 * get_project checks storage before it answers (readBeforeAnswer), so that it can say that another
 * writer deleted the project: whether the document is stored (a cheap check), and a full read of
 * the room only when that changed; at most once per PROJECT_READ_MAX_AGE_MS after the room's last
 * read, waiting at most PROJECT_READ_WAIT_MS for storage that does not answer, and not again for a
 * check that is late.
 */

const NOW = 1_000_000;

function store(hasDocument: () => Promise<boolean>) {
  return { hasDocument: vi.fn(hasDocument) } as unknown as ProjectFileStore & {
    hasDocument: ReturnType<typeof vi.fn>;
  };
}

function room(opts: { readAt?: number; stored?: boolean; deleted?: boolean; late?: boolean } = {}) {
  /** The reads of storage for the room that a request stopped waiting for (Room.storageLate). */
  const late = new Set<unknown>(opts.late ? ['readUnused'] : []);
  return {
    id: 'p',
    destroyed: false,
    readAt: opts.readAt ?? 0,
    documentStored: opts.stored ?? true,
    deletedFromStorage: opts.deleted ?? false,
    refresh: vi.fn(async () => undefined),
    get storageLate() {
      return late.size > 0;
    },
    readIsLate: (read: unknown) => late.add(read),
  } as unknown as Room & { refresh: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('readBeforeAnswer (get_project)', () => {
  it('reads the room again when its stored document was deleted elsewhere, or stored again', async () => {
    // deleted by another writer since the room read it: the room reads storage (and learns it)
    const gone = room({ stored: true });
    await readBeforeAnswer(
      gone,
      store(async () => false),
      NOW,
    );
    expect(gone.refresh).toHaveBeenCalledTimes(1);
    // stored again by another writer after the room found it deleted
    const back = room({ stored: false, deleted: true });
    await readBeforeAnswer(
      back,
      store(async () => true),
      NOW,
    );
    expect(back.refresh).toHaveBeenCalledTimes(1);
    // nothing changed: one cheap check, no read of the document
    const same = room({ stored: true });
    const s = store(async () => true);
    await readBeforeAnswer(same, s, NOW);
    expect(s.hasDocument).toHaveBeenCalledWith('p');
    expect(same.refresh).not.toHaveBeenCalled();
  });

  it('checks nothing when the room read storage within PROJECT_READ_MAX_AGE_MS, or without storage', async () => {
    const fresh = room({ readAt: NOW - PROJECT_READ_MAX_AGE_MS + 1 });
    const s = store(async () => false);
    await readBeforeAnswer(fresh, s, NOW);
    expect(s.hasDocument).not.toHaveBeenCalled();
    const memory = room();
    await readBeforeAnswer(memory, null, NOW);
    expect(memory.refresh).not.toHaveBeenCalled();
  });

  it('waits at most PROJECT_READ_WAIT_MS for storage, and not again for that check', async () => {
    const r = room();
    const s = store(() => new Promise<boolean>(() => undefined));
    let answered = false;
    const first = readBeforeAnswer(r, s, NOW).then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(PROJECT_READ_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(answered).toBe(true);
    // other requests that would read the room (opening it while nobody uses it) do not wait either
    expect(r.storageLate).toBe(true);
    // the check goes on; the next get_project neither waits for it nor starts another
    let next = false;
    void readBeforeAnswer(r, s, NOW + PROJECT_READ_WAIT_MS).then(() => {
      next = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toBe(true);
    expect(s.hasDocument).toHaveBeenCalledTimes(1);
  });

  /*
   * Opening a room nobody uses read storage first (RoomManager.readUnused) and stopped waiting for
   * it: get_project then started its own check and waited for it too (10 s, as storage that
   * accepts connections and never answers showed, not the 5 s get_project says it waits).
   */
  it('waits for nothing while another read of the room that a request stopped waiting for goes on', async () => {
    const r = room({ late: true });
    const s = store(() => new Promise<boolean>(() => undefined));
    let answered = false;
    void readBeforeAnswer(r, s, NOW).then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(true);
    expect(s.hasDocument).not.toHaveBeenCalled();
  });

  it('answers after a failed check like after none', async () => {
    const r = room();
    await expect(
      readBeforeAnswer(
        r,
        store(() => Promise.reject(new Error('storage offline'))),
        NOW,
      ),
    ).resolves.toBeUndefined();
    expect(r.refresh).not.toHaveBeenCalled();
  });
});
