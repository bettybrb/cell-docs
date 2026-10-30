import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CommentList, DocComment, DocState, WorkspaceState } from "../../src/shared/api-types";
import { dummyBody, dummyDocId, dummyTitle, dummyWorkspaceId } from "../../src/shared/dummy-data";
import { request, startDevServer, type DevServer } from "./dev-server";

/**
 * Restart persistence against the real local runtime: write through HTTP, stop
 * the whole server process tree, start a new one on the same state directory,
 * and read the data back.
 */

const PORT = 5191; // separate from the normal dev port (5180)

let stateDir: string;
let server: DevServer | undefined;

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "cell-docs-lab-restart-"));
});

afterAll(async () => {
  await server?.stop("SIGKILL");
  await rm(stateDir, { recursive: true, force: true });
});

describe.each(["SIGTERM", "SIGKILL"] as const)("after %s and restart", (signal) => {
  it("keeps workspace and document state, with comment threads", async () => {
    const ws = dummyWorkspaceId();
    const doc = dummyDocId();
    const content = { title: dummyTitle(), body: dummyBody(5) };

    server = await startDevServer({ port: PORT, stateDir });
    const wsWrite = await request<WorkspaceState>(server.baseUrl, "PUT", `/api/workspaces/${ws}`, {
      displayName: `Restart test (${signal})`,
    });
    expect(wsWrite.status).toBe(201);
    await request(server.baseUrl, "PUT", `/api/workspaces/${ws}/docs/${doc}`, content);
    const docWrite = await request<DocState>(server.baseUrl, "PUT", `/api/workspaces/${ws}/docs/${doc}`, {
      body: content.body + " [rev 2]",
    });
    expect(docWrite.data.revision).toBe(2);
    const comments = `/api/workspaces/${ws}/docs/${doc}/comments`;
    const thread = await request<DocComment>(server.baseUrl, "POST", comments, { body: "Check this." });
    expect(thread.status).toBe(201);
    await request(server.baseUrl, "POST", `${comments}/${thread.data.id}/replies`, { body: "Checked." });
    await request(server.baseUrl, "POST", `${comments}/${thread.data.id}/resolve`, { resolved: true });

    // The write responses above were only sent after the data was committed.
    await server.stop(signal);

    server = await startDevServer({ port: PORT, stateDir });
    const wsRead = await request<WorkspaceState>(server.baseUrl, "GET", `/api/workspaces/${ws}`);
    const docRead = await request<DocState>(server.baseUrl, "GET", `/api/workspaces/${ws}/docs/${doc}`);
    const commentsRead = await request<CommentList>(server.baseUrl, "GET", `/api/workspaces/${ws}/docs/${doc}/comments`);
    await server.stop("SIGTERM");

    expect(wsRead.status).toBe(200);
    expect(wsRead.data).toMatchObject({ displayName: `Restart test (${signal})`, cell: { id: wsWrite.data.cell.id } });
    expect(docRead.status).toBe(200);
    expect(docRead.data).toMatchObject({
      title: content.title,
      body: content.body + " [rev 2]",
      revision: 2,
      cell: { id: docWrite.data.cell.id },
    });
    expect(commentsRead.data.threads).toMatchObject([
      { body: "Check this.", resolvedAt: expect.any(String), replies: [{ body: "Checked." }] },
    ]);
  });
});
