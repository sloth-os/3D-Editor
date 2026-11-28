import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILD_TOP_LEVEL, RESERVED_PREFIXES } from '../../src/base-path';

/*
 * Serving under a subpath (docs/subpath.md) against the repository: the code blocks of its "Proxy
 * configurations" section are the copy-ready files in deploy/ (every directive line of a block is a
 * line of its file, in the block's order), Apache httpd's file and block keep the line that makes it
 * deliver its X-Forwarded-Prefix whatever a client names in Connection, the README has the
 * BASE_PATH row and the link to the doc, the files and anchors the doc names exist, and the paths it
 * says BASE_PATH may not start with are the server's (base-path.ts). Markdown is not formatted by
 * prettier, so nothing else checks these.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
/** A file of the repository, by its path from the root. */
const repo = (rel: string) => readFileSync(path.join(REPO, rel), 'utf8');
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const SUBPATH = 'docs/subpath.md';
const subpath = repo(SUBPATH);
const readme = repo('README.md');

/** The copy-ready file of each proxy's code block, by the block's language. */
const DEPLOY_FILES: Record<string, string> = {
  caddy: 'deploy/caddy/Caddyfile',
  nginx: 'deploy/nginx/3d-editor.conf',
  apache: 'deploy/httpd/3d-editor.conf',
};

/** The Markdown outside fenced code blocks (headings and prose only). */
const prose = (doc: string) => doc.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, '');

