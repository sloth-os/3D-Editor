import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

/**
 * The frame states of a document share what they read of it until it changes (core
 * eval/frame-input.ts): frozen in every test run, so that code writing into an evaluated object's
 * arrays, poses or constraints throws in its tests instead of changing later frames.
 */
const FREEZE_EVALUATION_INPUT = { EVAL_FREEZE_INPUT: '1' };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          environment: 'node',
          // geometry, physics and path-tracing tests are CPU heavy; on shared CI runners and
          // under coverage instrumentation they can take several times longer than locally
          testTimeout: 30_000,
          hookTimeout: 30_000,
          env: FREEZE_EVALUATION_INPUT,
        },
      },
      {
        test: {
          name: 'server',
          root: './apps/server',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          env: FREEZE_EVALUATION_INPUT,
        },
      },
      {
        test: {
          name: 'integration',
          root: './apps/server',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        plugins: [preact()],
        test: {
          name: 'web',
          root: './apps/web',
          include: ['test/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['./test/setup.ts'],
          env: FREEZE_EVALUATION_INPUT,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // resolved relative to each project's root (packages/core, apps/server, apps/web)
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/test/**', '**/*.d.ts'],
      reporter: ['text-summary', 'html', 'lcov'],
    },
  },
});
