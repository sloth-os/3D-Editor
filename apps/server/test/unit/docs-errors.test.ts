import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_UI_OPERATORS, createOperatorRegistry } from '@3d-editor/core';
import { MAX_EDITOR_TIMEOUT_MS } from '../../src/mcp/editor-commands';
import { AUTO_BROWSER_RASTER_TIMEOUT_MS, BROWSER_RASTER_TIMEOUT_MS } from '../../src/mcp/rendering';
import { toolOnlyOperator } from '../../src/mcp/operator-groups';

/*
 * docs/mcp.md and docs/agent-guide.md describe the error codes and the waits for browser editors
 * that agents branch on: they must say what the server does. Which render operators are FAILED
 * (refused for a tool) and which NOT_FOUND (browser UI operators), how screenshots are drawn, how
 * long the server waits for an editor, and until when it sends progress.
 */

const read = (doc: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../docs/${doc}`, import.meta.url)), 'utf8');
const mcp = read('mcp.md');
const guide = read('agent-guide.md');
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

/** The cells of the Markdown table row whose first cell is `first`. */
function row(doc: string, first: string): string {
  const line = doc.split('\n').find((l) => l.startsWith(`| ${first}`));
  expect(line, first).toBeDefined();
  return line!;
}

describe('docs: error codes of refused render operators', () => {
  it('render.render_software and render.render_animation are FAILED, render.render is NOT_FOUND', () => {
    const registry = createOperatorRegistry();
    const failed = registry
      .list()
      .map((d) => d.id)
      .filter((id) => toolOnlyOperator(id));
    expect(failed.sort()).toEqual(['render.render_animation', 'render.render_software']);
    expect(BROWSER_UI_OPERATORS).toContain('render.render');
    // the code table of docs/mcp.md
    const failedRow = row(mcp, '`FAILED`');
    for (const id of failed) expect(failedRow).toContain(id);
    expect(failedRow).not.toMatch(/`render\.\*`/);
    expect(row(mcp, '`NOT_FOUND`')).toContain('`render.render` included');
    // the FAILED bullet of the agent guide
    const bullet = guide.slice(
      guide.indexOf('- `FAILED`:'),
      guide.indexOf('\n\n', guide.indexOf('- `FAILED`:')),
    );
    for (const id of failed) expect(bullet).toContain(id);
    expect(bullet).toMatch(/`render\.render` is a browser UI operator: `NOT_FOUND`/);
    expect(bullet).not.toMatch(/or `render\.\*`/);
  });
});

describe('docs: browser editors', () => {
  it('describe screenshots as drawn whatever the viewport shading, not as the person sees them', () => {
    expect(row(mcp, '`screenshot`')).not.toMatch(/as the (user|person) sees it/);
    expect(flat(mcp)).toContain(
      'drawn with materials, lights and the world (Rendered shading) whatever shading the viewport shows',
    );
  });

  it('give the waits of the code', () => {
    expect(MAX_EDITOR_TIMEOUT_MS).toBe(55_000);
    for (const doc of [mcp, guide].map(flat)) {
      expect(doc).not.toMatch(/at most 60000|100–60000|waits up to 60 s|within 60 s/);
      expect(doc).toContain(`at most ${MAX_EDITOR_TIMEOUT_MS}`);
    }
    expect(row(mcp, '`editor_command`')).toContain(`\`timeout_ms\` 100–${MAX_EDITOR_TIMEOUT_MS}`);
    expect(row(mcp, 'Browser renders')).toContain(
      `Raster: ${BROWSER_RASTER_TIMEOUT_MS / 1000} s with \`renderer: "browser"\`, ${AUTO_BROWSER_RASTER_TIMEOUT_MS / 1000} s with \`auto\``,
    );
  });

  it('say that progress notifications last until the editor answers, not until time_limit', () => {
    expect(flat(mcp)).not.toMatch(/until `time_limit` has passed/);
    expect(flat(mcp)).toContain('until the image arrives');
  });
});
