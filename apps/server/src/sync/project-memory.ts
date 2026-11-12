import v8 from 'node:v8';
import {
  MeshMemoryError,
  SAVE_BYTES_PER_IMAGE_BYTE,
  SAVE_BYTES_PER_KEPT_BYTE,
  type SceneDoc,
} from '@3d-editor/core';
import { collectGarbage, freeHeapBytes, projectGrowthRefusal, serverHeapReserve } from '../render/memory';
import type { UpdateSize } from './update-size';

/*
 * What the server's process can hold of the projects that browsers sync and that storage holds
 * (render/memory.ts has the checks of operators, evaluations and renders):
 *
 * - A change a sync client sends (Room.handleMessage) that adds objects, datablocks, keyframes,
 *   geometry or images (sync/update-size.ts measures it) is asked about with
 *   render/memory.ts projectGrowthRefusal, the check of operators that add to a project. One the
 *   project cannot take is not applied: the connection gets a control error with code
 *   OUT_OF_MEMORY and {@link refusedChangesMessage}, and is closed with OUT_OF_MEMORY_CLOSE_CODE.
 * - A stored project is loaded (RoomManager.load) only when what the load and its first save take
 *   ({@link loadNeed}) fits into the free heap, less the reserve; else {@link ProjectMemoryError}.
 */

const MB = 1024 * 1024;
const n = (v: number): string => Math.round(v).toLocaleString('en-US');
const mbUp = (bytes: number): string => n(Math.ceil(Math.max(0, bytes) / MB));
const mb = (bytes: number): string => n(Math.max(0, bytes) / MB);

/** Why the project of `scene` cannot take `kept` more bytes, and `saved` more for its saves (null: it can). */
export type GrowthCheck = (scene: SceneDoc, kept: number, saved: number) => string | null;

/** The server's check of what a sync client's change adds: the one of operators (render/memory.ts). */
export const growthCheck: GrowthCheck = (scene, kept, saved) => projectGrowthRefusal(scene, kept, saved);

/**
 * "3 new objects, 2 new meshes and 40 new keyframes" of what an update adds (counts above 0, mesh
 * geometry and images from 1 MB), else its size ("about 12 KB").
 */
export function describeGrowth(size: UpdateSize): string {
  const parts: string[] = [];
  const count = (k: number, one: string, many: string) => `${n(k)} ${k === 1 ? one : many}`;
  if (size.objects > 0) parts.push(count(size.objects, 'new object', 'new objects'));
  const meshes = size.datablocks.meshes ?? 0;
  if (meshes > 0) parts.push(count(meshes, 'new mesh', 'new meshes'));
  if (size.keyframes > 0) parts.push(count(size.keyframes, 'new keyframe', 'new keyframes'));
  if (size.meshBytes >= MB) parts.push(`${mbUp(size.meshBytes)} MB of mesh geometry`);
  if (size.imageBytes >= MB) parts.push(`${mbUp(size.imageBytes)} MB of images`);
  if (!parts.length)
    return size.kept >= MB ? `about ${mbUp(size.kept)} MB` : `about ${n(Math.ceil(size.kept / 1024))} KB`;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The message of a sync client's change the server does not apply (`clause`: why the project
 * cannot take it, from {@link GrowthCheck}).
 */
export function refusedChangesMessage(size: UpdateSize, clause: string): string {
  return (
    `changes not applied on the server: they add ${describeGrowth(size)} to the project, and ${clause}. ` +
    'Delete objects and meshes the project no longer needs, then Save (Ctrl+S) to send it to the server again'
  );
}

/**
 * The message of a stored state that a room's save or refresh does not merge (Room.guarded):
 * another writer stored the project with more than it can take (`clause`, from {@link GrowthCheck}).
 */
export function storedChangesMessage(size: UpdateSize, clause: string): string {
  return (
    `changes in storage not merged on the server: another writer stored the project with ${describeGrowth(size)} ` +
    `more, and ${clause}. This server saves the changes made here once storage holds a project it can take ` +
    '(delete objects and meshes the project no longer needs where they were added, and save there)'
  );
}

/** A save or refresh of a room that did not merge the stored state (see storedChangesMessage). */
export class StoredChangesRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoredChangesRefusedError';
  }
}

