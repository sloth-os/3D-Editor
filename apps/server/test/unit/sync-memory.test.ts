import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  MSG_CONTROL,
  MSG_SYNC,
  MemoryFileStore,
  OUT_OF_MEMORY_CLOSE_CODE,
  ProjectFileStore,
  SAVE_BYTES_PER_IMAGE_BYTE,
  SAVE_BYTES_PER_KEPT_BYTE,
  SceneDoc,
  createEditorState,
  createGrid,
  createOperatorRegistry,
  encodeFrame,
  isMeshMemoryError,
  newUuid,
  projectObjects,
  readFrameType,
  readJsonPayload,
  storedMeshBytes,
  type ControlMessage,
  type FileStore,
} from '@3d-editor/core';
import { Room, type RoomDeps, type SyncConnection } from '../../src/sync/room';
import { RoomManager } from '../../src/sync/room-manager';
import { ProjectMemoryError, loadNeed, type GrowthCheck } from '../../src/sync/project-memory';
import { measureUpdate, yjsReadError } from '../../src/sync/update-size';
import { otherOpenProjects } from '../../src/render/memory';
import { ServerMetrics } from '../../src/observability/metrics';
import { silentLog, type Log } from '../../src/observability/log';
import type { Persistence } from '../../src/persistence';
import { registerProjectRoutes } from '../../src/api/projects';

/*
 * Changes a sync client sends that add to its project are asked about before they are applied
 * (Room.handleMessage, sync/update-size.ts measureUpdate, sync/project-memory.ts), and a stored
 * project is loaded only when its load fits into the free heap (RoomManager.load).
 */

const MB = 1024 * 1024;

/** Makes measureUpdate throw, as a gap of the measure would: on an update that Yjs reads whole. */
const measureGap = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/sync/update-size', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sync/update-size')>();
  return {
    ...actual,
    measureUpdate: (...args: Parameters<typeof actual.measureUpdate>) => {
      if (measureGap.on) throw new Error('a gap of the measure (test)');
      return actual.measureUpdate(...args);
    },
  };
});
afterEach(() => {
  measureGap.on = false;
});

/** A browser editor's document: core operators run on it as in the browser. */
function editor(name = 'P') {
  const scene = SceneDoc.create({ name, empty: true });
  const registry = createOperatorRegistry();
  const state = createEditorState();
  const ctx = {
    doc: scene,
    state,
    origin: { type: 'browser' },
    source: 'test',
    report: () => undefined,
  } as never;
  const run = (op: string, params: unknown) => {
    const r = registry.run(ctx, op, params) as { ok: boolean; error?: string };
    if (!r.ok) throw new Error(`${op}: ${r.error}`);
  };
  /** The update `fn` makes (one, merged). */
  const changes = (fn: () => void): Uint8Array => {
    const updates: Uint8Array[] = [];
    const on = (u: Uint8Array) => updates.push(u);
    scene.ydoc.on('update', on);
    try {
      fn();
    } finally {
      scene.ydoc.off('update', on);
    }
    return Y.mergeUpdates(updates);
  };
  return { scene, run, state, changes };
}

/** A copy of `scene`'s document (what the server has of it). */
function copy(scene: SceneDoc): SceneDoc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(scene.ydoc));
  return new SceneDoc(doc, { type: 'server', room: 'r' });
}

/** What core counts a project at: its objects' part, and what it keeps in all. */
function model(scene: SceneDoc) {
  const p = projectObjects(scene);
  return { objects: p.objects, kept: p.bytes + storedMeshBytes(scene), save: p.save };
}

