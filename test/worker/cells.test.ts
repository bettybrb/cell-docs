import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ApiError, DocState, WorkspaceState } from "../../src/shared/api-types";
import { dummyBody, dummyTitle } from "../../src/shared/dummy-data";
import { docCellName, workspaceCellName } from "../../src/worker/addressing";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

describe("DocCell state", () => {
  it("returns 404 before the first write, then stores and returns the document", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");

    const before = await api<ApiError>("GET", docPath(ws, doc));
    expect(before.status).toBe(404);
    expect(before.data.error.code).toBe("doc_not_found");

    const content = { title: dummyTitle(), body: dummyBody() };
    const created = await api<DocState>("PUT", docPath(ws, doc), content);
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ ...content, revision: 1, workspaceId: ws, docId: doc });

    const read = await api<DocState>("GET", docPath(ws, doc));
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ ...content, revision: 1 });
  });

  it("increments the revision and keeps unspecified fields on update", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    await api("PUT", docPath(ws, doc), { title: "Original", body: "v1" });

    const updated = await api<DocState>("PUT", docPath(ws, doc), { body: "v2" });
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({ title: "Original", body: "v2", revision: 2 });
    expect(updated.data.updatedAt >= updated.data.createdAt).toBe(true);
  });

  it("validates input", async () => {
    const path = docPath(uniqueId("ws"), uniqueId("doc"));
    expect((await api("PUT", path, {})).status).toBe(400);
    expect((await api("PUT", path, { title: 42 })).status).toBe(400);
    expect((await api("PUT", path, { body: "x".repeat(100_001) })).status).toBe(400);
    expect((await api("PUT", path, ["not", "an", "object"])).status).toBe(400);
    expect((await api("DELETE", path)).status).toBe(405);
    // Nothing was stored by the rejected writes.
    expect((await api("GET", path)).status).toBe(404);
  });
});

describe("WorkspaceCell state", () => {
  it("stores and updates the display name", async () => {
    const ws = uniqueId("ws");
    expect((await api("GET", `/api/workspaces/${ws}`)).status).toBe(404);

    const created = await api<WorkspaceState>("PUT", `/api/workspaces/${ws}`, { displayName: "First" });
    expect(created.status).toBe(201);
    const updated = await api<WorkspaceState>("PUT", `/api/workspaces/${ws}`, { displayName: "Second" });
    expect(updated.status).toBe(200);
    expect(updated.data.createdAt).toBe(created.data.createdAt);

    const read = await api<WorkspaceState>("GET", `/api/workspaces/${ws}`);
    expect(read.data.displayName).toBe("Second");
    expect((await api("PUT", `/api/workspaces/${ws}`, { displayName: "  " })).status).toBe(400);
  });
});

describe("cell isolation", () => {
  it("keeps documents in the same workspace separate", async () => {
    const ws = uniqueId("ws");
    const [a, b] = [uniqueId("doc"), uniqueId("doc")];
    await api("PUT", docPath(ws, a), { body: "content of A" });
    await api("PUT", docPath(ws, b), { body: "content of B" });
    await api("PUT", docPath(ws, b), { body: "content of B, edited" });

    const readA = await api<DocState>("GET", docPath(ws, a));
    const readB = await api<DocState>("GET", docPath(ws, b));
    expect(readA.data).toMatchObject({ body: "content of A", revision: 1 });
    expect(readB.data).toMatchObject({ body: "content of B, edited", revision: 2 });
    expect(readA.data.cell.id).not.toBe(readB.data.cell.id);
  });

  it("keeps the same doc id in different workspaces separate", async () => {
    const doc = uniqueId("doc");
    const [ws1, ws2] = [uniqueId("ws"), uniqueId("ws")];
    await api("PUT", docPath(ws1, doc), { body: "only in ws1" });

    expect((await api("GET", docPath(ws2, doc))).status).toBe(404);
  });

  it("stores each cell's data only in that cell's own SQLite database", async () => {
    const ws = uniqueId("ws");
    const [a, b] = [uniqueId("doc"), uniqueId("doc")];
    await api("PUT", docPath(ws, a), { body: "A" });
    await api("PUT", docPath(ws, b), { body: "B" });

    const stubA = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, a)));
    const rows = await runInDurableObject(stubA, (_instance, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM doc").toArray(),
    );
    // Cell A's database holds exactly one document row: A's.
    expect(rows).toEqual([{ body: "A" }]);
  });

  it("rejects a request addressed to a cell under a different name", async () => {
    const ws = uniqueId("ws");
    await api("PUT", `/api/workspaces/${ws}`, { displayName: "Owner" });

    // Bypass the router and send a mismatched name straight to the cell.
    const stub = env.WORKSPACE_CELL.get(env.WORKSPACE_CELL.idFromName(workspaceCellName(ws)));
    const response = await stub.fetch("https://cell.internal/", {
      headers: { "x-cell-name": workspaceCellName("intruder") },
    });
    expect(response.status).toBe(409);
  });
});

describe("persistence across cell restarts", () => {
  it("reloads state from SQLite after the cell instance is evicted from memory", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    const content = { title: dummyTitle(), body: dummyBody() };
    await api("PUT", docPath(ws, doc), content);
    await api("PUT", docPath(ws, doc), { body: content.body + " +1" });

    const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));

    // Tag the live in-memory instance so we can prove a *new* one is created.
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { marker?: string }).marker = "before-eviction";
    });

    await evictDurableObject(stub);

    const markerAfter = await runInDurableObject(
      stub,
      (instance) => (instance as unknown as { marker?: string }).marker,
    );
    expect(markerAfter).toBeUndefined(); // fresh instance, in-memory state gone

    const read = await api<DocState>("GET", docPath(ws, doc));
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ title: content.title, body: content.body + " +1", revision: 2 });
  });
});