/**
 * Heap a document loaded from storage keeps and takes while it loads, per byte its objects,
 * datablocks, keyframes and drivers count (core operators/memory-objects.ts, sync/update-size.ts
 * objectsPart): the least heap a load completed in, less the process's own (39 MB), was 152 MB for
 * 10,000 linked cubes counted at 104.9 MB (1.45) and 85 MB for 5,000 cubes with meshes of their own
 * counted at 66.8 MB (1.27); rounded up. A document made by edits keeps less (10.1 KB per linked
 * cube against 14.6 KB loaded): the items a load decodes do not share their keys and values.
 */
export const LOADED_BYTES_PER_KEPT_BYTE = 1.5;

/**
 * Heap a stored project takes to be loaded and saved once (bytes): {@link LOADED_BYTES_PER_KEPT_BYTE}
 * and core SAVE_BYTES_PER_KEPT_BYTE times its objects' part, its images and core
 * SAVE_BYTES_PER_IMAGE_BYTE times them (the server saves a project after its first change, and the
 * rooms that editors use read storage once a minute). Measured: 451 MB for the 10,000 linked cubes
 * (estimated 472 MB), 252 MB for the 5,000 cubes (estimated 300 MB). Its meshes are decoded later,
 * each checked when something reads it (render/memory.ts decodeCheck).
 */
export function loadNeed(size: UpdateSize): number {
  return (
    (LOADED_BYTES_PER_KEPT_BYTE + SAVE_BYTES_PER_KEPT_BYTE) * Math.max(0, size.objectsPart) +
    (1 + SAVE_BYTES_PER_IMAGE_BYTE) * Math.max(0, size.imageBytes)
  );
}

/**
 * A stored project the server does not load: its load would not fit into the free heap (code
 * OUT_OF_MEMORY, as the tools report MeshMemoryErrors; the REST API answers 507).
 */
export class ProjectMemoryError extends MeshMemoryError {
  readonly statusCode = 507;
  constructor(message: string) {
    super(message);
    this.name = 'ProjectMemoryError';
  }
}

/** The heap the load check is held against (bytes), and the collection it may run first. */
export interface HeapProbe {
  heapFree?: () => number;
  heapLimit?: () => number;
  collect?: () => unknown;
}

/**
 * Why the stored project `id` named `name`, of `size` (sync/update-size.ts measureUpdate of its
 * stored document), is not loaded: what loading and saving it takes ({@link loadNeed}) does not fit
 * into the free heap less the reserve (render/memory.ts serverHeapReserve), after a garbage
 * collection when one could make room. Null: it fits.
 */
export function loadRefusal(
  project: { id: string; name: string },
  size: UpdateSize,
  probe: HeapProbe = {},
): string | null {
  const need = loadNeed(size);
  const limit = (probe.heapLimit ?? (() => v8.getHeapStatistics().heap_size_limit))();
  const heapFree = probe.heapFree ?? freeHeapBytes;
  const reserve = serverHeapReserve(limit);
  let free = heapFree();
  if (need <= free - reserve) return null;
  if (need <= limit - reserve) {
    (probe.collect ?? collectGarbage)();
    free = heapFree();
    if (need <= free - reserve) return null;
  }
  const holds = [`${n(size.objects)} object${size.objects === 1 ? '' : 's'}`];
  if (size.keyframes > 0) holds.push(`${n(size.keyframes)} keyframes`);
  if (size.imageBytes > 0) holds.push(`${mbUp(size.imageBytes)} MB of images`);
  return (
    `project '${project.name}' (${project.id}) was not loaded on the server: loading it and saving it would ` +
    `take about ${mbUp(need)} MB of JavaScript heap for its ${holds.join(', ')}, and the server's process has ` +
    `${mb(free)} MB of its ${mb(limit)} MB heap free and keeps ${mb(reserve)} MB of it for its other work. Open ` +
    'it again once the server has more heap free (a project nobody uses, no editor and no MCP session, is ' +
    'unloaded after ROOM_IDLE_TTL_SECONDS, default 3600 s), or start the server with a larger heap ' +
    '(NODE_OPTIONS=--max-old-space-size=<MB>)'
  );
}
