import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG, STORE_CATEGORIES } from '@3d-editor/core';
import { SERVICE_ERROR_CODES, codedErrorDetails } from '../../src/mcp/agent';
import { insertReply } from '../../src/store';
import { VideoExports } from '../../src/video';
import { clearFfmpegChecks, ffmpegUnavailable, hasFfmpeg, requireFfmpeg } from '../../src/video/ffmpeg';
import {
  EXPORT_PRESET_ALIASES,
  EXPORT_PRESET_PARAMS,
  MAX_EXPORT_HEIGHT,
  MAX_EXPORT_WAIT_S,
  MAX_EXPORT_WIDTH,
  REFERENCE_PASSES,
  videoExportParamsSchema,
} from '../../src/video/params';
import { MAX_EXPORT_FRAMES } from '../../src/video/plan';
import { makeFakeFfmpeg } from '../helpers/video-fake-ffmpeg';
import { exportScene, fakeContext, makeFakeRenderer } from '../helpers/video-fake-renderer';

/*
 * The director's desk docs (video-export.md, model-store.md, director-desk.md) and the README's
 * environment table against the code: what features.videoExport checks, the export messages and
 * what cancel deletes, the code line of the service errors, the proxy variable, the Docker image's
 * ffmpeg, the env defaults, the built-in catalog, the limits, and the Markdown the formatter does not
 * check (*.md is prettier-ignored).
 */

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** A file of the repository, by its path from the root. */
const repo = (rel: string) => file(`../../../../${rel}`);
const read = (doc: string) => repo(`docs/${doc}`);
/** A source file of the server (apps/server/src/…). */
const source = (rel: string) => file(`../../src/${rel}`);
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

const readme = repo('README.md');
const videoExport = read('video-export.md');
const modelStore = read('model-store.md');
const directorDesk = read('director-desk.md');
const mcp = read('mcp.md');
const NEW_DOCS = {
  'video-export.md': videoExport,
  'model-store.md': modelStore,
  'director-desk.md': directorDesk,
};

