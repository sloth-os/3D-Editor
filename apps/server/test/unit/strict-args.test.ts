import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  strictArgObject,
  strictToolSchema,
  unknownArgumentsMessage,
  unknownKeysMessage,
} from '../../src/mcp/strict-args';

/*
 * Strict MCP tool arguments (lighthouse-cove v2 #0, leftovers #18): an unknown or misspelled tool
 * argument used to be stripped by zod and the tool ran with its default (`set_scene_settings
 * {sampels: 7}` succeeded and changed nothing). Tool schemas are closed now and the error names
 * the closest valid argument and every valid one.
 */

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const shape = {
  project: z.string(),
  samples: z.number().int().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  view: strictArgObject({ position: vec3, target: vec3, fov_degrees: z.number().optional() }).optional(),
};

function issues(schema: z.ZodType, value: unknown): string[] {
  const r = schema.safeParse(value);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.message);
}

describe('strict tool arguments', () => {
  const schema = strictToolSchema(shape, {
    tool: 'demo',
    hint: 'Operator parameters go inside `params`.',
  });

  it('rejects a misspelled argument with a suggestion and the valid names', () => {
    const [msg] = issues(schema, { project: 'P', sampels: 5 });
    expect(msg).toBe(
      "unknown argument 'sampels' (did you mean 'samples'?). Valid arguments: project, samples, params, view.",
    );
  });

  it('keeps valid calls working and leaves free-form params open', () => {
    const r = schema.safeParse({ project: 'P', samples: 4, params: { anything: 1 } });
    expect(r.success).toBe(true);
  });

  it('adds the hint only for keys that are no typo of a valid argument', () => {
    expect(issues(schema, { project: 'P', name: 'E' })[0]).toMatch(
      /Operator parameters go inside `params`\.$/,
    );
    expect(issues(schema, { project: 'P', parmas: {} })[0]).not.toMatch(/inside `params`/);
  });

  it('points keys of a nested argument object to that argument', () => {
    const [msg] = issues(schema, { project: 'P', position: [0, 0, 1] });
    expect(msg).toContain("'position' goes inside 'view' (view: {position: …})");
  });

  it('rejects unknown keys inside nested argument objects (the location is added by the MCP SDK)', () => {
    const msgs = issues(schema, { project: 'P', view: { position: [0, 0, 1], target: [0, 0, 0], fov: 40 } });
    expect(msgs).toEqual([
      "unknown key 'fov' (did you mean 'fov_degrees'?) (valid keys: position, target, fov_degrees)",
    ]);
    const r = schema.safeParse({ project: 'P', view: { position: [0, 0, 1], target: [0, 0, 0], fov: 40 } });
    expect(r.success ? [] : r.error.issues[0].path).toEqual(['view']);
  });

  it('lists several unknown arguments at once', () => {
    expect(unknownArgumentsMessage(['frmae', 'zzz'], shape, { tool: 'demo' })).toBe(
      "unknown arguments 'frmae', 'zzz'. Valid arguments: project, samples, params, view.",
    );
    expect(unknownKeysMessage(['parms'], ['operator', 'params'])).toBe(
      "unknown key 'parms' (did you mean 'params'?) (valid keys: operator, params)",
    );
  });

  it('produces closed JSON schemas at every object level', () => {
    const json = z.toJSONSchema(schema, { io: 'input' }) as {
      additionalProperties: unknown;
      properties: Record<string, { additionalProperties?: unknown }>;
    };
    expect(json.additionalProperties).toBe(false);
    expect(json.properties.view.additionalProperties).toBe(false);
    // records (free-form operator parameters) stay open
    expect(json.properties.params.additionalProperties).not.toBe(false);
  });
});
