import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";

/**
 * Starts the real local stack (`vite` + Cloudflare plugin + workerd) against a
 * chosen SQLite state directory, so tests can stop and restart it.
 */
export interface DevServer {
  baseUrl: string;
  stop(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}

export async function startDevServer(options: { port: number; stateDir: string }): Promise<DevServer> {
  const child = spawn("node_modules/.bin/vite", ["--port", String(options.port)], {
    env: { ...process.env, CELL_DOCS_STATE_DIR: options.stateDir },
    // Own process group, so stop() can terminate vite *and* its workerd child.
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));

  const baseUrl = `http://localhost:${options.port}`;
  await waitForHealth(baseUrl, child, () => output);

  return {
    baseUrl,
    async stop(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      process.kill(-child.pid!, signal); // negative pid = whole process group
      await exited;
    },
  };
}

async function waitForHealth(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Dev server exited early (code ${child.exitCode}):\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.kill(-child.pid!, "SIGKILL");
  throw new Error(`Dev server did not become healthy in time:\n${output()}`);
}

export async function request<T>(baseUrl: string, method: string, path: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, data: (await response.json()) as T };
}
