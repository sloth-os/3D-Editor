#!/usr/bin/env node
/**
 * Minimal MCP client for the 3D editor server (Streamable HTTP), usable as a CLI or a module.
 *
 *   node scripts/mcp.mjs tools [filter] [--json]   list tools; with a filter, each matching tool's
 *                                                  description and arguments (--json: input schemas)
 *   node scripts/mcp.mjs ops [filter]              list operators (via list_operators)
 *   node scripts/mcp.mjs call <tool> ['<json>'] [--out file] [--out-dir dir]
 *   node scripts/mcp.mjs batch <calls.json> [--out-dir dir]   [{ "tool": "...", "args": {...} }, ...]
 *
 *   import { connect } from './scripts/mcp.mjs';
 *   const mcp = await connect();                   // MCP_URL / MCP_TOKEN from the environment
 *   const scene = await mcp.call('get_scene', { project: 'Demo' });
 *
 * Environment: MCP_URL (default http://127.0.0.1:8080/mcp), MCP_TOKEN (bearer token, optional),
 * MCP_AGENT_ID (agent id, optional; see below).
 *
 * Undo history: the server keeps an agent's undo history (and its selection, mode and frame) per
 * MCP session. Every CLI call is a new session, so the CLI identifies itself with an agent id
 * (header x-mcp-agent-id): MCP_AGENT_ID, by default one id per user and working directory. Calls
 * with the same agent id share one history, so `call undo` reverts the previous call's change.
 * Set MCP_AGENT_ID to keep separate histories (e.g. two agents working in the same directory).
 * Module users get a per-connection history unless they pass `{ agentId }` (or set MCP_AGENT_ID).
 * Sessions are closed with an HTTP DELETE when done, so no "AI agent" presence lingers.
 *
 * Tool results are returned as parsed JSON (text content). Results with files are returned as
 * `{ text, images: [{ mimeType, data (base64) }], resources: [{ uri, mimeType, blob }],
 * links: [{ uri, name, mimeType }] }`. On the CLI, `--out file` saves the first image (or embedded
 * resource) and `--out-dir dir` saves every image and resource (render_animation PNG sequences,
 * export_scene files). Long renders report progress on stderr; `elapsed_ms` of the call is
 * printed with the result.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

/** Header carrying the agent id (sessions with the same id share their undo history). */
export const AGENT_ID_HEADER = 'x-mcp-agent-id';

/** The CLI's default agent id: one per user, host and working directory. */
export function defaultAgentId(cwd = process.cwd()) {
  let user = 'user';
  try {
    user = os.userInfo().username || user;
  } catch {
    /* no user info */
  }
  const hash = createHash('sha256').update(`${user}@${os.hostname()}:${cwd}`).digest('hex').slice(0, 12);
  return `cli-${hash}`;
}

/**
 * Connects to the server. `agentId` (default: MCP_AGENT_ID) makes the session share its undo
 * history and editor state with other sessions using the same id.
 */
