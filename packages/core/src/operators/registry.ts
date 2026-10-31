import { z } from 'zod';
import type { OperatorContext, OperatorSource, ReportLevel } from './context';
import { OperatorError } from './context';
import { Emitter } from '../util/emitter';

/**
 * Operators are the single entry point for every user-facing action (like Blender's
 * `bpy.ops`). Menus, hotkeys, the command palette, the scripting console, the redo panel
 * ("Adjust Last Operation") and MCP tools all execute operators through a registry, which
 * gives consistent validation, undo steps, info-log reports and telemetry.
 */
export interface OperatorDef<S extends z.ZodType = z.ZodType> {
  /** Blender-style id, e.g. 'mesh.primitive_cube_add'. */
  id: string;
  label: string;
  description: string;
  /** Menu/category grouping, e.g. 'Object', 'Mesh', 'Add', 'View'. */
  category: string;
  /** Parameter schema; `schema.parse(undefined ?? {})` must produce defaults. */
  schema: S;
  /**
   * Returns true when the operator can run, or a string explaining why it cannot.
   * Called before execute.
   */
  poll?: (ctx: OperatorContext) => true | string;
  execute(ctx: OperatorContext, params: z.infer<S>): unknown;
  /**
   * Whether the operator modifies the document and should create an undo step (default true).
   * Operators with `undo: false` must not modify the document; they run outside a transaction.
   */
  undo?: boolean;
  /** Whether the "Adjust Last Operation" panel can re-run it with different params. */
  redoable?: boolean;
  /** Only available in the browser UI (needs `ctx.ui`); hidden from MCP tool lists. */
  uiOnly?: boolean;
}

export interface OperatorRunEvent {
  id: string;
  label: string;
  params: unknown;
  source: OperatorSource;
  ok: boolean;
  error?: string;
  durationMs: number;
  result?: unknown;
  reports: { level: ReportLevel; message: string }[];
  startedAt: number;
  mode: string;
}

export interface RunResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
  reports: { level: ReportLevel; message: string }[];
  durationMs: number;
  params: unknown;
}

export interface OperatorInfo {
  id: string;
  label: string;
  description: string;
  category: string;
  redoable: boolean;
  uiOnly: boolean;
  /** JSON schema of the parameters. */
  parameters: unknown;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export class OperatorRegistry {
  private readonly ops = new Map<string, OperatorDef>();
  /** Fired after every operator execution (success or failure). */
  readonly onRun = new Emitter<OperatorRunEvent>();

  register<S extends z.ZodType>(def: OperatorDef<S>): this {
    if (this.ops.has(def.id)) throw new Error(`operator ${def.id} already registered`);
    this.ops.set(def.id, def as unknown as OperatorDef);
    return this;
  }

  /** Registers or replaces (used by the UI layer to override behaviour). */
  override<S extends z.ZodType>(def: OperatorDef<S>): this {
    this.ops.set(def.id, def as unknown as OperatorDef);
    return this;
  }

  has(id: string): boolean {
    return this.ops.has(id);
  }

  get(id: string): OperatorDef | undefined {
    return this.ops.get(id);
  }

  list(): OperatorDef[] {
    return [...this.ops.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Parses params, applying defaults. Throws OperatorError('INVALID_PARAMS'). */
  parseParams(id: string, params: unknown): unknown {
    const def = this.ops.get(id);
    if (!def) throw new OperatorError(`Unknown operator '${id}'`, 'NOT_FOUND');
    const res = def.schema.safeParse(params ?? {});
    if (!res.success) {
      const msg = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new OperatorError(`Invalid parameters for ${id}: ${msg}`, 'INVALID_PARAMS');
    }
    return res.data;
  }

  /** Checks availability: true or a reason string. */
  poll(ctx: OperatorContext, id: string): true | string {
    const def = this.ops.get(id);
    if (!def) return `Unknown operator '${id}'`;
    if (def.uiOnly && !ctx.ui) return `${id} is only available in the editor UI`;
    try {
      return def.poll ? def.poll(ctx) : true;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Runs an operator inside a single document transaction (= one undo step).
   * Never throws for operator failures; inspect `ok`/`error` on the result.
   */
  run<T = unknown>(ctx: OperatorContext, id: string, params?: unknown): RunResult<T> {
    const reports: RunResult['reports'] = [];
    const startedAt = Date.now();
    const t0 = now();
    const def = this.ops.get(id);
    const wrapped: OperatorContext = {
      ...ctx,
      report: (level, message) => {
        reports.push({ level, message });
        ctx.report(level, message);
      },
    };
    let parsed: unknown = params;
    const finish = (ok: boolean, result?: unknown, error?: string): RunResult<T> => {
      const durationMs = now() - t0;
      this.onRun.emit({
        id,
        label: def?.label ?? id,
        params: parsed,
        source: ctx.source,
        ok,
        error,
        durationMs,
        result,
        reports,
        startedAt,
        mode: ctx.state.mode,
      });
      return { ok, result: result as T, error, reports, durationMs, params: parsed };
    };
    try {
      parsed = this.parseParams(id, params);
      const p = this.poll(ctx, id);
      if (p !== true) throw new OperatorError(p, 'POLL_FAILED');
      let result: unknown;
      if (def!.undo === false) {
        // Non-undoable operators (selection, view, undo/redo itself) run outside a transaction so
        // they can drive the undo manager or read the document without creating undo steps.
        result = def!.execute(wrapped, parsed);
      } else {
        ctx.doc.transact(() => {
          result = def!.execute(wrapped, parsed);
        }, ctx.origin);
      }
      return finish(true, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      wrapped.report('ERROR', message);
      return finish(false, undefined, message);
    }
  }

  /** Describes operators (with JSON-schema parameters) for UIs, docs and MCP. */
  describe(opts: { includeUiOnly?: boolean; category?: string } = {}): OperatorInfo[] {
    return this.list()
      .filter((d) => (opts.includeUiOnly || !d.uiOnly) && (!opts.category || d.category === opts.category))
      .map((d) => ({
        id: d.id,
        label: d.label,
        description: d.description,
        category: d.category,
        redoable: !!d.redoable,
        uiOnly: !!d.uiOnly,
        parameters: safeJsonSchema(d.schema),
      }));
  }
}

export function safeJsonSchema(schema: z.ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
  } catch {
    return { type: 'object' };
  }
}

/** Helper to define an operator with full type inference. */
export function defineOperator<S extends z.ZodType>(def: OperatorDef<S>): OperatorDef<S> {
  return def;
}
