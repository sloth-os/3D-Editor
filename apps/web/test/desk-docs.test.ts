import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_EXPORT_HEIGHT, MAX_EXPORT_WIDTH } from '@3d-editor/core';
import { DEFAULT_DESK_EMBED, deskHeadersFor } from '../../server/src/desk-embed';
import {
  PROGRESS_INTERVAL_MS,
  READY_CHECK,
  STATE_MIN_INTERVAL_MS,
  STATE_QUIET_MS,
} from '../src/embed/controller';
import {
  DESK_MESSAGE_SCHEMAS,
  ERROR_CODES,
  HOST_MESSAGE_SCHEMAS,
  MAX_OPEN_UNIT_BYTES,
  MAX_OPEN_UNITS,
  MAX_STATE_BYTES,
  MAX_STATE_UNITS,
  MAX_THUMBNAIL_BYTES,
  MAX_UNIT_BYTES,
  MAX_UNIT_META_BYTES,
  MODES,
  PUBLISH_ACK_BASE_MS,
  PUBLISH_ACK_PER_MIB_MS,
  PUBLISH_REFUSALS,
  UNIT_DATA_FORMAT,
  UNIT_DATA_VERSION,
  UNIT_KINDS,
  UNIT_PENDING_REASONS,
  UNIT_REFUSED_REASONS,
  publishAckTimeoutMs,
} from '../src/embed/protocol';
import { CONTAINER_VERSION, STATE_MAGIC } from '../src/embed/state';

/*
 * docs/embedding.md against the code: the messages of each direction, the error codes and modes,
 * the timings and limits, library units' kinds, limits, publish refusals and the reasons a pin
 * waits or is refused, the headers and their defaults, the desk state's container, the fixtures
 * it lists, links that resolve, the docs that link to it, and the Markdown the formatter does not
 * check (*.md is prettier-ignored).
 */

const ROOT = resolve(__dirname, '../../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');
const DOC_PATH = 'docs/embedding.md';
const doc = read(DOC_PATH);
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** A doc's section: from its heading line to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = text.slice(start + heading.length + 2);
  const next = new RegExp(`\\n#{1,${level}} `).exec(rest);
  return rest.slice(0, next ? next.index : undefined);
}

/** The cells of a Markdown table row (`|` inside code spans does not split). */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let tick = 0;
  for (let i = 1; i < line.length; i++) {
    const c = line[i];
    if (c === '`') {
      let n = 1;
      while (line[i + n] === '`') n++;
      tick = tick === 0 ? n : tick === n ? 0 : tick;
      cur += '`'.repeat(n);
      i += n - 1;
    } else if (c === '|' && tick === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  return out;
}

/** The tables of a Markdown text (outside code blocks): header cells, rows of cells, their lines. */
function tables(text: string): { header: string[]; rows: string[][]; lines: string[] }[] {
  const out: { header: string[]; rows: string[][]; lines: string[] }[] = [];
  let fence = false;
  let cur: string[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push({ header: cells(cur[0]), rows: cur.slice(2).map(cells), lines: cur });
    cur = [];
  };
  for (const l of text.split('\n')) {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      flush();
    } else if (!fence && l.startsWith('|')) cur.push(l);
    else flush();
  }
  flush();
  return out;
}

/** The text of a doc outside its code blocks. */
const prose = (text: string) => text.replace(/^```[\s\S]*?^```$/gm, '');

