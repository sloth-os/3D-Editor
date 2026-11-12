import { writeSync } from 'node:fs';
import { stdTimeFunctions, symbols, type LoggerOptions } from 'pino';
import type { LogLevel } from '../config';
import { redactUrl } from '../auth';
import { traceLogMixin } from './tracing';

/** Header paths that must never appear in logs. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
];

interface RawRequestLike {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  socket?: { remoteAddress?: string; remotePort?: number };
  ip?: string;
  hostname?: string;
}

/** pino options used by Fastify: JSON lines, ISO timestamps, redaction and trace correlation. */
export function loggerOptions(level: LogLevel, service: string, version: string): LoggerOptions {
  return {
    level,
    base: { service, version },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    mixin: traceLogMixin,
    serializers: {
      req(req: RawRequestLike) {
        return {
          method: req.method,
          url: req.url ? redactUrl(req.url) : req.url,
          host: req.hostname,
          remoteAddress: req.ip ?? req.socket?.remoteAddress,
        };
      },
    },
  };
}

/**
 * The parts of pino's destination (sonic-boom 4, which writes to stdout asynchronously) that
 * {@link exitWithoutWaitingForLogs} uses: its file descriptor, the line an asynchronous write has in
 * hand and the lines that wait for it.
 */
interface LogDestination {
  fd?: unknown;
  _writing?: unknown;
  _writingBuf?: unknown;
  _bufs?: unknown;
  flushSync?: unknown;
}

/** How long {@link exitWithoutWaitingForLogs} lets a write of the logger in progress finish (ms). */
export const EXIT_LOG_DRAIN_MS = 100;

/**
 * Ends the process with `code` (process.exit) without waiting for the output of `logger` (a pino
 * logger, as Fastify's): a write of it in progress gets {@link EXIT_LOG_DRAIN_MS} at most to finish,
 * the lines it still holds are then written once, synchronously (as much as stdout takes at once:
 * nothing when the reader of its pipe closed it or does not read it), and its own flush at exit
 * does not run. That flush retries for ever when a write fails (sonic-boom 4.2: EPIPE after the
 * reader closed the pipe, EAGAIN while it does not read), so process.exit never returned and the
 * server never ended, also at the end of its forced shutdown.
 */
export function exitWithoutWaitingForLogs(
  logger: unknown,
  code: number,
  exit: (code: number) => void = (c) => process.exit(c),
): void {
  const stream =
    logger && typeof logger === 'object'
      ? ((logger as Record<symbol, unknown>)[symbols.streamSym] as LogDestination | undefined)
      : undefined;
  if (!stream || typeof stream !== 'object' || typeof stream.flushSync !== 'function') {
    exit(code);
    return;
  }
  const dest = stream;
  const end = () => {
    writeHeldLinesOnce(dest);
    // (pino flushes the destination when the process exits)
    dest.flushSync = () => undefined;
    exit(code);
  };
  const started = Date.now();
  const wait = () => {
    if (dest._writing !== true || Date.now() - started >= EXIT_LOG_DRAIN_MS) end();
    else setTimeout(wait, 5);
  };
  wait();
}

/** Writes the lines `dest` holds, once each and synchronously, until a write fails. */
function writeHeldLinesOnce(dest: LogDestination): void {
  const fd = dest.fd;
  if (typeof fd !== 'number' || fd < 0) return;
  const held: unknown[] = [];
  if (dest._writing !== true) held.push(dest._writingBuf);
  if (Array.isArray(dest._bufs)) held.push(...(dest._bufs as unknown[]));
  for (const chunk of held) {
    if (!(typeof chunk === 'string' || chunk instanceof Uint8Array) || chunk.length === 0) continue;
    try {
      if (typeof chunk === 'string') writeSync(fd, chunk);
      else writeSync(fd, chunk);
    } catch {
      return;
    }
  }
}
