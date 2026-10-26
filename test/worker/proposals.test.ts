import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiError, DocState, DocVersionList, Proposal, ProposalList } from "../../src/shared/api-types";
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

const propose = (path: string, request: object, user = "alice") => api<Proposal>("POST", `${path}/proposals`, request, user);
const proposals = async (path: string) => (await api<ProposalList>("GET", `${path}/proposals`)).data.proposals;
const body = async (path: string) => (await api<DocState>("GET", path)).data.body;

const TEXT = "Line one.\nLine two has a typo: teh.\nLine three.\n";

describe("agent proposals", () => {
  it("stores a pending proposal with each change and whether it still fits", async () => {
    const { path } = await newDoc(TEXT);
    const created = await propose(path, { action: "replace", find: "teh", replace: "the" });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({
      requestedBy: "alice",
      agent: "simulated",
      instruction: "Replace “teh” with “the”",
      status: "pending",
      changes: [
        {
          original: "Line two has a typo: teh.\n",
          replacement: "Line two has a typo: the.\n",
          before: "Line one.\n",
          after: "Line three.\n",
          applicable: true,
        },
      ],
    });
    expect(await body(path)).toBe(TEXT); // nothing changes until someone applies it
    expect((await propose(path, { action: "replace", find: "absent", replace: "x" })).status).toBe(422);
  });

  it("applies onto the current text, keeping edits made elsewhere since the proposal", async () => {
    const { ws, doc, path } = await newDoc(TEXT);
    const bob = await connect(ws, doc, "bob");
    await vi.waitFor(() => expect(bob.text.toString()).toBe(TEXT));
    const proposal = (await propose(path, { action: "replace", find: "teh", replace: "the" })).data;

    // Bob keeps editing other lines after the proposal was made.
    bob.text.insert(0, "Title by bob\n");
    bob.text.insert(bob.text.length, "Line four by bob.\n");
    await vi.waitFor(async () => expect(await body(path)).toContain("Line four by bob."));

    const applied = await api<DocState>("POST", `${path}/proposals/${proposal.id}/apply`, undefined, "alice");
    expect(applied.status).toBe(200);
    const expected = "Title by bob\nLine one.\nLine two has a typo: the.\nLine three.\nLine four by bob.\n";
    expect(applied.data.body).toBe(expected);
    await vi.waitFor(() => expect(bob.text.toString()).toBe(expected)); // live, in bob's browser
    await vi.waitFor(() => expect(bob.changes).toContain("proposals"));

    const [stored] = await proposals(path);
    expect(stored).toMatchObject({ status: "applied", decidedBy: "alice" });
    expect((await api("POST", `${path}/proposals/${proposal.id}/apply`)).status).toBe(409); // only once
    // The text from just before is kept, so the change can be undone with Restore.
    const versions = (await api<DocVersionList>("GET", `${path}/versions`)).data.versions;
    expect(versions[0]).toMatchObject({ reason: "proposal", createdBy: "alice" });
  });

  it("applies nothing when someone edited the text a change would replace", async () => {
    const { ws, doc, path } = await newDoc(TEXT);
    const bob = await connect(ws, doc, "bob");
    await vi.waitFor(() => expect(bob.text.toString()).toBe(TEXT));
    const replace = (await propose(path, { action: "replace", find: "teh", replace: "the" })).data;

    // Bob fixes the typo himself, on the same line.
    const at = bob.text.toString().indexOf("teh");
    bob.text.delete(at, 3);
    bob.text.insert(at, "THE");
    await vi.waitFor(async () => expect(await body(path)).toContain("THE"));

    const refused = await api<ApiError>("POST", `${path}/proposals/${replace.id}/apply`);
    expect(refused.status).toBe(409);
    expect(refused.data.error.code).toBe("proposal_conflict");
    expect(await body(path)).toBe(TEXT.replace("teh", "THE"));
    const listed = (await proposals(path)).find((p) => p.id === replace.id)!;
    expect(listed).toMatchObject({ status: "pending", changes: [expect.objectContaining({ applicable: false })] });

    expect((await api<Proposal>("POST", `${path}/proposals/${replace.id}/discard`)).data.status).toBe("discarded");
  });

  it("lets commenters ask and discard their own, but only editors apply", async () => {
    const { path } = await newDoc(TEXT);
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: { carol: "comment", bob: "comment" } }, "alice");
    expect((await propose(path, { action: "tidy" }, "dave-is-not-a-user")).status).toBe(400);

    const byCarol = await propose(path, { action: "replace", find: "teh", replace: "the" }, "carol");
    expect(byCarol.status).toBe(201);
    expect((await api("POST", `${path}/proposals/${byCarol.data.id}/apply`, undefined, "carol")).status).toBe(403);
    expect((await api("POST", `${path}/proposals/${byCarol.data.id}/discard`, undefined, "bob")).status).toBe(403);
    expect((await api("POST", `${path}/proposals/${byCarol.data.id}/discard`, undefined, "carol")).status).toBe(200);

    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: {} }, "alice");
    expect((await propose(path, { action: "tidy" }, "bob")).status).toBe(403); // readers only look
    expect((await api("GET", `${path}/proposals`, undefined, "bob")).status).toBe(200);
  });

  it("tidies text and adds a summary", async () => {
    const { path } = await newDoc("hello  world .  this is fine.\n\nsecond paragraph here.");
    const tidy = (await propose(path, { action: "tidy" })).data;
    await api("POST", `${path}/proposals/${tidy.id}/apply`);
    expect(await body(path)).toBe("Hello world. This is fine.\n\nSecond paragraph here.");

    const summary = (await propose(path, { action: "summary" })).data;
    await api("POST", `${path}/proposals/${summary.id}/apply`);
    expect(await body(path)).toBe(
      "## Summary\n\n- Hello world.\n- Second paragraph here.\n\nHello world. This is fine.\n\nSecond paragraph here.",
    );
  });
});
