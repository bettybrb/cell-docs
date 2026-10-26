import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type * as Y from "yjs";
import type { ApiError, CatalogueEntry, DocCatalogue, DocState, Folder, SearchResults } from "../../src/shared/api-types";
import { docCellName } from "../../src/worker/addressing";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;
const catalogue = async (ws: string, user?: string) =>
  (await api<DocCatalogue>("GET", `/api/workspaces/${ws}/docs`, undefined, user)).data;
const search = async (ws: string, query: string, user?: string) =>
  (await api<SearchResults>("GET", `/api/workspaces/${ws}/search?${query}`, undefined, user)).data.results;
const folder = async (ws: string, name: string, parentId?: string) =>
  api<Folder>("POST", `/api/workspaces/${ws}/folders`, { name, parentId });
const meta = (ws: string, doc: string, body: object, user?: string) =>
  api<CatalogueEntry>("PUT", `${docPath(ws, doc)}/meta`, body, user);

async function workspaceWithDocs() {
  const ws = uniqueId("ws");
  const docs = { budget: "budget-2026", notes: "meeting-notes", plan: "launch-plan" };
  await api("PUT", docPath(ws, docs.budget), { title: "Budget 2026", body: "Costs for travel and hardware." });
  await api("PUT", docPath(ws, docs.notes), { title: "Meeting notes", body: "We agreed the budget is tight." });
  await api("PUT", docPath(ws, docs.plan), { title: "Launch plan", body: "Ship in March." });
  return { ws, docs };
}

describe("folders", () => {
  it("creates folders, nested ones too, and refuses duplicate names in the same place", async () => {
    const ws = uniqueId("ws");
    const projects = await folder(ws, "Projects");
    expect(projects.status).toBe(201);
    const nested = await folder(ws, "2026", projects.data.id);
    expect(nested.data).toMatchObject({ name: "2026", parentId: projects.data.id });
    expect((await folder(ws, "projects")).status).toBe(409);
    expect((await folder(ws, "Projects", projects.data.id)).status).toBe(201); // another place
    expect((await folder(ws, "Orphan", "f-missing0")).status).toBe(400);
    expect((await catalogue(ws)).folders.map((f) => f.name).sort()).toEqual(["2026", "Projects", "Projects"]);
  });

  it("moves documents between folders without changing their ids", async () => {
    const { ws, docs } = await workspaceWithDocs();
    const finance = (await folder(ws, "Finance")).data;
    const moved = await meta(ws, docs.budget, { folderId: finance.id });
    expect(moved.data).toMatchObject({ docId: docs.budget, folderId: finance.id });

    expect((await api<DocState>("GET", docPath(ws, docs.budget))).data.title).toBe("Budget 2026"); // same address
    expect((await search(ws, `folder=${finance.id}`)).map((r) => r.docId)).toEqual([docs.budget]);
    expect((await meta(ws, docs.budget, { folderId: null })).data.folderId).toBeNull();
    expect((await meta(ws, docs.budget, { folderId: "f-missing0" })).status).toBe(400);
  });

  it("deletes only empty folders", async () => {
    const { ws, docs } = await workspaceWithDocs();
    const archive = (await folder(ws, "Archive")).data;
    await meta(ws, docs.plan, { folderId: archive.id });
    expect((await api<ApiError>("DELETE", `/api/workspaces/${ws}/folders/${archive.id}`)).status).toBe(409);
    await meta(ws, docs.plan, { folderId: null });
    expect((await api("DELETE", `/api/workspaces/${ws}/folders/${archive.id}`)).status).toBe(204);
  });

  it("only lets editors move or tag a document", async () => {
    const { ws, docs } = await workspaceWithDocs();
    await api("PUT", `${docPath(ws, docs.plan)}/permissions`, { defaultRole: "read", users: {} }, "alice");
    expect((await meta(ws, docs.plan, { tags: ["nope"] }, "bob")).status).toBe(403);
    expect((await meta(ws, docs.plan, { tags: ["ok"] }, "alice")).status).toBe(200);
  });
});

describe("tags", () => {
  it("stores tags in lower case without duplicates and offers them for reuse", async () => {
    const { ws, docs } = await workspaceWithDocs();
    expect((await meta(ws, docs.budget, { tags: ["Finance", "2026", "finance"] })).data.tags).toEqual(["2026", "finance"]);
    await meta(ws, docs.notes, { tags: ["finance"] });
    expect((await catalogue(ws)).tags).toEqual([
      { name: "2026", count: 1 },
      { name: "finance", count: 2 },
    ]);
    expect((await meta(ws, docs.notes, { tags: ["no/slashes"] })).status).toBe(400);
  });
});

describe("search", () => {
  it("finds documents by title, content or tag, with a snippet for content matches", async () => {
    const { ws, docs } = await workspaceWithDocs();
    await meta(ws, docs.plan, { tags: ["budget-review"] });

    const results = await search(ws, "q=budget");
    expect(results.map((r) => [r.docId, r.matchedIn])).toEqual([
      [docs.budget, ["title"]],
      [docs.notes, ["content"]],
      [docs.plan, ["tags"]],
    ]);
    expect(results[1].snippet).toBe("We agreed the budget is tight.");
    expect((await search(ws, "q=MARCH")).map((r) => r.docId)).toEqual([docs.plan]); // case-insensitive
    expect((await search(ws, "tag=budget-review")).map((r) => r.docId)).toEqual([docs.plan]);
    expect(await search(ws, "q=nothing-like-this")).toEqual([]);
  });

  it("leaves out documents in the Recycle Bin", async () => {
    const { ws, docs } = await workspaceWithDocs();
    await api("DELETE", docPath(ws, docs.notes));
    expect((await search(ws, "q=budget")).map((r) => r.docId)).toEqual([docs.budget]);
  });

  it("finds text typed live, once the document has refreshed the catalogue", async () => {
    const { ws, docs } = await workspaceWithDocs();
    const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, docs.plan)));
    // A live edit, as if typed in a browser; it does not pass the router.
    await runInDurableObject(stub, (instance) => {
      const text = (instance as unknown as { loadYDoc(): Y.Doc }).loadYDoc().getText("body");
      text.insert(text.length, " Remember the zebra.");
    });
    expect(await search(ws, "q=zebra")).toEqual([]); // not yet copied

    await runDurableObjectAlarm(stub); // the refresh the cell scheduled a moment after the edit
    expect((await search(ws, "q=zebra")).map((r) => r.docId)).toEqual([docs.plan]);
  });
});
