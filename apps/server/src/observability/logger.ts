import { stdTimeFunctions, type LoggerOptions } from 'pino';
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
