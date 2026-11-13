// Fills this process's JavaScript heap, then asks the server's decode check (render/memory.ts) for a
// mesh that does not fit, many times in a row, for server-gc.test.ts, which starts it with a heap
// limit and --expose-gc. Prints a JSON line per phase, with the full garbage collections the check
// ran (it runs V8's `gc`).
//   argv: <'guarded' | 'unguarded'> <refusals>
//   guarded: the heap is filled with 32 MB arrays, each one only after the check allowed it (as the
//     server decodes meshes); unguarded: filled without asking it to 85% of the old generation's
//     limit (data the checks do not see: rooms, sessions), counted after a garbage collection.
import v8 from 'node:v8';
import { decodeCheck } from '../../src/render/memory';

const [scenario, refusalsArg] = process.argv.slice(2);
const MB = 1024 * 1024;
const CHUNK = 32 * MB;
const used = () => v8.getHeapStatistics().used_heap_size;
const limit = v8.getHeapStatistics().heap_size_limit;
// V8's young generation (3 semi-spaces of 16 MB) is part of the heap limit
const oldGenerationLimit = limit - 48 * MB;
const g = globalThis as { gc?: () => void };
const gc = g.gc!;
let collections = 0;
g.gc = () => {
  collections++;
  gc();
};
const layout = { vertices: 0, faces: 0, corners: 0, uvs: false, colors: false };
const check = decodeCheck();
const keep: number[][] = [];
const chunk = () => keep.push(new Array(CHUNK / 8).fill(0.5));

if (scenario === 'guarded') {
  while (!check({ layout, bytes: CHUNK })) chunk();
} else {
  const target = 0.85 * oldGenerationLimit;
  for (;;) {
    if (used() + CHUNK > target) {
      gc();
      if (used() + CHUNK > target) break;
    }
    chunk();
  }
}
console.log(JSON.stringify({ phase: 'filled', used: used(), limit, oldGenerationLimit, collections }));
collections = 0;
let refused = 0;
const refusals = Number(refusalsArg);
for (let i = 0; i < refusals; i++) if (check({ layout, bytes: 600 * MB })) refused++;
console.log(JSON.stringify({ phase: 'survived', refused, collections, chunks: keep.length }));
