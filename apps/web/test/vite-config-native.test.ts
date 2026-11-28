// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, loadConfigFromFile, type Logger, type Plugin } from 'vite';
import { describe, expect, it } from 'vitest';

/*
 * vite.config.ts and every module it imports load with Vite's 'native' config loader (Node's own
 * import, which Vite plans to make its default): each names its imports with their file extension,
 * as Node resolves ES modules (vite.config.ts imports originForm from the server's import-free
 * request-target.ts, never from request-base.ts, whose own imports have no extension). Vite's
 * default loader, which bundles the config, would otherwise say at every `vite`, `vite preview` and
 * `vite build` that the config uses features the native loader does not support. It checks the
 * imports as it bundles them, on any Node; the native loader itself needs a Node that strips types
 * (the default from Node 22.18; engines allows 22.12).
 */

const CONFIG = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const ROOT = path.dirname(CONFIG);
const ENV = { command: 'build', mode: 'production' } as const;
/** Whether this Node imports a .ts module itself, as Vite's native loader has it do. */
const NODE_STRIPS_TYPES = Boolean(process.features.typescript);

/** A logger that keeps every message Vite gives it, and lets nothing through to the console. */
function keepingLogger(): { logger: Logger; messages: string[] } {
  const messages: string[] = [];
  const quiet = createLogger('silent');
  const keep = (msg: string) => void messages.push(msg);
  return {
    messages,
    logger: { ...quiet, info: keep, warn: keep, warnOnce: keep, error: (msg) => keep(msg) },
  };
}

/** The names of a config's plugins, nested arrays flattened. */
const pluginNames = (plugins: unknown[] | undefined) =>
  (plugins ?? []).flat(Infinity).flatMap((p) => ((p as Plugin | null)?.name ? [(p as Plugin).name] : []));

describe('vite.config.ts', () => {
  it.skipIf(!NODE_STRIPS_TYPES)(
    "loads with Vite's 'native' config loader, its plugins included",
    async () => {
      const { logger, messages } = keepingLogger();
      const loaded = await loadConfigFromFile(ENV, CONFIG, ROOT, 'info', logger, 'native');
      expect(messages).toEqual([]);
      expect(loaded?.path).toBe(CONFIG);
      const names = pluginNames(loaded?.config.plugins);
      for (const name of ['desk-embed-headers', 'pages-under-their-base', 'desk-page-without-manifest'])
        expect(names, name).toContain(name);
    },
  );

  it("gives Vite's default loader nothing to say about the 'native' one", async () => {
    // the variable that turns the check off, as a shell may have it set
    const ignore = process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING;
    delete process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING;
    try {
      const { logger, messages } = keepingLogger();
      const loaded = await loadConfigFromFile(ENV, CONFIG, ROOT, 'info', logger);
      expect(pluginNames(loaded?.config.plugins)).toContain('desk-embed-headers');
      expect(messages.filter((m) => m.includes("configLoader: 'native'"))).toEqual([]);
    } finally {
      if (ignore !== undefined) process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = ignore;
    }
  });
});
