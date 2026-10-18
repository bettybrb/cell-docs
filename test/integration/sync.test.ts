import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectDocSession, type ConnectedDocSession } from "../../src/client/doc-session";
import type { DocState } from "../../src/shared/api-types";
import { dummyDocId, dummyWorkspaceId } from "../../src/shared/dummy-data";
import { request, startDevServer, type DevServer } from "./dev-server";

/**
 * Two "browsers" (the real client sync code, using Node's WebSocket) editing
 * one document through the real dev server.
 */

const PORT = 5192;

let stateDir: string;
let server: DevServer;
const sessions: ConnectedDocSession[] = [];

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "cell-docs-lab-sync-"));
  server = await startDevServer({ port: PORT, stateDir });
});

afterAll(async () => {
  sessions.forEach((session) => session.destroy());
  await server?.stop("SIGTERM");
  await rm(stateDir, { recursive: true, force: true });
});

describe("live sync through the dev server", () => {
  it("shows one client's edits in the other without saving", async () => {
    const ws = dummyWorkspaceId();
    const doc = dummyDocId();
    const docPath = `/api/workspaces/${ws}/docs/${doc}`;
    await request(server.baseUrl, "PUT", docPath, { title: "Shared", body: "Saved text." });

    const serverUrl = `ws://localhost:${PORT}/api/workspaces/${ws}/docs`;
    const a = connectDocSession(serverUrl, doc);
    const b = connectDocSession(serverUrl, doc);
    sessions.push(a, b);
    await Promise.all([a.synced, b.synced]);
    expect(a.text.toString()).toBe("Saved text.");
    expect(b.text.toString()).toBe("Saved text.");

    a.text.insert(a.text.length, " Edited in A.");
    await vi.waitFor(() => expect(b.text.toString()).toBe("Saved text. Edited in A."), { timeout: 5_000 });

    const read = await request<DocState>(server.baseUrl, "GET", docPath);
    expect(read.data.body).toBe("Saved text. Edited in A.");
  });
});
