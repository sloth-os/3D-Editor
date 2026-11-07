/**
 * CPU time of the calling thread in milliseconds, for the performance bounds of tests.
 *
 * Unlike wall-clock time it does not grow while the thread waits for a CPU, so a bound on it holds
 * on a busy machine (a CI runner running test files in parallel): with four coverage runs at once
 * on four CPUs, the wall-clock time of the 100k-triangle render that render.test.ts times was 2.7
 * to 2.9 times its CPU time. Node before 22.19 has no thread CPU time: the process's is used instead
 * (vitest runs test files in child processes by default).
 */
export function cpuMs(): number {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage();
  return (u.user + u.system) / 1000;
}
