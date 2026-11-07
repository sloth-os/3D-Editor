import { describe, expect, it } from 'vitest';
import { BROWSER_UI_OPERATORS, createOperatorRegistry } from '@3d-editor/core';
import { registry } from '../src/editor/editor';
import { registerUiOperators } from '../src/editor/ui-operators';

/*
 * The MCP server has no UI-only operators: for an id of BROWSER_UI_OPERATORS, run_operator, batch
 * and edit_mesh tell the agent to run it in a live editor (editor_command run_operator) instead of
 * answering "unknown operator". The list in packages/core must therefore name exactly the
 * operators the web app registers for its UI.
 */

describe('BROWSER_UI_OPERATORS (packages/core)', () => {
  it('lists exactly the UI-only operators the web app registers', () => {
    // the registry of the web app, set up as main.tsx does
    if (!registry.has('wm.call_menu')) registerUiOperators(registry);
    const registered = registry
      .list()
      .filter((d) => d.uiOnly)
      .map((d) => d.id)
      .sort();
    expect(registered.length).toBeGreaterThan(30);
    expect([...BROWSER_UI_OPERATORS].sort()).toEqual(registered);
  });

  it('names no operator of the headless registry, and each id once', () => {
    const headless = createOperatorRegistry();
    expect(BROWSER_UI_OPERATORS.filter((id) => headless.has(id))).toEqual([]);
    expect(new Set(BROWSER_UI_OPERATORS).size).toBe(BROWSER_UI_OPERATORS.length);
  });
});
