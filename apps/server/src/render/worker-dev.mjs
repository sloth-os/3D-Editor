// Development entry of the render processes: runs the TypeScript sources (worker.ts and the core
// package) through tsx. The pool starts render processes without the server's Node flags, so the
// loader is registered here (unless a tsx loader is already active). The production bundle uses
// dist/render-worker.js instead.
if (!process.execArgv.some((arg) => arg.includes('tsx'))) {
  const { register } = await import('tsx/esm/api');
  register();
}
await import('./worker.ts');
