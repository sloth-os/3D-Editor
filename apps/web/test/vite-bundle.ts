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

/** The name the bundle's code reads `import.meta.hot` by: the stand-in HOT_CONTEXT declares it. */
const HOT = '__viteBundleHot';

/**
 * A stand-in for the hot context the dev server gives the modules it serves (`import.meta.hot`):
 * an object, as there, with every method of Vite's own (HMRContext in vite/dist/client/client.mjs)
 * taking its arguments and doing nothing, since no update ever comes to the bundle, and one `data`
 * object. So a module's HMR code (`if (import.meta.hot) …`, `import.meta.hot.accept()`, `dispose`,
 * `on`, `invalidate` …) runs as it does in the dev server's worker, where a build reads undefined.
 * It is the output's intro: at the top of the script's function, and left out by the bundler when no
 * module reads `import.meta.hot`.
 */
const HOT_CONTEXT =
  `var ${HOT} = { data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, ` +
  'decline() {}, invalidate() {}, on() {}, off() {}, send() {} };';

/**
 * What the dev server's modules read that a build would replace another way, as the dev server
 * serves them to a browser in its mode, 'development' (the mode bundle() builds in, so
 * `import.meta.env.MODE` is that too):
 * - `process.env`: NODE_ENV only, as that mode (Vite's client-inject), every other read left as
 *   written, for the browser to run (a worker has no `process`). A build would replace
 *   `process.env` itself with `{}`, so that a module reading `process.env.X` at load would run in
 *   the bundle but throw in the dev server's worker.
 * - `import.meta.env.DEV` and `PROD`: true and false, as the dev server has them; a build takes them
 *   from NODE_ENV, not from its mode (in a test run 'test', so already so; when unset, 'production').
 * - `import.meta.hot`: the stand-in HOT_CONTEXT, where a build reads undefined, so that code the dev
 *   server's modules run only under HMR runs in the bundle too.
 */
const DEV_NODE_ENV = JSON.stringify('development');
const DEV_DEFINE: Record<string, string> = {
  'process.env.NODE_ENV': DEV_NODE_ENV,
  'global.process.env.NODE_ENV': DEV_NODE_ENV,
  'globalThis.process.env.NODE_ENV': DEV_NODE_ENV,
  'import.meta.env.DEV': 'true',
  'import.meta.env.PROD': 'false',
  'import.meta.hot': HOT,
};

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
 * An entry of the web app (an absolute path) bundled by Vite's build() in the dev server's mode
 * ('development') with no config of the app's (only its root), nothing written and no module
 * tree-shaken away, so that every module the entry imports is in the bundle:
 * - `packages: 'bundled'` (the default): every module, packages included, in one classic script
 *   (iife), as a browser loads a worker; a Node built-in imported anywhere in the graph fails the
 *   build (noNodeBuiltins), and `process.env`, `import.meta.env` and `import.meta.hot` read as the
 *   dev server serves them (DEV_DEFINE, and HOT_CONTEXT at the top of the script), so that code
 *   run without Node's globals reads what the dev server's worker would;
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
    mode: 'development',
    logLevel: 'silent',
    plugins: bundled ? [noNodeBuiltins()] : [],
    // what the dev server's modules read (DEV_DEFINE): the build's own define of process.env left out
    ...(bundled ? { define: DEV_DEFINE, environments: { client: { keepProcessEnv: true } } } : {}),
    build: {
      write: false,
      minify: false,
      rolldownOptions: {
        input: entry,
        // a package, not a path: left out ('\0…' is one of Vite's own modules)
        external: bundled ? undefined : (id) => /^[\w@]/.test(id) && !isAbsolute(id),
        treeshake: false,
        output: bundled ? { format: 'iife', intro: HOT_CONTEXT } : undefined,
      },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunks = outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .flatMap((file) => (file.type === 'chunk' ? [file] : []));
  return { code: chunks.map((c) => c.code).join('\n'), modules: chunks.flatMap((c) => c.moduleIds) };
}
