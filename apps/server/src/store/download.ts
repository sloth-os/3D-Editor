import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ToolError } from '../mcp/agent';
import type { CachedFile, EntryContent } from './cache';
import { StoreUpstreamError, formatBytes, sniffImage, storeFetchToFile } from './http';
import type { DownloadPlan, PlannedFile } from './providers/types';
import { fileZipSource, readZipEntries, readZipEntry, safeArchivePath, ZipError, type ZipEntry } from './zip';

/*
 * Downloads a model's files (a provider's DownloadPlan) into a cache entry's directory: every file
 * streamed to disk with the size cap of the whole model (200 MB), announced sizes and MD5s
 * checked, the main file checked to be what its format says (a GLB header, glTF JSON, OBJ text);
 * for plans that do not list them, the buffers and images a glTF names (or the material libraries
 * and textures of an OBJ) fetched relative to it, from its own server only; and ZIP archives
 * (Sketchfab) unpacked: the main model and the files it names, relative to the main file. Files a
 * plan lists that the main file does not name are left out (the files route serves only what the
 * model uses), and images must be images. Paths never leave the directory.
 */

/** Most bytes of one model (all its files; also of a ZIP archive and of what it unpacks to). */
export const MAX_MODEL_BYTES = 200 * 1024 * 1024;
/** Most files of one model. */
const MAX_MODEL_FILES = 512;

export interface DownloadContext {
  fetch: typeof fetch;
  /** STORE_FETCH_TIMEOUT_MS: to the response headers and between two chunks of a body. */
  timeoutMs: number;
  signal: AbortSignal;
  /** The model ('khronos:SheenChair'), for messages. */
  what: string;
  maxBytes?: number;
  /** Bytes downloaded (metrics). */
  onBytes?: (bytes: number) => void;
}

/** The media type of a model file by its extension. */
export function contentTypeFor(file: string): string {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'glb':
      return 'model/gltf-binary';
    case 'gltf':
      return 'model/gltf+json';
    case 'obj':
      return 'model/obj';
    case 'mtl':
      return 'model/mtl';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'ktx2':
      return 'image/ktx2';
    default:
      return 'application/octet-stream';
  }
}

function formatOf(file: string): 'glb' | 'gltf' | 'obj' | null {
  const ext = file.toLowerCase().split('.').pop();
  return ext === 'glb' || ext === 'gltf' || ext === 'obj' ? ext : null;
}

/** Checks that the main file is a model of `format` (a provider's error page is not). */
export function checkModelFile(format: 'glb' | 'gltf' | 'obj', data: Uint8Array, what: string): void {
  if (format === 'glb') {
    const magic =
      data.length >= 12 && data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46;
    const version = data.length >= 8 ? data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24) : 0;
    if (!magic || version !== 2)
      throw new ToolError(`${what}: the file is not a glTF 2.0 binary (.glb)`, 'UPSTREAM');
    return;
  }
  if (format === 'gltf') {
    const json = parseGltf(data);
    if (!json) throw new ToolError(`${what}: the file is not glTF JSON`, 'UPSTREAM');
    return;
  }
  // OBJ is text: a NUL byte in its first kilobyte means something else was served
  if (data.subarray(0, 1024).includes(0))
    throw new ToolError(`${what}: the file is not an OBJ text file`, 'UPSTREAM');
}

/** A glTF file's JSON (null when it is not glTF JSON). */
export function parseGltf(
  data: Uint8Array,
): { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] } | null {
  try {
    const json = JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown>;
    return json && typeof json === 'object' && json.asset && typeof json.asset === 'object'
      ? (json as { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] })
      : null;
  } catch {
    return null;
  }
}

/** The external files a glTF names (buffers and images; data: URIs excluded), as written. */
export function gltfReferences(data: Uint8Array): string[] {
  const json = parseGltf(data);
  if (!json) return [];
  const out: string[] = [];
  for (const list of [json.buffers, json.images])
    for (const item of Array.isArray(list) ? list : [])
      if (typeof item?.uri === 'string' && item.uri && !item.uri.startsWith('data:')) out.push(item.uri);
  return [...new Set(out)];
}

