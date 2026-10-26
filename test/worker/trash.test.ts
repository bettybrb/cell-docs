import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, DocCatalogue, DocState, DocVersionList, TrashList } from "../../src/shared/api-types";
import { CLOSE_DOC_DELETED } from "../../src/shared/doc-messages";
import { docCellName } from "../../src/worker/addressing";
import { DEFAULT_TRASH_RETENTION_MS } from "../../src/worker/cells/doc-cell";
import { api, uniqueId } from "./helpers";
import { closeAllClients, connect } from "./sync-client";

afterEach(closeAllClients);

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

async function newDoc() {
  const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
  const path = docPath(ws, doc);
  expect((await api("PUT", path, { title: "Report", body: "First draft" }, "alice")).status).toBe(201);
  await api("PUT", path, { body: "Second draft" }, "bob");
  await api("POST", `${path}/comments`, { body: "Keep this" }, "carol");
  const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));
  return { ws, doc, path, stub };
}

const listed = async (ws: string) => (await api<DocCatalogue>("GET", `/api/workspaces/${ws}/docs`)).data.docs.map((d) => d.docId);
const trash = async (ws: string, user = "alice") => (await api<TrashList>("GET", `/api/workspaces/${ws}/trash`, undefined, user)).data.docs;

describe("Recycle Bin", () => {
  it("moves a deleted document to the Recycle Bin and closes its live connections", async () => {
    const { ws, doc, path } = await newDoc();
    const reader = await connect(ws, doc, "carol");
    await vi.waitFor(() => expect(reader.text.toString()).toBe("Second draft"));

    const deleted = await api<DocState>("DELETE", path, undefined, "bob");
    expect(deleted.status).toBe(200);
    expect(deleted.data).toMatchObject({ deletedBy: "bob" });
    expect(Date.parse(deleted.data.purgeAt!) - Date.parse(deleted.data.deletedAt!)).toBe(DEFAULT_TRASH_RETENTION_MS);
    expect((await reader.closed).code).toBe(CLOSE_DOC_DELETED);

    expect((await api<ApiError>("GET", path)).data.error.code).toBe("doc_deleted");
    expect((await api("PUT", path, { body: "edit while deleted" })).status).toBe(410);
    const sync = await exports.default.fetch(`https://example.test${path}/sync`, { headers: { upgrade: "websocket" } });
    expect(sync.status).toBe(410);
    expect(await listed(ws)).toEqual([]);
    expect(await trash(ws)).toEqual([expect.objectContaining({ docId: doc, title: "Report", deletedBy: "bob" })]);
  });

  it("restores a document with its id, text, versions and comments", async () => {
    const { ws, doc, path } = await newDoc();
    await api("PUT", `${path}/permissions`, { defaultRole: "edit", users: { carol: "comment" } }, "alice");
    const versionsBefore = (await api<DocVersionList>("GET", `${path}/versions`)).data.versions;
    await api("DELETE", path);

    const restored = await api<DocState>("POST", `${path}/restore`, undefined, "carol");
    expect(restored.status).toBe(403); // carol may only comment
    const byBob = await api<DocState>("POST", `${path}/restore`, undefined, "bob");
    expect(byBob.status).toBe(200);
    expect(byBob.data).toMatchObject({ docId: doc, body: "Second draft", deletedAt: null, purgeAt: null });

    expect(await listed(ws)).toEqual([doc]);
    expect(await trash(ws)).toEqual([]);
    expect((await api<DocVersionList>("GET", `${path}/versions`)).data.versions).toEqual(versionsBefore);
    const comments = await api<{ comments: { body: string }[] }>("GET", `${path}/comments`);
    expect(comments.data.comments.map((c) => c.body)).toEqual(["Keep this"]);
    expect((await api("POST", `${path}/restore`)).status).toBe(409); // not in the Recycle Bin any more
  });

  it("lets the owner delete for good straight away, and the id can then be used again", async () => {
    const { ws, path } = await newDoc();
    await api("DELETE", path, undefined, "alice");
    expect((await api("POST", `${path}/purge`, undefined, "bob")).status).toBe(403); // not the owner
    expect((await api("POST", `${path}/purge`, undefined, "alice")).status).toBe(200);

    expect((await api("GET", path)).status).toBe(404);
    expect(await trash(ws)).toEqual([]);
    const reused = await api<DocState>("PUT", path, { body: "A new document" }, "carol");
    expect(reused.status).toBe(201);
    expect(reused.data).toMatchObject({ revision: 1, permissions: { owner: "carol" } });
    expect((await api<DocVersionList>("GET", `${path}/versions`)).data.versions).toHaveLength(1);
  });

  it("deletes a document for good once its time in the Recycle Bin is up", async () => {
    const { ws, path, stub } = await newDoc();
    await api("DELETE", path);

    // Before the deadline the alarm leaves it alone.
    await runDurableObjectAlarm(stub);
    expect(await trash(ws)).toHaveLength(1);

    // Move the deadline into the past, as if 30 days had gone by; the alarm
    // still scheduled for the original deadline then finds it due.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE doc SET purge_at = ?", new Date(Date.now() - 1_000).toISOString());
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(await trash(ws)).toEqual([]);
    expect((await api("GET", path)).status).toBe(404);
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM doc").one().n,
    );
    expect(tables).toBe(0);
  });

  it("shows each user only the deleted documents they could read", async () => {
    const { ws, path } = await newDoc();
    await api("PUT", `${path}/permissions`, { defaultRole: "none", users: { bob: "edit" } }, "alice");
    await api("DELETE", path, undefined, "bob");
    expect(await trash(ws, "bob")).toHaveLength(1);
    expect(await trash(ws, "carol")).toEqual([]);
  });
});
