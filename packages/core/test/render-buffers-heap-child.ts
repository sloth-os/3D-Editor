// Builds the render buffers of a smooth grid of n × n quads and prints the triangle count; run in a
// child process with a small heap by render-buffers-memory.test.ts (argv: n, then 'reference' to
// build them with the old implementation instead).
import { buildRenderBuffers, createGrid } from '../src/mesh';
import { referenceBuildRenderBuffers } from './render-buffers-reference';

const n = Number(process.argv[2]);
const build = process.argv[3] === 'reference' ? referenceBuildRenderBuffers : buildRenderBuffers;
const grid = createGrid({ x_subdivisions: n, y_subdivisions: n });
grid.faceSmooth = grid.faceSmooth.map(() => true);
console.log(build(grid).indices.length / 3);
