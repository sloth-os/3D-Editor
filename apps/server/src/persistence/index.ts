import { ProjectFileStore, WebDAVClient } from '@3d-editor/core';
import type { PersistenceMode, ServerConfig } from '../config';
import { DiskFileStore } from './disk';

export { DiskFileStore, etagFor } from './disk';

/** Where room documents are stored (`store` is null in memory mode). */
export interface Persistence {
  mode: PersistenceMode;
  store: ProjectFileStore | null;
  /** Human readable location (never contains credentials). */
  location: string;
  /** Checks that the backend is reachable (used by /readyz). */
  check(): Promise<{ ok: boolean; message?: string }>;
}

/** What a persistence mode means for projects (startup log, get_project). */
export function persistenceNote(mode: PersistenceMode): string {
  switch (mode) {
    case 'disk':
      return 'projects are saved to disk (DATA_DIR) and survive server restarts';
    case 'webdav':
      return 'projects are saved to the WebDAV server and survive server restarts';
    default:
      return (
        'projects are kept in server memory only and are lost when the server stops ' +
        '(browsers keep their own copies); set DATA_DIR or SYNC_PERSISTENCE=disk to save them to disk'
      );
  }
}

export function createPersistence(
  config: Pick<ServerConfig, 'persistence' | 'dataDir' | 'webdav'>,
  fetchImpl?: typeof fetch,
): Persistence {
  if (config.persistence === 'disk') {
    const disk = new DiskFileStore(config.dataDir);
    return {
      mode: 'disk',
      store: new ProjectFileStore(disk, '/'),
      location: disk.root,
      check: () => disk.check(),
    };
  }
  if (config.persistence === 'webdav') {
    const dav = config.webdav;
    if (!dav) throw new Error('WebDAV persistence requires WEBDAV_URL');
    const client = new WebDAVClient(
      { url: dav.url, username: dav.username, password: dav.password, timeoutMs: 30_000 },
      fetchImpl,
    );
    return {
      mode: 'webdav',
      store: new ProjectFileStore(client, dav.basePath || '/'),
      location: `${dav.url}${dav.basePath}`,
      check: () => client.check(),
    };
  }
  return { mode: 'memory', store: null, location: 'memory', check: async () => ({ ok: true }) };
}
