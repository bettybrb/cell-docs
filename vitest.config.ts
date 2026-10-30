import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Two test projects, both run by `npm test`:
 * - worker: tests that run *inside* workerd, the Workers runtime, with the
 *   real Durable Object bindings declared in wrangler.jsonc.
 * - client: frontend tests in Node with happy-dom as a simulated browser.
 */
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, miniflare: { bindings: { LLM_MOCK: "1" } } })],
        test: { name: "worker", include: ["test/worker/**/*.test.ts"], setupFiles: ["test/worker/setup.ts"] },
      },
      {
        test: { name: "client", include: ["test/client/**/*.test.ts", "test/shared/**/*.test.ts"], environment: "happy-dom" },
      },
    ],
  },
});
