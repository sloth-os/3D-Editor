import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROWSER_UI_OPERATORS, createOperatorRegistry } from '@3d-editor/core';
import {
  browserUiOperator,
  browserUiOperatorsNote,
  closestOperatorIds,
  completesOperatorId,
} from '../../src/mcp/operator-groups';

/*
 * run_operator, batch and edit_mesh refuse the operators of the browser editor's UI with a message
 * that says how to run them in a live editor (editor_command), instead of "unknown operator"; where
 * the tools offer the same edit (Shift+D's object.duplicate_move, the interactive transform, the
 * mouse-picked loop cut, the editor's undo …) the message names that first, and it says what the
 * operator does in a live editor (it waits for the person's mouse, acts on their selection, view,
 * frame, undo history, project or clipboard: apps/web/src/editor/ui-operators.ts). Misspelled ids
 * get the closest ids, completions of the id first, and advice in the note after them names the id
 * it is for.
 */

const headless = createOperatorRegistry();
const RUN = (id: string) =>
  `editor_command {project, command: 'run_operator', params: {operator: '${id}', params: {…}}} ` +
  '(get_connected_clients lists the editors that have the project open)';
const HEAD = (id: string) =>
  `'${id}' is an operator of the browser editor's user interface (viewport, playback, tools, windows): ` +
  'only a live editor can run it, not run_operator, batch or edit_mesh.';

