import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { signal } from '@preact/signals';
import { cleanup, render } from '@testing-library/preact';
import { SyncStatus } from '../src/ui/App';
import type { ProjectSession } from '../src/project/session';
import type { SyncStatus as Status } from '../src/sync/provider';

// (the service worker's registration is a module of the production build)
vi.mock('../src/pwa/register', () => ({ pwaUpdate: { value: false }, applyPwaUpdate: () => undefined }));

afterEach(() => cleanup());

/** The parts of a ProjectSession the status bar reads: its sync provider and WebDAV storage. */
function session(status: Status, webdav: 'none' | 'via server' | 'direct' = 'none') {
  return {
    provider: { status: signal(status), latencyMs: signal<number | null>(null) },
    peers: signal([]),
    webdav:
      webdav === 'none'
        ? null
        : {
            target: { viaServer: webdav === 'via server' },
            status: signal('synced'),
            error: signal<string | null>(null),
          },
  } as unknown as ProjectSession;
}

function syncStatus(s: ProjectSession): HTMLElement {
  const { getByTestId } = render(h(SyncStatus, { s }));
  return getByTestId('sync-status');
}

describe('SyncStatus (status bar)', () => {
  /*
   * The server deleted the project (it closed the connection with 4404) and the browser no longer
   * connects by itself: the status bar used to say 'Local only' with a grey dot, as for a browser
   * without a server.
   */
  it('says that the server deleted the project, and what the browser does with it', () => {
    const deleted = syncStatus(session('deleted'));
    expect(deleted.dataset.status).toBe('deleted');
    expect(deleted.textContent).toBe('Deleted on server');
    expect(deleted.querySelector('.dot')!.className).toBe('dot err');
    expect(deleted.title).toBe(
      'The server deleted this project. This browser keeps its copy and no longer syncs it with the server. Save (Ctrl+S) or a reload tries the server again.',
    );
    cleanup();
    const direct = syncStatus(session('deleted', 'direct'));
    expect(direct.title).toBe(deleted.title);
    cleanup();
    // WebDAV through the server is the server's storage: a change or Save stores the project there again
    const viaServer = syncStatus(session('deleted', 'via server'));
    expect(viaServer.textContent).toBe('Deleted on server');
    expect(viaServer.title).toBe(
      'The server deleted this project. This browser keeps its copy and stores it on the server again when you change it or save (Ctrl+S).',
    );
  });

  it('says Local only without a server', () => {
    const local = syncStatus(session('disabled'));
    expect(local.textContent).toBe('Local only');
    expect(local.querySelector('.dot')!.className).toBe('dot off');
    expect(local.title).toBe('Real-time sync');
  });
});
