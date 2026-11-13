import type { ToolContext, ToolRegistrar } from './tool-kit';

/*
 * The rideo bridge tools (SPEC §11, phase 2): rideo_import (a rideo clip's blocking into a
 * project) and rideo_push (an export's clips back to rideo as motion references). The handlers
 * will read ctx.rideo when they run (registration reads nothing of ctx).
 */

export function registerRideoTools(_tool: ToolRegistrar, _ctx: ToolContext): void {
  // phase 2: rideo_import, rideo_push
}
