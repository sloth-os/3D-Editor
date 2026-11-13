// A render process that never reports that it is ready (a start that hangs).
process.on('disconnect', () => process.exit(0));
setInterval(() => undefined, 1000);
