/*
 * The errors of video export planning (planExport): the export names something that does not exist
 * (a shot, a camera), or its parameters cannot be exported. The server maps them to its tool errors
 * with the same codes (apps/server/src/video/plan.ts); the browser export shows the message.
 */

/** Codes of an {@link ExportError}: the same as the server's tool error codes. */
export type ExportErrorCode = 'INVALID_PARAMS' | 'NOT_FOUND';

/** An export that cannot be planned, with a message meant for the person or agent that asked for it. */
export class ExportError extends Error {
  constructor(
    message: string,
    readonly code: ExportErrorCode,
  ) {
    super(message);
    this.name = 'ExportError';
  }
}

export function isExportError(err: unknown): err is ExportError {
  return err instanceof ExportError;
}