/** The material libraries an OBJ names. */
export function objLibraries(data: Uint8Array): string[] {
  const out: string[] = [];
  for (const line of new TextDecoder().decode(data).split(/\r?\n/)) {
    const m = /^\s*mtllib\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** The textures a material library names (the last word of each map statement). */
export function mtlTextures(data: Uint8Array): string[] {
  const out: string[] = [];
  for (const line of new TextDecoder().decode(data).split(/\r?\n/)) {
    const m = /^\s*(map_\w+|bump|norm|disp|decal|refl)\s+(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const parts = m[2].split(/\s+/);
    out.push(parts[parts.length - 1]);
  }
  return [...new Set(out)];
}

/**
 * Where a referenced file goes in the model: its path relative to the main file when that stays
 * inside the model's folder (URI escapes decoded), else its file name (core's import finds
 * companion files by path, then by file name); an absolute URL by its file name.
 */
export function referencePath(ref: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
    try {
      ref = new URL(ref).pathname.split('/').pop() ?? '';
    } catch {
      return null;
    }
  }
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {}
  const safe = safeArchivePath(decoded);
  if (safe) return safe;
  const base = decoded.replace(/\\/g, '/').split('/').pop() ?? '';
  return safeArchivePath(base);
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Turns a body over the size cap into NOT_DOWNLOADABLE (the model is too large for the store). */
function tooLarge(err: unknown, ctx: DownloadContext, max: number): unknown {
  if (err instanceof StoreUpstreamError && err.tooLarge)
    return new ToolError(
      `${ctx.what} is larger than the ${formatBytes(max)} the model store downloads per model`,
      'NOT_DOWNLOADABLE',
    );
  return err;
}

/** Extensions of the images a model's files are checked to be (what sniffImage recognises). */
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|ktx2)$/i;

/** The parent folder of a path inside a model ('' at its top), with a trailing slash. */
const folderOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '');
const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();

/**
 * The files of a downloaded glTF or OBJ model its main file uses (a glTF's buffers and images; an
 * OBJ's material libraries and their textures, read from `dir`): by path relative to the model and
 * by file name (core's import also finds companions by name).
 */
async function namedFiles(
  format: 'gltf' | 'obj',
  mainRel: string,
  main: Uint8Array,
  dir: string,
): Promise<{ paths: Set<string>; names: Set<string> }> {
  const paths = new Set<string>();
  const names = new Set<string>();
  const add = (ref: string, from: string): string | null => {
    const p = referencePath(ref);
    if (!p) return null;
    const rel = safeArchivePath(`${folderOf(from)}${p}`) ?? p;
    paths.add(rel);
    names.add(baseName(rel));
    return rel;
  };
  if (format === 'gltf') for (const ref of gltfReferences(main)) add(ref, mainRel);
  else
    for (const lib of objLibraries(main)) {
      const rel = add(lib, mainRel);
      const data = rel ? await readFile(path.join(dir, ...rel.split('/'))).catch(() => null) : null;
      if (data && rel) for (const tex of mtlTextures(new Uint8Array(data))) add(tex, rel);
    }
  return { paths, names };
}

/** Files of one model downloaded at the same time (those whose sizes the provider announced). */
const PARALLEL_FILES = 4;

/**
 * Downloads `plan` into `dir` (empty, owned by the caller); lists the files and the main one. The
 * main file, the files whose references are read and files of unknown size download one at a time
 * (each with what is left of the size cap); files whose sizes the provider announced download
 * PARALLEL_FILES at a time with their sizes reserved, so the cap holds either way. The first
 * failure stops the downloads still running and is reported once they stopped.
 */
export async function downloadPlan(
  plan: DownloadPlan,
  dir: string,
  ctx: DownloadContext,
): Promise<EntryContent> {
  const max = ctx.maxBytes ?? MAX_MODEL_BYTES;
  if (plan.archive) return downloadArchive(plan, dir, ctx, max);
  const queue: { file: PlannedFile; discover: boolean }[] = plan.files.map((f, i) => ({
    file: f,
    discover: i === 0 && !!plan.discover,
  }));
  /** The files in queue order (main first), whatever order their downloads end in. */
  const slots: (CachedFile | null)[] = [];
  /** The first bytes of each slot's file (image checks). */
  const heads: (Uint8Array | null)[] = [];
  /** The main file of a glTF or OBJ (what it names decides which listed files are kept). */
  let mainData: Uint8Array | null = null;
  const seen = new Set<string>();
  /** Bytes downloaded, plus the announced sizes of the downloads running. */
  let used = 0;
  const stop = new AbortController();
  const onAbort = () => stop.abort(ctx.signal.reason);
  if (ctx.signal.aborted) stop.abort(ctx.signal.reason);
  else ctx.signal.addEventListener('abort', onAbort, { once: true });
  const running = new Set<Promise<void>>();
  /** The first failure of a parallel download. */
  const failures: unknown[] = [];
  const tooBig = () =>
    new ToolError(
      `${ctx.what} is larger than the ${formatBytes(max)} the model store downloads per model`,
      'NOT_DOWNLOADABLE',
    );

  /**
   * Downloads queue item `i` to `rel` into `slots[slot]`: at most `limit` bytes, or exactly its
   * announced size when `limit` is null (a parallel download whose size was reserved).
   */
  const fetchOne = async (i: number, rel: string, slot: number, limit: number | null): Promise<number> => {
    const { file, discover } = queue[i];
    const target = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    const headers =
      plan.headers && plan.headersHost && new URL(file.url).hostname === plan.headersHost
        ? plan.headers
        : undefined;
    let got;
    try {
      got = await storeFetchToFile(file.url, target, {
        what: `${ctx.what}: ${rel}`,
        timeoutMs: ctx.timeoutMs,
        maxBytes: limit ?? file.bytes ?? 0,
        expect: 'file',
        signal: stop.signal,
        fetchImpl: ctx.fetch,
        headers,
      });
    } catch (err) {
      if (limit === null && err instanceof StoreUpstreamError && err.tooLarge)
        throw new ToolError(`${ctx.what}: ${rel} is not the size its provider lists`, 'UPSTREAM');
      throw tooLarge(err, ctx, max);
    }
    ctx.onBytes?.(got.bytes);
    if (file.md5 && file.md5.toLowerCase() !== got.md5)
      throw new ToolError(`${ctx.what}: ${rel} does not match the checksum its provider lists`, 'UPSTREAM');
    if (file.bytes != null && file.bytes !== got.bytes)
      throw new ToolError(`${ctx.what}: ${rel} is not the size its provider lists`, 'UPSTREAM');
    slots[slot] = { path: rel, bytes: got.bytes, sha256: got.sha256, type: contentTypeFor(rel) };
    heads[slot] = got.head;
    // a GLB is checked by its header alone (it may be 200 MB); glTF JSON and OBJ text are read
    if (i === 0 && plan.format === 'glb') checkModelFile('glb', got.head, ctx.what);
    else if (i === 0 || discover) {
      const data = new Uint8Array(await readFile(target));
      if (i === 0) {
        checkModelFile(plan.format, data, ctx.what);
        mainData = data;
      }
      if (discover) {
        // companion files named by the main file (or by a material library), relative to it
        const refs =
          formatOf(rel) === 'obj'
            ? objLibraries(data)
            : rel.endsWith('.mtl')
              ? mtlTextures(data)
              : gltfReferences(data);
        const baseDir = folderOf(rel);
        const origin = new URL(file.url).origin;
        for (const ref of refs) {
          const refPath = referencePath(ref);
          if (!refPath) continue;
          let url: URL;
          try {
            url = new URL(ref, file.url);
          } catch {
            continue;
          }
          // only from the model's own server (a model file must not make the server fetch others)
          if (url.origin !== origin)
            throw new ToolError(
              `${ctx.what}: ${rel} names a file on another server (${url.host}); only files next to it are downloaded`,
              'UPSTREAM',
            );
          const p = safeArchivePath(`${baseDir}${refPath}`) ?? refPath;
          // material libraries name textures in turn
          queue.push({ file: { path: p, url: url.href }, discover: p.toLowerCase().endsWith('.mtl') });
        }
      }
    }
    return got.bytes;
  };
  const drain = async () => {
    while (running.size) await Promise.allSettled([...running]);
  };

  try {
    for (let i = 0; i < queue.length && !failures.length; i++) {
      const { file, discover } = queue[i];
      const rel = safeArchivePath(file.path);
      if (!rel)
        throw new ToolError(
          `${ctx.what}: the file path '${file.path}' leaves the model's folder`,
          'UPSTREAM',
        );
      if (seen.has(rel)) continue;
      seen.add(rel);
      if (seen.size > MAX_MODEL_FILES)
        throw new ToolError(`${ctx.what} has more than ${MAX_MODEL_FILES} files`, 'NOT_DOWNLOADABLE');
      if (file.bytes != null && file.bytes > max - used) throw tooBig();
      const slot = slots.push(null) - 1;
      if (i === 0 || discover || file.bytes == null) {
        // alone: what it names decides what follows, or its size is only known once downloaded
        await drain();
        if (failures.length) break;
        used += await fetchOne(i, rel, slot, max - used);
        continue;
      }
      used += file.bytes;
      while (running.size >= PARALLEL_FILES) await Promise.race(running);
      if (failures.length) break;
      const task: Promise<void> = fetchOne(i, rel, slot, null).then(
        () => void running.delete(task),
        (err: unknown) => {
          running.delete(task);
          failures.push(err);
          stop.abort(new Error('another file of the model failed'));
        },
      );
      running.add(task);
    }
    await drain();
    if (failures.length) throw failures[0];
  } catch (err) {
    // nothing may still write into the directory the caller removes
    stop.abort(new Error('the download failed'));
    await drain();
    throw err;
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
  const files: CachedFile[] = [];
  const main = slots[0];
  const named =
    main && mainData && plan.format !== 'glb'
      ? await namedFiles(plan.format, main.path, mainData, dir)
      : null;
  for (let i = 0; i < slots.length; i++) {
    const f = slots[i];
    if (!f) continue;
    if (i > 0) {
      // a listed file the model does not use is not kept (nor served by the files route)
      if (named && !named.paths.has(f.path) && !named.names.has(baseName(f.path))) {
        await rm(path.join(dir, ...f.path.split('/')), { force: true });
        continue;
      }
      if (IMAGE_EXTENSIONS.test(f.path) && !sniffImage(heads[i] ?? new Uint8Array(0)))
        throw new ToolError(`${ctx.what}: ${f.path} is not an image`, 'UPSTREAM');
    }
    files.push(f);
  }
  return { files, meta: { format: plan.format, main: safeArchivePath(plan.main) ?? files[0]?.path } };
}

/** Picks the main model of an archive: a .gltf, else a .glb, else an .obj (the shallowest first). */
function mainEntry(entries: ZipEntry[]): ZipEntry | null {
  for (const ext of ['.gltf', '.glb', '.obj']) {
    const found = entries
      .filter((e) => safeArchivePath(e.name)?.toLowerCase().endsWith(ext))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length || a.name.length - b.name.length);
    if (found.length) return found[0];
  }
  return null;
}

/** Downloads and unpacks a ZIP archive holding the model. */
async function downloadArchive(
  plan: DownloadPlan,
  dir: string,
  ctx: DownloadContext,
  max: number,
): Promise<EntryContent> {
  const archive = plan.archive!;
  if (archive.bytes != null && archive.bytes > max)
    throw new ToolError(
      `${ctx.what} is larger than the ${formatBytes(max)} the model store downloads per model`,
      'NOT_DOWNLOADABLE',
    );
  const zipPath = path.join(dir, '.download.zip');
  try {
    let got;
    try {
      got = await storeFetchToFile(archive.url, zipPath, {
        what: `${ctx.what} (archive)`,
        timeoutMs: ctx.timeoutMs,
        maxBytes: max,
        expect: 'file',
        signal: ctx.signal,
        fetchImpl: ctx.fetch,
      });
    } catch (err) {
      throw tooLarge(err, ctx, max);
    }
    ctx.onBytes?.(got.bytes);
    const src = await fileZipSource(zipPath);
    try {
      const entries = (await readZipEntries(src)).filter((e) => !e.directory);
      const main = mainEntry(entries);
      if (!main)
        throw new ToolError(`${ctx.what}: the archive holds no glTF, GLB or OBJ model`, 'NOT_DOWNLOADABLE');
      const mainPath = safeArchivePath(main.name)!;
      const root = mainPath.includes('/') ? mainPath.slice(0, mainPath.lastIndexOf('/') + 1) : '';
      const byPath = new Map<string, ZipEntry>();
      for (const e of entries) {
        const p = safeArchivePath(e.name);
        if (p) byPath.set(p.toLowerCase(), e);
      }
      const files: CachedFile[] = [];
      let budget = max;
      const written = new Set<string>();
      /** Unpacks `entry` to `rel` (relative to the main file's folder). */
      const unpack = async (entry: ZipEntry, rel: string): Promise<Uint8Array> => {
        const data = await readZipEntry(src, entry, budget);
        budget -= data.byteLength;
        if (!written.has(rel)) {
          written.add(rel);
          const target = path.join(dir, ...rel.split('/'));
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, data);
          files.push({ path: rel, bytes: data.byteLength, sha256: sha256(data), type: contentTypeFor(rel) });
        }
        return data;
      };
      const mainRel = mainPath.slice(root.length);
      const format = formatOf(mainRel)!;
      const mainData = await unpack(main, mainRel);
      checkModelFile(format, mainData, ctx.what);
      /** The archive entry a reference of the file at `from` (relative to root) names. */
      const lookup = (ref: string, from: string): { entry: ZipEntry; rel: string } | null => {
        let decoded = ref;
        try {
          decoded = decodeURIComponent(ref);
        } catch {}
        const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
        const full = path.posix.normalize(`${root}${fromDir}${decoded.replace(/\\/g, '/')}`);
        const entry = byPath.get(full.toLowerCase());
        if (!entry) return null;
        const rel = full.startsWith(root) ? safeArchivePath(full.slice(root.length)) : null;
        return { entry, rel: rel ?? referencePath(decoded) ?? full };
      };
      const pending: { ref: string; from: string }[] = [];
      if (format === 'gltf') for (const ref of gltfReferences(mainData)) pending.push({ ref, from: mainRel });
      if (format === 'obj') for (const ref of objLibraries(mainData)) pending.push({ ref, from: mainRel });
      while (pending.length) {
        if (files.length >= MAX_MODEL_FILES)
          throw new ToolError(`${ctx.what} has more than ${MAX_MODEL_FILES} files`, 'NOT_DOWNLOADABLE');
        const { ref, from } = pending.shift()!;
        const found = lookup(ref, from);
        if (!found || written.has(found.rel)) continue;
        const data = await unpack(found.entry, found.rel);
        if (found.rel.toLowerCase().endsWith('.mtl'))
          for (const tex of mtlTextures(data)) pending.push({ ref: tex, from: found.rel });
      }
      return { files, meta: { format, main: mainRel } };
    } catch (err) {
      if (err instanceof ZipError && err.tooLarge)
        throw new ToolError(
          `${ctx.what} is larger than the ${formatBytes(max)} the model store downloads per model`,
          'NOT_DOWNLOADABLE',
        );
      if (err instanceof ZipError) throw new ToolError(`${ctx.what}: ${err.message}`, 'UPSTREAM');
      throw err;
    } finally {
      await src.close();
    }
  } finally {
    await rm(zipPath, { force: true }).catch(() => undefined);
  }
}
