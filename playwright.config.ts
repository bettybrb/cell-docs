import { defineConfig } from "@playwright/test";

/**
 * Browser tests: real Chromium pages against the real dev server, which the
 * tests start (and restart) themselves. Run with `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "test/e2e",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: { browserName: "chromium", headless: true },
});
