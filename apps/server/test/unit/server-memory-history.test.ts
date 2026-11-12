import { afterEach, describe, expect, it } from 'vitest';
import {
  SceneDoc,
  createGrid,
  projectObjects,
  storedMeshBytes,
  type OperatorMemoryRequest,
} from '@3d-editor/core';
import { AgentHistory, historyKept } from '../../src/mcp/history';
import {
  HISTORY_ADVICE,
  HISTORY_SAVE_BYTES_PER_BYTE,
  HISTORY_SAVE_BYTES_PER_ITEM,
  heldByHistories,
  maxProjectMeshBytes,
  operatorCheck,
  otherOpenProjects,
  projectGrowthRefusal,
  simulationCheck,
  trackOpenProject,
} from '../../src/render/memory';

/*
 * What the agents' undo histories keep in a project (mcp/history.ts) counts with what the project
 * keeps, in the limit per project and the one of all open projects, with what a save of it takes:
 * core counts the project's live data only, while a history keeps up to MCP_UNDO_MEMORY_MB per agent
 * (and its newest step), and a saved document carries what it keeps. Heaps are injected.
 */

const MB = 1024 * 1024;
const n = (v: number) => Math.round(v).toLocaleString('en-US');
const up = (bytes: number) => n(Math.ceil(bytes / MB));
/** `s` as a regular expression that matches it literally. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const opened: SceneDoc[] = [];
const histories: AgentHistory[] = [];

afterEach(() => {
  for (const h of histories.splice(0)) h.destroy();
  for (const d of opened.splice(0)) d.ydoc.destroy();
});

/** A project of one grid of g × g quads, tracked as open, named `name`. */
function openProject(name: string, g = 50): SceneDoc {
  const doc = SceneDoc.create({ name, empty: true });
  doc.addObject({
    type: 'MESH',
    name: 'Grid',
    data: doc.addMesh('Grid', createGrid({ x_subdivisions: g, y_subdivisions: g })),
  });
  trackOpenProject(doc);
  opened.push(doc);
  return doc;
}

/**
 * An agent with an undo history in `doc` that replaces the grid's vertex groups `steps` times, a step
 * each: the history keeps every version it replaced (`weights` floats per group, `groups` groups).
 */
function agentReplacingGroups(doc: SceneDoc, steps: number, groups = 4, weights = 20_000): AgentHistory {
  const origin = { type: 'mcp', session: `agent-${histories.length}` };
  const history = new AgentHistory(doc.ydoc, doc.sharedTypes(), origin);
  histories.push(history);
  const agent = new SceneDoc(doc.ydoc, origin);
  const mesh = doc.listObjects()[0].data!;
  for (let s = 0; s <= steps; s++) {
    history.undo.stopCapturing();
    agent.setVertexGroups(
      mesh,
      Array.from({ length: groups }, (_, g) => ({
        name: `G${g}`,
        weights: new Uint8Array(4 * weights).fill(s + 1),
      })),
    );
    history.maintain();
  }
  return history;
}

/** What `doc` keeps and what its save takes, as core counts them (without histories). */
function sizes(doc: SceneDoc) {
  const project = projectObjects(doc);
  return { stored: storedMeshBytes(doc) + project.bytes, save: project.save, objects: project.objects };
}

