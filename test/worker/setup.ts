/**
 * Loads the Worker and its cells (Yjs, Effect, diff, …) before any test in a
 * file runs. Otherwise the first request in a file pays for loading them,
 * which can exceed a test's time limit when many test files start at once.
 */
await import("../../src/worker/index");

export {};
