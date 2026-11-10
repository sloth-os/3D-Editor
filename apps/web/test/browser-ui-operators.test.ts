import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  BROWSER_UI_OPERATORS,
  FrameState,
  SceneDoc,
  createFCurve,
  createOperatorRegistry,
  fcurveKey,
  insertKeyframe,
} from '@3d-editor/core';
import { registry, viewport } from '../src/editor/editor';
import { registerUiOperators } from '../src/editor/ui-operators';
import { runOperator } from '../src/editor/runner';
import { serverConfig, session, toasts } from '../src/app/store';
import { defaultPreferences, prefs } from '../src/app/prefs';
import { ProjectSession } from '../src/project/session';
import { viewportCamera } from '../src/render/view';
import { DEFAULT_POSE } from '../src/viewport/navigation';
import type { ViewportEngine } from '../src/viewport/engine';

/*
 * The MCP server has no UI-only operators: for an id of BROWSER_UI_OPERATORS, run_operator, batch
 * and edit_mesh tell the agent to run it in a live editor (editor_command run_operator) instead of
 * answering "unknown operator". The list in packages/core must therefore name exactly the
 * operators the web app registers for its UI.
 */

describe('BROWSER_UI_OPERATORS (packages/core)', () => {
  it('lists exactly the UI-only operators the web app registers', () => {
    // the registry of the web app, set up as main.tsx does
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    const registered = registry
      .list()
      .filter((d) => d.uiOnly)
      .map((d) => d.id)
      .sort();
    expect(registered.length).toBeGreaterThan(30);
    expect([...BROWSER_UI_OPERATORS].sort()).toEqual(registered);
  });

  it('names no operator of the headless registry, and each id once', () => {
    const headless = createOperatorRegistry();
    expect(BROWSER_UI_OPERATORS.filter((id) => headless.has(id))).toEqual([]);
    expect(new Set(BROWSER_UI_OPERATORS).size).toBe(BROWSER_UI_OPERATORS.length);
  });
});

describe('render.render', () => {
  it('says that {animation: true} only opens the Render Animation window (Dialogs.tsx)', () => {
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    const def = registry.get('render.render')!;
    // the still renders as the window opens; the animation window waits for its Render button
    expect(def.description).toContain('Open the Render window and render the scene there at once (F12)');
    expect(def.description).toContain(
      'animation=true opens the Render Animation window instead (Ctrl+F12), which renders nothing until ' +
        'its Render button is pressed',
    );
    expect(def.description).not.toMatch(/animation=true renders/);
    const animation = (def.schema as unknown as { shape: Record<string, { description?: string }> }).shape
      .animation;
    expect(animation.description).toBe(
      'Open the Render Animation window (Ctrl+F12) instead of rendering a still image; it renders nothing ' +
        'until its Render button is pressed',
    );
  });
});

describe('view3d.toggle_xray', () => {
  it('says where X-ray sees through: Solid shading, and the Edit Mode cage and selection', () => {
    // the menu tooltip and F3 search show this; Material Preview and Rendered draw objects as they
    // are with X-ray on (engine.ts sync, scene-objects.ts setXray), like Blender's. In Edit Mode a
    // face click picks the front face either way (picking.ts pickFace); in Object Mode a click picks
    // the front object and a box selects every object in it either way (interaction.ts,
    // picking.ts objectsInRect)
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    expect(registry.get('view3d.toggle_xray')!.description).toBe(
      'See through objects in Solid shading (Wireframe always does; Material Preview and Rendered draw them ' +
        'as they are); in Edit Mode the cage shows through and box selections and clicks on vertices or ' +
        'edges also select hidden elements (a click on a face picks the front one). Selecting objects ' +
        'works the same with it on or off (Alt+Z).',
    );
  });
});

/*
 * Save (Ctrl+S) shows what the save did (ProjectSession.flush, WebDAVSync.save): it used to say
 * "Saved to WebDAV" also when saving there failed.
 */
describe('wm.save_mainfile', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await session.value?.close(false);
    session.value = null;
  });

  /** Opens a new project in this browser; `webdav`: it also saves to https://dav.test/. */
  async function openProject(id: string, webdav: boolean): Promise<void> {
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    serverConfig.value = null;
    const d = defaultPreferences();
    prefs.value = {
      ...d,
      storage: webdav
        ? { mode: 'webdav', webdav: { ...d.storage.webdav, url: 'https://dav.test/', basePath: '/' } }
        : { ...d.storage, mode: 'browser' },
    };
    session.value = await ProjectSession.open(id, {
      initial: SceneDoc.create({ name: 'Saved', empty: true }),
    });
  }

  /** Runs Save and returns the toast it shows. */
  async function save() {
    toasts.value = [];
    expect(runOperator(session.value!, registry, 'wm.save_mainfile', {}).ok).toBe(true);
    await vi.waitFor(() => expect(toasts.value).toHaveLength(1));
    const [{ level, message }] = toasts.value;
    return { level, message };
  }

  it('says that saving to WebDAV failed, and why', async () => {
    // a WebDAV server that has no room left: the project's folders are made, its document is refused
    vi.stubGlobal(
      'fetch',
      async (_input: string, init: RequestInit = {}) =>
        new Response(null, { status: init.method === 'PUT' ? 507 : init.method === 'MKCOL' ? 201 : 404 }),
    );
    await openProject('p-save-failed', true);
    expect(await save()).toEqual({
      level: 'error',
      message:
        'Not saved to WebDAV (PUT /projects/p-save-failed/document.ybin failed: 507). The project is saved in this browser.',
    });
  });

  it('says that the project is saved in this browser when it has no WebDAV storage', async () => {
    await openProject('p-save-browser', false);
    expect(await save()).toEqual({ level: 'info', message: 'Saved in this browser' });
  });
});

