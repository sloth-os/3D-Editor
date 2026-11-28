import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toasts } from '../src/app/store';
import { editorServiceWorker, offlineReady, promptForUpdates, pwaUpdate } from '../src/pwa/register';
import { UPDATE_WAITS_FOR_DESK } from '../src/pwa/sw-desk';
import { sayWhyUpdateWaits } from '../src/pwa/update-waits';

/*
 * The editor's side of the answer to its Update (src/pwa/update-waits.ts, wired to the page's
 * ServiceWorkerContainer by register.ts registerPWA): when the waiting version answers that a desk
 * page open in this browser keeps it waiting (sw.ts, sw-desk.ts answerSkipWaiting), the editor says
 * so instead of seeming to ignore the click (docs/storage-and-sync.md "Offline / PWA",
 * docs/embedding.md "Offline"). e2e/tests/desk-partition.spec.ts presses Update in Chromium.
 */

const NOTE = "A director's desk is open in this browser; close it to update";

/** The page's ServiceWorkerContainer: the service worker's messages arrive on it. */
let container: EventTarget;
const fromServiceWorker = (data: unknown) => container.dispatchEvent(new MessageEvent('message', { data }));

beforeEach(() => {
  container = new EventTarget();
  sayWhyUpdateWaits(container);
  toasts.value = [];
});

describe("the editor's Update while a director's desk is open", () => {
  it('says why the update waits when the service worker answers so', () => {
    fromServiceWorker({ type: UPDATE_WAITS_FOR_DESK });
    expect(toasts.value.map((t) => [t.message, t.level])).toEqual([[NOTE, 'warning']]);
  });

  it('says nothing for other messages of the service worker', () => {
    fromServiceWorker({ type: 'SKIP_WAITING' });
    fromServiceWorker({ type: 'CACHE_UPDATED' });
    fromServiceWorker(null);
    fromServiceWorker('UPDATE_WAITS_FOR_DESK');
    expect(toasts.value).toEqual([]);
  });
});

/*
 * The editor's registration (register.ts): the base's sw.js with the base as its scope, as absolute
 * URLs, and the update prompt vite-plugin-pwa's registerSW wires for registerType 'prompt'. Workbox
 * tells its own worker from another page's by resolving the URL it was given against the page's
 * address: the build's relative ./sw.js made the editor at a deeper path (the server's /desk/,
 * /desk.html/ or any other path it answers with the editor) offer an update that was none
 * (e2e/tests/subpath.spec.ts checks that page in Chromium).
 */
describe("the editor's service worker registration", () => {
  it("registers the base's sw.js with the base as its scope, as absolute URLs whatever the page's path", () => {
    expect(editorServiceWorker('http://host.test/')).toEqual({
      scriptURL: 'http://host.test/sw.js',
      scope: 'http://host.test/',
    });
    expect(editorServiceWorker('https://site.test/3d/')).toEqual({
      scriptURL: 'https://site.test/3d/sw.js',
      scope: 'https://site.test/3d/',
    });
    // Workbox resolves the URL it registered against the page's address to recognise its worker:
    // absolute, it is the worker's own URL on a page at a deeper path too; the relative ./sw.js was not
    const { scriptURL } = editorServiceWorker('https://site.test/3d/');
    for (const page of ['https://site.test/3d/', 'https://site.test/3d/desk/', 'https://site.test/3d/x/y'])
      expect(new URL(scriptURL, page).href, page).toBe('https://site.test/3d/sw.js');
    expect(new URL('./sw.js', 'https://site.test/3d/desk/').href).not.toBe('https://site.test/3d/sw.js');
  });

  /** A Workbox as promptForUpdates uses it: its lifecycle events, and Update's message. */
  function fakeWorkbox() {
    const listeners = new Map<string, ((event: { isUpdate?: boolean; isExternal?: boolean }) => void)[]>();
    const wb = {
      addEventListener: (
        type: string,
        listener: (event: { isUpdate?: boolean; isExternal?: boolean }) => void,
      ) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      messageSkipWaiting: vi.fn(),
    };
    const fire = (type: string, event: { isUpdate?: boolean; isExternal?: boolean } = {}) =>
      (listeners.get(type) ?? []).forEach((listener) => listener(event));
    return {
      wb: wb as unknown as Parameters<typeof promptForUpdates>[0],
      fire,
      messageSkipWaiting: wb.messageSkipWaiting,
    };
  }

  beforeEach(() => {
    pwaUpdate.value = false;
    offlineReady.value = false;
  });

  it('says the editor works offline once its own worker is installed, and offers no update', () => {
    const { wb, fire } = fakeWorkbox();
    const reload = vi.fn();
    promptForUpdates(wb, reload);
    fire('installed', { isExternal: false });
    expect([pwaUpdate.value, offlineReady.value]).toEqual([false, true]);
    fire('controlling', { isUpdate: false });
    expect(reload).not.toHaveBeenCalled();
  });

  it('offers a waiting version, or one another page installed, as an update; Update makes it take over and the page reloads', () => {
    for (const { type, event } of [
      { type: 'waiting', event: {} },
      { type: 'installed', event: { isExternal: true } },
    ]) {
      pwaUpdate.value = false;
      offlineReady.value = false;
      const { wb, fire, messageSkipWaiting } = fakeWorkbox();
      const reload = vi.fn();
      const update = promptForUpdates(wb, reload);
      fire(type, event);
      expect([pwaUpdate.value, offlineReady.value], type).toEqual([true, false]);
      update();
      expect(messageSkipWaiting, type).toHaveBeenCalledTimes(1);
      fire('controlling', { isUpdate: true });
      expect(reload, type).toHaveBeenCalledTimes(1);
    }
  });

  it('says nothing for an update the page itself installed until it waits', () => {
    const { wb, fire } = fakeWorkbox();
    promptForUpdates(wb, vi.fn());
    fire('installed', { isUpdate: true });
    expect([pwaUpdate.value, offlineReady.value]).toEqual([false, false]);
    fire('installed', { isUpdate: false });
    expect([pwaUpdate.value, offlineReady.value]).toEqual([false, true]);
  });
});
