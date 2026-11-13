import { openDB, type IDBPDatabase } from 'idb';
import type { ProjectInfo } from '@3d-editor/core';

export interface LocalProjectEntry extends ProjectInfo {
  last_opened?: string;
}

const DB_NAME = '3d-editor';
const STORE = 'projects';
let dbp: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbp)
    dbp = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      },
    });
  return dbp;
}

/** Index of projects stored in this browser (documents live in per-project y-indexeddb databases). */
export const localIndex = {
  async list(): Promise<LocalProjectEntry[]> {
    const all = (await (await db()).getAll(STORE)) as LocalProjectEntry[];
    return all.sort((a, b) => (b.last_opened ?? b.updated_at).localeCompare(a.last_opened ?? a.updated_at));
  },
  async get(id: string): Promise<LocalProjectEntry | undefined> {
    return (await (await db()).get(STORE, id)) as LocalProjectEntry | undefined;
  },
  async put(entry: LocalProjectEntry): Promise<void> {
    await (await db()).put(STORE, entry);
  },
  async patch(id: string, patch: Partial<LocalProjectEntry>): Promise<void> {
    const cur = await this.get(id);
    if (cur) await this.put({ ...cur, ...patch });
  },
  async remove(id: string): Promise<void> {
    await (await db()).delete(STORE, id);
  },
};

export function projectDbName(id: string): string {
  return `3d-editor-project-${id}`;
}