/** A doc's section: from its heading line to the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)![0].length;
  const rest = doc.slice(start + heading.length + 2);
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

/** The tables of a Markdown text (outside code blocks): header cells and rows of cells, and their lines. */
function tables(doc: string): { header: string[]; rows: string[][]; lines: string[] }[] {
  const out: { header: string[]; rows: string[][]; lines: string[] }[] = [];
  let fence = false;
  let cur: string[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push({ header: cells(cur[0]), rows: cur.slice(2).map(cells), lines: cur });
    cur = [];
  };
  for (const l of doc.split('\n')) {
    if (/^\s*```/.test(l)) {
      fence = !fence;
      flush();
    } else if (!fence && l.startsWith('|')) cur.push(l);
    else flush();
  }
  flush();
  return out;
}

/** The table row whose first cell starts with `first`. */
function row(doc: string, first: string): string[] {
  const hit = tables(doc)
    .flatMap((t) => t.rows)
    .find((r) => r[0].startsWith(first));
  expect(hit, first).toBeDefined();
  return hit!;
}

// ---------------------------------------------------------------- video-export.md

/** The export messages the troubleshooting table quotes come from the code. */
const VIDEO_SOURCES = readdirSync(fileURLToPath(new URL('../../src/video/', import.meta.url)))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => source(`video/${f}`))
  .join('\n');

describe('docs/video-export.md', () => {
  it('says what features.videoExport checks, and what an ffmpeg without libx264 answers', async () => {
    const fake = await makeFakeFfmpeg();
    const before = process.env.FAKE_FFMPEG_NO_X264;
    process.env.FAKE_FFMPEG_NO_X264 = '1';
    clearFfmpegChecks();
    try {
      expect(await hasFfmpeg(fake.path)).toBe(true);
      const err = (await requireFfmpeg(fake.path).catch((e: unknown) => e)) as {
        code?: string;
        message: string;
      };
      expect(err.code).toBe('FFMPEG_UNAVAILABLE');
      expect(err.message).toContain('has no libx264 encoder');
    } finally {
      if (before === undefined) delete process.env.FAKE_FFMPEG_NO_X264;
      else process.env.FAKE_FFMPEG_NO_X264 = before;
      clearFfmpegChecks();
    }
    // app.ts: the flag
    const flag = /const videoExport = ([^;]+);/.exec(source('app.ts'))?.[1];
    expect(flag).toBeDefined();
    const flagChecksEncoders = /ffmpegEncoders|requireFfmpeg|libx264/.test(flag!);
    const troubleshooting = section(videoExport, '## Troubleshooting');
    const off = row(troubleshooting, '`features.videoExport: false`');
    expect(off.join(' ').includes('libx264'), off.join(' | ')).toBe(flagChecksEncoders);
    if (!flagChecksEncoders) {
      expect(row(troubleshooting, '`FFMPEG_UNAVAILABLE` "has no libx264 encoder"')[0]).toContain(
        'although `features.videoExport` is `true`',
      );
      expect(flat(section(videoExport, '## Requirements'))).toContain(
        'reports `features.videoExport: true` when that works, whatever encoders that ffmpeg has',
      );
    }
  });

  it('quotes the messages of the code: both ends of a running export at a restart, the others', () => {
    const ends = [
      ...source('video/index.ts').matchAll(/'(server (?:shut down|restarted) while the export ran)/g),
    ];
    expect(ends.map((m) => m[1]).sort()).toEqual([
      'server restarted while the export ran',
      'server shut down while the export ran',
    ]);
    const jobs = flat(section(videoExport, '## Jobs'));
    const troubleshooting = section(videoExport, '## Troubleshooting');
    for (const [, message] of ends) {
      expect(jobs).toContain(`"${message}"`);
      expect(row(troubleshooting, `failed "${message}"`)).toBeDefined();
    }
    // every quoted message of the table is one the server writes
    const written = [
      VIDEO_SOURCES,
      ffmpegUnavailable('ffmpeg').message,
      ffmpegUnavailable('ffmpeg', 'libx264').message,
    ].join('\n');
    const symptoms = tables(troubleshooting)[0].rows.map((r) => r[0]);
    const quoted = symptoms.flatMap((s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    for (const q of quoted) expect(written, q).toContain(q);
  });

  it('says that cancel with delete_files deletes a finished export too', async () => {
    const fake = await makeFakeFfmpeg();
    const dir = await mkdtemp(path.join(tmpdir(), 'docs-desk-'));
    const renderer = makeFakeRenderer();
    const exports = new VideoExports(
      fakeContext({
        exportDir: dir,
        ffmpegPath: fake.path,
        renderer: renderer.renderer,
        projects: { p1: exportScene({ shots: 1, frames: 2 }).doc },
      }),
      { memory: () => ({ available: 2 ** 40, source: 'meminfo' }) },
    );
    try {
      let st = await exports.start('p1', videoExportParamsSchema.parse({ width: 32, height: 18 }));
      for (let i = 0; i < 40 && !['done', 'failed', 'cancelled'].includes(st.status); i++)
        st = await exports.status(st.id, { waitS: 5 });
      expect(st.status).toBe('done');
      // without delete_files a finished job stays as it is
      expect((await exports.cancel(st.id)).status).toBe('done');
      expect((await exports.status(st.id)).status).toBe('done');
      expect((await exports.cancel(st.id, { deleteFiles: true })).status).toBe('done');
      await expect(exports.status(st.id)).rejects.toThrow(/not found/i);
    } finally {
      await exports.close();
    }
    const cancel = flat(section(videoExport, '## Jobs'));
    expect(cancel).toContain(
      'With `delete_files: true` it also deletes the job and its files, whatever its status (a finished export too)',
    );
    expect(row(mcp, '`cancel_export`')[2]).toBe(
      'The job as it was: a queued or running one is cancelled, a finished one left as it is; `delete_files` deletes any job and its files, a finished one too',
    );
    for (const doc of [videoExport, mcp]) expect(flat(doc)).not.toContain('a finished one is kept');
  });

  it("say what preset 'reference' sets, as the code sets it, and that its former name still works", () => {
    const p = EXPORT_PRESET_PARAMS.reference;
    expect(p.outputs).toEqual({ sequence: false, clips: true, posters: false, contact_sheet: false });
    expect(EXPORT_PRESET_ALIASES).toEqual({ rideo: 'reference' });
    const code = (s: string) => `\`${s}\``;
    const passes = `${REFERENCE_PASSES.slice(0, -1).map(code).join(', ')} and ${code(REFERENCE_PASSES.at(-1)!)}`;
    expect(row(videoExport, '`preset`')[2]).toBe(
      '`reference`: reference clips for a video model (below); the parameters given win over it',
    );
    const params = flat(section(videoExport, '## Parameters'));
    expect(params).toContain(
      `Preset \`reference\` makes reference clips for a video model: quality \`${p.quality}\`, look ` +
        `\`${p.look}\` and clips only (no sequence, posters or contact sheet), with the passes ${passes}, ` +
        'one for each reference mode (`motion`, `camera` and `pose`), at the render resolution at 100 %',
    );
    expect(params).toContain('Its former name `rideo` is still accepted (and stored as `reference`).');
    expect(videoExportParamsSchema.parse({ preset: 'rideo' }).preset).toBe('reference');
  });

  it('give the limits of the code', () => {
    const doc = flat(videoExport);
    expect(doc).toContain(`At most ${MAX_EXPORT_FRAMES.toLocaleString('en-US')} output frames per export.`);
    expect(row(videoExport, '`width`, `height`')[2]).toContain(
      `Even, 16–${MAX_EXPORT_WIDTH} × 16–${MAX_EXPORT_HEIGHT}`,
    );
    expect(doc).toContain(`wait up to ${MAX_EXPORT_WAIT_S} s for the job to change status`);
    const d = ENV_DEFAULTS;
    expect(doc).toContain(`At most \`EXPORT_MAX_QUEUED\` (${d.get('EXPORT_MAX_QUEUED')}) may wait`);
    expect(doc).toContain(
      `finished jobs older than \`EXPORT_TTL_HOURS\` (${d.get('EXPORT_TTL_HOURS')}) are deleted`,
    );
    expect(doc).toContain(`beyond \`EXPORT_MAX_MB\` (${d.get('EXPORT_MAX_MB')}) of exports in all`);
    expect(flat(mcp)).toContain(
      `Even sizes up to ${MAX_EXPORT_WIDTH} × ${MAX_EXPORT_HEIGHT}, 120 fps and ${MAX_EXPORT_FRAMES.toLocaleString('en-US')} frames`,
    );
    expect(flat(mcp)).toContain(
      `\`EXPORT_MAX_MB\` (${d.get('EXPORT_MAX_MB')}) in all, each kept \`EXPORT_TTL_HOURS\` (${d.get('EXPORT_TTL_HOURS')}) after it ends`,
    );
  });
});

