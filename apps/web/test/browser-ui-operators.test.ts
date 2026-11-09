import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_UI_OPERATORS, SceneDoc, createOperatorRegistry } from '@3d-editor/core';
import { registry } from '../src/editor/editor';
import { registerUiOperators } from '../src/editor/ui-operators';
import { runOperator } from '../src/editor/runner';
import { serverConfig, session, toasts } from '../src/app/store';
import { defaultPreferences, prefs } from '../src/app/prefs';
import { ProjectSession } from '../src/project/session';

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
