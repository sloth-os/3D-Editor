#!/usr/bin/env node
/**
 * Minimal MCP client for the 3D editor server (Streamable HTTP), usable as a CLI or a module.
 *
 *   node scripts/mcp.mjs tools [filter]            list tools
 *   node scripts/mcp.mjs ops [filter]              list operators (via list_operators)
 *   node scripts/mcp.mjs call <tool> ['<json>'] [--out file] [--out-dir dir]
 *   node scripts/mcp.mjs batch <calls.json> [--out-dir dir]   [{ "tool": "...", "args": {...} }, ...]
 *
 *   import { connect } from './scripts/mcp.mjs';
 *   const mcp = await connect();                   // MCP_URL / MCP_TOKEN from the environment
 *   const scene = await mcp.call('get_scene', { project: 'Demo' });
 *
 * Environment: MCP_URL (default http://127.0.0.1:8080/mcp), MCP_TOKEN (bearer token, optional).
 * Tool results are returned as parsed JSON (text content). Results with files are returned as
 * `{ text, images: [{ mimeType, data (base64) }], resources: [{ uri, mimeType, blob }],
 * links: [{ uri, name, mimeType }] }`. On the CLI, `--out file` saves the first image (or embedded
 * resource) and `--out-dir dir` saves every image and resource (render_animation PNG sequences,
 * export_scene files). Long renders report progress on stderr; `elapsed_ms` of the call is
 * printed with the result.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class McpToolError extends Error {}

const EXTENSIONS = { 'image/png': 'png', 'image/gif': 'gif', 'image/apng': 'png', 'image/jpeg': 'jpg' };

function parseResult(res) {
  const content = Array.isArray(res?.content) ? res.content : [];
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
  const images = content
    .filter((c) => c.type === 'image')
    .map((c) => ({ mimeType: c.mimeType, data: c.data }));
  const resources = content
    .filter((c) => c.type === 'resource' && c.resource)
    .map((c) => ({
      uri: c.resource.uri,
      mimeType: c.resource.mimeType,
      blob: c.resource.blob,
      text: c.resource.text,
    }));
  const links = content
    .filter((c) => c.type === 'resource_link')
    .map((c) => ({ uri: c.uri, name: c.name, mimeType: c.mimeType }));
  if (res?.isError) throw new McpToolError(texts.join('\n') || 'tool error');
  if (res?.structuredContent && !images.length && !resources.length) return res.structuredContent;
  let value = texts.join('\n');
  if (texts.length === 1) {
    try {
      value = JSON.parse(texts[0]);
    } catch {
      /* plain text */
    }
  }
  if (!images.length && !resources.length && !links.length) return value;
  return {
    text: value,
    ...(images.length ? { images } : {}),
    ...(resources.length ? { resources } : {}),
    ...(links.length ? { links } : {}),
  };
}

export async function connect(
  url = process.env.MCP_URL ?? 'http://127.0.0.1:8080/mcp',
  token = process.env.MCP_TOKEN,
) {
  const client = new Client({ name: '3d-editor-cli', version: '1.0.0' });
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return {
    client,
    /**
     * Calls a tool and returns its parsed result; throws McpToolError on tool errors. `onProgress`
     * receives progress notifications (long renders); they also keep the request alive.
     */
    async call(name, args = {}, { onProgress } = {}) {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 15 * 60_000,
        resetTimeoutOnProgress: true,
        onprogress: onProgress,
      });
      return parseResult(res);
    },
    async tools() {
      return (await client.listTools()).tools;
    },
    close: () => client.close(),
  };
}

/** Saves the images and embedded resources of a result; returns the written paths. */
async function saveFiles(r, { out, outDir }) {
  const saved = [];
  const files = [
    ...(r.images ?? []).map((i, k) => ({
      name: `image_${k + 1}.${EXTENSIONS[i.mimeType] ?? 'bin'}`,
      data: i.data,
    })),
    ...(r.resources ?? [])
      .filter((x) => x.blob)
      .map((x, k) => ({ name: x.uri?.split('/').pop() || `resource_${k + 1}`, data: x.blob })),
  ];
  if (out && files[0]) {
    await writeFile(out, Buffer.from(files[0].data, 'base64'));
    saved.push(out);
  }
  if (outDir && files.length) {
    await mkdir(outDir, { recursive: true });
    for (const f of files) {
      const p = path.join(outDir, f.name);
      await writeFile(p, Buffer.from(f.data, 'base64'));
      saved.push(p);
    }
  }
  return saved;
}

/** A result with file contents replaced by their sizes (for printing). */
function printable(r) {
  if (!r || typeof r !== 'object' || !('text' in r)) return r;
  return {
    ...r,
    ...(r.images
      ? { images: r.images.map((i) => ({ mimeType: i.mimeType, base64_bytes: i.data.length })) }
      : {}),
    ...(r.resources
      ? {
          resources: r.resources.map((x) => ({
            uri: x.uri,
            mimeType: x.mimeType,
            base64_bytes: x.blob?.length ?? 0,
          })),
        }
      : {}),
  };
}

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args.splice(i, 2)[1] : null;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const out = takeFlag(rest, '--out');
  const outDir = takeFlag(rest, '--out-dir');
  if (!['tools', 'ops', 'call', 'batch'].includes(cmd)) {
    console.error(
      'usage: mcp.mjs tools [filter] | ops [filter] | call <tool> [json] [--out f] [--out-dir d] | batch <file> [--out-dir d]',
    );
    process.exitCode = 2;
    return;
  }
  const mcp = await connect();
  const onProgress = (p) =>
    process.stderr.write(
      `  progress ${p.progress}${p.total ? `/${p.total}` : ''}${p.message ? ` ${p.message}` : ''}\n`,
    );
  try {
    if (cmd === 'tools') {
      const f = (rest[0] ?? '').toLowerCase();
      for (const t of await mcp.tools())
        if (!f || t.name.includes(f)) console.log(`${t.name}: ${(t.description ?? '').split('. ')[0]}`);
    } else if (cmd === 'ops') {
      const r = await mcp.call('list_operators', rest[0] ? { search: rest[0] } : {});
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === 'call') {
      const [name, json] = rest;
      const t0 = Date.now();
      const r = await mcp.call(name, json ? JSON.parse(json) : {}, { onProgress });
      const elapsed = Date.now() - t0;
      const saved = r && typeof r === 'object' ? await saveFiles(r, { out, outDir }) : [];
      const shown = printable(r);
      if (typeof shown === 'string') console.log(shown);
      else
        console.log(
          JSON.stringify({ ...(saved.length ? { saved } : {}), result: shown, elapsed_ms: elapsed }, null, 2),
        );
    } else {
      const calls = JSON.parse(await readFile(rest[0], 'utf8'));
      for (const [i, c] of calls.entries()) {
        const t0 = Date.now();
        const r = await mcp.call(c.tool, c.args ?? {}, { onProgress });
        const saved =
          r && typeof r === 'object' && outDir
            ? await saveFiles(r, { outDir: path.join(outDir, String(i)) })
            : [];
        const shown = printable(r);
        console.log(
          `#${i} ${c.tool} (${Date.now() - t0} ms):`,
          typeof shown === 'string' ? shown : JSON.stringify(shown).slice(0, 2000),
          saved.length ? `saved ${saved.join(', ')}` : '',
        );
      }
    }
  } finally {
    await mcp.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof McpToolError ? `tool error: ${e.message}` : e);
    process.exitCode = 1;
  });
}
