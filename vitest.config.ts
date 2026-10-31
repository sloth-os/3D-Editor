import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'core',
          root: './packages/core',
          include: ['test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          root: './apps/server',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
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