/** A doc's section: from its heading line to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = doc.slice(start + heading.length + 2);
  // headings only outside code blocks, where '#' starts a comment
  const fenced = [...rest.matchAll(/^```[^\n]*\n[\s\S]*?^```$/gm)].map((m) => [
    m.index,
    m.index + m[0].length,
  ]);
  const next = [...rest.matchAll(new RegExp(`\\n#{1,${level}} `, 'g'))].find(
    (m) => !fenced.some(([from, to]) => m.index > from && m.index < to),
  );
  return rest.slice(0, next ? next.index : undefined);
}

/** The fenced code blocks of a Markdown text: their language and their lines. */
function codeBlocks(md: string): { lang: string; lines: string[] }[] {
  return [...md.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((m) => ({
    lang: m[1],
    lines: m[2].split('\n'),
  }));
}

/** The directive lines of a configuration: trimmed, without blank lines and comments. */
const directives = (lines: string[]) =>
  lines.map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

/** The anchors of a Markdown doc's headings, as GitHub makes them. */
function anchors(doc: string): Set<string> {
  const out = new Set<string>();
  for (const m of prose(doc).matchAll(/^#{1,6} (.+)$/gm))
    out.add(
      m[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-'),
    );
  return out;
}

describe('docs/subpath.md: the proxy configurations', () => {
  const configurations = section(subpath, '## Proxy configurations');
  const blocks = codeBlocks(configurations).filter((b) => b.lang in DEPLOY_FILES);

  it('has a block for each of Caddy, nginx and Apache httpd, and links the copy-ready file of each', () => {
    expect(blocks.map((b) => b.lang)).toEqual(['caddy', 'nginx', 'apache']);
    for (const file of Object.values(DEPLOY_FILES)) {
      expect(existsSync(path.join(REPO, file)), file).toBe(true);
      expect(configurations, file).toContain(`[\`${file}\`](../${file})`);
    }
  });

  for (const block of blocks) {
    const file = DEPLOY_FILES[block.lang]!;
    it(`${file} has every directive line of the ${block.lang} block, in the block's order`, () => {
      const lines = directives(repo(file).split('\n'));
      const wanted = directives(block.lines);
      expect(wanted.length).toBeGreaterThan(5);
      let from = 0;
      for (const directive of wanted) {
        const at = lines.indexOf(directive, from);
        expect(at, `${directive} (in order, after ${lines[from - 1] ?? 'the start'})`).toBeGreaterThanOrEqual(
          0,
        );
        from = at + 1;
      }
    });
  }

  it('says what each file serves: /3d/ from 127.0.0.1:8080, the bare /3d redirected with 308', () => {
    expect(flat(configurations)).toContain(
      'Each serves `/3d/` from an editor server on `127.0.0.1:8080`, redirects `/3d` to `/3d/`',
    );
    for (const block of blocks) {
      const text = block.lines.join('\n');
      expect(text, block.lang).toContain('127.0.0.1:8080');
      expect(text, block.lang).toMatch(/\b308\b/);
      expect(text, block.lang).toContain('X-Forwarded-Prefix');
    }
  });
});

describe('docs/subpath.md: a stripping proxy delivers its X-Forwarded-Prefix', () => {
  const SET = 'RequestHeader set X-Forwarded-Prefix "/3d"';
  /** Removes a client's Connection that names X-Forwarded-Prefix, which mod_proxy_http would drop. */
  const UNSET = `RequestHeader unset Connection "expr=req_novary('Connection') =~ /x-forwarded-prefix/i"`;
  const apacheBlock = () =>
    codeBlocks(section(subpath, '## Proxy configurations')).find((b) => b.lang === 'apache')!;

  it('Apache httpd removes such a Connection header after setting the header and before proxying, in its file and its block', () => {
    for (const [what, lines] of [
      [DEPLOY_FILES.apache!, directives(repo(DEPLOY_FILES.apache!).split('\n'))],
      ['the apache block', directives(apacheBlock().lines)],
    ] as const) {
      const location = lines.indexOf('<Location "/3d/">');
      const set = lines.indexOf(SET);
      const unset = lines.indexOf(UNSET);
      const proxy = lines.findIndex((l) => l.startsWith('ProxyPass '));
      const end = lines.indexOf('</Location>');
      expect(location, what).toBeGreaterThanOrEqual(0);
      expect(set, what).toBeGreaterThan(location);
      expect(unset, what).toBe(set + 1);
      expect(proxy, what).toBeGreaterThan(unset);
      expect(end, what).toBeGreaterThan(proxy);
      // one such line, and no Connection removed from every request
      expect(
        lines.filter((l) => l.startsWith('RequestHeader unset Connection')),
        what,
      ).toEqual([UNSET]);
    }
  });

  it('says why: the rule, the proxies it was tried with and why the Apache line is conditional', () => {
    const rule = flat(section(subpath, '#### A stripping proxy delivers its header'));
    expect(rule).toContain(
      'A stripping proxy must deliver its `X-Forwarded-Prefix` whatever the client sends, also when the client names the header in `Connection`.',
    );
    for (const proxy of ['nginx 1.24.0', 'Caddy v2.11.9', 'Apache httpd 2.4.58'])
      expect(rule).toContain(proxy);
    expect(rule).toContain(`\`${UNSET}\``);
    expect(rule).toContain('Removing `Connection` from every request also works, but then Apache ignores');
    expect(flat(section(subpath, '## Proxy configurations'))).toContain(
      'whatever the client names in `Connection` ([a stripping proxy delivers its header](#a-stripping-proxy-delivers-its-header))',
    );
  });
});

describe('README.md', () => {
  it('has the BASE_PATH row in its table of environment variables, linking the doc', () => {
    const variables = section(readme, '## Configuration (server environment variables)');
    const row = variables.split('\n').find((l) => l.startsWith('| `BASE_PATH`'));
    expect(row).toBeDefined();
    expect(row).toContain('](docs/subpath.md)');
  });

  it('links the doc in its Documentation list', () => {
    expect(section(readme, '## Documentation')).toContain('[Serving under a subpath](docs/subpath.md)');
  });
});

describe('docs/subpath.md: what it names', () => {
  it('names files of the repository that exist (the deploy files, the tests, the modules)', () => {
    // code spans that are paths of files: a directory of the repository and a file name with its
    // extension (apps/web/dist, a build's output, is no file of the repository)
    const files = [...prose(subpath).matchAll(/`((?:apps|packages|e2e|deploy|docs)\/[\w./-]+\.\w+)`/g)].map(
      (m) => m[1]!,
    );
    for (const file of [
      'apps/web/src/app/base-url.ts',
      'apps/server/test/unit/base-path.test.ts',
      'apps/server/test/integration/subpath.test.ts',
      'apps/web/test/base-url.test.ts',
      'e2e/tests/subpath.spec.ts',
      'e2e/fixtures/prefix-proxy.mjs',
      ...Object.values(DEPLOY_FILES).filter((f) => f.includes('.')),
    ])
      expect(files, file).toContain(file);
    for (const file of files) expect(existsSync(path.join(REPO, file)), file).toBe(true);
  });

  it('links files and headings that exist', () => {
    const links = [...prose(subpath).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(10);
    for (const link of links) {
      if (/^[a-z]+:/.test(link)) continue;
      const [target, anchor] = link.split('#') as [string, string | undefined];
      const file = target ? path.join(REPO, 'docs', target) : path.join(REPO, SUBPATH);
      expect(existsSync(file), link).toBe(true);
      if (anchor) expect(anchors(readFileSync(file, 'utf8')), link).toContain(anchor);
    }
  });

  it("lists the server's own top-level paths as those BASE_PATH may not start with, and X-Forwarded-Prefix may", () => {
    const basePath = flat(section(subpath, '## The base path'));
    const rule =
      /The first segment of `BASE_PATH` is none of the server's own top-level paths, (.*?), since the server removes/.exec(
        basePath,
      );
    expect(rule).not.toBeNull();
    const listed = [...rule![1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(listed.sort()).toEqual([...RESERVED_PREFIXES.map((p) => p.slice(1)), ...BUILD_TOP_LEVEL].sort());
    expect(basePath).toContain(
      "The base in `X-Forwarded-Prefix` follows the same rules, but its first segment may be one of the server's own paths",
    );
  });
});
