import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_UI_OPERATORS, createOperatorRegistry } from '@3d-editor/core';
import {
  MAX_EDITOR_TIMEOUT_MS,
  checkEditorCommand,
  editorClosedMessage,
  editorTimeoutMessage,
} from '../../src/mcp/editor-commands';
import { AUTO_BROWSER_RASTER_TIMEOUT_MS, BROWSER_RASTER_TIMEOUT_MS } from '../../src/mcp/rendering';
import {
  browserUiOperator,
  browserUiOperatorsNote,
  closestOperatorIds,
  toolOnlyOperator,
} from '../../src/mcp/operator-groups';

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
  it('describe screenshots as the person sees the viewport: in its shading or `shading`, never path traced', () => {
    expect(row(mcp, '`screenshot`')).toMatch(
      /`shading` \(as for `view\.shading`; default: the viewport's\) *\| A PNG of the viewport as the person sees it/,
    );
    const doc = flat(mcp);
    expect(doc).toContain(
      '`screenshot` shows the viewport as the person sees it: its view (the scene camera when the viewport ' +
        'looks through it), in the shading the viewport shows, or in `shading` when given, without overlays. ' +
        'It is rasterized (WebGL) like the viewport, never path traced:',
    );
    for (const text of [doc, flat(guide)])
      expect(text).not.toMatch(/whatever (the editor's |the viewport's )?shading|drawn that way whatever/);
    expect(flat(guide)).toContain("in the viewport's shading unless you pass `shading`");
    // the messages shown are the server's
    expect(doc).toContain(editorTimeoutMessage('screenshot', 10_000));
    expect(doc).toContain(editorTimeoutMessage('select', 10_000));
    expect(() => checkEditorCommand('screenshot', { shading: 'SOILD' })).toThrow(
      `screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?).`,
    );
    expect(doc).toContain(
      `"screenshot: 'shading' must be WIREFRAME, SOLID, MATERIAL or RENDERED, letter case ignored (got "SOILD"; did you mean 'SOLID'?)."`,
    );
  });

  it("give the cost of screenshots by the viewport's shading, not MATERIAL and RENDERED as slow in themselves", () => {
    for (const doc of [mcp, guide].map(flat)) {
      expect(doc).not.toMatch(/tens of seconds per `editor_command` screenshot in those shadings/);
      expect(doc).not.toMatch(/tens of seconds per screenshot of a heavy scene in `MATERIAL` or `RENDERED`/);
      expect(doc).not.toMatch(/where one drawn with materials and lights took 20 s/);
    }
    expect(flat(mcp)).toContain(
      "A screenshot in the viewport's shading costs about one such frame; one in another shading builds " +
        "and compiles the scene's materials for that image.",
    );
    expect(flat(guide)).toContain(
      "in another shading it builds and compiles the scene's materials for that image, which takes tens of " +
        'seconds for a scene with many materials in `MATERIAL` or `RENDERED`',
    );
  });

  it('say what ed.undo undoes there: also operators run with editor_command, never the tools', () => {
    const doc = flat(mcp);
    expect(doc).not.toContain("undoes the user's change, not the agent's");
    expect(doc).toContain(
      "(`ed.undo` undoes the last change there: the person's, or an operator the agent ran there with " +
        "`editor_command`, never the agent's changes made with the tools: use the `undo` tool for those)",
    );
  });

  it('show the message of an editor that left the project before it answered (wm.read_homefile)', () => {
    expect(flat(mcp)).toContain(
      `"${editorClosedMessage('run_operator', { operator: 'wm.read_homefile', params: {} })}"`,
    );
    expect(flat(guide)).toContain('`wm.read_homefile` switches their editor to a new project, so the editor');
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

describe('docs: selections', () => {
  it('say which lists each select mode uses, and that the others and all: true with lists are refused', () => {
    expect(row(mcp, '`mesh`')).toContain(
      '`select_mode` (`VERT`: the listed vertices with those of the listed edges and faces; `EDGE`: only ' +
        '`edges`; `FACE`: only `faces`; when omitted `FACE` for faces alone, `EDGE` for edges alone, else `VERT`)',
    );
    expect(row(mcp, 'A list that `select_mode` does not select from')).toContain('`POLL_FAILED`');
    expect(row(mcp, '`all: true` with `verts`, `edges` or `faces`')).toContain('`POLL_FAILED`');
    expect(flat(mcp)).not.toMatch(/before applying the lists/);
    expect(flat(guide)).toContain(
      'Lists that the select mode would not use are refused (`POLL_FAILED`), and so is `all: true` with lists',
    );
  });
});

describe('docs: browser UI operators', () => {
  it('say what every one does in a live editor, and show the messages of the server', () => {
    const doc = flat(mcp);
    for (const id of ['view3d.view_all', 'object.duplicate_move'])
      expect(doc).toContain(browserUiOperator(id)!);
    const table = mcp.slice(mcp.indexOf('| Browser UI operator'), mcp.indexOf('Two of the messages'));
    for (const id of BROWSER_UI_OPERATORS) expect(table, id).toContain(`\`${id}\``);
    // the File operators do not all just open dialogs
    expect(mcp).not.toContain("Opens the editor's dialogs and menus");
    expect(row(mcp, '`wm.read_homefile`')).toContain(
      "Creates a new project (`{name, empty}`) and switches the person's editor to it, away from the project " +
        'it had open, which it leaves before it can answer: `editor_command` says it got no answer',
    );
    expect(row(mcp, '`wm.share`')).toContain("Puts the project's link on the person's clipboard");
    expect(flat(guide)).not.toMatch(/wm\.share[^.]*(dialog|menu)/);
  });

  it('give the did-you-mean note of the server for wm.save', () => {
    const registry = createOperatorRegistry();
    const candidates = [
      ...registry
        .list()
        .filter((d) => !d.uiOnly)
        .map((d) => d.id),
      ...BROWSER_UI_OPERATORS.filter((b) => !registry.has(b)),
    ];
    const ids = closestOperatorIds('wm.save', candidates);
    const message = `Did you mean: ${ids.join(', ')}? ${browserUiOperatorsNote(ids, ids, 'wm.save')}`;
    const quoted = flat(mcp).match(/`wm\.save` gets "(Did you mean: [^"]*) …"/)?.[1];
    expect(quoted).toBeDefined();
    expect(message.startsWith(quoted!)).toBe(true);
  });
});
