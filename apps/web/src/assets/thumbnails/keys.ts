import { THUMBNAIL_SIZE, THUMBNAIL_VERSION, getCatalogEntry } from '@3d-editor/core';

/*
 * What identifies a browser-made thumbnail: the build that made it, the model, its parameters and
 * the size. A thumbnail's pixels depend on the built-in model's code, core's store.add, renderer and
 * framing, all bundled into the thumbnail worker: in a production build the worker's file name
 * carries the hash of its content, so a build whose catalog or renderer changed has another build
 * id (and makes its thumbnails again), while one that changed elsewhere keeps the cached ones. The
 * development server's worker has no such hash: each page load is a build of its own there.
 */

/** A built-in model's thumbnail: catalog id, parameters (none: the defaults) and size in pixels. */
export interface ThumbnailSpec {
  /** 'chair' or 'builtin:chair'. */
  model: string;
  params?: Record<string, unknown>;
  size?: number;
}

/** The build id of thumbnails made by the worker at `workerUrl` in app version `appVersion`. */
export function thumbnailBuild(workerUrl: string, appVersion: string, now = Date.now()): string {
  const file = workerUrl.split(/[?#]/)[0].split('/').pop() ?? '';
  // Vite names production bundles '<name>-<hash>.js'; the dev server serves the source file
  const hashed = !/[?&]worker_file\b/.test(workerUrl) && /-[\w-]{6,}\.js$/.test(file);
  return `${appVersion}/${THUMBNAIL_VERSION}/${hashed ? file : `dev-${now.toString(36)}`}`;
}

/** The catalog id of a built-in model ('builtin:Coffee-Table' → 'coffee_table'; unknown ids as given). */
export function catalogModelId(model: string): string {
  return getCatalogEntry(model)?.id ?? model.replace(/^builtin:/i, '');
}

/** Parameters as one canonical string (keys sorted at every depth; '' for none). */
export function canonicalParams(params: Record<string, unknown> | undefined): string {
  if (!params || !Object.keys(params).length) return '';
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    return v;
  };
  const s = JSON.stringify(sort(params));
  return s === '{}' ? '' : s;
}

/** The size a spec asks for (THUMBNAIL_SIZE by default). */
export const specSize = (spec: ThumbnailSpec): number => spec.size ?? THUMBNAIL_SIZE;

/** The cache key of `spec`'s thumbnail made by build `build`. */
export function thumbnailKey(build: string, spec: ThumbnailSpec): string {
  return `${build}|builtin:${catalogModelId(spec.model)}|${specSize(spec)}|${canonicalParams(spec.params)}`;
}
