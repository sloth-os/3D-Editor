import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';

/*
 * A module graph of the web app as Vite's own bundler puts it together, for the tests that check
 * what a Web Worker imports and runs (base-url.test.ts, desk-stage-worker-safety.test.ts). It uses
 * Vite's build(): vite is a dependency of apps/web, so no bundler the app does not declare.
 */

/**
 * apps/web: the root the bundle is built from (no config of the app's is loaded). From this
 * module's file path: in a test that runs in happy-dom, vitest transforms the module as Vite does a
 * browser's code, which turns `new URL('..', import.meta.url)` into a URL of its server
 * (http://localhost:3000/…), no file URL.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A module graph bundled by bundle(). */
export interface Bundle {
  /** The code of its chunks: with every package bundled, one classic script (iife). */
  code: string;
  /** The ids of the modules in its chunks, absolute paths (`\0…` ids are Vite's own modules). */
  modules: string[];
}

/**
 * Fails the build at an import of a Node built-in that no package stands for in a browser, where
 * Vite would put its empty stand-in (`__vite-browser-external`) and build on.
 */
function noNodeBuiltins(): Plugin {
  return {
    name: 'no-node-builtins',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved?.id.startsWith('__vite-browser-external'))
        this.error(`${importer ?? 'the entry'} imports ${source}, a Node built-in: a browser has none`);
      return resolved;
    },
  };
}

/**
 * An entry of the web app (an absolute path) bundled by Vite's build() with no config of the
 * app's (only its root), nothing written and no module tree-shaken away, so that every module the
 * entry imports is in the bundle:
 * - `packages: 'bundled'` (the default): every module, packages included, in one classic script
 *   (iife), as a browser loads a worker; a Node built-in imported anywhere in the graph fails the
 *   build (noNodeBuiltins);
 * - `packages: 'external'`: the app's own modules only, every package left out.
 */
export async function bundle(
  entry: string,
  { packages = 'bundled' }: { packages?: 'bundled' | 'external' } = {},
): Promise<Bundle> {
  const bundled = packages === 'bundled';
  const output = await build({
    configFile: false,
    root: ROOT,
    logLevel: 'silent',
    plugins: bundled ? [noNodeBuiltins()] : [],
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        // a package, not a path: left out ('\0…' is one of Vite's own modules)
        external: bundled ? undefined : (id) => /^[\w@]/.test(id) && !isAbsolute(id),
        treeshake: false,
        output: bundled ? { format: 'iife' } : undefined,
      },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunks = outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .flatMap((file) => (file.type === 'chunk' ? [file] : []));
  return { code: chunks.map((c) => c.code).join('\n'), modules: chunks.flatMap((c) => c.moduleIds) };
}
