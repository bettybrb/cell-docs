import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Unit/integration tests that run *inside* workerd, the Workers runtime, with
 * the real Durable Object bindings declared in wrangler.jsonc.
 */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["test/worker/**/*.test.ts"],
  },
});
