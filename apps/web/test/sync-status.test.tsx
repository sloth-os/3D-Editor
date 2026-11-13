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
function session(
  status: Status,
  webdav: 'none' | 'via server' | 'direct' = 'none',
  refusal: { message: string; load: boolean } | null = null,
) {
  return {
    provider: { status: signal(status), latencyMs: signal<number | null>(null), refusal: signal(refusal) },
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

  /*
   * The server did not take this browser's changes for memory (it closed the connection with 4507
   * after an error that says why) and the browser no longer connects by itself: the status bar says
   * so, as for a deletion, with the server's reason and what the browser does.
   */
  it("says that the project is too large for the server, with the server's reason", () => {
    const why = { message: 'changes not applied on the server: they add 50 new objects (test)', load: false };
    const refused = syncStatus(session('refused', 'none', why));
    expect(refused.dataset.status).toBe('refused');
    expect(refused.textContent).toBe('Too large for server');
    expect(refused.querySelector('.dot')!.className).toBe('dot err');
    expect(refused.title).toBe(
      'The server did not take this project: changes not applied on the server: they add 50 new objects (test). ' +
        'This browser keeps the project with your changes (in this browser, in its other tabs and in WebDAV when it ' +
        'saves there) and no longer syncs it with the server; Save (Ctrl+S) or a reload sends it to the server again.',
    );
    cleanup();
    // WebDAV through the server is the server's storage: it gets nothing the server did not take
    expect(syncStatus(session('refused', 'via server', why)).title).toBe(
      'The server did not take this project: changes not applied on the server: they add 50 new objects (test). ' +
        'This browser keeps the project with your changes (in this browser and in its other tabs) and no longer ' +
        'syncs it with the server, nor saves it to WebDAV through the server; Save (Ctrl+S) or a reload sends it ' +
        'to the server again.',
    );
  });

  /* A stored project the server cannot load: the browser may hold nothing of it, and no changes. */
  it('says that the server did not open a stored project it cannot load, with its reason', () => {
    const refused = syncStatus(
      session('refused', 'via server', {
        message: "project 'Huge' (p1) was not loaded on the server: it would not fit (test)",
        load: true,
      }),
    );
    expect(refused.textContent).toBe('Too large for server');
    expect(refused.title).toBe(
      "The server did not open this project: project 'Huge' (p1) was not loaded on the server: it would not fit " +
        '(test). This browser shows what it holds of the project (in this browser, or from WebDAV) and does not ' +
        'sync it with the server; Save (Ctrl+S) or a reload asks the server to open it again.',
    );
  });

  it('says Local only without a server', () => {
    const local = syncStatus(session('disabled'));
    expect(local.textContent).toBe('Local only');
    expect(local.querySelector('.dot')!.className).toBe('dot off');
    expect(local.title).toBe('Real-time sync');
  });
});
