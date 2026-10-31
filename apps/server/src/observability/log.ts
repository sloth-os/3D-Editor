/** Minimal structured logger interface (satisfied by pino / Fastify loggers). */
export interface Log {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const silentLog: Log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
