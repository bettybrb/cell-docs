import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { ApiError, CommentList, CommentThread, DocState } from "../../src/shared/api-types";
import { positionsToRange, rangeToPositions } from "../../src/shared/relative-positions";
import { docCellName } from "../../src/worker/addressing";
import { api, uniqueId } from "./helpers";
import { closeAllClients, connect } from "./sync-client";

afterEach(closeAllClients);

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

async function newDoc(body: string) {
  const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
  const path = docPath(ws, doc);
  expect((await api("PUT", path, { title: "Notes", body }, "alice")).status).toBe(201);
  return { ws, doc, path };
}

const threads = async (path: string, user = "alice") =>
  (await api<CommentList>("GET", `${path}/comments`, undefined, user)).data.threads;

describe("comments anchored to text", () => {
  it("keeps a thread on its text while others insert and delete around it", async () => {
    const { ws, doc, path } = await newDoc("The quick brown fox jumps.");
    const alice = await connect(ws, doc, "alice");
    const bob = await connect(ws, doc, "bob");
    await vi.waitFor(() => expect(alice.text.toString()).toBe("The quick brown fox jumps."));

    const anchor = rangeToPositions(alice.text, 10, 15); // "brown"
    const created = await api<CommentThread>("POST", `${path}/comments`, { body: "Which brown?", anchor }, "alice");
    expect(created.status).toBe(201);
    const [thread] = await threads(path);
    expect(thread).toMatchObject({ author: "alice", body: "Which brown?", quote: "brown", resolvedAt: null, replies: [] });

    // Bob edits before and after the highlight, and right next to it.
    bob.text.delete(0, 4); // "The "
    bob.text.insert(0, "A very ");
    bob.text.insert(bob.text.toString().indexOf("brown"), "dark ");
    bob.text.insert(bob.text.toString().indexOf(" fox"), "ish");
    await vi.waitFor(() => expect(alice.text.toString()).toBe("A very quick dark brownish fox jumps."));

    // In both browsers, the anchor still covers exactly "brown".
    for (const client of [alice, bob]) {
      const range = positionsToRange(client.text, thread.anchor!)!;
      expect(client.text.toString().slice(range.from, range.to)).toBe("brown");
    }
  });

  it("keeps the thread, with its quote, when the commented text is deleted", async () => {
    const { ws, doc, path } = await newDoc("Keep this. Remove this part. End.");
    const alice = await connect(ws, doc, "alice");
    await vi.waitFor(() => expect(alice.text.length).toBeGreaterThan(0));
    const anchor = rangeToPositions(alice.text, 11, 27);
    await api("POST", `${path}/comments`, { body: "Is this needed?", anchor });

    alice.text.delete(11, 18); // "Remove this part. "
    await vi.waitFor(async () => expect((await api<DocState>("GET", path)).data.body).toBe("Keep this. End."));
    const [thread] = await threads(path);
    expect(thread.quote).toBe("Remove this part");
    const range = positionsToRange(alice.text, thread.anchor!)!;
    expect(range.from).toBe(range.to); // nothing left to highlight
  });

  it("refuses an anchor the server cannot place", async () => {
    const { path } = await newDoc("Some text");
    const notBase64 = await api<ApiError>("POST", `${path}/comments`, { body: "x", anchor: { start: "%%", end: "%%" } });
    expect(notBase64.data.error.code).toBe("invalid_anchor");
    // Positions in a document the server has never seen.
    const elsewhere = new Y.Doc().getText("body");
    elsewhere.insert(0, "Some text");
    const unknown = await api<ApiError>("POST", `${path}/comments`, { body: "x", anchor: rangeToPositions(elsewhere, 0, 4) });
    expect(unknown.status).toBe(400);
    expect(await threads(path)).toEqual([]);
  });
});

describe("replies, resolving and permissions", () => {
  it("lets commenters reply and resolve, readers only read", async () => {
    const { path } = await newDoc("Draft");
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: { carol: "comment" } }, "alice");
    const thread = (await api<CommentThread>("POST", `${path}/comments`, { body: "Is this final?" }, "alice")).data;

    expect((await api("POST", `${path}/comments/${thread.id}/replies`, { body: "Yes" }, "carol")).status).toBe(201);
    expect((await api("POST", `${path}/comments/${thread.id}/replies`, { body: "No" }, "bob")).status).toBe(403);
    expect((await api("POST", `${path}/comments`, { body: "New" }, "bob")).status).toBe(403);
    expect((await api("POST", `${path}/comments/${thread.id}/resolve`, { resolved: true }, "bob")).status).toBe(403);

    expect((await api("POST", `${path}/comments/${thread.id}/resolve`, { resolved: true }, "carol")).status).toBe(200);
    let [read] = await threads(path, "bob");
    expect(read).toMatchObject({ resolvedBy: "carol", replies: [expect.objectContaining({ author: "carol", body: "Yes" })] });

    await api("POST", `${path}/comments/${thread.id}/resolve`, { resolved: false }, "alice");
    [read] = await threads(path, "bob");
    expect(read).toMatchObject({ resolvedAt: null, resolvedBy: null });
    expect((await api("POST", `${path}/comments/999999/replies`, { body: "x" })).status).toBe(404);
  });

  it("tells every open page when comments change", async () => {
    const { ws, doc, path } = await newDoc("Text");
    const reader = await connect(ws, doc, "bob");
    await vi.waitFor(() => expect(reader.roles).toEqual(["edit"]));
    await api("POST", `${path}/comments`, { body: "Ping" }, "alice");
    await vi.waitFor(() => expect(reader.changes).toEqual(["comments"]));
  });

  it("shows comments from before threads existed as document-level threads", async () => {
    const { ws, doc, path } = await newDoc("Text");
    const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO comments (created_at, author, body) VALUES (?, 'carol', 'Old comment')", new Date().toISOString());
    });
    expect(await threads(path)).toEqual([
      expect.objectContaining({ author: "carol", body: "Old comment", anchor: null, quote: null, replies: [] }),
    ]);
  });
});
