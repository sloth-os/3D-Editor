import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SceneDoc, createOperatorRegistry } from '@3d-editor/core';
import { runOperator, redoLast, lastOperator, infoLog } from '../src/editor/runner';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return { doc, undo, state: new EditorStateSignals(), view: new ViewState() } as unknown as ProjectSession;
}

describe('operator runner', () => {
  it('creates one undo step per operator and logs reports', () => {
    const s = fakeSession();
    const reg = createOperatorRegistry();
    expect(runOperator(s, reg, 'mesh.primitive_cube_add', {}, 'test').ok).toBe(true);
    expect(runOperator(s, reg, 'mesh.primitive_uv_sphere_add', { segments: 8 }, 'test').ok).toBe(true);
    expect(s.undo.undoStack.length).toBe(2);
    expect(infoLog.value.at(-1)?.message).toBe('Sphere');
    s.undo.undo();
    expect(s.doc.listObjects().map((o) => o.name)).toEqual(['Cube']);
  });

  it('re-runs the last operator with new parameters (Adjust Last Operation)', () => {
    const s = fakeSession();
    const reg = createOperatorRegistry();
    runOperator(s, reg, 'mesh.primitive_cube_add', { size: 2 }, 'test');
    expect(lastOperator.value?.id).toBe('mesh.primitive_cube_add');
    const r = redoLast(s, reg, { size: 4 });
    expect(r?.ok).toBe(true);
    const objs = s.doc.listObjects();
    expect(objs).toHaveLength(1);
    const xs = s.doc.getMesh(objs[0].data!)!.positions.filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeCloseTo(2);
    expect(s.undo.undoStack.length).toBe(1);
  });

  it('restores the pre-operator selection when re-running', () => {
    const s = fakeSession();
    const reg = createOperatorRegistry();
    runOperator(s, reg, 'mesh.primitive_cube_add', {}, 'test');
    runOperator(s, reg, 'object.duplicate', { offset: [2, 0, 0] }, 'test');
    expect(s.doc.listObjects()).toHaveLength(2);
    expect(redoLast(s, reg, { offset: [5, 0, 0] })?.ok).toBe(true);
    const copy = s.doc.listObjects().find((o) => o.name === 'Cube.001')!;
    expect(copy.location[0]).toBeCloseTo(5);
    expect(s.doc.listObjects()).toHaveLength(2);
  });

  it('reports failures without throwing', () => {
    const s = fakeSession();
    const reg = createOperatorRegistry();
    const r = runOperator(s, reg, 'object.join', {}, 'test');
    expect(r.ok).toBe(false);
    expect(infoLog.value.at(-1)?.level).toBe('ERROR');
  });
});