// ---------------------------------------------------------------- mcp.md, errors

describe('docs/mcp.md: the code line of the video and store tools', () => {
  it('names the codes that carry it, and the codes that do not', () => {
    const doc = flat(mcp);
    const start = doc.indexOf('The video export and model store tools fail with codes of their own');
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = doc.slice(start, doc.indexOf(' | ', start));
    const listed = paragraph.slice(
      paragraph.indexOf('on the line after the message:'),
      paragraph.indexOf('Their `OUT_OF_MEMORY` failures carry that line too'),
    );
    expect(listed).not.toBe('');
    const codes = [...listed.matchAll(/`([A-Z_]+)` \(/g)].map((m) => m[1]);
    expect(codes.sort()).toEqual([...SERVICE_ERROR_CODES].sort());
    for (const code of [...SERVICE_ERROR_CODES, 'OUT_OF_MEMORY'] as const)
      expect(codedErrorDetails(code)).toEqual({ code });
    for (const code of ['NOT_FOUND', 'INVALID_PARAMS'] as const) {
      expect(codedErrorDetails(code)).toBeUndefined();
      expect(paragraph).toContain(`(\`${code}\`)`);
    }
    expect(paragraph).toContain('are plain messages without it.');
  });
});

// ---------------------------------------------------------------- README and model-store.md

/** config.ts's environment variables, with the default of each that has one (as the docs write it). */
const ENV_DEFAULTS = (() => {
  const schema = /const envSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(source('config.ts'))?.[1] ?? '';
  const keys = [...schema.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)];
  const out = new Map<string, string | null>();
  keys.forEach((m, i) => {
    const body = schema.slice(m.index, keys[i + 1]?.index);
    // the last .default(…) of the variable, as the docs write it ('info' → info, 20_000 → 20000)
    const d =
      [...body.matchAll(/\.default\(([^()]*)\)/g)]
        .pop()?.[1]
        .trim()
        .replace(/^'(.*)'$/, '$1') ?? null;
    out.set(m[1], d !== null && /^\d[\d_]*$/.test(d) ? d.replace(/_/g, '') : d);
  });
  return out;
})();

