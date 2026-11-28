import type { FastifyReply } from 'fastify';

/** The header names of a Vary value (`Accept-Encoding, Origin`), as written, without blanks. */
function varyNames(value: unknown): string[] {
  const text = Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '';
  return text
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Adds header names (or whole Vary values, `Accept, Brief`) to a reply's Vary, whether it was set
 * with reply.header or on the raw response (as the CORS hook does): each name once, whatever its
 * case. `*` (the answer depends on more than headers) stays alone.
 */
export function addVary(reply: FastifyReply, ...values: string[]): void {
  const names = varyNames(reply.getHeader('vary'));
  if (names.includes('*')) return;
  for (const name of values.flatMap(varyNames)) {
    if (name === '*') {
      reply.header('vary', '*');
      return;
    }
    if (!names.some((v) => v.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  if (names.length > 0) reply.header('vary', names.join(', '));
}
