// Development entry of the render worker: runs the TypeScript sources (worker.ts and the core
// package) through tsx. Under `tsx` the loader is inherited from the parent's execArgv; elsewhere
// (e.g. vitest) it is registered here. The production bundle uses dist/render-worker.js instead.
if (!process.execArgv.some((arg) => arg.includes('tsx'))) {
  const { register } = await import('tsx/esm/api');
  register();
}
await import('./worker.ts');
