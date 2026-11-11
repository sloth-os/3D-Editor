import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Y from 'yjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileStore, ProjectFileStore, SceneDoc, type WriteOptions } from '@3d-editor/core';
import { loadConfig } from '../../src/config';
import { shutdown, stopOnSignals, type ShutdownTarget } from '../../src/shutdown';
import { RoomManager, SHUTDOWN_SAVE_WAIT_MS } from '../../src/sync/room-manager';
import { ServerMetrics } from '../../src/observability/metrics';
import type { Log } from '../../src/observability/log';
import type { Persistence } from '../../src/persistence';

/*
 * The server's shutdown (SIGTERM, SIGINT; main.ts): it closes the app within SHUTDOWN_TIMEOUT_SECONDS
 * (9 s by default, below Docker's 10 s stop timeout), and when that time runs out it names the
 * projects that stayed unsaved and exits anyway. Storage that does not answer used to hold the
 * shutdown until the server gave up after 20 s, and a killed server said nothing about what it had
 * not saved.
 */

/** MemoryFileStore whose writes of documents can be left unanswered (storage that hangs). */
class HangingStore extends MemoryFileStore {
  hangWrites = false;
  override async write(path: string, data: Uint8Array, opts?: WriteOptions) {
    if (this.hangWrites && path.endsWith('/document.ybin')) await new Promise(() => undefined);
    return super.write(path, data, opts);
  }
}

/** A log that keeps every line (level, fields, message). */
function recordingLog() {
  const lines: { level: string; obj: unknown; msg?: string }[] = [];
  const entry = (level: string) => (obj: unknown, msg?: string) => lines.push({ level, obj, msg });
  const log: Log = { debug: entry('debug'), info: entry('info'), warn: entry('warn'), error: entry('error') };
  return { log, lines, messages: () => lines.map((l) => l.msg ?? l.obj) };
}

const managers: RoomManager[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(managers.splice(0).map((m) => m.close()));
});

function setup(log: Log) {
  const fs = new HangingStore();
  const store = new ProjectFileStore(fs, '/');
  const persistence: Persistence = {
    mode: 'disk',
    store,
    location: 'memory',
    check: async () => ({ ok: true }),
  };
  const rooms = new RoomManager({
    persistence,
    metrics: new ServerMetrics({ defaultMetrics: false }),
    log,
    ttlMs: 60_000,
    debounceMs: 60_000,
    serverVersion: 'test',
    sweepIntervalMs: 3_600_000,
  });
  managers.push(rooms);
  return { fs, store, rooms };
}

/** The names of the objects of a project's stored document. */
async function storedObjects(store: ProjectFileStore, id: string): Promise<string[]> {
  const stored = await store.loadDocument(id);
  const doc = new Y.Doc();
  if (stored) Y.applyUpdate(doc, stored.update);
  return new SceneDoc(doc).listObjects().map((o) => o.name);
}