describe("agents' undo histories in the server's memory checks", () => {
  it('count what they keep, and six times it and 1,000 bytes per item for a save', () => {
    const doc = openProject('Solo');
    const history = agentReplacingGroups(doc, 5);
    const kept = historyKept(doc.ydoc);
    // five versions replaced (4 groups of 80,000 bytes each): about 1.6 MB
    expect(kept.items).toBe(5);
    expect(kept.bytes).toBeGreaterThan(5 * 4 * 80_000);
    expect(kept.bytes).toBeLessThan(5 * 4 * 80_000 * 1.01);
    expect(heldByHistories(doc)).toEqual({
      kept: kept.bytes,
      save: HISTORY_SAVE_BYTES_PER_BYTE * kept.bytes + HISTORY_SAVE_BYTES_PER_ITEM * kept.items,
    });
    expect([HISTORY_SAVE_BYTES_PER_BYTE, HISTORY_SAVE_BYTES_PER_ITEM]).toEqual([6, 1_000]);
    // the history ends (its session did): nothing is kept, nothing counted
    history.destroy();
    expect(historyKept(doc.ydoc)).toEqual({ bytes: 0, items: 0 });
    expect(heldByHistories(doc)).toEqual({ kept: 0, save: 0 });
  });

  it('take a project past its limit, which names their share; ended histories free it', () => {
    const limit = 300 * MB; // 22 MB for one project
    const doc = openProject('Solo');
    const history = agentReplacingGroups(doc, 5);
    const s = sizes(doc);
    const h = heldByHistories(doc);
    const max = maxProjectMeshBytes(limit);
    // a change that fits the project without what the history keeps, not with it
    const added = max - s.stored - s.save - h.kept / 2 - h.save;
    expect(s.stored + added + s.save).toBeLessThan(max);
    const total = s.stored + h.kept + added;
    const save = s.save + h.save;
    expect(projectGrowthRefusal(doc, added, 0, { heapLimit: () => limit })).toBe(
      `the project's meshes, objects, keyframes and images would then take about ${up(total)} MB of memory ` +
        `(now ${n((s.stored + h.kept) / MB)} MB with 1 object, ${up(h.kept)} MB of it kept by agents' undo histories), ` +
        `and a save of it about ${up(save)} MB more for a moment (3 times what its objects, datablocks and ` +
        `keyframes take, 5 times its images, 6 times its vertex groups and shape keys, 6 times what agents' ` +
        `undo histories keep and 1,000 bytes for each replaced value they keep): ` +
        `${n(Math.ceil(total / MB) + Math.ceil(save / MB))} MB in all, more than the 22 MB the server's process ` +
        'keeps for one project (half of its 300 MB heap less the 256 MB it keeps for its other work)',
    );
    // operators are held against the same
    const check = operatorCheck({
      heapFree: () => 290 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    const req: OperatorMemoryRequest = {
      operator: 'object.add_mesh_from_data',
      estimate: { bytes: MB, faces: 0, addedStoredBytes: added, addedSaveBytes: 0, lower: 'the faces' },
      storedBytes: s.stored,
      saveBytes: s.save,
      objects: s.objects,
      doc,
    };
    expect(check(req)).toMatch(
      new RegExp(
        `^not run on the server: the project's meshes, objects, keyframes and images would then take about [\\d,]+ MB of memory \\(now [\\d,.]+ MB with 1 object, ${up(h.kept)} MB of it kept by agents' undo histories\\), and a save of it about [\\d,]+ MB more for a moment \\(.*6 times what agents' undo histories keep and 1,000 bytes for each replaced value they keep\\): [\\d,]+ MB in all, more than the 22 MB .*\\. Lower the faces, or delete objects and meshes the project no longer needs${literal(HISTORY_ADVICE)}$`,
      ),
    );
    // the agent's session ended: the history is freed, the same change fits
    history.destroy();
    expect(projectGrowthRefusal(doc, added, 0, { heapLimit: () => limit })).toBeNull();
    expect(check(req)).toBeNull();
  });

  it('count with the frames a rigid body simulation would keep', () => {
    const limit = 300 * MB;
    const doc = openProject('Solo');
    const history = agentReplacingGroups(doc, 5);
    const s = sizes(doc);
    const h = heldByHistories(doc);
    const bytes = maxProjectMeshBytes(limit) - s.stored - s.save - h.kept / 2 - h.save;
    const check = simulationCheck({
      heapFree: () => 290 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    const req = { bodies: { simulated: 10, kinematic: 0 }, frame: 250, frames: 249, bytes, doc };
    expect(check(req)).toMatch(
      new RegExp(
        `^not simulated on the server: simulating 10 rigid bodies to frame 250 keeps 249 more frames of their poses, about [\\d,]+ MB, and the project's meshes, objects, keyframes, images and rigid body cache would then take about [\\d,]+ MB of memory \\(now [\\d,.]+ MB with 1 object, ${up(h.kept)} MB of it kept by agents' undo histories\\).* or delete objects and meshes the project no longer needs${literal(HISTORY_ADVICE)}$`,
      ),
    );
    history.destroy();
    expect(check(req)).toBeNull();
  });

  it('name the share only from 1 MB, but count it all the same', () => {
    const limit = 300 * MB;
    const doc = openProject('Solo');
    // two versions of one group of 80,000 bytes: about 160 KB
    agentReplacingGroups(doc, 2, 1);
    const h = heldByHistories(doc);
    expect(h.kept).toBeGreaterThan(160_000);
    expect(h.kept).toBeLessThan(MB);
    const s = sizes(doc);
    const added = maxProjectMeshBytes(limit) - s.stored - s.save - h.save - h.kept / 2;
    const refusal = projectGrowthRefusal(doc, added, 0, { heapLimit: () => limit });
    expect(refusal).toMatch(/\(now [\d,.]+ MB with 1 object\), and a save of it/);
    expect(refusal).toContain("6 times what agents' undo histories keep");
    // an operator's refusal ends with the advice only when it names the share
    const check = operatorCheck({
      heapFree: () => 290 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    const operator = check({
      operator: 'object.add_mesh_from_data',
      estimate: { bytes: MB, faces: 0, addedStoredBytes: added, addedSaveBytes: 0, lower: '' },
      storedBytes: s.stored,
      saveBytes: s.save,
      objects: s.objects,
      doc,
    });
    expect(operator).toMatch(/Delete objects and meshes the project no longer needs$/);
    expect(operator).not.toContain(HISTORY_ADVICE);
  });

  it('count in what open projects keep, naming the share of the others', () => {
    const limit = 300 * MB; // 36 MB for all open projects
    const a = openProject('Alpha');
    agentReplacingGroups(a, 10, 8); // about 6.4 MB kept by its history, 38 MB more while saved
    const b = openProject('Beta');
    const ha = heldByHistories(a);
    expect(ha.kept).toBeGreaterThan(6 * MB);
    const [other] = otherOpenProjects(b);
    expect(other).toEqual({
      id: '',
      name: 'Alpha',
      kept: sizes(a).stored + ha.kept,
      save: sizes(a).save + ha.save,
      history: ha.kept,
    });
    // Beta alone could take 1 MB more; with Alpha's history open beside it, it cannot
    expect(projectGrowthRefusal(b, 1 * MB, 0, { heapLimit: () => limit })).toMatch(
      new RegExp(
        `Other open projects take ${up(sizes(a).stored + ha.kept)} MB of it: 'Alpha' ${up(sizes(a).stored + ha.kept)} MB \\(${up(ha.kept)} MB of it kept by agents' undo histories\\)$`,
      ),
    );
    const check = operatorCheck({
      heapFree: () => 290 * MB,
      collect: () => undefined,
      heapLimit: () => limit,
    });
    const sb = sizes(b);
    const req: OperatorMemoryRequest = {
      operator: 'object.add_mesh_from_data',
      estimate: { bytes: MB, faces: 0, addedStoredBytes: 1 * MB, addedSaveBytes: 0, lower: '' },
      storedBytes: sb.stored,
      saveBytes: sb.save,
      objects: sb.objects,
      doc: b,
    };
    expect(check(req)).toMatch(
      new RegExp(
        `'Alpha' ${up(sizes(a).stored + ha.kept)} MB \\(${up(ha.kept)} MB of it kept by agents' undo histories\\)\\. Delete objects and meshes the projects no longer need \\(.*\\)${literal(HISTORY_ADVICE)}$`,
      ),
    );
    for (const h of histories) h.destroy();
    expect(otherOpenProjects(b)[0]).toEqual({
      id: '',
      name: 'Alpha',
      kept: sizes(a).stored,
      save: sizes(a).save,
    });
    expect(projectGrowthRefusal(b, 1 * MB, 0, { heapLimit: () => limit })).toBeNull();
  });
});
