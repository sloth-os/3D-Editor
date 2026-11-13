import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import { signal } from '@preact/signals';
import { SceneDoc, SceneEvaluator } from '@3d-editor/core';
import { session as sessionSignal } from '../src/app/store';
import { runResult } from '../src/editor/editor';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import { Properties, activePropertiesTab } from '../src/ui/properties/Properties';

/*
 * Widths in the Properties editor, checked through the editor's real stylesheet (happy-dom resolves
 * the cascade but does no layout; the pixel widths were measured in Chromium at 1600x900):
 *  - a property row's value column never grows past the row, and drop-downs never get wider than
 *    it (the Add IK form's Target select listed long object names and stuck out of the panel);
 *  - a driver variable's Target and Path rows give the value the width (the Path field showed
 *    'rotation_eu').
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  const revision = signal(0);
  doc.onChange(() => revision.value++);
  return {
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
    evaluator: new SceneEvaluator(doc),
    revision,
    undoRevision: signal(0),
    peers: signal([]),
    currentOperator: null,
  } as unknown as ProjectSession;
}

function ok(id: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  const r = runResult(id, params, 'test');
  if (!r?.ok) throw new Error(`${id} failed: ${r?.error}`);
  return (r.result ?? {}) as Record<string, unknown>;
}

function select(s: ProjectSession, name: string): void {
  const id = s.doc.findObjectByName(name)!.id;
  s.state.selectedIds = [id];
  s.state.activeId = id;
}

const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** The property row (label + value) an element sits in. */
const rowOf = (el: Element) => el.closest('.prop-row') as HTMLElement;

let s: ProjectSession;
beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(__dirname, '../src/ui/styles.css'), 'utf8');
  document.head.appendChild(style);
});
beforeEach(() => {
  localStorage.clear();
  s = fakeSession();
  sessionSignal.value = s;
});
afterEach(() => {
  cleanup();
  sessionSignal.value = null;
});

describe('Properties editor widths', () => {
  it('keeps the Add IK target select inside its row, whatever the object names', () => {
    // regression: the 1fr value column grew to the select's longest option ('Robot_ClampBrackets_Upper'),
    // so the select stuck 41 px out of the form and the window
    ok('object.armature_add', { name: 'Robot_Rig' });
    ok('object.empty_add', { name: 'Robot_ClampBrackets_Upper_Left_Very_Long_Name' });
    select(s, 'Robot_Rig');
    activePropertiesTab.value = 'data';
    const { container } = render(<Properties session={s} />);
    const target = byTestId(container, 'pose-ik-target')!;
    expect(target.tagName).toBe('SELECT');
    const row = rowOf(target);
    expect(getComputedStyle(row).gridTemplateColumns).toBe('40% minmax(0, 1fr)');
    expect(['0', '0px']).toContain(getComputedStyle(target.parentElement!).minWidth);
    expect(getComputedStyle(target).maxWidth).toBe('100%');
    expect(getComputedStyle(target).width).toBe('100%');
    expect(getComputedStyle(target).textOverflow).toBe('ellipsis');
  });

  it('gives a driver variable’s path the width of the row', () => {
    // regression: 'rotation_euler' showed as 'rotation_eu' next to the index field
    ok('mesh.primitive_cube_add', { name: 'Cube' });
    ok('object.empty_add', { name: 'Master Drive' });
    select(s, 'Cube');
    ok('anim.driver_add', {
      target_type: 'object',
      target: 'Cube',
      path: 'rotation_euler',
      index: 2,
      expression: 'var',
      variables: [
        { name: 'var', target_type: 'object', target: 'Master Drive', path: 'rotation_euler', index: 2 },
      ],
    });
    activePropertiesTab.value = 'object';
    localStorage.setItem('3d-editor:panel:object-drivers', '1');
    const { container } = render(<Properties session={s} />);
    const path = byTestId(container, 'driver-rotation_euler-2-var-0-path') as HTMLInputElement;
    expect(path.value).toBe('rotation_euler');
    // the full path and channel on hover
    expect(path.title).toBe('rotation_euler[2]');
    for (const el of [path, byTestId(container, 'driver-rotation_euler-2-var-0-target')!]) {
      const row = rowOf(el);
      expect(row.classList.contains('compact')).toBe(true);
      // the label column is as wide as 'Target' / 'Path', not 40% of the row
      expect(getComputedStyle(row).gridTemplateColumns).toBe('auto minmax(0, 1fr)');
    }
    // the path field takes what the index field leaves
    expect(['0', '0px']).toContain(getComputedStyle(path.parentElement!).minWidth);
    expect(getComputedStyle(path).width).toBe('100%');
    // editing it still sets the variable
    fireEvent.input(path, { target: { value: 'location' } });
    fireEvent.keyDown(path, { key: 'Enter' });
    const cube = s.doc.findObjectByName('Cube')!;
    const d = s.doc.listDrivers(cube.id).find((x) => x.path === 'rotation_euler')!;
    expect(d.variables[0].path).toBe('location');
  });
});