/*
 * Align Active Camera to View puts the camera where the view is, as the scene shows it at the
 * current frame: in the space of its parent there (Blender's ED_view3d_to_object reads the
 * evaluated parent), keeping an animated channel it changes by keying it at the frame.
 */
describe('view3d.camera_to_view', () => {
  afterEach(async () => {
    viewport.engine = null;
    await session.value?.close(false);
    session.value = null;
  });

  it('puts the camera on the view under an animated parent, keying its animated location', async () => {
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    serverConfig.value = null;
    const d = defaultPreferences();
    prefs.value = { ...d, storage: { ...d.storage, mode: 'browser' } };
    session.value = await ProjectSession.open('p-camera-to-view', {
      initial: SceneDoc.create({ name: 'Camera', empty: true }),
    });
    const s = session.value!;
    const doc = s.doc;
    const parent = doc.addObject({ type: 'EMPTY', name: 'Rig' });
    const cam = doc.addObject({ type: 'CAMERA', name: 'Camera', parent, location: [0, -5, 1] });
    doc.updateScene({ camera: cam });
    const animate = (id: string, index: number, from: number, to: number) => {
      let fc = createFCurve({ target_type: 'object', target_id: id, path: 'location', index });
      fc = insertKeyframe(fc, 1, from, 'LINEAR');
      fc = insertKeyframe(fc, 11, to, 'LINEAR');
      doc.setFCurve(fc);
    };
    animate(parent, 0, 0, 10);
    animate(cam, 2, 1, 3);
    s.state.frame = 6;
    const pose = { ...DEFAULT_POSE(), target: new THREE.Vector3(1, 2, 0.5) };
    viewport.engine = { pose, width: 800, height: 600 } as unknown as ViewportEngine;
    expect(runOperator(s, registry, 'view3d.camera_to_view', {}).ok).toBe(true);
    const view = viewportCamera(pose, 800 / 600).matrixWorld.toArray();
    const shown = new FrameState(doc, 6).world(cam)!;
    expect(Math.max(...shown.map((v, i) => Math.abs(v - view[i])))).toBeLessThan(1e-9);
    // the animated Z location is keyed at frame 6 with the value that puts the camera there
    const key = doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: cam, path: 'location', index: 2 }))!
      .keyframes.find((k) => k.frame === 6)!;
    expect(key.value).toBeCloseTo(view[14], 9);
  });

  it('keys an animated rotation on the turn it shows, beyond a full turn', async () => {
    // the camera's Z rotation shows 2π + 0.2 at frame 6: the view's rotation is keyed as the angle
    // closest to that, not the same angle a whole turn back
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    serverConfig.value = null;
    const d = defaultPreferences();
    prefs.value = { ...d, storage: { ...d.storage, mode: 'browser' } };
    session.value = await ProjectSession.open('p-camera-to-view-turn', {
      initial: SceneDoc.create({ name: 'Camera', empty: true }),
    });
    const s = session.value!;
    const doc = s.doc;
    const cam = doc.addObject({ type: 'CAMERA', name: 'Camera', location: [0, -5, 1] });
    doc.updateScene({ camera: cam });
    let fc = createFCurve({ target_type: 'object', target_id: cam, path: 'rotation_euler', index: 2 });
    fc = insertKeyframe(fc, 1, 2 * Math.PI + 0.1, 'LINEAR');
    fc = insertKeyframe(fc, 11, 2 * Math.PI + 0.3, 'LINEAR');
    doc.setFCurve(fc);
    s.state.frame = 6;
    const pose = { ...DEFAULT_POSE(), target: new THREE.Vector3(1, 2, 0.5) };
    viewport.engine = { pose, width: 800, height: 600 } as unknown as ViewportEngine;
    expect(runOperator(s, registry, 'view3d.camera_to_view', {}).ok).toBe(true);
    const view = viewportCamera(pose, 800 / 600).matrixWorld.toArray();
    const shown = new FrameState(doc, 6).world(cam)!;
    expect(Math.max(...shown.map((v, i) => Math.abs(v - view[i])))).toBeLessThan(1e-9);
    const key = doc
      .getFCurve(fcurveKey({ target_type: 'object', target_id: cam, path: 'rotation_euler', index: 2 }))!
      .keyframes.find((k) => k.frame === 6)!;
    expect(Math.abs(key.value - (2 * Math.PI + 0.2))).toBeLessThan(Math.PI);
  });
});
