// A stand-in for the server: starts a render process from the TypeScript sources (worker-dev.mjs)
// with the test requests on, keeps it busy, prints its pid and is then killed with SIGKILL, so the
// render process is left busy without its server.
//   node render-orphan.mjs <worker-dev.mjs>
import { fork } from 'node:child_process';
const child = fork(process.argv[2], [], {
  execArgv: ['--expose-gc'],
  env: { ...process.env, RENDER_WORKER_TEST_JOBS: '1' },
  serialization: 'advanced',
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
child.on('message', (m) => {
  if (m.type !== 'ready') return;
  child.send({ type: 'test-busy', id: 1, ms: 60_000 });
  setTimeout(() => {
    process.stdout.write(`${child.pid}\n`, () => process.kill(process.pid, 'SIGKILL'));
  }, 200);
});