describe('server shutdown', () => {
  it('takes its times from SHUTDOWN_TIMEOUT_SECONDS: 9 s by default, and 2 s less for storage', () => {
    const defaults = loadConfig({});
    expect(defaults.shutdownTimeoutMs).toBe(9000);
    expect(defaults.shutdownSaveWaitMs).toBe(7000);
    expect(defaults.shutdownSaveWaitMs).toBe(SHUTDOWN_SAVE_WAIT_MS);
    // Kubernetes stops a pod 30 s after SIGTERM by default (terminationGracePeriodSeconds)
    expect(loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '28' })).toMatchObject({
      shutdownTimeoutMs: 28_000,
      shutdownSaveWaitMs: 26_000,
    });
    expect(loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '3' })).toMatchObject({
      shutdownTimeoutMs: 3000,
      shutdownSaveWaitMs: 1500,
    });
    for (const bad of ['0', '-5', 'soon', '3601'])
      expect(() => loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: bad })).toThrow(/SHUTDOWN_TIMEOUT_SECONDS/);
    // main.ts stops the server with these times
    const main = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/stopOnSignals\(\s*\{\s*log: app\.log,\s*rooms: handle\.rooms,/);
    expect(main).toMatch(/\},\s*config,\s*\(code\) => process\.exit\(code\),\s*\);/);
  });

  it('exits with 0 once the app has closed and storage has saved the projects', async () => {
    const rec = recordingLog();
    const { rooms, store } = setup(rec.log);
    const room = await rooms.createProject({ name: 'Saved', empty: true });
    room.scene.addObject({ type: 'EMPTY', name: 'Change' });
    const exit = vi.fn();
    const target: ShutdownTarget = { log: rec.log, rooms, close: () => rooms.close() };
    await shutdown(target, { timeoutMs: 5000, saveWaitMs: 3000 }, exit, 'SIGTERM');
    expect(exit.mock.calls).toEqual([[0]]);
    expect(await storedObjects(store, room.id)).toEqual(['Change']);
    expect(rec.messages()).toEqual([
      'shutting down: closing connections and saving projects',
      'shutdown complete',
    ]);
  });

  it('tells the projects how long to wait for storage that does not answer', async () => {
    const rec = recordingLog();
    const { fs, rooms } = setup(rec.log);
    const room = await rooms.createProject({ name: 'Unsaved', empty: true });
    fs.hangWrites = true;
    room.scene.addObject({ type: 'EMPTY', name: 'Change' });
    const exit = vi.fn();
    const target: ShutdownTarget = { log: rec.log, rooms, close: () => rooms.close() };
    const started = Date.now();
    await shutdown(target, { timeoutMs: 5000, saveWaitMs: 200 }, exit);
    // the rooms waited 0.2 s for storage (not their default of 7 s), then said what stayed unsaved
    expect(Date.now() - started).toBeLessThan(3000);
    expect(exit.mock.calls).toEqual([[0]]);
    const report = rec.lines.find((l) => l.msg === 'projects not saved at shutdown');
    expect(report).toMatchObject({
      level: 'error',
      obj: {
        projects: [{ id: room.id, name: 'Unsaved' }],
        reason:
          'storage did not save their changes within 0.2 s, or refused them: the changes since their last save are lost',
      },
    });
  });

  it('exits after 9 s by default, naming the projects that stayed unsaved', async () => {
    const rec = recordingLog();
    const { rooms } = setup(rec.log);
    const kept = await rooms.createProject({ name: 'Kept open', empty: true });
    kept.scene.addObject({ type: 'EMPTY', name: 'Change' });
    await rooms.createProject({ name: 'Unchanged', empty: true });
    const exit = vi.fn();
    const signals = new EventEmitter();
    const wait = vi.spyOn(rooms, 'setShutdownWait');
    // a request that does not end holds the app's close (it closes the rooms after the requests)
    const target: ShutdownTarget = { log: rec.log, rooms, close: () => new Promise(() => undefined) };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopOnSignals(target, loadConfig({}), exit, signals);
    signals.emit('SIGTERM', 'SIGTERM');
    signals.emit('SIGINT', 'SIGINT'); // a second signal does not start another shutdown
    expect(wait.mock.calls).toEqual([[7000]]);
    await vi.advanceTimersByTimeAsync(8999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(rec.lines.filter((l) => l.level === 'error')).toEqual([
      {
        level: 'error',
        obj: {
          projects: [{ id: kept.id, name: 'Kept open' }],
          reason: 'the shutdown ran out of time before storage saved their changes',
        },
        msg: 'projects not saved at shutdown',
      },
      { level: 'error', obj: { timeoutMs: 9000 }, msg: 'shutdown timed out after 9 s, exiting' },
    ]);
    expect(rec.lines.filter((l) => l.msg?.startsWith('shutting down'))).toHaveLength(1);
    expect(rec.lines.filter((l) => l.level === 'warn')).toEqual([
      {
        level: 'warn',
        obj: { signal: 'SIGINT', timeoutMs: 9000 },
        msg: 'shutdown already running, signal ignored',
      },
    ]);
  });

  it('exits after the time SHUTDOWN_TIMEOUT_SECONDS gives', async () => {
    const rec = recordingLog();
    const exit = vi.fn();
    const signals = new EventEmitter();
    const rooms = { setShutdownWait: vi.fn(), unsaved: () => [] };
    const target: ShutdownTarget = { log: rec.log, rooms, close: () => new Promise(() => undefined) };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopOnSignals(target, loadConfig({ SHUTDOWN_TIMEOUT_SECONDS: '28' }), exit, signals);
    signals.emit('SIGINT', 'SIGINT');
    expect(rooms.setShutdownWait.mock.calls).toEqual([[26_000]]);
    await vi.advanceTimersByTimeAsync(27_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit.mock.calls).toEqual([[1]]);
    expect(rec.lines.map((l) => l.msg)).toEqual([
      'shutting down: closing connections and saving projects',
      'shutdown timed out after 28 s, exiting',
    ]);
  });

  /*
   * In a process of its own: a close that waits for a promise that never settles (nothing the
   * event loop holds) let the process end by itself, with code 0 and without a word, when the timer
   * of the forced exit did not hold the process.
   */
  it('ends its process at the time, also when nothing else keeps the process running', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shutdown-test-'));
    const module = fileURLToPath(new URL('../../src/shutdown.ts', import.meta.url));
    const script = path.join(dir, 'stop.mts');
    await writeFile(
      script,
      [
        `import { shutdown } from ${JSON.stringify(module)};`,
        'const line = (level) => (_obj, msg) => console.log(level, msg);',
        "const log = { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };",
        "const rooms = { setShutdownWait() {}, unsaved: () => [{ id: 'p', name: 'Kept open' }] };",
        'const target = { log, rooms, close: () => new Promise(() => undefined) };',
        'void shutdown(target, { timeoutMs: 300, saveWaitMs: 100 }, (code) => process.exit(code));',
      ].join('\n'),
    );
    try {
      const repo = fileURLToPath(new URL('../../../../', import.meta.url));
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: repo });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect({ code, lines: out.trim().split('\n') }).toEqual({
        code: 1,
        lines: [
          'info shutting down: closing connections and saving projects',
          'error projects not saved at shutdown',
          'error shutdown timed out after 0.3 s, exiting',
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /*
   * In a process of its own: the listeners of SIGTERM and SIGINT were removed by the first signal
   * (process.once), so a second SIGTERM ended the server at once (killed by the signal, without the
   * lines on what it did not save).
   */
  it('ignores a second signal while it shuts down', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'shutdown-test-'));
    const module = fileURLToPath(new URL('../../src/shutdown.ts', import.meta.url));
    const script = path.join(dir, 'signals.mts');
    await writeFile(
      script,
      [
        `import { stopOnSignals } from ${JSON.stringify(module)};`,
        'const line = (level) => (_obj, msg) => console.log(level, msg);',
        "const log = { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };",
        "const rooms = { setShutdownWait() {}, unsaved: () => [{ id: 'p', name: 'Kept open' }] };",
        'const target = { log, rooms, close: () => new Promise(() => undefined) };',
        'const config = { shutdownTimeoutMs: 800, shutdownSaveWaitMs: 400 };',
        'stopOnSignals(target, config, (code) => process.exit(code));',
        "console.log('ready');",
      ].join('\n'),
    );
    try {
      const repo = fileURLToPath(new URL('../../../../', import.meta.url));
      const child = spawn(process.execPath, ['--import', 'tsx', script], { cwd: repo });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        // the first signal once it listens, the second once it shuts down
        if (out === 'ready\n') child.kill('SIGTERM');
        else if (out.endsWith('info shutting down: closing connections and saving projects\n'))
          child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
      const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      expect({ ...ended, lines: out.trim().split('\n') }).toEqual({
        code: 1,
        signal: null,
        lines: [
          'ready',
          'info shutting down: closing connections and saving projects',
          'warn shutdown already running, signal ignored',
          'error projects not saved at shutdown',
          'error shutdown timed out after 0.8 s, exiting',
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits with 1 when closing fails, also when close throws at once', async () => {
    const rooms = { setShutdownWait: vi.fn(), unsaved: () => [] };
    const failures: ShutdownTarget['close'][] = [
      () => Promise.reject(new Error('broken')),
      () => {
        throw new Error('broken at once');
      },
    ];
    for (const close of failures) {
      const rec = recordingLog();
      const exit = vi.fn();
      await shutdown({ log: rec.log, rooms, close }, { timeoutMs: 5000, saveWaitMs: 3000 }, exit);
      expect(exit.mock.calls).toEqual([[1]]);
      expect(rec.lines.at(-1)).toMatchObject({ level: 'error', msg: 'shutdown failed' });
    }
  });
});
