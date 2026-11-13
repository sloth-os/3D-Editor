import type { ServerConfig } from './config';
import type { Log } from './observability/log';
import type { RoomManager } from './sync/room-manager';

/** What a shutdown stops: the app (see app.ts AppHandle) and what the process runs besides. */
export interface ShutdownTarget {
  log: Log;
  /** The loaded projects: how long their close waits for storage, and which stayed unsaved. */
  rooms: Pick<RoomManager, 'setShutdownWait' | 'unsaved'>;
  /**
   * Stops everything: closes connections and MCP sessions, saves and closes the projects (waiting
   * for storage as long as `rooms` was told), stops the render processes.
   */
  close(): Promise<unknown>;
}

/** How long a shutdown takes at most (ServerConfig.shutdownTimeoutMs, shutdownSaveWaitMs). */
export interface ShutdownTimes {
  /** After this time the process exits anyway (SHUTDOWN_TIMEOUT_SECONDS). */
  timeoutMs: number;
  /** How long the projects' close waits for storage to save them (2 s less, half below 4 s: config.ts). */
  saveWaitMs: number;
}

/**
 * Stops the server (SIGTERM, SIGINT): tells the rooms how long to wait for storage, closes the
 * target, and calls `exit` with 0 once it has stopped, or with 1 when stopping failed. When it has
 * not stopped within `timeoutMs` (storage that does not answer, a request that does not end), it
 * logs the projects whose changes storage may not hold ('projects not saved at shutdown', with
 * their ids and names) and 'shutdown timed out after <n> s, exiting' at `error`, and calls
 * `exit(1)`: Docker sends SIGKILL 10 s after SIGTERM (`docker stop -t`), Kubernetes after
 * terminationGracePeriodSeconds (30 s), and a killed server says nothing about what it did not
 * save. Returns once `exit` was called.
 */
export function shutdown(
  target: ShutdownTarget,
  times: ShutdownTimes,
  exit: (code: number) => void,
  signal?: NodeJS.Signals,
): Promise<void> {
  const { log } = target;
  log.info({ signal }, 'shutting down: closing connections and saving projects');
  target.rooms.setShutdownWait(times.saveWaitMs);
  return new Promise<void>((resolve) => {
    let exited = false;
    const end = (code: number) => {
      if (exited) return;
      exited = true;
      clearTimeout(force);
      exit(code);
      resolve();
    };
    const force = setTimeout(() => {
      const unsaved = target.rooms.unsaved();
      if (unsaved.length > 0)
        log.error(
          { projects: unsaved, reason: 'the shutdown ran out of time before storage saved their changes' },
          'projects not saved at shutdown',
        );
      log.error(
        { timeoutMs: times.timeoutMs },
        `shutdown timed out after ${times.timeoutMs / 1000} s, exiting`,
      );
      end(1);
    }, times.timeoutMs);
    // (not unref'd: a close that waits for nothing the event loop holds, a promise that never settles,
    // would otherwise let the process end without these lines)
    // (a close that throws at once fails like one whose promise rejects)
    new Promise<unknown>((settle) => settle(target.close())).then(
      () => {
        if (exited) return;
        log.info({}, 'shutdown complete');
        end(0);
      },
      (err: unknown) => {
        if (exited) return;
        log.error({ err }, 'shutdown failed');
        end(1);
      },
    );
  });
}

/** What {@link stopOnSignals} listens to: the process. */
interface SignalSource {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
}

/**
 * Runs {@link shutdown} with the times of `config` (SHUTDOWN_TIMEOUT_SECONDS) on the first SIGTERM
 * or SIGINT. Later signals do nothing more than a log line ('shutdown already running, signal
 * ignored'): the listeners stay for the whole shutdown, since a signal without a listener ends the
 * process at once: a second SIGTERM used to kill the server that way, without the lines on what it
 * did not save.
 */
export function stopOnSignals(
  target: ShutdownTarget,
  config: Pick<ServerConfig, 'shutdownTimeoutMs' | 'shutdownSaveWaitMs'>,
  exit: (code: number) => void,
  signals: SignalSource = process,
): void {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      target.log.warn(
        { signal, timeoutMs: config.shutdownTimeoutMs },
        'shutdown already running, signal ignored',
      );
      return;
    }
    stopping = true;
    void shutdown(
      target,
      { timeoutMs: config.shutdownTimeoutMs, saveWaitMs: config.shutdownSaveWaitMs },
      exit,
      signal,
    );
  };
  signals.on('SIGTERM', stop);
  signals.on('SIGINT', stop);
}