describe('what an update adds to a project (measureUpdate)', () => {
  it('counts new objects, datablocks and meshes as core counts the project', () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(e.scene);
    const before = model(server);
    const linked = e.changes(() =>
      e.run('object.array_place', { objects: ['Cube'], linked: true, count: 300, offset: [0.1, 0, 0] }),
    );
    const copies = e.changes(() =>
      e.run('object.array_place', { objects: ['Cube'], linked: false, count: 41, offset: [0, 0.1, 0] }),
    );
    const a = measureUpdate(linked, server);
    Y.applyUpdate(server.ydoc, linked);
    const b = measureUpdate(copies, server);
    Y.applyUpdate(server.ydoc, copies);
    const after = model(server);
    expect(a.objects).toBe(299);
    expect(b.objects).toBe(40);
    expect(b.datablocks.meshes).toBe(40);
    expect(b.meshBytes).toBeGreaterThan(0);
    // core samples the extra JSON of 32 objects: within 1% of what it counts
    expect(a.kept + b.kept).toBeGreaterThan(0.99 * (after.kept - before.kept));
    expect(a.kept + b.kept).toBeLessThan(1.01 * (after.kept - before.kept));
    expect(a.saved + b.saved).toBeGreaterThan(0.99 * (after.save - before.save));
    expect(a.saved + b.saved).toBeLessThan(1.01 * (after.save - before.save));
  });

  it("counts the JSON of new objects' modifiers", () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Mod' });
    const id = e.scene.findObjectByName('Mod')!.id;
    e.state.selectedIds = [id];
    e.state.activeId = id;
    for (const type of ['SUBSURF', 'BEVEL', 'MIRROR', 'SOLIDIFY']) e.run('object.modifier_add', { type });
    const server = copy(e.scene);
    const before = model(server);
    const update = e.changes(() =>
      e.run('object.array_place', { objects: ['Mod'], linked: true, count: 101, offset: [0.1, 0, 0] }),
    );
    const size = measureUpdate(update, server);
    Y.applyUpdate(server.ydoc, update);
    const added = model(server).kept - before.kept;
    expect(size.objects).toBe(100);
    // 11,000 bytes per object without them
    expect(size.kept).toBeGreaterThan(100 * 11_000 * 1.2);
    expect(Math.abs(size.kept - added)).toBeLessThan(0.01 * added);
  });

  it('counts changes of what the project has as nothing, and deletions as less', () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    e.run('object.array_place', { objects: ['Cube'], linked: true, count: 20, offset: [0.1, 0, 0] });
    const server = copy(e.scene);
    const id = e.scene.findObjectByName('Cube')!.id;
    const move = e.changes(() => e.scene.updateObject(id, { location: [1, 2, 3] }));
    expect(measureUpdate(move, server).kept).toBe(0);
    Y.applyUpdate(server.ydoc, move);
    const rename = e.changes(() => e.scene.updateObject(id, { name: 'Renamed' }));
    expect(measureUpdate(rename, server).kept).toBe(0);
    Y.applyUpdate(server.ydoc, rename);
    const ids = e.scene.objectIds().slice(0, 5);
    const removal = e.changes(() => e.scene.transact(() => ids.forEach((o) => e.scene.removeObject(o))));
    const size = measureUpdate(removal, server);
    expect(size.objects).toBe(-5);
    expect(size.kept).toBe(-5 * 11_000);
  });

  it('counts what replaces a mesh by how much it grows, and keyframes by how many are new', () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'K' });
    const o = e.scene.findObjectByName('K')!;
    e.state.selectedIds = [o.id];
    e.state.activeId = o.id;
    const server = copy(e.scene);
    const grow = e.changes(() =>
      e.scene.setMesh(o.data!, createGrid({ x_subdivisions: 50, y_subdivisions: 50 })),
    );
    const before = model(server).kept;
    const size = measureUpdate(grow, server);
    Y.applyUpdate(server.ydoc, grow);
    expect(size.objects).toBe(0);
    expect(size.meshBytes).toBe(model(server).kept - before);
    expect(size.meshBytes).toBeGreaterThan(100_000);
    const first = e.changes(() => {
      e.state.frame = 1;
      e.run('anim.keyframe_insert', { type: 'Location' });
    });
    expect(measureUpdate(first, server).keyframes).toBe(3);
    Y.applyUpdate(server.ydoc, first);
    const more = e.changes(() => {
      for (let f = 2; f <= 11; f++) {
        e.state.frame = f;
        e.run('anim.keyframe_insert', { type: 'Location' });
      }
    });
    expect(measureUpdate(more, server).keyframes).toBe(30);
    Y.applyUpdate(server.ydoc, more);
    const again = e.changes(() => {
      e.state.frame = 5;
      e.run('anim.keyframe_insert', { type: 'Location' });
    });
    expect(measureUpdate(again, server)).toMatchObject({ keyframes: 0, kept: 0 });
  });

  it('counts nothing of what an update adds and deletes again, nor what the project has already', () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(e.scene);
    // made and deleted again before the update is sent (an undo while offline)
    const gone = e.changes(() => {
      e.run('object.array_place', { objects: ['Cube'], linked: true, count: 50, offset: [0.1, 0, 0] });
      const ids = e.scene.objectIds().filter((o) => o !== e.scene.findObjectByName('Cube')!.id);
      e.scene.transact(() => ids.forEach((o) => e.scene.removeObject(o)));
    });
    expect(measureUpdate(gone, server)).toMatchObject({ objects: 0, kept: 0 });
    // the whole document of a project the server has: nothing new
    expect(measureUpdate(Y.encodeStateAsUpdate(e.scene.ydoc), copy(e.scene))).toMatchObject({
      objects: 0,
      kept: 0,
    });
  });

  it('counts the objects of a whole stored document as core counts the project', () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    e.run('object.array_place', { objects: ['Cube'], linked: true, count: 200, offset: [0.1, 0, 0] });
    const size = measureUpdate(Y.encodeStateAsUpdate(e.scene.ydoc));
    const m = model(e.scene);
    expect(size.objects).toBe(200);
    expect(Math.abs(size.kept - m.kept)).toBeLessThan(0.01 * m.kept);
  });

  it('finds what changes of another client refer to when that client comes later in the update', () => {
    // client A makes objects, client B (a higher id: written first in an update) renames one of them
    const a = editor();
    a.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(a.scene);
    const made = a.changes(() =>
      a.run('object.array_place', { objects: ['Cube'], linked: true, count: 11, offset: [0.1, 0, 0] }),
    );
    const b = new Y.Doc();
    b.clientID = a.scene.ydoc.clientID + 1;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.scene.ydoc));
    const bScene = new SceneDoc(b);
    const id = bScene.objectIds().find((o) => o !== a.scene.findObjectByName('Cube')!.id)!;
    const sv = Y.encodeStateVector(b);
    bScene.updateObject(id, { location: [5, 5, 5] });
    const renamed = Y.encodeStateAsUpdate(b, sv);
    const both = Y.mergeUpdates([renamed, made]);
    const size = measureUpdate(both, server);
    expect(size.objects).toBe(10);
    expect(size.kept).toBe(measureUpdate(made, server).kept);
  });

  it('attributes what a client changes in items of a client that comes later in the update', () => {
    // client A adds a cube; client B (a higher id: written first in an update) gives its mesh the
    // geometry of a grid, replacing (and deleting) the cube's: only the pass after the update's
    // items finds which mesh B's geometry belongs to
    const a = editor();
    const server = copy(a.scene);
    const before = model(server).kept;
    const made = a.changes(() => a.run('mesh.primitive_cube_add', { name: 'Cube' }));
    const b = new Y.Doc();
    b.clientID = a.scene.ydoc.clientID + 1;
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.scene.ydoc));
    const bScene = new SceneDoc(b);
    const sv = Y.encodeStateVector(b);
    bScene.setMesh(
      bScene.findObjectByName('Cube')!.data!,
      createGrid({ x_subdivisions: 40, y_subdivisions: 40 }),
    );
    const both = Y.mergeUpdates([Y.encodeStateAsUpdate(b, sv), made]);
    const size = measureUpdate(both, server);
    Y.applyUpdate(server.ydoc, both);
    expect(size.objects).toBe(1);
    expect(size.meshBytes).toBe(storedMeshBytes(server));
    expect(size.meshBytes).toBeGreaterThan(100_000);
    expect(size.kept).toBe(model(server).kept - before);
  });

  it('resolves long chains of items that refer to a later client in one pass', () => {
    // two clients that take turns appending to a list: in an update every item of the one written
    // first refers to an item of the other, which refers to the next one of the first …
    const turns = 2000;
    const x = new Y.Doc();
    x.clientID = 1;
    const y = new Y.Doc();
    y.clientID = 2;
    x.on('update', (u: Uint8Array, origin: unknown) => origin !== y && Y.applyUpdate(y, u, x));
    y.on('update', (u: Uint8Array, origin: unknown) => origin !== x && Y.applyUpdate(x, u, y));
    for (let i = 0; i < turns; i++) {
      x.getArray('list').push([i]);
      y.getArray('list').push([i]);
    }
    const chained = Y.encodeStateAsUpdate(x);
    // as many items of one client, each referring to an item before it
    const z = new Y.Doc();
    for (let i = 0; i < 2 * turns; i++) z.getArray('list').insert(0, [i]);
    const plain = Y.encodeStateAsUpdate(z);
    const time = (u: Uint8Array) => {
      const t0 = performance.now();
      measureUpdate(u);
      return performance.now() - t0;
    };
    time(plain);
    const base = Math.min(time(plain), time(plain));
    const t = Math.min(time(chained), time(chained));
    // (in rounds, one link of the chain each: 0.1–0.2 s against 1–3 ms)
    expect(t).toBeLessThan(10 * base + 25);
  });

  it('counts vertex groups added to a mesh the project has, as core counts the project', () => {
    const e = editor();
    e.run('mesh.primitive_grid_add', { name: 'Grid', x_subdivisions: 30, y_subdivisions: 30 });
    const meshId = e.scene.findObjectByName('Grid')!.data!;
    const vertices = e.scene.meshCounts(meshId)!.vertices;
    const server = copy(e.scene);
    const before = model(server).kept;
    const groups = Array.from({ length: 8 }, (_, i) => ({
      name: `Bone.${i}`,
      weights: new Uint8Array(vertices * 4).fill(i + 1),
    }));
    const update = e.changes(() => e.scene.setVertexGroups(meshId, groups));
    const size = measureUpdate(update, server);
    Y.applyUpdate(server.ydoc, update);
    expect(size.meshBytes).toBe(8 * vertices * 4);
    expect(size.kept).toBe(model(server).kept - before);
  });

  it('counts the vertex groups of a new mesh by their bytes, without writing them as JSON', () => {
    const e = editor();
    e.run('mesh.primitive_grid_add', { name: 'Grid', x_subdivisions: 60, y_subdivisions: 60 });
    const o = e.scene.findObjectByName('Grid')!;
    const vertices = e.scene.meshCounts(o.data!)!.vertices;
    const weights = 20 * vertices * 4;
    e.scene.setVertexGroups(
      o.data!,
      Array.from({ length: 20 }, (_, i) => ({
        name: `G${i}`,
        weights: new Uint8Array(vertices * 4).fill(i),
      })),
    );
    const server = copy(e.scene);
    const before = model(server).kept;
    e.state.selectedIds = [o.id];
    e.state.activeId = o.id;
    const update = e.changes(() => e.run('object.duplicate', {}));
    const stringify = JSON.stringify;
    let chars = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
      const json = stringify(...args);
      chars += json?.length ?? 0;
      return json;
    });
    let size: ReturnType<typeof measureUpdate>;
    try {
      size = measureUpdate(update, server);
    } finally {
      spy.mockRestore();
    }
    Y.applyUpdate(server.ydoc, update);
    expect(size.datablocks.meshes).toBe(1);
    expect(Math.abs(size.kept - (model(server).kept - before))).toBeLessThan(0.01 * size.kept);
    expect(size.meshBytes).toBeGreaterThan(weights);
    // (JSON of the weights: about ten characters per byte)
    expect(chars).toBeLessThan(weights / 10);
  });

  it('counts shape keys added to a mesh the project has, as core counts the project', () => {
    const e = editor();
    e.run('mesh.primitive_grid_add', { name: 'Grid', x_subdivisions: 30, y_subdivisions: 30 });
    const meshId = e.scene.findObjectByName('Grid')!.data!;
    const vertices = e.scene.meshCounts(meshId)!.vertices;
    const server = copy(e.scene);
    const before = model(server).kept;
    const update = e.changes(() => {
      for (const name of ['Basis', 'Smile', 'Frown']) e.run('object.shape_key_add', { object: 'Grid', name });
    });
    const size = measureUpdate(update, server);
    Y.applyUpdate(server.ydoc, update);
    // (core SHAPE_KEY_STORED_BYTES_PER_VERTEX: 16 bytes per vertex of each key)
    expect(size.meshBytes).toBe(3 * 16 * vertices);
    expect(size.kept).toBe(model(server).kept - before);
  });

  it('counts the bytes of new images, and a save of them', () => {
    const e = editor();
    const server = copy(e.scene);
    const update = e.changes(() =>
      e.scene.addImage({
        name: 'Wood',
        mime: 'image/png',
        width: 512,
        height: 512,
        data: new Uint8Array(3 * MB),
      }),
    );
    const size = measureUpdate(update, server);
    expect(size.imageBytes).toBe(3 * MB);
    expect(size.kept - size.objectsPart).toBe(3 * MB);
    expect(size.saved).toBe(SAVE_BYTES_PER_KEPT_BYTE * size.objectsPart + SAVE_BYTES_PER_IMAGE_BYTE * 3 * MB);
  });

  it('reads past the skips of an update that lacks some changes of a client', () => {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(e.scene);
    const cube = e.scene.findObjectByName('Cube')!.id;
    const place = (count: number, y: number) =>
      e.changes(() =>
        e.run('object.array_place', { objects: ['Cube'], linked: true, count, offset: [0.1, y, 0] }),
      );
    const first = place(6, 0);
    e.changes(() => e.scene.updateObject(cube, { location: [1, 2, 3] }));
    const third = place(4, 1);
    // (the merged update holds a skip where the changes it lacks were)
    const merged = Y.mergeUpdates([first, third]);
    expect(Y.decodeUpdate(merged).structs.some((s) => s instanceof Y.Skip)).toBe(true);
    const size = measureUpdate(merged, server);
    expect(size.objects).toBe(5 + 3);
    expect(size.kept).toBe(8 * 11_000);
  });

  it('takes no memory for the clock units that a few bytes of an update declare', () => {
    // one struct of `len` clock units: garbage-collected items, a skip, deleted content
    const crafted = (kind: 'gc' | 'skip' | 'deleted', len: number): Uint8Array => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 1); // clients
      encoding.writeVarUint(enc, 1); // structs
      encoding.writeVarUint(enc, 4_000_000); // client
      encoding.writeVarUint(enc, 0); // clock
      if (kind === 'deleted') {
        encoding.writeUint8(enc, 1); // content deleted, parent named by key
        encoding.writeVarUint(enc, 1);
        encoding.writeVarString(enc, 'x');
      } else encoding.writeUint8(enc, kind === 'gc' ? 0 : 10);
      encoding.writeVarUint(enc, len);
      encoding.writeVarUint(enc, 0); // delete set
      return encoding.toUint8Array(enc);
    };
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(e.scene);
    const made = e.changes(() =>
      e.run('object.array_place', { objects: ['Cube'], linked: true, count: 21, offset: [0.1, 0, 0] }),
    );
    const expected = measureUpdate(made, server);
    for (const kind of ['gc', 'skip', 'deleted'] as const) {
      for (const len of [20_000_000, 2 ** 40]) {
        const update = Y.mergeUpdates([crafted(kind, len), made]);
        const before = process.memoryUsage().arrayBuffers;
        const size = measureUpdate(update, server);
        // (an index per clock unit: 5 bytes each, 100 MB for 20,000,000; none for 2 ** 40)
        expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(8 * MB);
        expect(size).toEqual(expected);
      }
    }
  });

  it('throws on what is no update', () => {
    expect(() => measureUpdate(new Uint8Array([5, 1, 2, 3, 200, 200, 200]))).toThrow();
  });

  it('counts what replaces or deletes mesh data without a header, or an entry that is no datablock', () => {
    // what the project has of them counts as nothing: reading it must not throw (an update the
    // measure cannot read goes to Yjs without the check, see Room.unmeasured)
    const scene = oddProject();
    const server = copy(scene);
    const replaced = updateOf(scene.ydoc, () => replaceOdd(scene));
    const size = measureUpdate(replaced, server);
    Y.applyUpdate(server.ydoc, replaced);
    // the two grids, and the image
    expect(size.meshBytes).toBe(storedMeshBytes(server));
    expect(size.meshBytes).toBeGreaterThan(2 * 100_000);
    expect(size.imageBytes).toBe(2 * MB);
    const other = oddProject();
    const removal = updateOf(other.ydoc, () =>
      other.transact(() => {
        other.map('meshes').delete('no-mesh');
        other.map('images').delete('no-image');
      }),
    );
    expect(measureUpdate(removal, copy(other))).toMatchObject({ meshBytes: 0, imageBytes: 0 });
  });
});

