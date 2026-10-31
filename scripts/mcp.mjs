#!/usr/bin/env node
/**
 * Minimal MCP client for the 3D editor server (Streamable HTTP), usable as a CLI or a module.
 *
 *   node scripts/mcp.mjs tools [filter]            list tools
 *   node scripts/mcp.mjs ops [filter]              list operators (via list_operators)
 *   node scripts/mcp.mjs call <tool> ['<json>'] [--out file.png]
 *   node scripts/mcp.mjs batch <calls.json>        [{ "tool": "...", "args": {...} }, ...]
 *
 *   import { connect } from './scripts/mcp.mjs';
 *   const mcp = await connect();                   // MCP_URL / MCP_TOKEN from the environment
 *   const scene = await mcp.call('get_scene', { project: 'Demo' });
 *
 * Environment: MCP_URL (default http://127.0.0.1:8080/mcp), MCP_TOKEN (bearer token, optional).
 * Tool results are returned as parsed JSON (text content); image content is returned as
 * `{ images: [{ mimeType, data (base64) }], text }` and saved with --out on the CLI.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class McpToolError extends Error {}

function parseResult(res) {
  const content = Array.isArray(res?.content) ? res.content : [];
  const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '');
  const images = content
    .filter((c) => c.type === 'image')
    .map((c) => ({ mimeType: c.mimeType, data: c.data }));
  if (res?.isError) throw new McpToolError(texts.join('\n') || 'tool error');
  if (res?.structuredContent && !images.length) return res.structuredContent;
  let value = texts.join('\n');
  if (texts.length === 1) {
    try {
      value = JSON.parse(texts[0]);
    } catch {
      /* plain text */
    }
  }
  return images.length ? { images, text: value } : value;
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
    /** Calls a tool and returns its parsed result; throws McpToolError on tool errors. */
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 15 * 60_000 });
      return parseResult(res);
    },
    async tools() {
      return (await client.listTools()).tools;
    },
    close: () => client.close(),
  };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const outIdx = rest.indexOf('--out');
  const out = outIdx >= 0 ? rest.splice(outIdx, 2)[1] : null;
  if (!['tools', 'ops', 'call', 'batch'].includes(cmd)) {
    console.error(
      'usage: mcp.mjs tools [filter] | ops [filter] | call <tool> [json] [--out f] | batch <file>',
    );
    process.exitCode = 2;
    return;
  }
  const mcp = await connect();
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
      const r = await mcp.call(name, json ? JSON.parse(json) : {});
      if (r && typeof r === 'object' && Array.isArray(r.images)) {
        if (out) {
          await writeFile(out, Buffer.from(r.images[0].data, 'base64'));
          console.log(JSON.stringify({ saved: out, text: r.text }, null, 2));
        } else
          console.log(
            JSON.stringify(
              { ...r, images: r.images.map((i) => ({ mimeType: i.mimeType, bytes: i.data.length })) },
              null,
              2,
            ),
          );
      } else console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 2));
    } else {
      const calls = JSON.parse(await readFile(rest[0], 'utf8'));
      for (const [i, c] of calls.entries()) {
        const r = await mcp.call(c.tool, c.args ?? {});
        console.log(`#${i} ${c.tool}:`, typeof r === 'string' ? r : JSON.stringify(r).slice(0, 2000));
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
