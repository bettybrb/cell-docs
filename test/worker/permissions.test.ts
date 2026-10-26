import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, DocCatalogue, DocState, SearchResults } from "../../src/shared/api-types";
import { CLOSE_ACCESS_REVOKED, CLOSE_EDIT_REJECTED } from "../../src/shared/doc-messages";
import { docCellName } from "../../src/worker/addressing";
import { api, uniqueId } from "./helpers";
import { closeAllClients, connect } from "./sync-client";

afterEach(closeAllClients);

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

/** A document created by alice, the owner. */
async function aliceDoc(body = "Shared text") {
  const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
  const created = await api<DocState>("PUT", docPath(ws, doc), { title: "Plan", body }, "alice");
  expect(created.status).toBe(201);
  return { ws, doc, path: docPath(ws, doc) };
}

const setPermissions = (path: string, permissions: object, user = "alice") =>
  api<DocState>("PUT", `${path}/permissions`, permissions, user);

describe("roles over HTTP", () => {
  it("makes the creator the owner and lets everyone else edit by default", async () => {
    const { path } = await aliceDoc();
    const asBob = await api<DocState>("GET", path, undefined, "bob");
    expect(asBob.data).toMatchObject({ permissions: { owner: "alice", defaultRole: "edit", users: {} }, yourRole: "edit" });
    expect((await api("PUT", path, { body: "Bob edits" }, "bob")).status).toBe(200);
  });

  it("hides a private document from everyone not given a role", async () => {
    const { ws, doc, path } = await aliceDoc("Secret plans");
    expect((await setPermissions(path, { defaultRole: "none", users: {} })).status).toBe(200);

    const asBob = await api<ApiError>("GET", path, undefined, "bob");
    expect(asBob.status).toBe(403);
    expect(asBob.data.error.code).toBe("forbidden");
    const list = await api<DocCatalogue>("GET", `/api/workspaces/${ws}/docs`, undefined, "bob");
    expect(list.data.docs.map((d) => d.docId)).not.toContain(doc);
    const search = await api<SearchResults>("GET", `/api/workspaces/${ws}/search?q=secret`, undefined, "bob");
    expect(search.data.results).toEqual([]);
    // The owner still sees it everywhere.
    const own = await api<SearchResults>("GET", `/api/workspaces/${ws}/search?q=secret`, undefined, "alice");
    expect(own.data.results.map((r) => r.docId)).toEqual([doc]);
  });

  it("enforces read, comment and edit separately", async () => {
    const { path } = await aliceDoc();
    await setPermissions(path, { defaultRole: "none", users: { bob: "read", carol: "comment" } });

    // bob: read only
    expect((await api("GET", path, undefined, "bob")).status).toBe(200);
    expect((await api("GET", `${path}/versions`, undefined, "bob")).status).toBe(200);
    expect((await api("POST", `${path}/comments`, { body: "Nice" }, "bob")).status).toBe(403);
    expect((await api("PUT", path, { body: "Bob edits" }, "bob")).status).toBe(403);
    expect((await api("DELETE", path, undefined, "bob")).status).toBe(403);

    // carol: may comment, not edit
    expect((await api("POST", `${path}/comments`, { body: "Looks good" }, "carol")).status).toBe(201);
    expect((await api("PUT", path, { title: "Carol renames" }, "carol")).status).toBe(403);
    const comments = await api<{ comments: { author: string; body: string }[] }>("GET", `${path}/comments`, undefined, "bob");
    expect(comments.data.comments).toEqual([expect.objectContaining({ author: "carol", body: "Looks good" })]);

    // Nothing was changed by the refused requests.
    expect((await api<DocState>("GET", path, undefined, "alice")).data).toMatchObject({ title: "Plan", body: "Shared text" });
  });

  it("lets only the owner change permissions, and checks the users named", async () => {
    const { path } = await aliceDoc();
    expect((await setPermissions(path, { defaultRole: "read", users: {} }, "bob")).status).toBe(403);
    expect((await setPermissions(path, { defaultRole: "read", users: { mallory: "edit" } })).status).toBe(400);
    expect((await setPermissions(path, { defaultRole: "read", users: { alice: "read" } })).status).toBe(400);
    expect((await setPermissions(path, { defaultRole: "admin", users: {} })).status).toBe(400);
  });

  it("lets an editor claim a document that has no owner (created before permissions)", async () => {
    const { ws, doc, path } = await aliceDoc();
    const stub = env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));
    await runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("UPDATE doc SET owner = NULL"));

    const claimed = await setPermissions(path, { defaultRole: "read", users: {} }, "bob");
    expect(claimed.status).toBe(200);
    expect(claimed.data.permissions.owner).toBe("bob");
    expect((await api("PUT", path, { body: "x" }, "alice")).status).toBe(403); // alice is now a reader
  });

  it("refuses unknown test users at the router", async () => {
    const response = await exports.default.fetch("https://example.test/api/workspaces/acme/docs", {
      headers: { "x-test-user": "mallory" },
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error.code).toBe("unknown_user");
  });
});

describe("permissions on live connections", () => {
  it("lets a reader follow live edits without being able to make any", async () => {
    const { ws, doc, path } = await aliceDoc("Start");
    await setPermissions(path, { defaultRole: "edit", users: { carol: "read" } });
    const alice = await connect(ws, doc, "alice");
    const carol = await connect(ws, doc, "carol");
    await vi.waitFor(() => expect(carol.text.toString()).toBe("Start"));
    expect(carol.roles).toEqual(["read"]);

    alice.text.insert(5, " and more");
    await vi.waitFor(() => expect(carol.text.toString()).toBe("Start and more"));

    // A reader's edit is refused: the connection closes and nothing is stored.
    carol.text.insert(0, "Carol was here. ");
    expect((await carol.closed).code).toBe(CLOSE_EDIT_REJECTED);
    expect((await api<DocState>("GET", path)).data.body).toBe("Start and more");
    expect(alice.text.toString()).toBe("Start and more");
  });

  it("switches a connected editor to read-only the moment their edit right is taken away", async () => {
    const { ws, doc, path } = await aliceDoc("Draft");
    const bob = await connect(ws, doc, "bob");
    await vi.waitFor(() => expect(bob.text.toString()).toBe("Draft"));
    expect(bob.roles).toEqual(["edit"]);
    bob.text.insert(5, " (bob)");
    await vi.waitFor(async () => expect((await api<DocState>("GET", path)).data.body).toBe("Draft (bob)"));

    await setPermissions(path, { defaultRole: "edit", users: { bob: "read" } });
    await vi.waitFor(() => expect(bob.roles).toEqual(["edit", "read"])); // told at once

    bob.text.insert(0, "Too late: ");
    expect((await bob.closed).code).toBe(CLOSE_EDIT_REJECTED);
    expect((await api<DocState>("GET", path)).data.body).toBe("Draft (bob)");
  });

  it("disconnects a user whose access is removed entirely", async () => {
    const { ws, doc, path } = await aliceDoc();
    const bob = await connect(ws, doc, "bob");
    await vi.waitFor(() => expect(bob.roles).toEqual(["edit"]));
    await setPermissions(path, { defaultRole: "none", users: {} });
    expect((await bob.closed).code).toBe(CLOSE_ACCESS_REVOKED);

    const again = await exports.default.fetch(`https://example.test${path}/sync?user=bob`, { headers: { upgrade: "websocket" } });
    expect(again.status).toBe(403);
  });
});
