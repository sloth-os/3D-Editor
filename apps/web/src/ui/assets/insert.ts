import { signal } from '@preact/signals';
import { BUILTIN_PROVIDER, base64Encode, type RunResult, type StoreResult, type Vec3 } from '@3d-editor/core';
import { serverConfig, session, toast } from '../../app/store';
import { runResult } from '../../editor/editor';
import {
  ApiError,
  downloadStoreFile,
  fetchStoreModel,
  isAbort,
  type StoreModelDetails,
} from '../../io/store-client';

/*
 * Inserting a store model into the open project (SPEC §10, §13). Built-in models run the core
 * operator store.add; an external model's files are downloaded through the server's cached files
 * proxy and inserted with the core operator store.insert_files, here in the browser, so the insert
 * is one step of this editor's undo history (Ctrl+Z removes it) and syncs to everyone else. The
 * model goes to `location` (a drop point), else to the 3D cursor.
 */

/** What an insert in flight is doing (cards show it). */
export interface InsertProgress {
  phase: 'downloading' | 'inserting';
  /** Share of the files' bytes downloaded (null while unknown). */
  fraction: number | null;
}

/** Inserts in flight by store id. */
export const insertsInFlight = signal<ReadonlyMap<string, InsertProgress>>(new Map());

function setProgress(id: string, p: InsertProgress | null): void {
  const next = new Map(insertsInFlight.value);
  if (p) next.set(id, p);
  else next.delete(id);
  insertsInFlight.value = next;
}

/** Files downloaded at the same time for one model (a glTF's buffers and textures). */
const PARALLEL_FILES = 4;

/** Whether a model is built by code (store.add) rather than downloaded (store.insert_files). */
export function isBuiltinModel(r: Pick<StoreResult, 'id' | 'provider'>): boolean {
  return r.provider === BUILTIN_PROVIDER || r.id.startsWith(`${BUILTIN_PROVIDER}:`);
}

/** Why a model cannot be inserted from this browser (null: it can). */
export function insertBlocker(
  r: Pick<StoreResult, 'id' | 'provider' | 'name' | 'downloadable' | 'needs_key'>,
): { code: 'NOT_DOWNLOADABLE' | 'NEEDS_KEY' | 'NO_SERVER'; message: string } | null {
  if (isBuiltinModel(r)) return null;
  if (!r.downloadable)
    return {
      code: 'NOT_DOWNLOADABLE',
      message: `${r.name} is listed only: ${r.provider} does not allow downloading it (open its page to see it)`,
    };
  if (r.needs_key)
    return {
      code: 'NEEDS_KEY',
      message: `Downloading ${r.provider} models needs ${r.needs_key} on the editor server: set it there and restart the server`,
    };
  if (!serverConfig.value?.features.modelStore)
    return {
      code: 'NO_SERVER',
      message: `${r.name} comes from ${r.provider}: inserting it needs the editor server`,
    };
  return null;
}

/** The message of a failed insert, by the server's error code. */
export function insertErrorMessage(err: unknown, r: Pick<StoreResult, 'name' | 'provider'>): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'NEEDS_KEY':
        return `${r.name}: ${err.message}`;
      case 'NOT_DOWNLOADABLE':
        return `${r.name} is listed only: ${r.provider} does not allow downloading it`;
      case 'UPSTREAM':
        return `${r.provider} did not deliver ${r.name}: ${err.message}`;
      case 'UNAVAILABLE':
        return `The model store is not available: ${err.message}`;
      default:
        return `Could not add ${r.name}: ${err.message}`;
    }
  }
  return `Could not add ${r.name}: ${err instanceof Error ? err.message : String(err)}`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/**
 * The store.insert_files parameters of a downloaded model (the entry clipped to the operator's
 * limits, as the server's own insert writes it).
 */
