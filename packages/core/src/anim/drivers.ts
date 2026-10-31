import type { AnimTargetType, DriverData, DriverVariable } from '../doc/types';
import {
  compileExpression,
  EXPRESSION_CONSTANTS,
  ExpressionError,
  variableNameError,
  type CompiledExpression,
} from './expression';

export {
  compileExpression,
  evaluateExpression,
  tryCompileExpression,
  isReservedName,
  variableNameError,
  ExpressionError,
  EXPRESSION_CONSTANTS,
  EXPRESSION_FUNCTIONS,
  EXPRESSION_SYNTAX_HELP,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_LENGTH,
  type CompiledExpression,
  type ExpressionFunctionInfo,
  type ExpressionScope,
} from './expression';

/*
 * Drivers (Blender "Scripted Expression" drivers): a property is set every frame from an
 * expression of variables that read other (animated) properties, plus the current `frame`.
 * Expressions use the sandboxed language of ./expression (a Python subset compiled to closures,
 * never `eval`). The scene evaluator (FrameState) applies drivers after F-curves; a driver whose
 * expression or variables fail leaves the property at its animated value and reports the error.
 */

/** Reads the (animated) value of a channel; undefined when the target or property is missing. */
export type DriverReadFn = (
  type: AnimTargetType,
  id: string,
  path: string,
  index: number,
) => number | undefined;

/** A driver that cannot be evaluated (syntax error, unreadable variable, math error, NaN …). */
export class DriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriverError';
  }
}

/** Human readable description of the channel a variable reads, e.g. `object 'abc' location[2]`. */
export function describeDriverVariable(v: Pick<DriverVariable, 'target_type' | 'target_id' | 'path' | 'index'>): string {
  const target = v.target_type === 'world' || v.target_type === 'scene' ? v.target_type : `${v.target_type} '${v.target_id}'`;
  return `${target} ${v.path}[${v.index}]`;
}

function compile(expression: unknown): CompiledExpression {
  try {
    return compileExpression(typeof expression === 'string' ? expression : '');
  } catch (e) {
    throw new DriverError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Problems that make a driver unusable regardless of the scene state: expression syntax errors,
 * invalid or duplicate variable names, malformed variables and names used in the expression that
 * are neither variables, `frame` nor a constant. Empty when the driver is well formed.
 */
export function driverProblems(d: Pick<DriverData, 'expression' | 'variables'>): string[] {
  const problems: string[] = [];
  const vars: unknown[] = Array.isArray(d.variables) ? d.variables : [];
  if (d.variables !== undefined && !Array.isArray(d.variables)) problems.push('Driver variables must be a list');
  const names = new Set<string>();
  vars.forEach((raw, i) => {
    const v = raw as Partial<DriverVariable> | null;
    if (!v || typeof v !== 'object') {
      problems.push(`Variable #${i + 1} is not an object`);
      return;
    }
    const nameError = variableNameError(v.name as string);
    if (nameError) problems.push(nameError);
    else if (names.has(v.name!)) problems.push(`Duplicate variable name '${v.name}'`);
    else names.add(v.name!);
    if (typeof v.path !== 'string' || !v.path) problems.push(`Variable '${String(v.name)}' has no data path`);
    if (typeof v.target_id !== 'string') problems.push(`Variable '${String(v.name)}' has no target`);
    if (typeof v.index !== 'number' || !Number.isInteger(v.index) || v.index < 0)
      problems.push(`Variable '${String(v.name)}' has an invalid index (use 0 for scalars)`);
  });
  let expr: CompiledExpression;
  try {
    expr = compile(d.expression);
  } catch (e) {
    problems.push((e as Error).message);
    return problems;
  }
  for (const name of expr.names) {
    if (name === 'frame' || names.has(name) || Object.hasOwn(EXPRESSION_CONSTANTS, name)) continue;
    const have = [...names].map((n) => `'${n}'`).join(', ');
    problems.push(
      `Unknown name '${name}' in the expression: add a variable named '${name}'` +
        (have ? ` (variables: ${have})` : ' (the driver has no variables)') +
        ', or use frame, pi, tau or e',
    );
  }
  return problems;
}

/**
 * Evaluates a driver expression. Variables are bound by name from `d.variables` (read through
 * `read`), and `frame` is always available. Every variable is read (like Blender, an unreadable
 * variable invalidates the driver even if the expression does not use it). Throws DriverError for
 * syntax errors, unreadable or invalid variables, math errors and non-finite results.
 */
export function evaluateDriver(d: DriverData, frame: number, read: DriverReadFn): number {
  const expr = compile(d.expression);
  const scope = new Map<string, number>([['frame', frame]]);
  const problems: string[] = [];
  const vars: unknown[] = Array.isArray(d.variables) ? d.variables : [];
  for (const raw of vars) {
    const v = raw as DriverVariable | null;
    if (!v || typeof v !== 'object') {
      problems.push('Malformed driver variable');
      continue;
    }
    const nameError = variableNameError(v.name);
    if (nameError) {
      problems.push(nameError);
      continue;
    }
    if (scope.has(v.name)) {
      problems.push(`Duplicate variable name '${v.name}'`);
      continue;
    }
    let value: number | undefined;
    if (typeof v.path === 'string' && typeof v.target_id === 'string') {
      const index = Number.isInteger(v.index) && v.index >= 0 ? v.index : 0;
      try {
        value = read(v.target_type, v.target_id, v.path, index);
      } catch {
        value = undefined;
      }
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(
        value === undefined
          ? `Variable '${v.name}' cannot be read: ${describeDriverVariable(v)} does not exist`
          : `Variable '${v.name}' (${describeDriverVariable(v)}) is ${value}`,
      );
      continue;
    }
    scope.set(v.name, value);
  }
  if (problems.length) throw new DriverError(problems.join('; '));
  let result: number;
  try {
    result = expr.evaluate(scope);
  } catch (e) {
    if (e instanceof ExpressionError) throw new DriverError(e.message);
    throw new DriverError(e instanceof Error ? e.message : String(e));
  }
  if (!Number.isFinite(result))
    throw new DriverError(`Driver expression "${expr.source}" evaluated to ${result}`);
  return result;
}
