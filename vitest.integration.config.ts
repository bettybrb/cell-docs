import { defineConfig } from "vitest/config";

/**
 * Integration tests that run in Node and drive the real dev server as a child
 * process. Slower than the in-runtime tests, so they are a separate command.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