/** The update `fn` makes of `doc`. */
function updateOf(doc: Y.Doc, fn: () => void): Uint8Array {
  const sv = Y.encodeStateVector(doc);
  fn();
  return Y.encodeStateAsUpdate(doc, sv);
}

/**
 * A project whose cube's mesh data has no mesh header (4 bytes), with values that are no datablocks
 * in the place of a mesh ('no-mesh') and an image ('no-image'): what a client can set.
 */
function oddProject(): SceneDoc {
  const e = editor('Odd');
  e.run('mesh.primitive_cube_add', { name: 'Cube' });
  const meshes = e.scene.map('meshes');
  e.scene.transact(() => {
    (meshes.get(e.scene.findObjectByName('Cube')!.data!) as Y.Map<unknown>).set(
      'data',
      new Uint8Array([1, 2, 3, 4]),
    );
    meshes.set('no-mesh', 'a value that is no datablock');
    e.scene.map('images').set('no-image', 7);
  });
  return e.scene;
}

/** Replaces what {@link oddProject} made odd: a grid in the cube's mesh and in 'no-mesh', an image of 2 MB. */
function replaceOdd(scene: SceneDoc): void {
  const meshes = scene.map('meshes');
  const meshId = scene.findObjectByName('Cube')!.data!;
  scene.transact(() => {
    scene.setMesh(meshId, createGrid({ x_subdivisions: 50, y_subdivisions: 50 }));
    const entry = new Y.Map<unknown>();
    meshes.set('no-mesh', entry);
    entry.set('data', (meshes.get(meshId) as Y.Map<unknown>).get('data'));
    const image = new Y.Map<unknown>();
    scene.map('images').set('no-image', image);
    image.set('data', new Uint8Array(2 * MB));
  });
}

