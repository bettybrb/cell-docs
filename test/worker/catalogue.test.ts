import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ApiError, DocCatalogue, DocState } from "../../src/shared/api-types";
import { docCellName, workspaceCellName } from "../../src/worker/addressing";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;
const listPath = (ws: string) => `/api/workspaces/${ws}/docs`;

const listedIds = async (ws: string) => (await api<DocCatalogue>("GET", listPath(ws))).data.docs.map((d) => d.docId);

const workspaceStub = (ws: string) =>
  env.WORKSPACE_CELL.get(env.WORKSPACE_CELL.idFromName(workspaceCellName(ws)));

/** Writes a doc straight to its DocCell, bypassing the router, as Phase 1 did. */
async function writePhase1Doc(ws: string, doc: string, body: string): Promise<void> {
  const name = docCellName(ws, doc);
  const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(name));
  const response = await stub.fetch("https://cell.internal/", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-cell-name": name },
    body: JSON.stringify({ title: "Old doc", body }),
  });
  expect(response.status).toBe(201);
}

describe("document catalogue", () => {
  it("is empty for a new workspace, without requiring the workspace to be created", async () => {
    const ws = uniqueId("ws");
    const { status, data } = await api<DocCatalogue>("GET", listPath(ws));
    expect(status).toBe(200);
    expect(data).toMatchObject({ workspaceId: ws, docs: [] });
    expect(data.cell.name).toBe(workspaceCellName(ws));
  });

  it("lists each created document once, with the doc's own createdAt", async () => {
    const ws = uniqueId("ws");
    const [a, b] = [uniqueId("doc"), uniqueId("doc")];
    const created = await api<DocState>("PUT", docPath(ws, a), { body: "A" });
    await api("PUT", docPath(ws, b), { body: "B" });
    await api("PUT", docPath(ws, a), { body: "A, edited" }); // update, not a new entry

    const { data } = await api<DocCatalogue>("GET", listPath(ws));
    expect(data.docs.map((d) => d.docId).sort()).toEqual([a, b].sort());
    expect(data.docs.find((d) => d.docId === a)?.createdAt).toBe(created.data.createdAt);
  });

  it("does not list documents that were never written or failed validation", async () => {
    const ws = uniqueId("ws");
    expect((await api("GET", docPath(ws, uniqueId("doc")))).status).toBe(404);
    expect((await api("PUT", docPath(ws, uniqueId("doc")), {})).status).toBe(400);
    expect(await listedIds(ws)).toEqual([]);
  });

  it("keeps catalogues of different workspaces separate", async () => {
    const [ws1, ws2] = [uniqueId("ws"), uniqueId("ws")];
    const doc = uniqueId("doc");
    await api("PUT", docPath(ws1, doc), { body: "only in ws1" });
    expect(await listedIds(ws1)).toEqual([doc]);
    expect(await listedIds(ws2)).toEqual([]);
  });

  it("survives eviction of the workspace cell", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    await api("PUT", docPath(ws, doc), { body: "x" });
    await evictDurableObject(workspaceStub(ws));
    expect(await listedIds(ws)).toEqual([doc]);
  });

  it("cannot be written by clients through the router", async () => {
    const ws = uniqueId("ws");
    expect((await api("PUT", listPath(ws), { createdAt: "x" })).status).toBe(405);
    expect(await listedIds(ws)).toEqual([]);
  });
});

describe("backward compatibility with Phase 1 documents", () => {
  it("keeps an uncatalogued document readable and registers it on first read", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    await writePhase1Doc(ws, doc, "written before the catalogue");
    expect(await listedIds(ws)).toEqual([]);

    const read = await api<DocState>("GET", docPath(ws, doc));
    expect(read.status).toBe(200);
    expect(read.data).toMatchObject({ body: "written before the catalogue", revision: 1 });
    expect(await listedIds(ws)).toEqual([doc]);
  });

  it("registers an uncatalogued document when it is saved, keeping its history", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    await writePhase1Doc(ws, doc, "v1");

    const updated = await api<DocState>("PUT", docPath(ws, doc), { body: "v2" });
    expect(updated.status).toBe(200);
    expect(updated.data).toMatchObject({ title: "Old doc", body: "v2", revision: 2 });
    expect(await listedIds(ws)).toEqual([doc]);
  });
});

describe("registration failure", () => {
  it("reports a clear error after the doc is saved, and a retry registers it", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");

    // Break the workspace cell's catalogue table to force registration to fail.
    await api("GET", listPath(ws));
    await runInDurableObject(workspaceStub(ws), (_instance, state) => {
      state.storage.sql.exec("DROP TABLE documents");
    });

    const failed = await api<ApiError>("PUT", docPath(ws, doc), { body: "saved anyway" });
    expect(failed.status).toBe(502);
    expect(failed.data.error.code).toBe("catalogue_registration_failed");
    expect(failed.data.error.message).toContain("is stored (revision 1)");

    // The DocCell kept the write.
    const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ body: string }>("SELECT body FROM doc").toArray(),
    );
    expect(rows).toEqual([{ body: "saved anyway" }]);

    // Restarting the workspace cell recreates the table; a plain read retries registration.
    await evictDurableObject(workspaceStub(ws));
    const retried = await api<DocState>("GET", docPath(ws, doc));
    expect(retried.status).toBe(200);
    expect(retried.data).toMatchObject({ body: "saved anyway", revision: 1 });
    expect(await listedIds(ws)).toEqual([doc]);
  });
});

describe("titles in the catalogue", () => {
  const listedTitles = async (ws: string) =>
    (await api<DocCatalogue>("GET", listPath(ws))).data.docs.map((d) => [d.docId, d.title]);

  it("lists each document's title and keeps it current", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    await api("PUT", docPath(ws, doc), { title: "First title", body: "x" });
    expect(await listedTitles(ws)).toEqual([[doc, "First title"]]);

    await api("PUT", docPath(ws, doc), { title: "Renamed" });
    expect(await listedTitles(ws)).toEqual([[doc, "Renamed"]]);
  });

  it("adds the title column to catalogues created before titles were tracked", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    await api("PUT", docPath(ws, doc), { title: "Kept title", body: "x" });
    // Recreate the catalogue table as it was before this change.
    await runInDurableObject(workspaceStub(ws), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE documents");
      sql.exec("CREATE TABLE documents (doc_id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
      sql.exec("INSERT INTO documents VALUES (?, ?)", doc, new Date().toISOString());
    });
    await evictDurableObject(workspaceStub(ws));

    expect(await listedTitles(ws)).toEqual([[doc, null]]); // known again after the next read
    await api("GET", docPath(ws, doc));
    expect(await listedTitles(ws)).toEqual([[doc, "Kept title"]]);
  });
});
