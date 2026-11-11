import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The server's memory checks (render/memory.ts) run a full garbage collection before they refuse a
 * request, since the heap in use counts garbage. V8 ends a process ("FATAL ERROR: Ineffective
 * mark-compacts near heap limit") when four full collections in a row leave its old generation at
 * 80% of its limit or more while the program ran for less than 40% of the time between them. With
 * Node's default heap the checks used to let the heap fill up to its limit less 256 MB (88%), and a
 * get_scene that found six stored meshes it could not load, or an agent asking get_object about one
 * of them six times, ended the server that way. The checks now keep a quarter of the heap free
 * (serverHeapReserve) and run at most one collection a second (collectGarbage). A process with a
 * heap of 1,280 MB (in which the old checks also went past that mark) fills its heap through the
 * check, as the server decodes meshes, or without it (data the checks do not see), and then has 20
 * requests refused in a row: it keeps running.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(here, '..', '..');
const OLD_SPACE_MB = 1280;
const REFUSALS = 20;

interface Phase {
  phase: string;
  used?: number;
  oldGenerationLimit?: number;
  refused?: number;
  collections?: number;
}

/** Runs server-gc-child.ts with a heap of OLD_SPACE_MB: its JSON lines, and its output for errors. */
function run(scenario: 'guarded' | 'unguarded') {
  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${OLD_SPACE_MB}`,
      '--expose-gc',
      '--import',
      'tsx',
      path.join(here, 'server-gc-child.ts'),
      scenario,
      String(REFUSALS),
    ],
    { cwd: SERVER_DIR, encoding: 'utf8', timeout: 45_000 },
  );
  const phases = child.stdout
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Phase);
  const output = `exit ${child.status ?? child.signal}\n${child.stdout.slice(-1500)}\n${child.stderr.slice(-1500)}`;
  return {
    child,
    output,
    filled: phases.find((p) => p.phase === 'filled'),
    survived: phases.find((p) => p.phase === 'survived'),
  };
}

describe("the server's memory checks near its heap limit", () => {
  it('keep what they let in below the mark where V8 ends a process, and survive refusals in a row', () => {
    const { child, output, filled, survived } = run('guarded');
    expect(child.signal, output).toBeNull();
    expect(child.status, output).toBe(0);
    // a quarter of the heap stays free: under 80% of the old generation's limit
    expect(filled!.used!, output).toBeLessThan(0.8 * filled!.oldGenerationLimit!);
    expect(survived).toMatchObject({ refused: REFUSALS });
    // the check that ended the filling collected; the refusals right after it do not
    expect(survived!.collections).toBe(0);
  });

  it('run at most one full collection a second, also in a heap filled past that mark without them', () => {
    const { child, output, filled, survived } = run('unguarded');
    expect(child.signal, output).toBeNull();
    expect(child.status, output).toBe(0);
    expect(filled!.used!).toBeGreaterThan(0.8 * filled!.oldGenerationLimit!);
    expect(survived).toMatchObject({ refused: REFUSALS, collections: 1 });
  });
});
