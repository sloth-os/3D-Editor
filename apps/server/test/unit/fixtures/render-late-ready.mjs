// A render process that reports that it is ready at once and writes the file RENDER_READY_MARKER
// names once the message is on its way (a test makes the server read it after its start timeout).
import { writeFileSync } from 'node:fs';

process.on('disconnect', () => process.exit(0));
process.send({ type: 'ready', pid: process.pid, heapLimitMb: 99 }, () =>
  writeFileSync(process.env.RENDER_READY_MARKER, 'sent'),
);
setInterval(() => undefined, 1000);