describe('updates the measure cannot read (yjsReadError)', () => {
  /** An update of `count` - 1 new linked cubes, the whole one and with its last byte dropped. */
  function cubes(count: number) {
    const e = editor();
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(e.scene);
    const update = e.changes(() =>
      e.run('object.array_place', { objects: ['Cube'], linked: true, count, offset: [0.1, 0, 0] }),
    );
    // (an update that deletes nothing ends with its empty delete set: one byte, 0)
    expect(update[update.byteLength - 1]).toBe(0);
    return { e, server, update, truncated: update.slice(0, update.byteLength - 1) };
  }

  it('says why Yjs cannot read an update, and nothing of one it reads, applying neither', () => {
    const { server, update, truncated } = cubes(51);
    expect(() => measureUpdate(truncated, server)).toThrow();
    const state = Y.encodeStateVector(server.ydoc);
    expect(yjsReadError(update)).toBeNull();
    expect(yjsReadError(truncated)).toBe('Unexpected end of array');
    expect(yjsReadError(update.slice(0, update.byteLength >> 1))).not.toBeNull();
    expect(yjsReadError(new Uint8Array(0))).toBe('Unexpected end of array');
    expect(Y.encodeStateVector(server.ydoc)).toEqual(state);
    // Yjs itself adds the structs it read before it fails on the rest
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server.ydoc));
    expect(() => Y.applyUpdate(doc, truncated)).toThrow();
    expect(new SceneDoc(doc).objectIds()).toHaveLength(51);
  });
});

