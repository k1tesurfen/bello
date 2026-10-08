import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Browser-based integration tests launch real Chromium processes.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
