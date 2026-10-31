import { signal } from '@preact/signals';
import { telemetry } from '../telemetry/telemetry';

/** True when a new service worker is waiting to activate. */
export const pwaUpdate = signal(false);
export const offlineReady = signal(false);
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;

export async function registerPWA(): Promise<void> {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
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
