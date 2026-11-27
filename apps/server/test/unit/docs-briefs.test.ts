import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createOperatorRegistry } from '@3d-editor/core';

/*
 * docs/mcp.md against the code, where the brief tools and the operator catalogue are concerned: the
 * number of operators the registry holds (list_operators leaves out the render.* ones), the brief
 * tools among those whose out-of-memory errors carry the code, and what desk_stage_brief does with
 * a project it made for a brief that fails to stage; and architecture.md's note on what the retired
 * rideo bridge left in DATA_DIR. (*.md is prettier-ignored: nothing else keeps these numbers and
 * sentences true.)
 */

const file = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const mcp = file('../../../../docs/mcp.md');
const architecture = file('../../../../docs/architecture.md');
/** A source file of the server (apps/server/src/…). */
const source = (rel: string) => file(`../../src/${rel}`);
/** Prose with its line breaks as spaces (the docs are wrapped at 100 columns). */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('docs/mcp.md: the operator catalogue and the brief tools', () => {
  it('counts the operators the registry holds and the render.* ones list_operators leaves out', () => {
    const ops = createOperatorRegistry().list();
    const render = ops.filter((o) => o.id.startsWith('render.')).length;
    expect(render).toBeGreaterThan(0);
    expect(flat(mcp)).toContain(
      `The operator catalogue: ${ops.length} operators are registered, of which the ${render} ` +
        '`render.*` operators are not listed',
    );
  });

  it("names the brief tools among those whose out-of-memory errors carry the code, as their failures carry the operator's", () => {
    const tools = source('mcp/brief-tools.ts');
    // desk_stage_brief (runStep) and desk_shot_results throw the operator's code, which the tool
    // wrapper writes as JSON after the message for OUT_OF_MEMORY (agent.ts codedErrorDetails)
    expect(tools).toContain("throw new ToolError(res.error ?? `${id} failed`, res.code ?? 'FAILED');");
    expect(tools).toContain(
      "throw new ToolError(res.error ?? 'desk.shot_results failed', res.code ?? 'FAILED');",
    );
    expect(flat(mcp)).toContain(
      'and so do those of `desk_stage_brief` and `desk_shot_results`, whose operators the ' +
        "server's memory check refuses with that code (see [Briefs](#briefs)).",
    );
    expect(flat(mcp)).toContain(
      'A brief the server has no memory to stage is refused with `{"code": "OUT_OF_MEMORY"}` after ' +
        'the message',
    );
  });

  it('says that a project made for a brief that fails to stage is deleted again, or named when it stays', () => {
    const tools = source('mcp/brief-tools.ts');
    expect(tools).toContain('throw project ? err : await dropMadeProject(ctx, p, err);');
    expect(tools).toContain(
      'made for the brief stays: pass it as project to stage the brief in it, or delete it',
    );
    expect(flat(mcp)).toContain(
      'A project the call made for a brief that then fails to stage is deleted again, so that the ' +
        'brief can be sent again; when storage does not delete it, the error names it (pass it as ' +
        '`project`, or delete it).',
    );
  });

  it('says what the retired rideo bridge left behind can be deleted, and that the server deletes none of it', () => {
    // the job store leaves the bridge's push block out of loaded jobs and writes it back (jobs.ts)
    expect(source('video/jobs.ts')).toContain("const RETIRED_FIELDS = ['push'] as const;");
    expect(flat(architecture)).toContain(
      'Upgrading from a server with the retired rideo bridge: nothing reads `DATA_DIR/rideo-previs` (its ' +
        'previs jobs) or `DATA_DIR/rideo-push` (what it pushed to each clip) any more, and both can be ' +
        'deleted by hand; the server deletes neither. Exports of that time may keep a `push` block in ' +
        'their `job.json`, which `export_status` and `list_exports` leave out',
    );
  });
});
