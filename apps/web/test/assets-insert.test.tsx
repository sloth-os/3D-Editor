import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  SceneDoc,
  base64Decode,
  builtinResult,
  exportScene,
  getCatalogEntry,
  type StoreResult,
} from '@3d-editor/core';
import { serverConfig, session as sessionSignal, toasts } from '../src/app/store';
import type { ServerConfig } from '../src/app/server-config';
import { EditorStateSignals, ViewState } from '../src/editor/state';
import type { ProjectSession } from '../src/project/session';
import {
  insertBlocker,
  insertErrorMessage,
  insertFilesParams,
  insertStoreModel,
  insertsInFlight,
  isBuiltinModel,
} from '../src/ui/assets/insert';
import { ApiError } from '../src/io/store-client';

/*
 * Inserting store models from the Asset Browser: built-in models run core store.add, external
 * ones are downloaded through the server's files proxy and inserted with core store.insert_files in
 * the browser, each as one step of the editor's undo history; models that cannot be downloaded
 * (listed only, a missing key, no server) are refused with a message before anything is fetched.
 */

function fakeSession(): ProjectSession {
  const doc = SceneDoc.create({ empty: true });
  const undo = new Y.UndoManager(doc.sharedTypes(), {
    trackedOrigins: new Set([doc.origin]),
    captureTimeout: 0,
  });
  return {
    id: 'insert-test',
    doc,
    undo,
    state: new EditorStateSignals(),
    view: new ViewState(),
  } as unknown as ProjectSession;
}

const SERVER: ServerConfig = {
  version: 'test',
  features: {
    sync: true,
    mcp: true,
    telemetry: false,
    webdavProxy: false,
    modelStore: true,
    videoExport: true,
  },
  webdav: null,
  persistence: 'memory',
};

/** A store result of an external provider. */
function external(over: Partial<StoreResult> = {}): StoreResult {
  return {
    id: 'khronos:Box',
    provider: 'khronos',
    name: 'Box',
    category: 'props',
    tags: [],
    thumbnail_url: '/api/store/models/khronos:Box/thumbnail',
    license: {
      spdx: 'CC-BY-4.0',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      attribution: '“Box” by Someone',
    },
    author: 'Someone',
    source_url: 'https://example.org/box',
    dimensions_m: [0.5, 0.5, 0.5],
    triangles: 12,
    formats: ['glb'],
    downloadable: true,
    ...over,
  };
}

/** A minimal fetch Response (JSON or bytes). */
function response(body: unknown, status = 200): Response {
  const bytes = body instanceof Uint8Array ? body : null;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
    arrayBuffer: async () => bytes!.slice().buffer,
  } as unknown as Response;
}

/** The default scene's cube as a GLB file (2 m). */
function cubeGlb(): Uint8Array {
  const src = SceneDoc.create();
  const cube = src.listObjects().find((o) => o.name === 'Cube')!;
  return exportScene(src, 'glb', { objectIds: [cube.id] }).data;
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const toastText = () => toasts.value.map((t) => `${t.level}: ${t.message}`).join('\n');

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  serverConfig.value = SERVER;
  toasts.value = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionSignal.value = null;
  serverConfig.value = null;
});

