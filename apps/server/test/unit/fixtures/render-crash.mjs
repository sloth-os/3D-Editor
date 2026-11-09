// A render process that crashes on its first request with an uncaught exception (Node prints the
// error, its stack and its version banner on stderr and exits with code 1).
process.on('disconnect', () => process.exit(0));
process.on('message', (m) => {
  if (m.type === 'clear' || m.type === 'release') return;
  setImmediate(() => {
    throw new TypeError('boom in a render process');
  });
});
process.send({ type: 'ready', pid: process.pid, heapLimitMb: 1 });
