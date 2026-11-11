import { loadConfig } from './config';
import { createApp } from './app';
import { persistenceNote } from './persistence';
import { closeSharedRenderer } from './render';

/**
 * How long a shutdown (SIGTERM, SIGINT) may take before the server exits anyway: Docker sends
 * SIGKILL 10 s after SIGTERM.
 */
const SHUTDOWN_EXIT_MS = 9000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  const handle = await createApp(config);
  const { app } = handle;
  app.log.info(
    {
      persistence: handle.persistence.mode,
      location: handle.persistence.location,
      mcp: config.mcpEnabled,
      auth: !!config.authToken,
      webdavProxy: config.webdavProxy,
      otel: config.otel?.endpoint ?? null,
      publicDir: config.publicDir,
    },
    '3d-editor server starting',
  );
  const note = `persistence: ${handle.persistence.mode} (${handle.persistence.location}): ${persistenceNote(handle.persistence.mode)}`;
  if (handle.persistence.mode === 'memory') app.log.warn(note);
  else app.log.info(note);
  await app.listen({ port: config.port, host: config.host });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  app.log.info(
    {
      url: `http://${shownHost}:${port}/`,
      mcp: config.mcpEnabled ? `http://${shownHost}:${port}/mcp` : null,
    },
    'server listening',
  );

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down: closing connections and saving projects');
    // within Docker's stop timeout (SIGKILL 10 s after SIGTERM); the rooms wait for storage 7 s
    // at most (RoomManager.close), and say which projects stayed unsaved
    const force = setTimeout(() => {
      const unsaved = handle.rooms.unsaved();
      if (unsaved.length > 0)
        app.log.error(
          { projects: unsaved, reason: 'the shutdown ran out of time before storage saved their changes' },
          'projects not saved at shutdown',
        );
      app.log.error(`shutdown timed out after ${SHUTDOWN_EXIT_MS / 1000} s, exiting`);
      process.exit(1);
    }, SHUTDOWN_EXIT_MS);
    force.unref();
    // the render processes stop at once (renders in progress are cancelled); a busy one would
    // otherwise finish its request first
    Promise.all([handle.close(), closeSharedRenderer()])
      .then(() => {
        app.log.info('shutdown complete');
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'shutdown failed');
        process.exit(1);
      });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled promise rejection'));
}

void main().catch((err: unknown) => {
  console.error('failed to start server:', err);
  process.exit(1);
});
