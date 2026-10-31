import { signal } from '@preact/signals';
import { createOperatorRegistry, type OperatorSource, type RunResult } from '@3d-editor/core';
import { session, toast } from '../app/store';
import { runOperator } from './runner';
import type { ViewportEngine } from '../viewport/engine';
import type { ViewportInteraction } from '../viewport/interaction';

/** The global operator registry: core (headless) operators plus UI-only operators. */
export const registry = createOperatorRegistry();

/** Live viewport (set by the Viewport component). */
export const viewport = {
  engine: null as ViewportEngine | null,
  interaction: null as ViewportInteraction | null,
};

/** Which area the pointer is over (keymaps are area specific, like Blender). */
export type AreaKind = 'viewport' | 'outliner' | 'properties' | 'timeline' | 'console' | 'other';
export const hoveredArea = signal<AreaKind>('viewport');

/** Popup menu request (rendered by the PopupMenu host). */
export const popupMenu = signal<{ name: string; x: number; y: number } | null>(null);
export const paletteOpen = signal(false);

export function run(id: string, params?: unknown, source: OperatorSource = 'ui'): boolean {
  return runResult(id, params, source)?.ok ?? false;
}

export function runResult(id: string, params?: unknown, source: OperatorSource = 'ui'): RunResult | null {
  const s = session.value;
  if (!s) {
    toast('Open a project first', 'warning');
    return null;
  }
  return runOperator(s, registry, id, params, source);
}

/** Whether an operator could run now (for greying out menu items). */
export function canRun(id: string): boolean {
  const s = session.value;
  if (!s || !registry.has(id)) return false;
  return (
    registry.poll(
      {
        doc: s.doc,
        state: s.state,
        origin: s.doc.origin,
        source: 'ui',
        report: () => undefined,
        ui: {},
      },
      id,
    ) === true
  );
}
