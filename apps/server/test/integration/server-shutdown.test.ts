import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/*
 * The shutdown of the server's own process (main.ts, SIGTERM): it stops its render processes
 * (closeSharedRenderer) before it exits; a render process that is busy would otherwise go on with
 * its request after the server ended (until its watchdog notices, within a second). The server runs
 * from source (tsx) through a script that reports, when the process exits, how many of its render
 * processes still run.
 */

const SERVER_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** The render processes (process.title '3d-editor-render') whose parent is `pid`, not ended. */
function renderProcesses(pid: number): number[] {
  const found: number[] = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(ppid) !== pid || state === 'Z') continue;
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes('3d-editor-render'))
        found.push(Number(entry));
    } catch {
      // ended meanwhile
    }
  }
  return found;
}

let dir: string | undefined;
let child: ChildProcess | undefined;

afterAll(async () => {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ended
    }
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('the server process at shutdown', () => {
  it('stops its render processes before it exits', async () => {
    dir = await mkdtemp(path.join(tmpdir(), '3d-editor-shutdown-'));
    const script = path.join(dir, 'server.mts');
    await writeFile(
      script,
      [
        "import { readdirSync, readFileSync, writeSync } from 'node:fs';",
        // (as renderProcesses above)
        'const renderProcesses = (pid) =>',
        "  readdirSync('/proc').filter((entry) => {",
        '    if (!/^\\d+$/.test(entry)) return false;',
        '    try {',
        "      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');",
        "      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');",
        "      if (Number(ppid) !== pid || state === 'Z') return false;",
        "      return readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes('3d-editor-render');",
        '    } catch {',
        '      return false;',
        '    }',
        '  });',
        "process.on('exit', () => {",
        '  writeSync(2, `render processes at exit: ${renderProcesses(process.pid).length}\\n`);',
        '});',
        `await import(${JSON.stringify(path.join(SERVER_DIR, 'src', 'main.ts'))});`,
      ].join('\n'),
    );
    const server = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: SERVER_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        PORT: '0',
        HOST: '127.0.0.1',
        SYNC_PERSISTENCE: 'memory',
        PUBLIC_DIR: path.join(dir, 'no-public'),
        LOG_LEVEL: 'info',
        RENDER_WORKERS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child = server;
    let out = '';
    server.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
    server.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d));
    const exited = new Promise<number | null>((resolve) => server.once('exit', (code) => resolve(code)));
    let url: string | null = null;
    for (let i = 0; i < 600 && !url; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const line = out.split('\n').find((l) => l.includes('"server listening"'));
      if (line) url = (JSON.parse(line) as { url: string }).url.replace(/\/$/, '');
    }
    expect(url, out.slice(-1500)).not.toBeNull();
    const created = await fetch(`${url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shutdown' }),
    });
    const { id } = (await created.json()) as { id: string };
    // a path-traced render starts a render process, which stays for the next one
    const render = await fetch(
      `${url}/api/projects/${id}/render.png?engine=PATHTRACER&width=32&height=32&samples=1`,
    );
    expect(render.status).toBe(200);
    expect(renderProcesses(server.pid!).length).toBeGreaterThan(0);
    server.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(out).toContain('"msg":"shutdown complete"');
    expect(out).toContain('render processes at exit: 0');
  });
});