/** A WebSocket of a sync client, as a room sees it: what the room sends it and how it closes it. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = 'nodebuffer';
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: Uint8Array, _opts?: unknown, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }
  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close', code);
  }
  terminate(): void {
    this.close(1006, '');
  }
  ping(): void {}
  /** The control messages the room sent. */
  controls(): ControlMessage[] {
    return this.sent.flatMap((frame) => {
      const { type, decoder } = readFrameType(frame);
      return type === MSG_CONTROL ? [readJsonPayload<ControlMessage>(decoder)] : [];
    });
  }
  /** The sync frames the room sent. */
  syncFrames(): number {
    return this.sent.filter((frame) => readFrameType(frame).type === MSG_SYNC).length;
  }
}

const rooms: Room[] = [];
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((r) => r.close({ flush: false })));
});

/** A room of the project `scene` (its document as the server has it), with `growthCheck`. */
function roomOf(scene: SceneDoc, growthCheck: GrowthCheck, log: Log = silentLog) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(scene.ydoc));
  const deps: RoomDeps = {
    store: null,
    metrics: new ServerMetrics({ defaultMetrics: false }),
    log,
    debounceMs: 10,
    serverVersion: 'test',
    growthCheck,
  };
  const room = new Room(newUuid(), doc, deps);
  rooms.push(room);
  const connect = () => {
    const ws = new FakeSocket();
    const conn = room.addConnection(ws as unknown as WebSocket);
    return { ws, conn };
  };
  return { room, connect };
}

const updateFrame = (update: Uint8Array) =>
  encodeFrame(MSG_SYNC, (enc) => syncProtocol.writeUpdate(enc, update));
function send(room: Room, conn: SyncConnection, frame: Uint8Array): void {
  room.handleMessage(conn, frame);
}

describe('changes of sync clients the project cannot take (Room)', () => {
  it('applies none of them: an error with code OUT_OF_MEMORY, then the close code; the others go on', () => {
    const e = editor('Flood');
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const asked: [number, number][] = [];
    const lines: string[] = [];
    const log: Log = { ...silentLog, warn: (_o, msg) => void lines.push(msg ?? '') };
    const { room, connect } = roomOf(
      e.scene,
      (_scene, kept, saved) => {
        asked.push([kept, saved]);
        return 'the project would not fit (test)';
      },
      log,
    );
    const a = connect();
    const b = connect();
    const bFrames = b.ws.syncFrames();
    const update = e.changes(() =>
      e.run('object.array_place', { objects: ['Cube'], linked: true, count: 51, offset: [0.1, 0, 0] }),
    );
    send(room, a.conn, updateFrame(update));
    expect(asked).toEqual([[50 * 11_000, 3 * 50 * 11_000]]);
    expect(room.scene.objectIds()).toHaveLength(1);
    expect(a.ws.closed).toEqual({
      code: OUT_OF_MEMORY_CLOSE_CODE,
      reason: 'project too large for the server',
    });
    const error = a.ws.controls().find((m) => m.kind === 'error');
    expect(error).toEqual({
      kind: 'error',
      code: 'OUT_OF_MEMORY',
      message:
        'changes not applied on the server: they add 50 new objects to the project, and the project would not fit ' +
        '(test). Delete objects and meshes the project no longer needs, then Save (Ctrl+S) to send it to the ' +
        'server again',
    });
    expect(lines).toContain('sync changes not applied: the project cannot take them');
    // the other connection got nothing of them, and stays
    expect(b.ws.syncFrames()).toBe(bFrames);
    expect(b.ws.closed).toBeNull();
    expect(room.conns.size).toBe(1);
    // what the refused connection sends meanwhile is not applied either
    send(room, a.conn, updateFrame(update));
    expect(asked).toHaveLength(1);
    expect(room.scene.objectIds()).toHaveLength(1);
  });

  it('asks the same of the changes a client brings when it connects (sync step 2)', () => {
    const e = editor('Offline');
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const server = copy(e.scene);
    e.run('object.array_place', { objects: ['Cube'], linked: true, count: 21, offset: [0.1, 0, 0] });
    const { room, connect } = roomOf(server, () => 'no room (test)');
    const a = connect();
    const frame = encodeFrame(MSG_SYNC, (enc) =>
      syncProtocol.writeSyncStep2(enc, e.scene.ydoc, Y.encodeStateVector(server.ydoc)),
    );
    send(room, a.conn, frame);
    expect(room.scene.objectIds()).toHaveLength(1);
    expect(a.ws.closed?.code).toBe(OUT_OF_MEMORY_CLOSE_CODE);
    expect(a.ws.controls().find((m) => m.kind === 'error')).toMatchObject({ code: 'OUT_OF_MEMORY' });
  });

  it('applies what the project can take', () => {
    const e = editor('Fits');
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    const { room, connect } = roomOf(e.scene, () => null);
    const a = connect();
    send(room, a.conn, updateFrame(e.changes(() => e.run('mesh.primitive_uv_sphere_add', { name: 'Ball' }))));
    expect(room.scene.findObjectByName('Ball')).toBeTruthy();
    expect(a.ws.closed).toBeNull();
  });

  it('applies changes and deletions of a project past its limit without asking', () => {
    const e = editor('Past');
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    e.run('object.array_place', { objects: ['Cube'], linked: true, count: 10, offset: [0.1, 0, 0] });
    let asked = 0;
    const { room, connect } = roomOf(e.scene, () => {
      asked++;
      return 'already past its limit (test)';
    });
    const a = connect();
    const id = e.scene.findObjectByName('Cube')!.id;
    send(room, a.conn, updateFrame(e.changes(() => e.scene.updateObject(id, { location: [3, 2, 1] }))));
    const ids = e.scene.objectIds().filter((o) => o !== id);
    send(
      room,
      a.conn,
      updateFrame(e.changes(() => e.scene.transact(() => ids.forEach((o) => e.scene.removeObject(o))))),
    );
    expect(asked).toBe(0);
    expect(room.scene.objectIds()).toEqual([id]);
    expect(room.scene.getObject(id)!.location).toEqual([3, 2, 1]);
    expect(a.ws.closed).toBeNull();
    // what adds to it is refused
    send(room, a.conn, updateFrame(e.changes(() => e.run('mesh.primitive_cube_add', { name: 'More' }))));
    expect(asked).toBe(1);
    expect(room.scene.findObjectByName('More')).toBeNull();
    expect(a.ws.closed?.code).toBe(OUT_OF_MEMORY_CLOSE_CODE);
  });

  it('answers an update it cannot read with BAD_MESSAGE, and applies none of it', () => {
    const e = editor('Truncated');
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    let asked = 0;
    const lines: string[] = [];
    const log: Log = { ...silentLog, warn: (_o, msg) => void lines.push(msg ?? '') };
    const { room, connect } = roomOf(
      e.scene,
      () => {
        asked++;
        return 'no room (test)';
      },
      log,
    );
    const a = connect();
    const b = connect();
    const bFrames = b.ws.syncFrames();
    const update = e.changes(() =>
      e.run('object.array_place', { objects: ['Cube'], linked: true, count: 51, offset: [0.1, 0, 0] }),
    );
    // its delete set (one byte, 0: it deletes nothing) dropped: Yjs would add its 50 objects, then fail
    send(room, a.conn, updateFrame(update.slice(0, update.byteLength - 1)));
    expect(a.ws.controls().filter((m) => m.kind === 'error')).toEqual([
      {
        kind: 'error',
        code: 'BAD_MESSAGE',
        message:
          'could not process sync message: the update cannot be read (Unexpected end of array), so none of it ' +
          'was applied',
      },
    ]);
    expect(room.scene.objectIds()).toHaveLength(1);
    expect(asked).toBe(0);
    expect(b.ws.syncFrames()).toBe(bFrames);
    expect(lines).toEqual([]);
    // the connection stays: what it sends next is asked about as before
    expect(a.ws.closed).toBeNull();
    send(room, a.conn, updateFrame(update));
    expect(asked).toBe(1);
    expect(a.ws.closed?.code).toBe(OUT_OF_MEMORY_CLOSE_CODE);
    expect(room.scene.objectIds()).toHaveLength(1);
  });

  it('applies an update the measure cannot read but Yjs reads, without the check, and says so', () => {
    const e = editor('Gap');
    e.run('mesh.primitive_cube_add', { name: 'Cube' });
    let asked = 0;
    const lines: string[] = [];
    const log: Log = { ...silentLog, warn: (_o, msg) => void lines.push(msg ?? '') };
    const { room, connect } = roomOf(
      e.scene,
      () => {
        asked++;
        return 'no room (test)';
      },
      log,
    );
    const a = connect();
    measureGap.on = true;
    send(
      room,
      a.conn,
      updateFrame(
        e.changes(() =>
          e.run('object.array_place', { objects: ['Cube'], linked: true, count: 11, offset: [0.1, 0, 0] }),
        ),
      ),
    );
    expect(room.scene.objectIds()).toHaveLength(11);
    expect(asked).toBe(0);
    expect(a.ws.controls().filter((m) => m.kind === 'error')).toEqual([]);
    expect(a.ws.closed).toBeNull();
    expect(lines).toEqual(['sync changes applied without the memory check: the measure could not read them']);
  });

  it('asks about what replaces mesh data without a header, or an entry that is no datablock', () => {
    const scene = oddProject();
    let asked = 0;
    const { room, connect } = roomOf(scene, () => {
      asked++;
      return 'no room (test)';
    });
    const a = connect();
    send(room, a.conn, updateFrame(updateOf(scene.ydoc, () => replaceOdd(scene))));
    expect(asked).toBe(1);
    expect(a.ws.closed?.code).toBe(OUT_OF_MEMORY_CLOSE_CODE);
    expect(room.scene.map('meshes').get('no-mesh')).toBe('a value that is no datablock');
  });
});

