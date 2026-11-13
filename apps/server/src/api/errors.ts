import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { ToolError, isServiceErrorCode, type ServiceErrorCode, type ToolErrorCode } from '../mcp/agent';
import { errorMessage } from '../observability/tracing';

/*
 * Errors of the REST routes: `{error}` bodies, and `{error, code}` for a failure with a code (a
 * ToolError of a service, the same codes the MCP tools give as JSON after their message).
 */

/** HTTP status of each service error code (SPEC §1). */
export const SERVICE_ERROR_STATUS: Readonly<Record<ServiceErrorCode, number>> = {
  UNAVAILABLE: 503,
  FFMPEG_UNAVAILABLE: 503,
  UPSTREAM: 503,
  QUEUE_FULL: 409,
  NOT_DOWNLOADABLE: 409,
  NEEDS_KEY: 400,
};

/**
 * HTTP status of a ToolError code: the service codes as {@link SERVICE_ERROR_STATUS}, NOT_FOUND
 * 404, INVALID_PARAMS 400, POLL_FAILED 409 (the project's state does not allow it), OUT_OF_MEMORY
 * 507 (as the render routes answer), anything else 500.
 */
export function errorStatus(code: ToolErrorCode | undefined): number {
  if (isServiceErrorCode(code)) return SERVICE_ERROR_STATUS[code];
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_PARAMS':
      return 400;
    case 'POLL_FAILED':
      return 409;
    case 'OUT_OF_MEMORY':
      return 507;
    default:
      return 500;
  }
}

/** The reply of a ToolError: its status and `{error, code}` (`{error}` without a code), else null. */
export function restErrorReply(
  err: unknown,
): { status: number; body: { error: string; code?: ToolErrorCode } } | null {
  if (!(err instanceof ToolError)) return null;
  return {
    status: errorStatus(err.code),
    body: err.code ? { error: err.message, code: err.code } : { error: err.message },
  };
}

/**
 * Sends the reply of a failed route: a ToolError as {@link restErrorReply}, anything else as 500
 * `{error: "<what> failed: …"}`.
 */
export function sendRestError(reply: FastifyReply, err: unknown, what = 'request'): FastifyReply {
  const r = restErrorReply(err);
  if (r) return reply.code(r.status).send(r.body);
  reply.log.warn({ err: errorMessage(err) }, `${what} failed`);
  return reply.code(500).send({ error: `${what} failed: ${errorMessage(err)}` });
}

/** 400 `{error: "path: message; …"}` for a body or query that does not validate. */
export function badRequest(reply: FastifyReply, error: z.ZodError | string): FastifyReply {
  const message =
    typeof error === 'string'
      ? error
      : error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
  return reply.code(400).send({ error: message });
}