export async function connect(
  url = process.env.MCP_URL ?? 'http://127.0.0.1:8080/mcp',
  token = process.env.MCP_TOKEN,
  { agentId = process.env.MCP_AGENT_ID } = {},
) {
  const client = new Client({ name: '3d-editor-cli', version: '1.0.0' });
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(agentId ? { [AGENT_ID_HEADER]: agentId } : {}),
  };
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return {
    client,
    agentId: agentId ?? null,
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
    /** Ends the session on the server (HTTP DELETE: its presence disappears at once), then disconnects. */
    async close() {
      try {
        await transport.terminateSession();
      } catch {
        /* the server may already have closed it */
      }
      await client.close();
    },
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

/** A short type of a JSON schema property: `number`, `string[]`, `[number, number, number]`, `A | B` … */
function schemaType(p) {
  if (!p || typeof p !== 'object') return 'any';
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (p.const !== undefined) return JSON.stringify(p.const);
  const alts = p.anyOf ?? p.oneOf;
  if (alts) return [...new Set(alts.map(schemaType))].join(' | ');
  if (p.type === 'array') {
    // tuples: draft 2020-12 prefixItems, or draft-07 items as an array
    const tuple = Array.isArray(p.prefixItems) ? p.prefixItems : Array.isArray(p.items) ? p.items : null;
    if (tuple) return `[${tuple.map(schemaType).join(', ')}]`;
    const item = schemaType(p.items);
    const n = p.minItems !== undefined && p.minItems === p.maxItems ? ` × ${p.minItems}` : '';
    return `${item.includes(' ') ? `(${item})` : item}[]${n}`;
  }
  if (p.type === 'object' && !p.properties && p.additionalProperties) return 'object (any keys)';
  return Array.isArray(p.type) ? p.type.join(' | ') : (p.type ?? 'any');
}

/** Lines describing the properties of an object schema (nested objects and object arrays indented). */
function describeProperties(schema, indent = '  ', depth = 0) {
  const lines = [];
  const required = new Set(schema?.required ?? []);
  for (const [key, p] of Object.entries(schema?.properties ?? {})) {
    const facts = [schemaType(p), required.has(key) ? 'required' : 'optional'];
    if (p.default !== undefined) facts.push(`default ${JSON.stringify(p.default)}`);
    // zod gives every integer the safe-integer range: not worth showing
    const bound = (v) => (v === undefined || Math.abs(v) >= Number.MAX_SAFE_INTEGER ? undefined : v);
    const lo =
      bound(p.minimum) ?? (bound(p.exclusiveMinimum) !== undefined ? `>${p.exclusiveMinimum}` : undefined);
    const hi =
      bound(p.maximum) ?? (bound(p.exclusiveMaximum) !== undefined ? `<${p.exclusiveMaximum}` : undefined);
    if (lo !== undefined || hi !== undefined) facts.push(`range ${lo ?? '…'}..${hi ?? '…'}`);
    lines.push(`${indent}${key} (${facts.join(', ')})${p.description ? `: ${p.description}` : ''}`);
    const nested =
      p.type === 'object' ? p : p.type === 'array' && p.items?.type === 'object' ? p.items : null;
    if (nested?.properties && depth < 3) lines.push(...describeProperties(nested, `${indent}  `, depth + 1));
  }
  return lines;
}

/** `tools [filter]`: one line per tool, or with a filter each matching tool in full. */
export function formatTools(tools, filter = '', { json = false } = {}) {
  const f = filter.toLowerCase();
  const exact = tools.filter((t) => t.name === f);
  const matches = exact.length ? exact : tools.filter((t) => !f || t.name.includes(f));
  if (json)
    return JSON.stringify(
      matches.map((t) => ({ name: t.name, inputSchema: t.inputSchema })),
      null,
      2,
    );
  if (!f) return tools.map((t) => `${t.name}: ${(t.description ?? '').split('. ')[0]}`).join('\n');
  if (!matches.length) return `no tool matches '${filter}' (tools: ${tools.map((t) => t.name).join(', ')})`;
  return matches
    .map((t) => {
      const args = describeProperties(t.inputSchema);
      return [
        `${t.name}`,
        `  ${t.description ?? ''}`,
        args.length ? '  Arguments:' : '  No arguments.',
        ...args.map((l) => `  ${l}`),
      ].join('\n');
    })
    .join('\n\n');
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const json = rest.includes('--json');
  if (json) rest.splice(rest.indexOf('--json'), 1);
  const out = takeFlag(rest, '--out');
  const outDir = takeFlag(rest, '--out-dir');
  if (!['tools', 'ops', 'call', 'batch'].includes(cmd)) {
    console.error(
      'usage: mcp.mjs tools [filter] [--json] | ops [filter] | call <tool> [json] [--out f] [--out-dir d] | batch <file> [--out-dir d]',
    );
    process.exitCode = 2;
    return;
  }
  // every CLI call is a new MCP session: one agent id keeps one undo history across calls
  const mcp = await connect(undefined, undefined, { agentId: process.env.MCP_AGENT_ID || defaultAgentId() });
  const onProgress = (p) =>
    process.stderr.write(
      `  progress ${p.progress}${p.total ? `/${p.total}` : ''}${p.message ? ` ${p.message}` : ''}\n`,
    );
  try {
    if (cmd === 'tools') {
      console.log(formatTools(await mcp.tools(), rest[0] ?? '', { json }));
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