/** A RoomManager over `fs` whose loads are held against a heap of `free` of `limit` bytes. */
function manager(
  fs: FileStore,
  free: number,
  limit = 1024 * MB,
  collect: () => void = () => undefined,
  growthCheck?: GrowthCheck,
) {
  const persistence: Persistence = {
    mode: 'disk',
    store: new ProjectFileStore(fs, '/'),
    location: 'memory',
    check: async () => ({ ok: true }),
  };
  const lines: string[] = [];
  const log: Log = { ...silentLog, warn: (_o, msg) => void lines.push(msg ?? '') };
  const rooms = new RoomManager({
    persistence,
    metrics: new ServerMetrics({ defaultMetrics: false }),
    log,
    ttlMs: 60_000,
    debounceMs: 10,
    serverVersion: 'test',
    sweepIntervalMs: 3_600_000,
    heap: { heapFree: () => free, heapLimit: () => limit, collect },
    growthCheck,
  });
  return { rooms, lines };
}

const managers: RoomManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

/** A stored project of `count` linked cubes; its id and what core counts its objects' part at. */
async function storedProject(fs: MemoryFileStore, count: number) {
  const e = editor('Stored');
  e.run('mesh.primitive_cube_add', { name: 'Cube' });
  e.run('object.array_place', { objects: ['Cube'], linked: true, count, offset: [0.1, 0, 0] });
  const id = newUuid();
  const store = new ProjectFileStore(fs, '/');
  await store.syncDocument(id, e.scene.ydoc, {
    info: () =>
      ({
        id,
        name: 'Stored',
        created_at: '',
        updated_at: '',
        stats: { objects: count, vertices: 0, faces: 0 },
      }) as never,
  });
  return { id, objectsPart: projectObjects(e.scene).bytes };
}