/** Variables the server reads outside config.ts's schema (process.env.X / env.X anywhere in src). */
const ENV_READ = (() => {
  const src = fileURLToPath(new URL('../../src/', import.meta.url));
  const names = new Set<string>();
  for (const f of readdirSync(src, { recursive: true }) as string[])
    if (f.endsWith('.ts'))
      for (const m of readFileSync(path.join(src, f), 'utf8').matchAll(
        /\benv(?:\.([A-Z][A-Z0-9_]*)|\[['"]([A-Z][A-Z0-9_]*)['"]\])/g,
      ))
        names.add(m[1] ?? m[2]);
  return names;
})();

describe('README.md: the environment variables', () => {
  const config = tables(section(readme, '## Configuration (server environment variables)'))[0];
  const documented = config.rows.flatMap((r) => [...r[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]));

  it('list every variable of config.ts, and only variables the server or Node.js read', () => {
    expect(ENV_DEFAULTS.size).toBeGreaterThan(30);
    for (const key of ENV_DEFAULTS.keys()) expect(documented, key).toContain(key);
    for (const key of documented)
      expect(ENV_DEFAULTS.has(key) || ENV_READ.has(key) || key === 'NODE_USE_ENV_PROXY', key).toBe(true);
  });

  it('give the defaults of config.ts, here and in the docs of the desk', () => {
    const docs = { 'README.md': readme, 'video-export.md': videoExport, 'model-store.md': modelStore };
    let checked = 0;
    for (const [name, doc] of Object.entries(docs))
      for (const t of tables(doc).filter((x) => x.header[1] === 'Default'))
        for (const r of t.rows)
          for (const [, key] of r[0].matchAll(/`([A-Z][A-Z0-9_]*)`/g)) {
            const d = ENV_DEFAULTS.get(key);
            if (d == null) continue;
            expect(r[1], `${name} ${key}`).toContain(`\`${d}\``);
            checked++;
          }
    expect(checked).toBeGreaterThanOrEqual(20);
  });

  it('say which Node.js reads NODE_USE_ENV_PROXY, and that it applies to every outgoing request', () => {
    const engines = (JSON.parse(repo('package.json')) as { engines: { node: string } }).engines.node;
    const [major, minor] = /(\d+)\.(\d+)/.exec(engines)!.slice(1).map(Number);
    const proxyRow = row(readme, '`NODE_USE_ENV_PROXY`')[2];
    const proxySection = flat(section(modelStore, '## Behind a proxy'));
    // Node.js reads it from 22.21 (--use-env-proxy); the engines allow older ones
    if (major === 22 && minor < 21) {
      expect(proxyRow).toContain('Node.js 22.21 or later');
      expect(proxySection).toContain('Node.js 22.21 and later read');
    }
    for (const text of [proxyRow, proxySection]) {
      for (const name of ['WEBDAV_URL', 'NO_PROXY']) expect(text, name).toContain(name);
      // the server calls no rideo (the bridge is retired): nothing of it to keep off the proxy
      expect(text).not.toMatch(/rideo/i);
    }
  });

  it('say how to build an image without ffmpeg, and the Dockerfile builds one', () => {
    const dockerfile = repo('Dockerfile');
    expect(dockerfile).not.toMatch(/\btiny\b/);
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(runtime).toContain(
      'ARG WITH_FFMPEG=1\nRUN if [ "$WITH_FFMPEG" = 1 ]; then apk add --no-cache ffmpeg; fi\n',
    );
    expect(runtime.indexOf('apk add')).toBeLessThan(runtime.indexOf('\nUSER node'));
    expect(flat(readme)).toContain('`docker build --build-arg WITH_FFMPEG=0 .`');
    expect(flat(videoExport)).toContain('`--build-arg WITH_FFMPEG=0`');
    // the published image is the one with ffmpeg (its smoke test exports a video)
    expect(repo('.github/workflows/docker.yml')).not.toContain('WITH_FFMPEG');
  });
});

describe('docs/model-store.md: what an insert answers', () => {
  it('names the keys of the entry the reply gives once, with its thumbnail per transport', () => {
    const entry = {
      id: 'khronos:DeskLamp',
      provider: 'khronos',
      name: 'Desk Lamp',
      category: 'furniture' as const,
      tags: ['lamp'],
      thumbnail_url: '/api/store/models/khronos:DeskLamp/thumbnail',
      license: { spdx: 'CC-BY-4.0', url: null, attribution: 'Someone' },
      author: 'Someone',
      source_url: 'https://example.org/lamp',
      dimensions_m: [0.3, 0.3, 0.5] as [number, number, number],
      triangles: 1200,
      formats: ['gltf' as const],
      downloadable: true,
    };
    const reply = insertReply({ root: 'r', entry, warnings: ['w'] }, entry, []);
    const text = flat(modelStore);
    const start = text.indexOf('An insert answers `{result, entry, warnings}`, each once:');
    expect(start).toBeGreaterThanOrEqual(0);
    const paragraph = text.slice(start, text.indexOf('## ', start));
    expect(Object.keys(reply)).toEqual(['result', 'entry', 'warnings']);
    for (const key of Object.keys(reply.entry)) expect(paragraph, key).toContain(`\`${key}\``);
    expect(paragraph).toContain("from `store_add` a link on the server as in `store_search`'s results");
  });
});

describe('docs/model-store.md: the built-in models', () => {
  it('lists the catalog per category, and its size wherever the docs give it', () => {
    let total = 0;
    for (const category of STORE_CATEGORIES) {
      const r = row(modelStore, `\`${category}\``);
      const ids = r[2].replace(/ \(actors\)$/, '').split(', ');
      const entries = BUILTIN_CATALOG.filter((e) => e.category === category).map((e) => e.id);
      expect(Number(r[1]), category).toBe(entries.length);
      expect([...ids].sort(), category).toEqual([...entries].sort());
      total += entries.length;
    }
    expect(total).toBe(BUILTIN_CATALOG.length);
    const counts = [readme, modelStore, directorDesk, read('features.md')].flatMap((doc) =>
      [...flat(doc).matchAll(/\b(\d+) (?:original |built-in )?procedural models\b/g)].map((m) =>
        Number(m[1]),
      ),
    );
    expect(counts.length).toBeGreaterThanOrEqual(4);
    for (const n of counts) expect(n).toBe(BUILTIN_CATALOG.length);
  });
});

// ---------------------------------------------------------------- Markdown of the new docs

describe('the Markdown of the new docs (prettier does not format *.md)', () => {
  it.each(Object.entries(NEW_DOCS))(
    '%s: aligned tables, code spans on one line, prose within 100 columns',
    (_name, doc) => {
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
    },
  );
});
