import { signal, computed } from '@preact/signals';
import type { ServerConfig } from './server-config';
import type { ProjectSession } from '../project/session';

export const serverConfig = signal<ServerConfig | null>(null);
export const serverChecked = signal(false);
export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine);
export const session = signal<ProjectSession | null>(null);

export type Workspace = 'Layout' | 'Modeling' | 'Shading' | 'Animation' | 'Scripting' | 'Director';
export const workspace = signal<Workspace>('Layout');

export type DialogKind = 'projects' | 'preferences' | 'export' | 'about' | 'shortcuts' | 'render' | null;
export const dialog = signal<DialogKind>(null);
export const dialogProps = signal<Record<string, unknown>>({});

export function openDialog(kind: Exclude<DialogKind, null>, props: Record<string, unknown> = {}): void {
  dialogProps.value = props;
  dialog.value = kind;
}
export function closeDialog(): void {
  dialog.value = null;
}

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;
export function toast(message: string, level: Toast['level'] = 'info', ms = 3500): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, level, message }].slice(-6);
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, ms);
}

/** True when the WebDAV backend should be used for persistence. */
export const hasServer = computed(() => !!serverConfig.value);

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => (online.value = true));
  window.addEventListener('offline', () => (online.value = false));
}