describe('stored projects whose load would not fit (RoomManager)', () => {
  it('does not load one when loading and saving it does not fit into the free heap', async () => {
    const fs = new MemoryFileStore();
    const { id, objectsPart } = await storedProject(fs, 100);
    let collections = 0;
    // 256 MB reserve of 1,024 MB: 2 MB free above it, less than 4.5 times the objects' part (5 MB)
    const { rooms, lines } = manager(fs, 258 * MB, 1024 * MB, () => collections++);
    managers.push(rooms);
    expect(4.5 * objectsPart).toBeGreaterThan(2 * MB);
    const need = Math.ceil((4.5 * objectsPart) / MB);
    const err = await rooms.open(id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProjectMemoryError);
    expect(isMeshMemoryError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'OUT_OF_MEMORY', statusCode: 507 });
    expect((err as Error).message).toBe(
      `project 'Stored' (${id}) was not loaded on the server: loading it and saving it would take about ${need} MB ` +
        "of JavaScript heap for its 100 objects, and the server's process has 258 MB of its 1,024 MB heap free and " +
        'keeps 256 MB of it for its other work. Open it again once the server has more heap free (a project ' +
        'nobody uses, no editor and no MCP session, is unloaded after ROOM_IDLE_TTL_SECONDS, default 3600 s), or ' +
        'start the server with a larger heap (NODE_OPTIONS=--max-old-space-size=<MB>)',
    );
    expect(collections).toBe(1);
    expect(rooms.get(id)).toBeUndefined();
    expect(lines).toContain('project not loaded: the server cannot hold it');
  });

  it('answers REST requests for one with 507, its reason and code OUT_OF_MEMORY, without an error log', async () => {
    const fs = new MemoryFileStore();
    const { id } = await storedProject(fs, 100);
    const { rooms, lines } = manager(fs, 258 * MB);
    managers.push(rooms);
    const logged: { level: number; msg?: string }[] = [];
    const app = Fastify({
      logger: { level: 'info', stream: { write: (line: string) => void logged.push(JSON.parse(line)) } },
    });
    registerProjectRoutes(app, rooms);
    try {
      for (const url of [`/api/projects/${id}`, `/api/projects/${id}/snapshot`]) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(507);
        expect(res.json()).toEqual({
          error: expect.stringMatching(
            new RegExp(`^project 'Stored' \\(${id}\\) was not loaded on the server: `),
          ),
          code: 'OUT_OF_MEMORY',
        });
      }
    } finally {
      await app.close();
    }
    // (Fastify logs the errors a route throws at level 50, with their stack)
    expect(logged.filter((l) => l.level >= 50)).toEqual([]);
    expect(lines.filter((l) => l === 'project not loaded: the server cannot hold it')).toHaveLength(2);
  });

  it('does not load one whose stored document Yjs cannot read', async () => {
    const fs = new MemoryFileStore();
    const { id } = await storedProject(fs, 100);
    const store = new ProjectFileStore(fs, '/');
    const whole = (await store.loadDocument(id))!.update;
    expect(whole[whole.byteLength - 1]).toBe(0);
    await fs.write(store.docPath(id), whole.slice(0, whole.byteLength - 1));
    const { rooms, lines } = manager(fs, 1024 * MB);
    managers.push(rooms);
    const err = await rooms.open(id).then(
      () => null,
      (e: unknown) => e,
    );
    // (Yjs would add the structs of the 100 objects to a document, then fail on the rest)
    expect((err as Error).message).toBe(
      `could not load project ${id}: its stored document cannot be read (Unexpected end of array)`,
    );
    expect(rooms.get(id)).toBeUndefined();
    expect(lines).toContain('project not loaded: its stored document cannot be read');
  });

  it('loads one whose stored document the measure cannot read but Yjs reads, without the check', async () => {
    const fs = new MemoryFileStore();
    const { id } = await storedProject(fs, 100);
    // (2 MB free above the reserve: measured, it would not be loaded)
    const { rooms, lines } = manager(fs, 258 * MB);
    managers.push(rooms);
    measureGap.on = true;
    const room = await rooms.open(id);
    expect(room?.scene.objectIds()).toHaveLength(100);
    expect(lines).toContain(
      'project loaded without the memory check: the measure could not read its stored document',
    );
  });

  it('loads one that fits, and counts it among the open projects', async () => {
    const fs = new MemoryFileStore();
    const { id, objectsPart } = await storedProject(fs, 100);
    const { rooms } = manager(fs, 256 * MB + 4.6 * objectsPart);
    managers.push(rooms);
    const room = await rooms.open(id);
    expect(room?.scene.objectIds()).toHaveLength(100);
    expect(otherOpenProjects().map((p) => p.id)).toContain(id);
  });

  it('needs four and a half times what the objects of a stored project count', () => {
    const size = {
      objects: 1,
      datablocks: {},
      keyframes: 0,
      meshBytes: 0,
      imageBytes: 0,
      objectsPart: MB,
      kept: MB,
      saved: 3 * MB,
    };
    expect(loadNeed(size)).toBe(4.5 * MB);
    expect(loadNeed({ ...size, imageBytes: MB })).toBe(10.5 * MB);
  });
});

