import { describe, expect, it } from 'vitest';
import { BROWSER_UI_OPERATORS, createOperatorRegistry } from '@3d-editor/core';
import { browserUiOperator, browserUiOperatorsNote } from '../../src/mcp/operator-groups';

/*
 * run_operator, batch and edit_mesh refuse the operators of the browser editor's UI with a message
 * that says how to run them in a live editor (editor_command), instead of "unknown operator"; where
 * the tools offer the same edit (Shift+D's object.duplicate_move, the interactive transform, the
 * mouse-picked loop cut, the editor's undo …) the message names that first, and says what the
 * operator does in a live editor (it waits for the person's mouse, acts on their selection).
 */

const headless = createOperatorRegistry();
const RUN = (id: string) =>
  `editor_command {project, command: 'run_operator', params: {operator: '${id}', params: {…}}} ` +
  '(get_connected_clients lists the editors that have the project open)';
const HEAD = (id: string) =>
  `'${id}' is an operator of the browser editor's user interface (viewport, playback, tools, windows): ` +
  'only a live editor can run it, not run_operator, batch or edit_mesh.';

describe('browserUiOperator', () => {
  it('says how to run a browser UI operator in a live editor', () => {
    expect(browserUiOperator('view3d.view_axis')).toBe(
      `${HEAD('view3d.view_axis')} Run it there with ${RUN('view3d.view_axis')}.`,
    );
  });

  it('names the server operator first for interactive operators an agent means as an edit', () => {
    expect(browserUiOperator('object.duplicate_move')).toBe(
      `${HEAD('object.duplicate_move')} To duplicate objects use object.duplicate {linked, offset: [x, y, z]} on your ` +
        'selection (or the duplicate_object tool): it copies them and moves the copies by offset in one step. ' +
        `In a live editor run it with ${RUN('object.duplicate_move')}: it duplicates the editor's selection, then ` +
        'waits for the person to move the copies with the mouse.',
    );
    expect(browserUiOperator('view3d.transform_modal')).toMatch(
      /To move, rotate or scale use transform\.translate \{value\}, transform\.rotate \{value, orient_axis\} or transform\.resize \{value\} on your selection \(through edit_mesh for mesh elements\), or the transform_object tool\. In a live editor run it with .*: it starts a move, rotation or scale of the editor's selection that follows the person's mouse\.$/,
    );
    expect(browserUiOperator('mesh.loopcut_pick')).toMatch(
      /To cut a loop use edit_mesh \{object, operator: 'mesh\.loopcut', params: \{edge: \[a, b\], number_cuts\}\}.*: it cuts the edge ring under the person's mouse pointer\.$/,
    );
    expect(browserUiOperator('ed.undo')).toMatch(
      /To undo your own changes use the undo tool\. In a live editor .*: it undoes the editor user's last change, not yours\.$/,
    );
    expect(browserUiOperator('render.render')).toMatch(/For an image use render_image/);
    expect(browserUiOperator('wm.save_mainfile')).toMatch(
      /Saving is not needed: the server stores projects itself/,
    );
  });

  it('only names operators that exist: in the server registry, or the browser UI operators', () => {
    for (const id of BROWSER_UI_OPERATORS) {
      const msg = browserUiOperator(id)!;
      expect(msg, id).toContain(RUN(id));
      // the advice before the editor_command part names server operators (dotted ids)
      const advice = msg.slice(HEAD(id).length, msg.indexOf('editor_command'));
      for (const named of advice.match(/\b[a-z][a-z0-9]*\.[a-z][a-z0-9_]*\b/g) ?? [])
        expect(headless.has(named) || BROWSER_UI_OPERATORS.includes(named), `${id}: ${named}`).toBe(true);
    }
  });

  it('knows every browser UI operator, and nothing else unless registered uiOnly', () => {
    for (const def of headless.list()) expect(browserUiOperator(def.id), def.id).toBeNull();
    expect(browserUiOperator('view3d.view_al')).toBeNull();
    // an operator a registry marks uiOnly gets the same answer (run_operator's uiOnly branch)
    expect(browserUiOperator('custom.panel_toggle', true)).toBe(
      `${HEAD('custom.panel_toggle')} Run it there with ${RUN('custom.panel_toggle')}.`,
    );
  });
});

describe('browserUiOperatorsNote', () => {
  const RUN_THEM = "editor_command {project, command: 'run_operator', params: {operator, params}}.";
  it('names the browser UI operators of a did-you-mean list and what to use instead', () => {
    expect(browserUiOperatorsNote(['view3d.view_all'], ['view3d.view_all'])).toBe(
      `It is an operator of the browser editor's user interface: a live editor runs it with ${RUN_THEM}`,
    );
    expect(browserUiOperatorsNote(['ed.undo', 'ed.redo'], ['ed.undo', 'ed.redo'])).toBe(
      "They are operators of the browser editor's user interface (instead: the undo tool for ed.undo, the redo " +
        `tool for ed.redo): a live editor runs them with ${RUN_THEM}`,
    );
    expect(
      browserUiOperatorsNote(
        ['object.duplicate_move'],
        ['object.duplicate_move', 'mesh.duplicate_move', 'object.duplicate'],
      ),
    ).toBe(
      "object.duplicate_move is an operator of the browser editor's user interface (instead: object.duplicate " +
        `{offset}): a live editor runs it with ${RUN_THEM}`,
    );
    expect(browserUiOperatorsNote([], ['mesh.subdivide'])).toBe('');
  });
});
