import { z } from 'zod';
import { suggestNames } from '../operators/params-check';

/*
 * Closed argument objects. zod objects strip keys they do not declare, so a misspelled argument
 * (`outputs: {clip: true}`) would be dropped silently and the default used instead; these objects
 * fail with did-you-mean suggestions and the valid keys, like operator parameters do. The server's
 * MCP tools and REST bodies use them for their nested arguments (apps/server/src/mcp/strict-args.ts
 * re-exports them), the video export parameters for `outputs` and the whole object.
 */

const quote = (s: string) => `'${s}'`;

/** `'sampels' (did you mean 'samples'?)` for each key. */
export function keysWithSuggestions(keys: readonly string[], valid: readonly string[]): string[] {
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
  return `unknown key${plural} ${keysWithSuggestions(keys, valid).join(', ')} (valid keys: ${valid.join(', ') || 'none'})`;
}

/**
 * A closed object schema for a nested argument: unknown keys fail with suggestions and the valid
 * keys (instead of being dropped).
 */
export function strictArgObject<S extends z.ZodRawShape>(shape: S): z.ZodObject<S, z.core.$strict> {
  const valid = Object.keys(shape);
  return z.strictObject(shape, {
    error: (iss) => (iss.code === 'unrecognized_keys' ? unknownKeysMessage(iss.keys, valid) : undefined),
  });
}
