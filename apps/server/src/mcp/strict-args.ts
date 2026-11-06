import { z } from 'zod';
import { schemaParamNames, suggestNames } from '@3d-editor/core';

/*
 * Strict MCP tool arguments. zod objects strip keys they do not declare, so a misspelled tool
 * argument (`set_scene_settings {sampels: 5}`) used to be dropped silently and the tool ran with
 * the default instead. Tool input schemas are therefore closed (`additionalProperties: false` in
 * tools/list) and an unknown key, at the top level or inside a nested argument object (`view`,
 * `selection`, batch `operations`), fails the call with did-you-mean suggestions and the valid
 * names, like operator parameters do. Free-form maps (`params` of run_operator and friends) stay
 * open here: the operator registry checks their keys itself.
 */

const quote = (s: string) => `'${s}'`;

/** `'sampels' (did you mean 'samples'?)` for each key. */
function withSuggestions(keys: readonly string[], valid: readonly string[]): string[] {
  return keys.map((k) => {
    const s = suggestNames(k, valid);
    return s.length ? `${quote(k)} (did you mean ${s.map(quote).join(' or ')}?)` : quote(k);
  });
}

/**
 * Message for unknown keys of a nested argument object. The MCP SDK appends the location
 * (" at view", " at operations[2]"), so the message does not repeat it.
 */
export function unknownKeysMessage(keys: readonly string[], valid: readonly string[]): string {
  const plural = keys.length > 1 ? 's' : '';
  return `unknown key${plural} ${withSuggestions(keys, valid).join(', ')} (valid keys: ${valid.join(', ') || 'none'})`;
}

/** What a tool says about the unknown top-level arguments that are not typos of its own. */
export interface ToolArgsHelp {
  /** Tool name. */
  tool: string;
  /**
   * Hint for keys that match no argument, e.g. that operator parameters belong in `params`
   * (only shown when such a key is present).
   */
  hint?: string;
}

/**
 * Message for unknown top-level tool arguments: did-you-mean suggestions, the valid argument
 * names, keys that belong inside a nested argument (`position` → `view`) and the tool's hint.
 */
export function unknownArgumentsMessage(
  keys: readonly string[],
  shape: z.ZodRawShape,
  help: ToolArgsHelp,
): string {
  const valid = Object.keys(shape);
  const plural = keys.length > 1 ? 's' : '';
  // the MCP SDK names the tool before this message ("Invalid arguments for tool <name>: …")
  const parts = [
    `unknown argument${plural} ${withSuggestions(keys, valid).join(', ')}. Valid arguments: ${valid.join(', ') || 'none'}`,
  ];
  // keys of nested argument objects given at the top level
  const nested: string[] = [];
  for (const k of keys) {
    for (const [arg, schema] of Object.entries(shape)) {
      const inner = schemaParamNames(schema as z.ZodType);
      if (inner?.includes(k)) nested.push(`${quote(k)} goes inside ${quote(arg)} (${arg}: {${k}: …})`);
    }
  }
  if (nested.length) parts.push(nested.join('; '));
  const unmatched = keys.some((k) => !suggestNames(k, valid).length);
  if (help.hint && unmatched) parts.push(help.hint);
  return `${parts.map((p) => p.replace(/[.\s]+$/, '')).join('. ')}.`;
}

/**
 * A closed object schema for a nested tool argument: unknown keys fail with suggestions and the
 * valid keys (instead of being dropped).
 */
export function strictArgObject<S extends z.ZodRawShape>(shape: S): z.ZodObject<S, z.core.$strict> {
  const valid = Object.keys(shape);
  return z.strictObject(shape, {
    error: (iss) => (iss.code === 'unrecognized_keys' ? unknownKeysMessage(iss.keys, valid) : undefined),
  });
}

/** The closed input schema of a tool: unknown top-level arguments fail with suggestions. */
export function strictToolSchema<S extends z.ZodRawShape>(
  shape: S,
  help: ToolArgsHelp,
): z.ZodObject<S, z.core.$strict> {
  // the error map of an object only sees the issues of that object (nested objects have their own)
  return z.strictObject(shape, {
    error: (iss) =>
      iss.code === 'unrecognized_keys' ? unknownArgumentsMessage(iss.keys, shape, help) : undefined,
  });
}
