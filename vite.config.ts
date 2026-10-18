import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * One dev server for everything: Vite serves the React app, and the Cloudflare
 * plugin runs the Worker and its Durable Objects inside workerd (the open-source
 * Workers runtime), configured from wrangler.jsonc.
 *
 * CELL_DOCS_STATE_DIR lets tests point the local SQLite files at a throwaway
 * directory. By default state is kept in .wrangler/state (git-ignored).
 */
const stateDir = process.env.CELL_DOCS_STATE_DIR;

export default defineConfig({
  // Fixed port so the local URL is predictable; fail loudly if it is taken.
  server: { port: 5180, strictPort: true },
  preview: { port: 5180, strictPort: true },
  plugins: [
    react(),
    cloudflare({
      persistState: stateDir ? { path: stateDir } : true,
      // A second dev server (e.g. the restart test) must not fight over the debugger port.
      inspectorPort: stateDir ? false : undefined,
    }),
  ],
});