describe('inserting store models', () => {
  it('adds a built-in model with store.add at the 3D cursor, as one undo step', async () => {
    const s = fakeSession();
    sessionSignal.value = s;
    s.state.cursorLocation = [1, 2, 0];
    const chair = builtinResult(getCatalogEntry('chair')!);
    expect(isBuiltinModel(chair)).toBe(true);
    const res = await insertStoreModel(chair);
    expect(res?.ok).toBe(true);
    const root = s.doc.getObject((res!.result as { root: string }).root)!;
    expect(root.type).toBe('EMPTY');
    expect(root.location).toEqual([1, 2, 0]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.undo.undoStack).toHaveLength(1);
    expect(toastText()).toContain(`Added ${chair.name}`);
    s.undo.undo();
    expect(s.doc.listObjects()).toHaveLength(0);
  });

  it('puts a built-in model where it is asked to (a drop point)', async () => {
    const s = fakeSession();
    sessionSignal.value = s;
    const res = await insertStoreModel(builtinResult(getCatalogEntry('chair')!), { location: [3, -1, 0.75] });
    const root = s.doc.getObject((res!.result as { root: string }).root)!;
    expect(root.location).toEqual([3, -1, 0.75]);
  });

  it('downloads an external model through the files proxy and inserts it with store.insert_files', async () => {
    const s = fakeSession();
    sessionSignal.value = s;
    const glb = cubeGlb();
    let release!: () => void;
    const fileGate = new Promise<void>((r) => (release = r));
    fetchMock.mockImplementation(async (url) => {
      if (url === '/api/store/models/khronos:Box?download=1')
        return response({
          ...external(),
          description: null,
          license_note: 'credit the author',
          files: [{ path: 'Box.glb', bytes: glb.byteLength }],
          format: 'glb',
          main: 'Box.glb',
        });
      if (url === '/api/store/models/khronos:Box/files/Box.glb') {
        await fileGate;
        return response(glb);
      }
      return response({ error: `unexpected ${url}` }, 404);
    });
    const pending = insertStoreModel(external(), { location: [2, 0, 0] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(insertsInFlight.value.get('khronos:Box')?.phase).toBe('downloading');
    release();
    const res = await pending;
    expect(res?.ok).toBe(true);
    expect(insertsInFlight.value.size).toBe(0);
    const root = s.doc.getObject((res!.result as { root: string }).root)!;
    expect(root.custom_props).toMatchObject({
      store_id: 'khronos:Box',
      license: 'CC-BY-4.0',
      author: 'Someone',
      source_url: 'https://example.org/box',
    });
    expect(root.location).toEqual([2, 0, 0]);
    // the size the provider gives
    expect((res!.result as { dimensions_m: number[] }).dimensions_m).toEqual([0.5, 0.5, 0.5]);
    expect(toastText()).toContain('Downloading Box');
    expect(toastText()).toContain('Added Box');
    // one undo step takes the whole model away
    expect(s.undo.undoStack).toHaveLength(1);
    s.undo.undo();
    expect(s.doc.listObjects()).toHaveLength(0);
  });

  it('downloads every file a glTF names (a few at a time) and passes them to the insert', async () => {
    const s = fakeSession();
    sessionSignal.value = s;
    const src = SceneDoc.create();
    const cube = src.listObjects().find((o) => o.name === 'Cube')!;
    const gltf = JSON.parse(
      new TextDecoder().decode(exportScene(src, 'gltf', { objectIds: [cube.id] }).data),
    ) as {
      buffers: { uri: string }[];
    };
    // the embedded buffer as its own file, as providers serve them
    const bin = base64Decode(gltf.buffers[0].uri);
    gltf.buffers[0].uri = 'cube data.bin';
    const main = new TextEncoder().encode(JSON.stringify(gltf));
    fetchMock.mockImplementation(async (url) => {
      if (url.endsWith('?download=1'))
        return response({
          ...external({ id: 'polyhaven:cube', provider: 'polyhaven', name: 'Cube', formats: ['gltf'] }),
          files: [
            { path: 'cube.gltf', bytes: main.byteLength },
            { path: 'cube data.bin', bytes: bin.byteLength },
          ],
          format: 'gltf',
          main: 'cube.gltf',
        });
      if (url.endsWith('/files/cube.gltf')) return response(main);
      if (url.endsWith('/files/cube%20data.bin')) return response(bin);
      return response({ error: `unexpected ${url}` }, 404);
    });
    const res = await insertStoreModel(
      external({ id: 'polyhaven:cube', provider: 'polyhaven', name: 'Cube', formats: ['gltf'] }),
    );
    expect(res?.ok).toBe(true);
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/store/models/polyhaven:cube?download=1',
      '/api/store/models/polyhaven:cube/files/cube.gltf',
      '/api/store/models/polyhaven:cube/files/cube%20data.bin',
    ]);
    expect(s.doc.listObjects().some((o) => o.type === 'MESH')).toBe(true);
  });

  it('refuses models it cannot download before fetching anything', async () => {
    sessionSignal.value = fakeSession();
    expect(await insertStoreModel(external({ downloadable: false }))).toBeNull();
    expect(toastText()).toMatch(/Box is listed only: khronos does not allow downloading it/);
    expect(
      await insertStoreModel(external({ provider: 'sketchfab', needs_key: 'SKETCHFAB_TOKEN' })),
    ).toBeNull();
    expect(toastText()).toContain('needs SKETCHFAB_TOKEN on the editor server');
    serverConfig.value = null;
    expect(await insertStoreModel(external())).toBeNull();
    expect(toastText()).toContain('inserting it needs the editor server');
    expect(fetchMock).not.toHaveBeenCalled();
    // built-in models need no server
    expect(insertBlocker(builtinResult(getCatalogEntry('chair')!))).toBeNull();
  });

  it("says what the server's refusals mean", async () => {
    sessionSignal.value = fakeSession();
    fetchMock.mockResolvedValueOnce(
      response({ error: 'khronos:Box is listed only', code: 'NOT_DOWNLOADABLE' }, 409),
    );
    expect(await insertStoreModel(external())).toBeNull();
    expect(toastText()).toContain('Box is listed only: khronos does not allow downloading it');
    fetchMock.mockResolvedValueOnce(
      response({ error: 'Downloading Sketchfab models needs SKETCHFAB_TOKEN', code: 'NEEDS_KEY' }, 400),
    );
    expect(await insertStoreModel(external())).toBeNull();
    expect(toastText()).toContain('Box: Downloading Sketchfab models needs SKETCHFAB_TOKEN');
    expect(insertsInFlight.value.size).toBe(0);
    expect(insertErrorMessage(new ApiError('timeout', 503, 'UPSTREAM'), external())).toBe(
      'khronos did not deliver Box: timeout',
    );
    expect(insertErrorMessage(new Error('boom'), external())).toBe('Could not add Box: boom');
  });

  it('needs an open project', async () => {
    expect(await insertStoreModel(builtinResult(getCatalogEntry('chair')!))).toBeNull();
    expect(toastText()).toContain('Open a project first');
  });

  it("writes store.insert_files' entry within the operator's limits", () => {
    const long = 'x'.repeat(5000);
    const p = insertFilesParams(
      external({
        name: long,
        author: long,
        dimensions_m: [1, 0, 2],
        license: { spdx: long, url: long, attribution: null },
      }),
      'glb',
      { 'a.glb': 'AA==' },
      'a.glb',
      [1, 2, 3],
    ) as { entry: Record<string, unknown>; location: number[] };
    expect((p.entry.name as string).length).toBe(200);
    expect((p.entry.author as string).length).toBe(400);
    expect((p.entry.license as { spdx: string }).spdx.length).toBe(64);
    expect((p.entry.license as { url: string }).url.length).toBe(2000);
    // a size with a zero side is not passed on
    expect('dimensions_m' in p.entry).toBe(false);
    expect(p.entry.category).toBe('props');
    expect(p.location).toEqual([1, 2, 3]);
    expect('location' in insertFilesParams(external(), 'glb', {}, 'a.glb')).toBe(false);
  });
});
