import { signal, effect } from '@preact/signals';
import { colorForName } from '@3d-editor/core';

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
    /** Connect to the real-time sync server (same origin by default). */
    enabled: boolean;
    /** Optional custom server origin, e.g. https://editor.example.com (empty = same origin). */
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

function load(): Preferences {
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
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.value));
  } catch {
    /* storage full or unavailable */
  }
});

export function updatePrefs(fn: (p: Preferences) => Preferences): void {
  prefs.value = fn(structuredClone(prefs.value));
}