describe('browserUiOperator', () => {
  it('says how to run a browser UI operator in a live editor, and what it does there', () => {
    expect(browserUiOperator('view3d.view_axis')).toBe(
      `${HEAD('view3d.view_axis')} Run it there with ${RUN('view3d.view_axis')}: it turns the person's view to ` +
        'an axis ({type: FRONT, BACK, RIGHT, LEFT, TOP or BOTTOM}, orthographic), out of the camera view ' +
        '(editor_command view.set_view does the same).',
    );
  });

  it("says what each one does to the person's editor", () => {
    for (const id of BROWSER_UI_OPERATORS) {
      const msg = browserUiOperator(id)!;
      expect(msg.slice(msg.indexOf(RUN(id)) + RUN(id).length), id).toMatch(/^: (it|in Edit Mode it) \S/);
    }
    // a new project in the person's editor, which leaves the project it had open before it answers
    expect(browserUiOperator('wm.read_homefile')).toBe(
      `${HEAD('wm.read_homefile')} To create a project use create_project. In a live editor run it with ` +
        `${RUN('wm.read_homefile')}: it creates a new project ({name, empty}) and switches the person's editor ` +
        'to it, away from the project it had open, which it leaves before it can answer (editor_command says ' +
        'so; list_projects lists the new project).',
    );
    // the person's clipboard
    expect(browserUiOperator('wm.share')).toBe(
      `${HEAD('wm.share')} For the project's link use get_project (editor_url). In a live editor run it with ` +
        `${RUN('wm.share')}: it puts the project's link on the person's clipboard, replacing what they had ` +
        'copied (a browser that refuses the copy shows them the link in a message; an editor page without ' +
        'clipboard access, served over plain HTTP from a host other than localhost, does nothing).',
    );
    const caveats: [string, string][] = [
      ['wm.import', 'browsers block unless the person has just clicked or pressed a key'],
      ['wm.export', "it opens the Export window on the person's screen."],
      ['wm.open_mainfile', "it opens the project browser on the person's screen."],
      ['wm.search_menu', "it opens the operator search on the person's screen."],
      ['wm.preferences', "it opens the Preferences window on the person's screen."],
      ['wm.save_mainfile', 'sync its WebDAV copy at once if it has one'],
      ['render.render', "it opens the Render window on the person's screen and renders the scene there"],
      [
        'view3d.object_as_camera',
        "it makes the editor's active object, which must be a camera, the scene camera",
      ],
      ['view3d.camera_to_view', 'and switches that editor to the camera view'],
      ['screen.animation_play', 'it starts or stops playback in that editor'],
      ['screen.workspace_set', "it switches the person's workspace layout"],
      ['wm.tool_set', "it changes the person's active tool"],
      [
        'view3d.view_all',
        "changing the person's view, out of the camera view (editor_command view.frame_all does the same)",
      ],
      ['ed.undo', 'never your changes made with the tools'],
      ['screen.repeat_last', 'operations run with editor_command are not repeated'],
    ];
    for (const [id, text] of caveats) expect(browserUiOperator(id), id).toContain(text);
  });

  it('says what the view operators do with the camera view (ui-operators.ts, rpc.ts)', () => {
    const src = (path: string) =>
      readFileSync(fileURLToPath(new URL(`../../../web/src/${path}`, import.meta.url)), 'utf8');
    const ui = src('editor/ui-operators.ts');
    const op = (id: string) => {
      const start = ui.indexOf(`id: '${id}'`);
      expect(start, id).toBeGreaterThan(0);
      return ui.slice(start, ui.indexOf('reg.register(', start));
    };
    // view3d.view_camera toggles and needs a scene camera; view.set_view CAMERA runs it unless the
    // editor already looks through a scene camera: it never leaves the camera view, and fails the
    // same way without a scene camera
    expect(op('view3d.view_camera')).toContain('v.cameraView.value = !v.cameraView.value');
    expect(op('view3d.view_camera')).toContain("throw new Error('No active camera in scene')");
    const rpc = src('editor/rpc.ts');
    const setView = rpc.slice(rpc.indexOf("case 'view.set_view':"), rpc.indexOf("case 'view.shading':"));
    expect(setView).toContain("type === 'CAMERA' && s.view.cameraView.value && s.doc.getScene().camera");
    expect(setView).toContain("runForAgent('view3d.view_camera', {})");
    const camera = browserUiOperator('view3d.view_camera')!;
    expect(camera).not.toContain('always');
    expect(camera).toMatch(
      /: it switches the person's view into or out of the scene camera's view, and fails without a scene camera \(editor_command view\.set_view \{view: 'CAMERA'\} switches into it, never out of it, and fails the same way\)\.$/,
    );
    // orbiting and perspective/orthographic change the pose only; zooming leaves the camera view
    for (const id of ['view3d.view_orbit', 'view3d.view_persportho']) {
      expect(op(id)).toContain('e.setPose(pose');
      expect(op(id)).not.toContain('cameraView');
      expect(browserUiOperator(id), id).toMatch(
        /; in the camera view it changes only the view they get back when they leave it\.$/,
      );
    }
    expect(op('view3d.zoom')).toContain('viewport.interaction?.zoomBy(');
    const interaction = src('viewport/interaction.ts');
    const zoomBy = interaction.slice(interaction.indexOf('  zoomBy(factor: number)'));
    expect(zoomBy.slice(0, zoomBy.indexOf('\n  }\n'))).toContain('this.leaveCameraView()');
    expect(browserUiOperator('view3d.zoom')).toMatch(
      /: it zooms the person's view in or out, out of the camera view\.$/,
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
      /To move, rotate or scale use transform\.translate \{value\}, transform\.rotate \{value, orient_axis\} or transform\.resize \{value\} on your selection \(through edit_mesh for mesh elements\), or the transform_object tool\. In a live editor run it with .*: it starts a move, rotation or scale of the editor's selection that follows the person's mouse until they click\.$/,
    );
    expect(browserUiOperator('mesh.loopcut_pick')).toMatch(
      /To cut a loop use edit_mesh \{object, operator: 'mesh\.loopcut', params: \{edge: \[a, b\], number_cuts\}\}.*: in Edit Mode it cuts the edge ring of the editor's active mesh under the person's mouse pointer, and fails when the pointer is over no edge\.$/,
    );
    expect(browserUiOperator('ed.undo')).toMatch(
      /To undo your own changes use the undo tool\. In a live editor .*: it undoes the last change in that editor's undo history: the person's, or an operator run there with editor_command, never your changes made with the tools\.$/,
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
    expect(browserUiOperatorsNote(['view3d.view_all'], ['view3d.view_all'], 'view3d.view_al')).toBe(
      `It is an operator of the browser editor's user interface: a live editor runs it with ${RUN_THEM}`,
    );
    expect(browserUiOperatorsNote(['ed.undo', 'ed.redo'], ['ed.undo', 'ed.redo'], 'ed.undoo')).toBe(
      "They are operators of the browser editor's user interface (instead: the undo tool for ed.undo, the redo " +
        `tool for ed.redo): a live editor runs them with ${RUN_THEM}`,
    );
    expect(
      browserUiOperatorsNote(
        ['object.duplicate_move'],
        ['object.duplicate_move', 'mesh.duplicate_move', 'object.duplicate'],
        'object.duplicate_movee',
      ),
    ).toBe(
      "object.duplicate_move is an operator of the browser editor's user interface (instead: object.duplicate " +
        `{offset}): a live editor runs it with ${RUN_THEM}`,
    );
    expect(browserUiOperatorsNote([], ['mesh.subdivide'], 'mesh.subdivid')).toBe('');
  });

  it('says which id each piece of advice is for, unless it is the one completion of the id', () => {
    // 'wm.save': get_project is the advice for wm.share, not for saving
    expect(
      browserUiOperatorsNote(['wm.save_mainfile', 'wm.share'], ['wm.save_mainfile', 'wm.share'], 'wm.save'),
    ).toBe(
      "They are operators of the browser editor's user interface (instead: nothing (the server stores projects) " +
        `for wm.save_mainfile, get_project for wm.share): a live editor runs them with ${RUN_THEM}`,
    );
    // one suggestion that is not a completion of what was typed
    expect(browserUiOperatorsNote(['wm.share'], ['wm.share'], 'wm.sahre')).toBe(
      "It is an operator of the browser editor's user interface (instead: get_project for wm.share): a live " +
        `editor runs it with ${RUN_THEM}`,
    );
    // the one completion: what the agent meant
    expect(browserUiOperatorsNote(['wm.share'], ['wm.share'], 'WM.SHA')).toBe(
      `It is an operator of the browser editor's user interface (instead: get_project): a live editor runs it with ${RUN_THEM}`,
    );
  });
});

describe('closestOperatorIds', () => {
  const candidates = [
    ...headless
      .list()
      .filter((d) => !d.uiOnly)
      .map((d) => d.id),
    ...BROWSER_UI_OPERATORS.filter((b) => !headless.has(b)),
  ];

  it('suggests the completions of an id first, the shortest first, letter case ignored', () => {
    // wm.save_mainfile is far from 'wm.save' by edit distance (wm.share is near): it used to be missing
    expect(closestOperatorIds('wm.save', candidates)).toEqual(['wm.save_mainfile', 'wm.share']);
    expect(closestOperatorIds('WM.Save', candidates)[0]).toBe('wm.save_mainfile');
    const views = closestOperatorIds('view3d.view', candidates);
    expect(views.slice(0, 6)).toEqual([
      'view3d.view_all',
      'view3d.view_axis',
      'view3d.view_orbit',
      'view3d.view_camera',
      'view3d.view_selected',
      'view3d.view_persportho',
    ]);
    expect(closestOperatorIds('object.dupli', candidates).slice(0, 3)).toEqual([
      'object.duplicate',
      'object.duplicate_move',
      'object.duplicates_make_real',
    ]);
    // at most 8, the nearest after the completions
    expect(closestOperatorIds('object.dupli', candidates)).toHaveLength(8);
    // the namespace counts: mesh.dupli is not object.duplicate
    expect(closestOperatorIds('mesh.dupli', candidates)[0]).toBe('mesh.duplicate_move');
    expect(closestOperatorIds('mesh.primitive_cub', candidates)[0]).toBe('mesh.primitive_cube_add');
  });

  it('needs 3 characters of the last segment and a namespace for a completion', () => {
    expect(completesOperatorId('wm.sav', 'wm.save_mainfile')).toBe(true);
    expect(completesOperatorId('wm.sa', 'wm.save_mainfile')).toBe(false);
    expect(completesOperatorId('save', 'wm.save_mainfile')).toBe(false);
    expect(completesOperatorId('mesh.save', 'wm.save_mainfile')).toBe(false);
    expect(completesOperatorId('WM.SAVE', 'wm.save_mainfile')).toBe(true);
    expect(closestOperatorIds('wm.sa', candidates)).not.toContain('wm.save_mainfile');
  });

  it('ranks the other suggestions by edit distance as before', () => {
    expect(closestOperatorIds('view3d.viewall', candidates)[0]).toBe('view3d.view_all');
    expect(closestOperatorIds('ed.undoo', candidates)).toEqual(['ed.undo', 'ed.redo']);
    expect(closestOperatorIds('object.duplicate_movee', candidates).slice(0, 3)).toEqual([
      'object.duplicate_move',
      'mesh.duplicate_move',
      'object.duplicate',
    ]);
    expect(closestOperatorIds('mesh.subdivid', candidates)[0]).toBe('mesh.subdivide');
    expect(closestOperatorIds('qqqqqqqq.zzzzzz', candidates)).toEqual([]);
  });
});
