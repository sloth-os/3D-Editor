import { onCLS, onINP, onLCP, onFCP, onTTFB } from 'web-vitals';
import { telemetry } from './telemetry';
import { prefs } from '../app/prefs';
import { serverConfig } from '../app/store';
import { apiUrl, authHeaders } from '../app/server-config';

/** Wires telemetry: resource attributes, global error capture and web vitals. */
export function setupTelemetry(): void {
  const ua = navigator.userAgent;
  telemetry.configure({
    endpoint: apiUrl('/otlp').replace(/\?.*$/, ''),
    headers: authHeaders,
    enabled: () => prefs.value.telemetry && !!serverConfig.value?.features.telemetry,
    resource: {
      'service.name': '3d-editor-web',
      'service.version': typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev',
      'browser.mobile': /Mobi|Android/i.test(ua),
      'browser.language': navigator.language,
      'display.width': screen.width,
      'display.height': screen.height,
      'device.pixel_ratio': devicePixelRatio,
      'app.installed': matchMedia('(display-mode: standalone)').matches,
    },
  });
  window.addEventListener('error', (e) => {
    telemetry.log('ERROR', e.message || 'error', {
      'error.source': 'window.onerror',
      'code.filepath': e.filename?.split('/').pop(),
      'code.lineno': e.lineno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    telemetry.log('ERROR', r instanceof Error ? r.message : String(r), {
      'error.source': 'unhandledrejection',
    });
  });
  const vital = (name: string) => (m: { value: number; rating?: string }) =>
    telemetry.gauge(`web_vitals.${name}`, m.value, { rating: m.rating ?? 'unknown' });
  onCLS(vital('cls'));
  onINP(vital('inp'));
  onLCP(vital('lcp'));
  onFCP(vital('fcp'));
  onTTFB(vital('ttfb'));
}