describe('stored changes the project cannot take (Room saves and refreshes)', () => {
  it('does not merge what another writer stored beyond them, and merges it once that is deleted again', async () => {
    const fs = new MemoryFileStore();
    const { id } = await storedProject(fs, 10);
    const asked: number[] = [];
    const { rooms, lines } = manager(fs, 1024 * MB, 2048 * MB, undefined, (_scene, kept) => {
      asked.push(kept);
      return 'it would not fit (test)';
    });
    managers.push(rooms);
    const room = (await rooms.open(id))!;
    // the room's own saves are not asked about (the stored state is the one it read or wrote)
    room.scene.updateObject(room.scene.objectIds()[0], { location: [1, 1, 1] });
    await room.flush();
    expect(asked).toEqual([]);
    expect(lines).not.toContain('changes in storage not merged: the project cannot take them');
    // another writer (a browser saving to WebDAV) stores 20 more objects
    const store = new ProjectFileStore(fs, '/');
    const other = new SceneDoc(new Y.Doc(), { type: 'other' });
    Y.applyUpdate(other.ydoc, (await store.loadDocument(id))!.update);
    const registry = createOperatorRegistry();
    const ctx = {
      doc: other,
      state: createEditorState(),
      origin: { type: 'b' },
      source: 'test',
      report: () => undefined,
    } as never;
    registry.run(ctx, 'object.array_place', {
      objects: ['Cube'],
      linked: true,
      count: 21,
      offset: [0, 0.1, 0],
    });
    await store.syncDocument(id, other.ydoc);
    await room.refresh();
    expect(room.scene.objectIds()).toHaveLength(10);
    expect(asked).toEqual([20 * 11_000]);
    expect(lines).toContain('changes in storage not merged: the project cannot take them');
    // the room's change is not saved meanwhile
    room.scene.updateObject(room.scene.objectIds()[0], { location: [2, 2, 2] });
    await room.flush();
    expect(room.hasUnsavedChanges).toBe(true);
    // the other writer deletes them again: merged, and the room's change saved
    const added = other.objectIds().filter((o) => !room.scene.getObject(o));
    other.transact(() => added.forEach((o) => other.removeObject(o)));
    await store.syncDocument(id, other.ydoc);
    await room.flush();
    expect(room.hasUnsavedChanges).toBe(false);
    expect(room.scene.objectIds()).toHaveLength(10);
    const stored = new SceneDoc(new Y.Doc());
    Y.applyUpdate(stored.ydoc, (await store.loadDocument(id))!.update);
    expect(stored.objectIds()).toHaveLength(10);
  });

  it('merges none of a stored state Yjs cannot read, and merges it once it is whole', async () => {
    const fs = new MemoryFileStore();
    const { id } = await storedProject(fs, 10);
    const { rooms, lines } = manager(fs, 1024 * MB, 2048 * MB, undefined, () => null);
    managers.push(rooms);
    const room = (await rooms.open(id))!;
    // another writer stores 20 more objects, without the last byte of the document
    const store = new ProjectFileStore(fs, '/');
    const other = new SceneDoc(new Y.Doc(), { type: 'other' });
    Y.applyUpdate(other.ydoc, (await store.loadDocument(id))!.update);
    const ctx = {
      doc: other,
      state: createEditorState(),
      origin: { type: 'b' },
      source: 'test',
      report: () => undefined,
    } as never;
    createOperatorRegistry().run(ctx, 'object.array_place', {
      objects: ['Cube'],
      linked: true,
      count: 21,
      offset: [0, 0.1, 0],
    });
    const whole = Y.encodeStateAsUpdate(other.ydoc);
    await fs.write(store.docPath(id), whole.slice(0, whole.byteLength - 1));
    const updates: Uint8Array[] = [];
    room.doc.on('update', (u: Uint8Array) => updates.push(u));
    room.scene.updateObject(room.scene.objectIds()[0], { location: [2, 2, 2] });
    const own = updates.length;
    await room.flush();
    // the save failed: nothing of the stored state was merged, and the room's change is kept
    expect(updates).toHaveLength(own);
    expect(room.scene.objectIds()).toHaveLength(10);
    expect(room.hasUnsavedChanges).toBe(true);
    expect(lines).toContain('saving project failed, will retry');
    // the other writer stores it whole: merged, and the room's change saved
    await fs.write(store.docPath(id), whole);
    await room.flush();
    expect(room.scene.objectIds()).toHaveLength(30);
    expect(room.hasUnsavedChanges).toBe(false);
  });

  it('merges a stored state the measure cannot read but Yjs reads, without the check, and says so', async () => {
    const fs = new MemoryFileStore();
    const { id } = await storedProject(fs, 10);
    let asked = 0;
    const { rooms, lines } = manager(fs, 1024 * MB, 2048 * MB, undefined, () => {
      asked++;
      return 'it would not fit (test)';
    });
    managers.push(rooms);
    const room = (await rooms.open(id))!;
    const store = new ProjectFileStore(fs, '/');
    const other = new SceneDoc(new Y.Doc(), { type: 'other' });
    Y.applyUpdate(other.ydoc, (await store.loadDocument(id))!.update);
    const ctx = {
      doc: other,
      state: createEditorState(),
      origin: { type: 'b' },
      source: 'test',
      report: () => undefined,
    } as never;
    createOperatorRegistry().run(ctx, 'object.array_place', {
      objects: ['Cube'],
      linked: true,
      count: 21,
      offset: [0, 0.1, 0],
    });
    await store.syncDocument(id, other.ydoc);
    measureGap.on = true;
    await room.refresh();
    expect(room.scene.objectIds()).toHaveLength(30);
    expect(asked).toBe(0);
    expect(lines).toContain(
      'changes in storage merged without the memory check: the measure could not read them',
    );
  });

  it('does not merge what another writer stored between its write and the read back of it', async () => {
    const memory = new MemoryFileStore();
    const { id } = await storedProject(memory, 10);
    const store = new ProjectFileStore(memory, '/');
    // storage whose conditional writes are not one step (WebDAV): writers read their writes back,
    // and another writer's write can come between (`next`, right after the room's next write)
    let next: Uint8Array | null = null;
    const fs: FileStore = {
      list: (dir) => memory.list(dir),
      read: (path) => memory.read(path),
      etag: (path) => memory.etag(path),
      remove: (path) => memory.remove(path),
      mkdirp: (dir) => memory.mkdirp(dir),
      write: async (path, data, opts) => {
        const r = await memory.write(path, data, opts);
        if (next && path === store.docPath(id)) {
          await memory.write(path, next);
          next = null;
        }
        return r;
      },
    };
    const asked: number[] = [];
    const { rooms, lines } = manager(fs, 1024 * MB, 2048 * MB, undefined, (_scene, kept) => {
      asked.push(kept);
      return 'it would not fit (test)';
    });
    managers.push(rooms);
    const room = (await rooms.open(id))!;
    // the other writer's state: 20 more objects
    const other = new SceneDoc(new Y.Doc(), { type: 'other' });
    Y.applyUpdate(other.ydoc, (await store.loadDocument(id))!.update);
    const ctx = {
      doc: other,
      state: createEditorState(),
      origin: { type: 'b' },
      source: 'test',
      report: () => undefined,
    } as never;
    createOperatorRegistry().run(ctx, 'object.array_place', {
      objects: ['Cube'],
      linked: true,
      count: 21,
      offset: [0, 0.1, 0],
    });
    next = Y.encodeStateAsUpdate(other.ydoc);
    room.scene.updateObject(room.scene.objectIds()[0], { location: [1, 1, 1] });
    await room.flush();
    expect(next).toBeNull();
    expect(room.scene.objectIds()).toHaveLength(10);
    expect(asked).toEqual([20 * 11_000]);
    expect(lines).toContain('changes in storage not merged: the project cannot take them');
    expect(room.hasUnsavedChanges).toBe(true);
  });
});
