import { signal } from '@preact/signals';
import type { Workbox, WorkboxLifecycleEvent } from 'workbox-window';
import { appBaseUrl } from '../app/base-url';
import { telemetry } from '../telemetry/telemetry';
import { sayWhyUpdateWaits } from './update-waits';

/** True when a new service worker is waiting to activate. */
export const pwaUpdate = signal(false);
export const offlineReady = signal(false);
let updateSW: (() => void) | null = null;

/**
 * The editor's service worker: the build's sw.js of the app's base, with the base as its scope, as
 * absolute URLs (the desk registers the same: embed/pwa.ts). Workbox tells its own worker from one
 * another page installed by comparing script URLs resolved against the page's address, not its
 * base: given the build's relative ./sw.js, the editor at a deeper path of its base (the server's
 * /desk/ or /desk.html/, any path the server answers with the editor) took its own worker for
 * another page's and offered an update that was none, which Update could not apply.
 */
export function editorServiceWorker(base: string = appBaseUrl()): { scriptURL: string; scope: string } {
  return { scriptURL: new URL('sw.js', base).href, scope: base };
}

/**
 * Wires the editor's update prompt to a Workbox as vite-plugin-pwa's registerSW does for
 * registerType 'prompt': a version that waits, or that another page installed, is offered as an
 * update (pwaUpdate); the first install says that the app works offline (offlineReady); once Update
 * made the waiting version take over, the page reloads. Returns what Update calls.
 */
export function promptForUpdates(
  wb: Pick<Workbox, 'addEventListener' | 'messageSkipWaiting'>,
  reload: () => void = () => window.location.reload(),
): () => void {
  let offered = false;
  const offerUpdate = () => {
    if (!offered)
      wb.addEventListener('controlling', (event) => {
        if (event.isUpdate) reload();
      });
    offered = true;
    pwaUpdate.value = true;
    telemetry.count('editor.pwa.update_available');
  };
  const sayOfflineReady = () => {
    offlineReady.value = true;
    telemetry.count('editor.pwa.offline_ready');
  };
  wb.addEventListener('installed', (event: WorkboxLifecycleEvent) => {
    if (event.isUpdate === undefined) {
      if (event.isExternal) offerUpdate();
      else if (!offered) sayOfflineReady();
    } else if (!event.isUpdate) sayOfflineReady();
  });
  wb.addEventListener('waiting', offerUpdate);
  return () => wb.messageSkipWaiting();
}

/**
 * Registers the service worker for the editor (the desk registers it itself: embed/pwa.ts): the
 * base's sw.js with the base as its scope (editorServiceWorker), so the app's base and its sw.js
 * under a subpath (docs/subpath.md). A new version waits (pwaUpdate) until Update asks it to take
 * over; while a desk page is open in this browser it answers that it keeps waiting, and the editor
 * says why (update-waits.ts).
 */
export async function registerPWA(): Promise<void> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  sayWhyUpdateWaits(navigator.serviceWorker);
  try {
    const { Workbox } = await import('workbox-window');
    const { scriptURL, scope } = editorServiceWorker();
    const wb = new Workbox(scriptURL, { scope, type: 'classic' });
    updateSW = promptForUpdates(wb);
    await wb.register({ immediate: true });
  } catch (err) {
    telemetry.log('WARN', `service worker registration failed: ${String(err)}`);
  }
}

export function applyPwaUpdate(): void {
  updateSW?.();
}
