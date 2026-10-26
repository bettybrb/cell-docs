import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import type { DocCatalogue, DocState, DocVersionDetail, DocVersionList } from "../../src/shared/api-types";
import { docCellName } from "../../src/worker/addressing";
import { AUTO_VERSION_INTERVAL_MS, MAX_VERSIONS, type DocCell } from "../../src/worker/cells/doc-cell";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

async function newDoc(content: { title?: string; body: string }) {
  const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
  expect((await api("PUT", docPath(ws, doc), content)).status).toBe(201);
  const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc))) as DurableObjectStub<DocCell>;
  return { ws, doc, path: docPath(ws, doc), stub };
}

const versions = async (path: string) => (await api<DocVersionList>("GET", `${path}/versions`)).data.versions;

/** A live edit, as if typed in a browser (applied to the cell's Y.Doc without a server origin). */
const liveEdit = (stub: DurableObjectStub<DocCell>, edit: (text: Y.Text) => void) =>
  runInDurableObject(stub, (instance) => edit((instance as unknown as { loadYDoc(): Y.Doc }).loadYDoc().getText("body")));

describe("versions", () => {
  it("keeps a version on every save with a body, not on title-only saves", async () => {
    const { path } = await newDoc({ title: "Plan", body: "First draft" });
    await api("PUT", path, { body: "Second draft" });
    await api("PUT", path, { title: "Renamed" }); // like a title autosave

    const list = await versions(path);
    expect(list.map((v) => [v.reason, v.title, v.preview, v.length])).toEqual([
      ["save", "Plan", "Second draft", 12],
      ["save", "Plan", "First draft", 11],
    ]);
  });

  it("restores a version, keeping the text it replaced as a version too", async () => {
    const { ws, doc, path } = await newDoc({ title: "Original", body: "Good text" });
    await api("PUT", path, { title: "Broken", body: "Someone deleted everything" });
    const [, first] = await versions(path);

    const restored = await api<DocState>("POST", `${path}/versions/${first.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.data).toMatchObject({ title: "Original", body: "Good text", revision: 3 });
    // The catalogue's title copy follows, as after any save.
    const catalogue = await api<DocCatalogue>("GET", `/api/workspaces/${ws}/docs`);
    expect(catalogue.data.docs).toEqual([expect.objectContaining({ docId: doc, title: "Original" })]);

    // Undo the restore by restoring the version it created.
    const [beforeRestore] = await versions(path);
    expect(beforeRestore).toMatchObject({ reason: "restore", title: "Broken", preview: "Someone deleted everything" });
    await api("POST", `${path}/versions/${beforeRestore.id}/restore`);
    expect((await api<DocState>("GET", path)).data).toMatchObject({ title: "Broken", body: "Someone deleted everything" });
  });

  it("takes an automatic version of the text before live edits, at most every few minutes", async () => {
    const { path, stub } = await newDoc({ body: "Before editing" });
    await liveEdit(stub, (text) => text.insert(text.length, "!"));
    expect((await versions(path)).map((v) => v.reason)).toEqual(["save"]); // the save is recent enough

    // Age the newest version past the interval: the next live edit keeps the text before it.
    await runInDurableObject(stub, (_instance, state) => {
      const old = new Date(Date.now() - AUTO_VERSION_INTERVAL_MS - 1_000).toISOString();
      state.storage.sql.exec("UPDATE doc_versions SET created_at = ?", old);
    });
    await liveEdit(stub, (text) => text.delete(0, 7));
    await liveEdit(stub, (text) => text.insert(0, ">> "));

    const list = await versions(path);
    expect(list.map((v) => [v.reason, v.preview])).toEqual([
      ["auto", "Before editing!"],
      ["save", "Before editing"],
    ]);
    expect((await api<DocState>("GET", path)).data.body).toBe(">> editing!");
  });

  it(`keeps only the newest ${MAX_VERSIONS} versions`, async () => {
    const { path } = await newDoc({ body: "v0" });
    for (let i = 1; i <= MAX_VERSIONS + 5; i++) await api("PUT", path, { body: `v${i}` });
    const list = await versions(path);
    expect(list).toHaveLength(MAX_VERSIONS);
    expect(list[0].preview).toBe(`v${MAX_VERSIONS + 5}`);
    expect(list.at(-1)!.preview).toBe("v6");
  });

  it("rejects unknown versions and wrong methods", async () => {
    const { path } = await newDoc({ body: "x" });
    expect((await api("POST", `${path}/versions/999999/restore`)).status).toBe(404);
    expect((await api("GET", `${path}/versions/1/restore`)).status).toBe(405);
    expect((await api("POST", `${path}/versions`)).status).toBe(405);
    expect((await api("POST", `${path}/versions/abc/restore`)).status).toBe(404); // no such route
  });
});

describe("version history: who and when, preview, nothing lost", () => {
  it("records who created each version and who edited since the previous one", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    const path = docPath(ws, doc);
    await api("PUT", path, { title: "Notes", body: "v1" }, "alice");
    await api("PUT", path, { title: "Notes by bob" }, "bob"); // title only: no version, but bob edited
    await api("PUT", path, { body: "v2" }, "carol");

    const list = await versions(path);
    expect(list.map((v) => [v.reason, v.createdBy, v.editors, v.preview])).toEqual([
      ["save", "carol", ["bob", "carol"], "v2"],
      ["save", "alice", ["alice"], "v1"],
    ]);
    expect(Date.parse(list[0].createdAt)).toBeGreaterThanOrEqual(Date.parse(list[1].createdAt));
  });

  it("previews a version's full text", async () => {
    const long = "x".repeat(500);
    const { path } = await newDoc({ body: long });
    const [version] = await versions(path);
    expect(version.preview).toHaveLength(80);
    const detail = await api<DocVersionDetail>("GET", `${path}/versions/${version.id}`);
    expect(detail.status).toBe(200);
    expect(detail.data).toMatchObject({ id: version.id, body: long, length: 500 });
    expect((await api("GET", `${path}/versions/999999`)).status).toBe(404);
  });

  it("restores without deleting any version in between", async () => {
    const { path } = await newDoc({ body: "one" });
    await api("PUT", path, { body: "two" });
    await api("PUT", path, { body: "three" });
    const before = await versions(path);
    const oldest = before.at(-1)!;

    await api("POST", `${path}/versions/${oldest.id}/restore`, undefined, "bob");
    const after = await versions(path);
    expect(after.map((v) => v.id)).toEqual(expect.arrayContaining(before.map((v) => v.id)));
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]).toMatchObject({ reason: "restore", createdBy: "bob", preview: "three" });
    expect((await api<DocState>("GET", path)).data.body).toBe("one");
  });
});