export function insertFilesParams(
  m: Pick<
    StoreModelDetails,
    'id' | 'name' | 'provider' | 'license' | 'author' | 'source_url' | 'dimensions_m' | 'category'
  >,
  format: 'glb' | 'gltf' | 'obj',
  files: Record<string, string>,
  main: string,
  location?: Vec3,
): Record<string, unknown> {
  const dims =
    m.dimensions_m && m.dimensions_m.length === 3 && m.dimensions_m.every((d) => Number.isFinite(d) && d > 0)
      ? [...m.dimensions_m]
      : null;
  return {
    entry: {
      id: clip(m.id, 400),
      name: clip(m.name, 200),
      provider: clip(m.provider, 64),
      license: {
        spdx: clip(m.license.spdx, 64),
        url: m.license.url ? clip(m.license.url, 2000) : null,
        attribution: m.license.attribution ? clip(m.license.attribution, 2000) : null,
      },
      author: m.author ? clip(m.author, 400) : null,
      source_url: m.source_url ? clip(m.source_url, 2000) : null,
      ...(dims ? { dimensions_m: dims } : {}),
      ...(m.category ? { category: m.category } : {}),
    },
    format,
    files,
    main,
    ...(location ? { location: [location[0], location[1], location[2]] } : {}),
  };
}

/** Downloads a model's files (a few at a time), as base64 by path; `onBytes` gets the running total. */
async function downloadFiles(
  model: string,
  files: { path: string; bytes: number | null }[],
  signal: AbortSignal | undefined,
  onBytes: (received: number) => void,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const received = new Map<string, number>();
  const report = () => onBytes([...received.values()].reduce((a, b) => a + b, 0));
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      const data = await downloadStoreFile(model, f.path, {
        signal,
        onBytes: (n) => {
          received.set(f.path, n);
          report();
        },
      });
      received.set(f.path, data.byteLength);
      report();
      out[f.path] = base64Encode(data);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_FILES, files.length) }, worker));
  return out;
}

export interface InsertOptions {
  /** Where the model's base centre goes (default: the 3D cursor). */
  location?: Vec3;
  signal?: AbortSignal;
}

/**
 * Inserts a store model into the open project as one undo step: store.add for a built-in model,
 * else its files through the server's proxy and store.insert_files. Progress shows on the model's
 * card ({@link insertsInFlight}); refusals and failures are toasts. Returns the operator's result,
 * or null when nothing was inserted.
 */
export async function insertStoreModel(
  result: StoreResult,
  opts: InsertOptions = {},
): Promise<RunResult | null> {
  const s = session.value;
  if (!s) {
    toast('Open a project first', 'warning');
    return null;
  }
  const location = opts.location
    ? ([opts.location[0], opts.location[1], opts.location[2]] as Vec3)
    : undefined;
  if (isBuiltinModel(result)) {
    // failures report themselves (the runner's error toast)
    const res = runResult('store.add', { model: result.id, ...(location ? { location } : {}) }, 'ui');
    if (res?.ok) toast(`Added ${result.name}`);
    return res;
  }
  const blocker = insertBlocker(result);
  if (blocker) {
    toast(blocker.message, 'error', 6000);
    return null;
  }
  if (insertsInFlight.value.has(result.id)) return null;
  setProgress(result.id, { phase: 'downloading', fraction: 0 });
  toast(`Downloading ${result.name}…`);
  try {
    // the server downloads (or finds in its cache) the model's files and lists them
    const details = await fetchStoreModel(result.id, { download: true, signal: opts.signal });
    if (!details.files?.length || !details.format || !details.main)
      throw new Error(`the server listed no files for ${result.name}`);
    const known = details.files.every((f) => typeof f.bytes === 'number');
    const total = details.files.reduce((n, f) => n + (f.bytes ?? 0), 0);
    const files = await downloadFiles(result.id, details.files, opts.signal, (received) =>
      setProgress(result.id, {
        phase: 'downloading',
        fraction: known && total > 0 ? Math.min(1, received / total) : null,
      }),
    );
    if (session.value !== s) throw new Error('the project was closed while the model downloaded');
    setProgress(result.id, { phase: 'inserting', fraction: 1 });
    const res = runResult(
      'store.insert_files',
      insertFilesParams(details, details.format, files, details.main, location),
      'ui',
    );
    if (res?.ok) toast(`Added ${result.name}`);
    return res;
  } catch (err) {
    if (!isAbort(err)) toast(insertErrorMessage(err, result), 'error', 6000);
    return null;
  } finally {
    setProgress(result.id, null);
  }
}
