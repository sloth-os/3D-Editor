import { loadConfig } from './config';
import { createApp } from './app';
import { persistenceNote } from './persistence';
import { closeSharedRenderer } from './render';
import { stopOnSignals } from './shutdown';

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
      shutdownTimeoutSeconds: config.shutdownTimeoutMs / 1000,
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

  // SIGTERM, SIGINT: within SHUTDOWN_TIMEOUT_SECONDS (9 s by default: Docker sends SIGKILL 10 s
  // after SIGTERM), naming the projects that stayed unsaved; the render processes stop at once
  // (renders in progress are cancelled), a busy one would otherwise finish its request first
  stopOnSignals(
    {
      log: app.log,
      rooms: handle.rooms,
      close: () => Promise.all([handle.close(), closeSharedRenderer()]),
    },
    config,
    (code) => process.exit(code),
  );
  process.on('unhandledRejection', (reason) => app.log.error({ err: reason }, 'unhandled promise rejection'));
}

void main().catch((err: unknown) => {
  console.error('failed to start server:', err);
  process.exit(1);
});
