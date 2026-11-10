import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SceneDoc,
  createEditorState,
  createFCurve,
  createOperatorRegistry,
  insertKeyframe,
  type OperatorContext,
} from '@3d-editor/core';
import { ViewportInteraction } from '../src/viewport/interaction';
import type { ViewportEngine } from '../src/viewport/engine';
import type { ProjectSession } from '../src/project/session';

/*
 * The Move, Rotate and Scale tools' gizmo sits on the pivot the transform it starts uses (the one
 * the modal transform rotates and scales about): for Scale the origin of an object with Copy
 * Transforms mixed Before is read with the constraint switched off, as Blender's Scale reads it
 * (constraints_list_needinv), for Move where the constraint shows it.
 */

const reg = createOperatorRegistry();

function setup() {
  const doc = SceneDoc.create({ empty: true });
  const state = createEditorState();
  const ctx: OperatorContext = { doc, state, origin: doc.origin, source: 'test', report: () => undefined };
  const run = (id: string, params?: unknown) => {
    const r = reg.run(ctx, id, params);
    if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
  };
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(3, -8, 6);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const afterRender = new Set<() => void>();
  const engine = {
    camera,
    canvas: document.createElement('canvas'),
    overlay: new THREE.Scene(),
    onAfterRender: afterRender,
    shownPose: { distance: 10 },
    ev: null as unknown,
    requestRender() {},
  };
  const tool = { value: 'move' };
  const session = { doc, state, view: { tool, snapping: { value: false }, hud: { value: null } } };
  const el = document.createElement('div');
  const interaction = new ViewportInteraction(
    engine as unknown as ViewportEngine,
    session as unknown as ProjectSession,
    el,
    { run: () => true, openContextMenu() {} },
  );
  /** Places the gizmo as after a drawn frame; returns where it sits. */
  const gizmoAt = () => {
    for (const f of afterRender) f();
    return (interaction as unknown as { gizmoProxy: THREE.Object3D }).gizmoProxy.position.toArray();
  };
  return { doc, state, run, tool, engine, gizmoAt };
}

describe('the transform gizmo sits on the pivot of the transform it starts', () => {
  it('Move: where the Copy Transforms constraint shows the object; Scale: its origin without the constraint', () => {
    const t = setup();
    const target = t.doc.addObject({ type: 'EMPTY', name: 'T', location: [0, 4, 0] });
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    t.state.selectedIds = [id];
    t.state.activeId = id;
    t.run('object.constraint_add', { type: 'COPY_TRANSFORMS', target, params: { mix_mode: 'BEFORE' } });
    t.tool.value = 'move';
    expect(t.gizmoAt()).toEqual([1, 4, 0]);
    t.tool.value = 'scale';
    expect(t.gizmoAt()).toEqual([1, 0, 0]);
    t.tool.value = 'rotate';
    expect(t.gizmoAt()).toEqual([1, 4, 0]);
  });

  it('moves when the scene is evaluated anew and when the frame changes', () => {
    const t = setup();
    const id = t.doc.addObject({ type: 'EMPTY', name: 'A', location: [1, 0, 0] });
    let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index: 1 });
    fc = insertKeyframe(fc, 1, 0, 'LINEAR');
    fc = insertKeyframe(fc, 11, 10, 'LINEAR');
    t.doc.setFCurve(fc);
    t.state.selectedIds = [id];
    t.state.activeId = id;
    expect(t.gizmoAt()).toEqual([1, 0, 0]);
    // another frame, before the viewport evaluated it
    t.state.frame = 6;
    expect(t.gizmoAt()).toEqual([1, 5, 0]);
    // an edit the viewport evaluated (the document, the selection and the frame stay the same)
    t.doc.updateObject(id, { location: [3, 0, 0] });
    t.engine.ev = {};
    expect(t.gizmoAt()).toEqual([3, 5, 0]);
  });
});
