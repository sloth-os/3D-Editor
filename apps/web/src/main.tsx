import { render } from 'preact';
import { App } from './ui/App';
import './ui/styles.css';
import { serverConfig, serverChecked, toast } from './app/store';
import { fetchServerConfig } from './app/server-config';
import { setupTelemetry } from './telemetry/setup';
import { registerUiOperators } from './editor/ui-operators';
import { registry } from './editor/editor';
import { installKeymap } from './editor/keymap';
import { installRpcHandler } from './editor/rpc';
import { openProject, projectFromUrl } from './project/manager';
import { registerPWA } from './pwa/register';
import { telemetry } from './telemetry/telemetry';
import { importFiles } from './io/import-export';

registerUiOperators(registry);
installKeymap();
installRpcHandler();

async function boot(): Promise<void> {
  const span = telemetry.startSpan('app.boot');
  render(<App />, document.getElementById('app')!);
  serverConfig.value = await fetchServerConfig();
  serverChecked.value = true;
  setupTelemetry();
  void registerPWA();
  const id = projectFromUrl();
  if (id) {
    try {
      await openProject(id);
    } catch (err) {
      toast(`Could not open project: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }
  // Files opened through the OS (PWA file handlers)
  const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
  lq?.setConsumer(async (params) => {
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    if (files.length) await importFiles(files);
  });
  span.setAttribute('server.available', !!serverConfig.value).setOk().end();
}

void boot();

// expose a small debugging/scripting hook (also used by end-to-end tests)
Object.assign(window, { __editor: { registry, telemetry } });
