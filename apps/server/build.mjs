// Bundles the server into ESM files: dist/main.js (the server) and dist/render-worker.js (the
// entry of the render processes, which src/render/pool.ts starts with child_process.fork from
// the directory of main.js).
// @3d-editor/* workspace packages are bundled from their TypeScript sources; every other
// package stays external and is resolved from node_modules at runtime.
import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'));

/** Marks bare imports external, except workspace packages (bundled from source). */
const externalDependencies = {
  name: 'external-dependencies',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@3d-editor/')) return undefined;
      if (path.isAbsolute(args.path)) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await rm(path.join(here, 'dist'), { recursive: true, force: true });

const result = await build({
  absWorkingDir: here,
  entryPoints: { main: 'src/main.ts', 'render-worker': 'src/render/worker.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
  plugins: [externalDependencies],
  // CommonJS helpers (require/__dirname) for any bundled code that still expects them.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
});

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
console.log(
  `built ${pkg.name}@${pkg.version} → dist/main.js + dist/render-worker.js (${(bytes / 1024).toFixed(0)} KiB incl. sourcemaps)`,
);