/** GitHub's anchor of a heading. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');

const anchors = (text: string) =>
  new Set([...prose(text).matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1].trim())));

describe('docs/embedding.md', () => {
  it('lists every message of the protocol in the table of its direction', () => {
    const first = (heading: string) =>
      tables(section(doc, heading))[0].rows.map((r) => r[0].replace(/`/g, ''));
    expect(first('### Messages from the host')).toEqual(Object.keys(HOST_MESSAGE_SCHEMAS));
    expect(first('### Messages from the desk')).toEqual(Object.keys(DESK_MESSAGE_SCHEMAS));
  });

  it("gives the code's error codes, modes, limits and timings", () => {
    const types = /```ts\n([\s\S]*?)```/.exec(section(doc, '### Types'))![1];
    const quoted = (decl: string) => [...decl.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(quoted(/type ErrorCode = ([\s\S]*?);/.exec(types)![1])).toEqual([...ERROR_CODES]);
    expect(quoted(/type Mode = ([^;]*);/.exec(types)![1])).toEqual([...MODES]);
    const text = flat(doc);
    expect(MAX_STATE_BYTES).toBe(64 * 1024 * 1024);
    expect(text).toContain('at most 64 MiB');
    expect(text).toContain(`an export at most ${MAX_EXPORT_WIDTH} × ${MAX_EXPORT_HEIGHT}`);
    expect(text).toContain(`a brief over ${MAX_EXPORT_WIDTH} × ${MAX_EXPORT_HEIGHT}`);
    expect(text).toContain(`${STATE_QUIET_MS / 1000} s after the last edit`);
    expect(text).toContain(`at most one every ${STATE_MIN_INTERVAL_MS / 1000} s`);
    expect(text).toContain(`one message every ${PROGRESS_INTERVAL_MS} ms`);
    expect(text).toContain(`${READY_CHECK.width} × ${READY_CHECK.height} at ${READY_CHECK.fps} fps`);
  });

  it('gives the headers the server sends and the defaults of its configuration', () => {
    const rows = tables(section(doc, '### Headers'))[0].rows;
    // rows without a path continue the one above
    const byPath = new Map<string, Map<string, string>>();
    let path = '';
    for (const [p, header, value] of rows) {
      if (p) path = p;
      if (!byPath.has(path)) byPath.set(path, new Map());
      byPath.get(path)!.set(header.replace(/`/g, '').toLowerCase(), value);
    }
    const page = byPath.get('`/desk.html` (and `/desk`)')!;
    const assets = byPath.get('`/assets/*` (scripts, styles, workers)')!;
    const sent = {
      page: deskHeadersFor('desk.html', DEFAULT_DESK_EMBED),
      assets: deskHeadersFor('assets/x.js', DEFAULT_DESK_EMBED),
    };
    expect(page.get('cross-origin-embedder-policy')).toContain(
      `\`${sent.page['cross-origin-embedder-policy']}\` (default)`,
    );
    expect(page.get('cross-origin-resource-policy')).toBe(`\`${sent.page['cross-origin-resource-policy']}\``);
    expect(sent.page['content-security-policy']).toBe('frame-ancestors *');
    expect(page.get('content-security-policy')).toMatch(/^`frame-ancestors` .*\(default `\*`\)$/);
    expect(assets.get('cross-origin-embedder-policy')).toBe('as the page');
    expect(sent.assets['cross-origin-embedder-policy']).toBe(sent.page['cross-origin-embedder-policy']);
    expect(assets.get('cross-origin-resource-policy')).toBe(
      `\`${sent.assets['cross-origin-resource-policy']}\``,
    );
    expect(sent.assets['content-security-policy']).toBeUndefined();
    // the cache policy of the server's static files (static.ts cacheControlFor)
    const statics = read('apps/server/src/static.ts');
    for (const [headers, value] of [
      [page, 'no-cache'],
      [assets, 'public, max-age=31536000, immutable'],
    ] as const) {
      expect(headers.get('cache-control')).toBe(`\`${value}\``);
      expect(statics).toContain(`'${value}'`);
    }

    // the defaults: config.ts's schema, desk-embed.ts's, and the docs' (here and in the README)
    const config = read('apps/server/src/config.ts');
    const configDefault = (name: string) =>
      new RegExp(`${name}: z\\.string\\(\\)\\.default\\('([^']*)'\\)`).exec(config)?.[1];
    expect(configDefault('DESK_EMBED_COEP')).toBe(DEFAULT_DESK_EMBED.coep);
    expect(configDefault('DESK_EMBED_ORIGINS')).toBe(DEFAULT_DESK_EMBED.frameAncestors.join(','));
    const readme = read('README.md');
    for (const text of [section(doc, '### Configuration'), readme]) {
      const table = tables(text).find(
        (t) => t.header[1] === 'Default' && t.rows.some((r) => r[0] === '`DESK_EMBED_COEP`'),
      )!;
      const row = (name: string) => table.rows.find((r) => r[0] === `\`${name}\``)!;
      expect(row('DESK_EMBED_COEP')[1]).toBe(`\`${configDefault('DESK_EMBED_COEP')}\``);
      expect(row('DESK_EMBED_ORIGINS')[1]).toBe(`\`${configDefault('DESK_EMBED_ORIGINS')}\``);
      for (const v of ['require-corp', 'credentialless', 'off'])
        expect(row('DESK_EMBED_COEP')[2]).toContain(`\`${v}\``);
    }
  });

  it("gives library units' kinds, limits, timings, refusals and reasons as the protocol has them", () => {
    const units = section(doc, '## Library units');
    const text = flat(units);
    const MiB = 1024 * 1024;
    expect([MAX_UNIT_BYTES, MAX_OPEN_UNIT_BYTES]).toEqual([32 * MiB, 48 * MiB]);
    expect([MAX_THUMBNAIL_BYTES, MAX_UNIT_META_BYTES]).toEqual([64 * 1024, 16 * 1024]);
    expect(text).toContain(`format \`${UNIT_DATA_FORMAT}\`, version ${UNIT_DATA_VERSION}`);
    const types = /```ts\n([\s\S]*?)```/.exec(units)![1];
    expect(types).toContain(`kinds: (${UNIT_KINDS.map((k) => `'${k}'`).join(' | ')})[];`);
    expect(types).toContain(`format: '${UNIT_DATA_FORMAT}'; version: ${UNIT_DATA_VERSION};`);
    const quoted = (decl: string) => [...decl.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(quoted(/type PublishRefusal = ([^;]*);/.exec(types)![1])).toEqual([...PUBLISH_REFUSALS]);

    // the limits table, row by row
    const limits = new Map(
      tables(section(doc, '### Unit limits and timings'))[0].rows.map((r) => [r[0], r[1]]),
    );
    expect(limits.get('A unit file')).toContain(
      `1 byte to 32 MiB (\`capabilities.units.maxBytes\`: ${MAX_UNIT_BYTES})`,
    );
    expect(limits.get('`open.units`')).toBe(
      `at most ${MAX_OPEN_UNITS} entries (a set, 16 cast members, 64 elements), at most 48 MiB in all`,
    );
    expect(limits.get('A thumbnail')).toContain('at most 64 KiB');
    expect(limits.get('`meta`')).toContain('at most 16 KiB as JSON in UTF-8');
    expect(limits.get('`state.units`')).toBe(`at most ${MAX_STATE_UNITS} rows`);
    const wait = limits.get("The desk's wait for `unit-ack`")!;
    expect(wait).toContain(
      `${PUBLISH_ACK_BASE_MS / 1000} s plus ${PUBLISH_ACK_PER_MIB_MS / 1000} s per MiB of the file`,
    );
    expect(wait).toContain(`(${publishAckTimeoutMs(MAX_UNIT_BYTES) / 1000} s for 32 MiB)`);
    expect(text).toContain(`${publishAckTimeoutMs(MAX_UNIT_BYTES) / 1000} s for 32 MiB`);

    // the refusals of a publish, in the protocol's order
    const codes = tables(section(doc, '### Publishing and linking'))[0].rows.map((r) => r[0]);
    expect(codes).toEqual(PUBLISH_REFUSALS.map((c) => `\`${c}\``));

    // every reason a slot waits or is refused, with its record state, in the protocol's order
    const failures = tables(section(doc, '### When a unit is not used'))[0].rows;
    const reasons = (staged: string) =>
      failures.filter((r) => r[1] === `\`${staged}\`` && r[0].startsWith('`')).map((r) => r[0]);
    expect(reasons('pending')).toEqual(UNIT_PENDING_REASONS.map((w) => `\`${w}\``));
    expect(reasons('refused')).toEqual(UNIT_REFUSED_REASONS.map((w) => `\`${w}\``));
    expect(failures.filter((r) => r[1] === '`unit`')).toHaveLength(2);
  });

  it('describes the desk state container as state.ts writes it', () => {
    const rows = tables(section(doc, '### The desk state'))[0].rows;
    const magic = /`([^`]+)`/
      .exec(rows.find((r) => r[0] === '0–7')![1])![1]
      .replace('\\r', '\r')
      .replace('\\n', '\n');
    expect(new TextEncoder().encode(magic)).toEqual(STATE_MAGIC);
    expect(rows.find((r) => r[0] === '8')![1]).toContain(`\`${CONTAINER_VERSION}\``);
    // version 2 for a document with instances of library units (the rule older desks refuse)
    expect(rows.find((r) => r[0] === '8')![1]).toMatch(/`1`, or `2` when the document holds instances/);
    expect(flat(section(doc, '### The desk state'))).toContain(
      'it answers a version-2 state with `error` `state_unreadable`',
    );
    const header = rows.find((r) => r[0] === 'header')![1];
    for (const key of ['sceneId', 'lineage', 'shots', 'savedAt', 'deskVersion', 'updateBytes'])
      expect(header).toContain(`\`${key}\``);
  });

  it("names, under Testing a host, every member of the fake host's window.host and each desk spec", () => {
    const host = read('e2e/fixtures/desk-host/index.html');
    const block = host.slice(host.indexOf('window.host = {'), host.indexOf('window.host.mount();'));
    // the members of window.host: methods and properties at its first level
    const members = [...block.matchAll(/^ {8}(\w+)(?=\(|,|:)/gm)].map((m) => m[1]);
    expect(members).toEqual(expect.arrayContaining(['open', 'publishMode', 'ackPublish', 'library']));
    const testing = section(doc, '## Testing a host');
    for (const name of members) expect(testing, name).toContain(`\`${name}\``);
    // the open's library units, and the answers publishMode gives
    expect(flat(testing)).toContain('`units`');
    for (const mode of ['linked', 'linked-always', 'unlinked', 'refused:<code>', 'never']) {
      expect(host, mode).toContain(`'${mode.replace(':<code>', ':')}`);
      expect(testing, mode).toContain(`\`${mode}\``);
    }
    for (const spec of readdirSync(resolve(ROOT, 'e2e/tests')).filter((f) => /^desk-.*\.spec\.ts$/.test(f)))
      expect(testing, spec).toContain(`e2e/tests/${spec}`);
  });

  it('lists the fixtures this repository keeps', () => {
    const dir = resolve(__dirname, 'fixtures/desk-protocol');
    const json = (d: string) => readdirSync(d).filter((f) => f.endsWith('.json'));
    const valid = json(dir);
    const invalid = json(resolve(dir, 'invalid'));
    const fixtures = flat(section(doc, '### Fixtures'));
    expect(fixtures).toContain(`the ${valid.length} valid messages`);
    for (const f of valid) expect(fixtures).toContain(`\`${f}\``);
    expect(fixtures).toContain(`the ${invalid.length} that must not validate`);
    expect(existsSync(resolve(ROOT, 'packages/core/test/fixtures/desk-embed'))).toBe(true);
  });

  it('links to files and headings that exist, and the docs that name it link to it', () => {
    let links = 0;
    for (const m of prose(doc).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/.test(target)) continue;
      const [file, anchor] = target.split('#');
      const path = file ? resolve(ROOT, dirname(DOC_PATH), file) : resolve(ROOT, DOC_PATH);
      expect(existsSync(path), target).toBe(true);
      if (anchor) expect(anchors(readFileSync(path, 'utf8')).has(anchor), target).toBe(true);
      links++;
    }
    expect(links).toBeGreaterThan(15);
    for (const f of [
      'README.md',
      'docs/agent-guide.md',
      'docs/architecture.md',
      'docs/director-desk.md',
      'docs/features.md',
      'docs/mcp.md',
    ])
      expect(read(f), f).toMatch(/\]\((?:docs\/)?embedding\.md\)/);
  });

  it('has aligned tables, code spans on one line and prose within 100 columns', () => {
    for (const t of tables(doc)) {
      const widths = new Set(t.lines.map((l) => Array.from(l).length));
      expect(widths.size, t.lines[0]).toBe(1);
    }
    let fence = false;
    doc.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) fence = !fence;
      if (fence || /^\s*```/.test(line) || line.startsWith('|')) return;
      // a run of backticks opens a span that the next run of the same length closes
      let open = 0;
      for (const [run] of line.matchAll(/`+/g))
        open = open === 0 ? run.length : open === run.length ? 0 : open;
      expect(open, `line ${i + 1}: ${line}`).toBe(0);
      if (Array.from(line).length <= 100) return;
      // longer only when it cannot break: one code span or word after the list marker
      const rest = line.replace(/^\s*(?:[-*]|\d+\.)?\s*/, '').replace(/(`+)[\s\S]*?\1/g, 'x');
      expect(rest.trim(), `line ${i + 1}: ${line}`).not.toMatch(/ /);
    });
  });
});
