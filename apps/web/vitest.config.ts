import { defineConfig } from 'vitest/config';

// Merged by the Angular unit-test builder (angular.json → test.options.runnerConfig).
// One forked worker keeps memory low on laptops and small CI runners (7 spec files run in ~1–2 min).
export default defineConfig({
  test: {
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});
