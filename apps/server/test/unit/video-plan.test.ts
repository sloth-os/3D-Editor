import { describe, expect, it } from 'vitest';
import { ExportError, SceneDoc, newShotId, setShots, videoExportParamsSchema } from '@3d-editor/core';
import { NotFoundError, ToolError } from '../../src/mcp/agent';
import { MAX_EXPORT_WAIT_S } from '../../src/video/params';
import { exportToolError, planExport } from '../../src/video/plan';

/*
 * The server's video export plan is core's (export/plan.ts, tested in packages/core); what the
 * server adds: core's planning errors become its tool errors with the same codes (agents and the
 * REST API see INVALID_PARAMS and NOT_FOUND as before), and status requests wait less than an MCP
 * client's request timeout.
 */

const params = (p: Record<string, unknown> = {}) => videoExportParamsSchema.parse(p);

describe('the server export plan', () => {
  it("throws core's planning errors as tool errors with their codes", () => {
    const doc = SceneDoc.create();
    const cam = doc.listObjects().find((o) => o.type === 'CAMERA')!.id;
    setShots(doc, [{ id: newShotId(), name: 'A', enabled: true, camera: cam, frame_start: 1, frame_end: 4 }]);
    expect(planExport(doc, params()).shots.map((s) => s.name)).toEqual(['A']);
    const missing = (() => {
      try {
        planExport(doc, params({ shots: ['Nope'] }));
      } catch (err) {
        return err;
      }
    })();
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as ToolError).code).toBe('NOT_FOUND');
    expect((missing as Error).message).toMatch(/^Shot 'Nope' not found \(shots: A\)/);
    const backwards = (() => {
      try {
        planExport(doc, params({ shots: undefined, frame_start: 9, frame_end: 3 }));
      } catch (err) {
        return err;
      }
    })();
    expect(backwards).toBeInstanceOf(ToolError);
    expect(backwards).not.toBeInstanceOf(NotFoundError);
    expect((backwards as ToolError).code).toBe('INVALID_PARAMS');
  });

  it('maps only export errors', () => {
    const other = new Error('boom');
    expect(exportToolError(other)).toBe(other);
    const mapped = exportToolError(new ExportError('too long', 'INVALID_PARAMS'));
    expect(mapped).toBeInstanceOf(ToolError);
    expect(mapped).toMatchObject({ message: 'too long', code: 'INVALID_PARAMS' });
  });

  it('waits less than an MCP request timeout for a status', () => {
    expect(MAX_EXPORT_WAIT_S).toBeLessThan(60);
  });
});
