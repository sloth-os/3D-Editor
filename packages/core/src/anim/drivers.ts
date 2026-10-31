import type { AnimTargetType, DriverData } from '../doc/types';

/** Reads the (animated) value of a channel; undefined when the target or property is missing. */
export type DriverReadFn = (
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
) => number | undefined;

export class DriverError extends Error {}

/**
 * Evaluates a driver expression. Variables are bound by name from `d.variables` (read through
 * `read`), and `frame` is always available. Expressions are parsed by a safe evaluator (no `eval`).
 *
 * Phase-0 stub: only plain numeric expressions. The animation workstream implements the parser
 * (arithmetic, comparison, ternary, math functions like sin/cos/abs/min/max/clamp/lerp/noise).
 */
export function evaluateDriver(d: DriverData, frame: number, read: DriverReadFn): number {
  void frame;
  void read;
  const v = Number(d.expression);
  if (d.expression.trim() !== '' && Number.isFinite(v)) return v;
  throw new DriverError('driver expressions are not supported yet');
}
