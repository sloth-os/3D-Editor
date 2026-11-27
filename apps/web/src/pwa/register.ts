import { signal } from '@preact/signals';
import { telemetry } from '../telemetry/telemetry';
import { sayWhyUpdateWaits } from './update-waits';

/** True when a new service worker is waiting to activate. */
export const pwaUpdate = signal(false);
export const offlineReady = signal(false);
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

/**
 * Registers the service worker for the editor (the desk registers it itself: embed/pwa.ts). A new
 * version waits (pwaUpdate) until Update asks it to take over; while a desk page is open in this
 * browser it answers that it keeps waiting, and the editor says why (update-waits.ts).
 */
export async function registerPWA(): Promise<void> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  sayWhyUpdateWaits(navigator.serviceWorker);
  try {
    const { registerSW } = await import('virtual:pwa-register');
    updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        pwaUpdate.value = true;
        telemetry.count('editor.pwa.update_available');
      },
      onOfflineReady() {
        offlineReady.value = true;
        telemetry.count('editor.pwa.offline_ready');
      },
      onRegisterError(err: unknown) {
        telemetry.log('WARN', `service worker registration failed: ${String(err)}`);
      },
    });
  } catch (err) {
    console.warn('PWA registration unavailable', err);
  }
}

export function applyPwaUpdate(): void {
  void updateSW?.(true);
}
