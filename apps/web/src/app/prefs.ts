import { signal, effect } from '@preact/signals';
import { colorForName } from '@3d-editor/core';
import { isDeskRuntime } from './runtime';

export type StorageMode = 'auto' | 'browser' | 'webdav';

export interface Preferences {
  userName: string;
  userColor: string;
  storage: {
    /** auto: use the server's WebDAV proxy when available, else the browser. */
    mode: StorageMode;
    webdav: { url: string; username: string; password: string; basePath: string };
  };
  sync: {
    /** Connect to the real-time sync server (the editor server the page came from by default). */
    enabled: boolean;
    /**
     * Optional URL of the editor server to use, with its path where it has one, e.g.
     * https://editor.example.com or https://example.com/3d (empty: the server the page came from,
     * under the app's base; app/base-url.ts serverBaseUrl).
     */
    serverUrl: string;
    token: string;
  };
  telemetry: boolean;
  ui: {
    emulate3Button: boolean;
    invertZoom: boolean;
    showStats: boolean;
    orbitSensitivity: number;
  };
}

const KEY = '3d-editor:prefs:v1';

function randomName(): string {
  const adjectives = ['Swift', 'Calm', 'Bright', 'Quiet', 'Bold', 'Clever', 'Lucky', 'Gentle'];
  const nouns = ['Otter', 'Falcon', 'Maple', 'Comet', 'Lynx', 'Cedar', 'Heron', 'Pixel'];
  const a = adjectives[Math.floor(Math.random() * adjectives.length)];
  const n = nouns[Math.floor(Math.random() * nouns.length)];
  return `${a} ${n}`;
}

export function defaultPreferences(): Preferences {
  const name = randomName();
  return {
    userName: name,
    userColor: colorForName(name),
    storage: { mode: 'auto', webdav: { url: '', username: '', password: '', basePath: '/3d-editor' } },
    sync: { enabled: true, serverUrl: '', token: '' },
    telemetry: true,
    ui: { emulate3Button: true, invertZoom: false, showStats: true, orbitSensitivity: 1 },
  };
}

/**
 * The embeddable desk's preferences (desk.html): the defaults with storage in the browser only, no
 * sync and no telemetry. It neither reads nor writes the editor's preferences (KEY): it is another
 * application on the same origin, and a host's desk must not change how the editor syncs.
 */
export function deskPreferences(): Preferences {
  const d = defaultPreferences();
  return {
    ...d,
    storage: { ...d.storage, mode: 'browser' },
    sync: { ...d.sync, enabled: false },
    telemetry: false,
  };
}

function load(): Preferences {
  if (isDeskRuntime()) return deskPreferences();
  const d = defaultPreferences();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<Preferences>;
    return {
      ...d,
      ...p,
      storage: { ...d.storage, ...p.storage, webdav: { ...d.storage.webdav, ...p.storage?.webdav } },
      sync: { ...d.sync, ...p.sync },
      ui: { ...d.ui, ...p.ui },
    };
  } catch {
    return d;
  }
}

export const prefs = signal<Preferences>(load());

effect(() => {
  // the desk keeps its preferences for the page's life only (see deskPreferences)
  if (isDeskRuntime()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.value));
  } catch {
    /* storage full or unavailable */
  }
});

export function updatePrefs(fn: (p: Preferences) => Preferences): void {
  prefs.value = fn(structuredClone(prefs.value));
}
