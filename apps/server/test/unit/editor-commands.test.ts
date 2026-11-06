import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDITOR_COMMANDS, checkEditorCommand, editorCommandList } from '../../src/mcp/editor-commands';

/*
 * The server checks editor_command commands and parameter names against its catalogue before it
 * sends them to a browser editor, so the catalogue must list exactly the commands and parameters
 * the editor's handler (apps/web/src/editor/rpc.ts, uiCommand) reads.
 */

const RPC_SOURCE = fileURLToPath(new URL('../../../web/src/editor/rpc.ts', import.meta.url));

/** The commands of uiCommand and the parameter names each one reads, from the editor's source. */
function webCommands(): Map<string, Set<string>> {
  const src = readFileSync(RPC_SOURCE, 'utf8');
  const start = src.indexOf('export async function uiCommand(');
  expect(start).toBeGreaterThan(0);
  const body = src.slice(start, src.indexOf('\n}\n', start));
  const out = new Map<string, Set<string>>();
  const cases = body.split(/\n\s*case '/).slice(1);
  for (const c of cases) {
    const name = c.slice(0, c.indexOf("'"));
    const read = new Set<string>();
    for (const m of c.matchAll(/params\.(\w+)/g)) read.add(m[1]);
    for (const m of c.matchAll(/ui(?:Number|Boolean)Param\(params, '(\w+)'/g)) read.add(m[1]);
    for (const m of c.matchAll(/uiEnumParam\(params, \[([^\]]*)\]/g))
      for (const k of m[1].matchAll(/'(\w+)'/g)) read.add(k[1]);
    out.set(name, read);
  }
  return out;
}

describe('editor command catalogue', () => {
  it('lists exactly the commands and parameters of the browser editor', () => {
    const web = webCommands();
    expect(Object.keys(EDITOR_COMMANDS).sort()).toEqual([...web.keys()].sort());
    for (const [name, read] of web)
      expect([...read].sort(), `parameters of ${name}`).toEqual(
        Object.keys(EDITOR_COMMANDS[name].params).sort(),
      );
  });

  it('accepts valid commands and refuses unknown names with suggestions', () => {
    expect(() => checkEditorCommand('view.set_view', { view: 'TOP' })).not.toThrow();
    expect(() => checkEditorCommand('screenshot', { width: 640, height: 360 })).not.toThrow();
    expect(() =>
      checkEditorCommand('run_operator', { operator: 'view3d.view_all', params: {} }),
    ).not.toThrow();
    expect(() => checkEditorCommand('view.shading', { shadng: 'SOLID' })).toThrow(
      /'shadng' \(did you mean 'shading'\?\)/,
    );
    expect(() => checkEditorCommand('set_mod', {})).toThrow(/did you mean 'set_mode'\?/);
    expect(() => checkEditorCommand('get_view', { x: 1 })).toThrow(/get_view takes no parameters/);
    expect(() => checkEditorCommand('notify', { message: 42 })).toThrow(/'message' must be a string/);
    expect(() => checkEditorCommand('run_operator', { operator: 'x', params: [1] })).toThrow(
      /must be an object/,
    );
    expect(editorCommandList()).toContain('view.set_view {view: FRONT | BACK');
  });
});
