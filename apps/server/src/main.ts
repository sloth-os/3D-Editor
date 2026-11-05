import { loadConfig } from './config';
import { createApp } from './app';
import { persistenceNote } from './persistence';

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
    const force = setTimeout(() => {
      app.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 20_000);
    force.unref();
    handle
      .close()
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
