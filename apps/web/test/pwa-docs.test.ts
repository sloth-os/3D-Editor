import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDeskEmbedOrigins } from '../../server/src/desk-embed';
import { UPDATE_WAITS_FOR_DESK_NOTE } from '../src/pwa/update-waits';

/*
 * The docs of the app's serving, its service worker and the built-in thumbnails against the code:
 * the README's APP_VERSION row and the server's thumbnail cache key, the IndexedDB fallback of
 * docs/model-store.md and the desk's sandbox rule (embedding.md "The iframe"), the Update that
 * waits for a desk page (storage-and-sync.md "Offline / PWA", embedding.md "Offline") and the
 * ports DESK_EMBED_ORIGINS accepts (embedding.md "Configuration").
 */

const ROOT = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** A doc's section: from its heading line to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = text.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end < 0 ? rest : rest.slice(0, end);
}

describe("README: APP_VERSION also keys the server's built-in thumbnail cache", () => {
  it('as the store builds the key from the configured version', () => {
    expect(read('apps/server/src/config.ts')).toContain('version: e.APP_VERSION ?? PACKAGE_VERSION,');
    expect(read('apps/server/src/store/index.ts')).toContain(
      '`builtin:${id}:v${THUMBNAIL_VERSION}:${this.ctx.config.version}:${build}:${THUMBNAIL_SIZE}`',
    );
    const row = read('README.md')
      .split('\n')
      .find((l) => l.startsWith('| `APP_VERSION`'));
    expect(row).toBeDefined();
    expect(flat(row!)).toMatch(/Version reported by `\/healthz` and in logs; also part of the key of the/);
    expect(row).toContain("server's built-in model thumbnail cache");
    expect(row).toContain('(docs/model-store.md#thumbnails)');
  });
});

describe('docs/model-store.md: where the thumbnail cache stays in the page', () => {
  const thumbnails = flat(section(read('docs/model-store.md'), '## Thumbnails'));
  const iframe = flat(section(read('docs/embedding.md'), '### The iframe'));

  it('lists no sandboxed frame as a case that works: the desk never connects in one', () => {
    // embedding.md: without allow-same-origin the desk's hello comes from no origin a host accepts
    expect(iframe).toContain('without `allow-same-origin` the desk');
    expect(iframe).toContain('the desk never connects');
    expect(thumbnails).not.toContain('a sandboxed frame)');
    expect(thumbnails).toContain(
      'A desk framed with a `sandbox` without `allow-same-origin` is not such a case: it never connects',
    );
    expect(thumbnails).toContain('(embedding.md#the-iframe)');
  });
});

describe("the editor's Update while a desk page is open", () => {
  it('waits, and the docs give the message the editor shows', () => {
    const pwa = flat(section(read('docs/storage-and-sync.md'), '## Offline / PWA'));
    expect(pwa).toContain('Update waits too, so that the files of a running desk never change under it');
    expect(pwa).toContain(`"${UPDATE_WAITS_FOR_DESK_NOTE}": close the desk, then press Update again`);
    const offline = flat(section(read('docs/embedding.md'), '### Offline'));
    expect(offline).toContain(`answers the editor, which says "${UPDATE_WAITS_FOR_DESK_NOTE}"`);
  });
});

describe('docs/embedding.md: the ports of DESK_EMBED_ORIGINS', () => {
  it('are the ones the server takes: 1 to 65535, or *', () => {
    const config = flat(section(read('docs/embedding.md'), '### Configuration'));
    expect(config).toContain('an optional port (1 to 65535, or `*`)');
    expect(
      parseDeskEmbedOrigins('https://a.example:1, https://b.example:65535, https://c.example:*'),
    ).toEqual(['https://a.example:1', 'https://b.example:65535', 'https://c.example:*']);
    for (const bad of ['https://a.example:0', 'https://a.example:65536'])
      expect(() => parseDeskEmbedOrigins(bad), bad).toThrow(/is not an origin: .* a port from 1 to 65535$/);
  });
});
