import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllClients, connect, type Client } from "./sync-client";
import * as encoding from "lib0/encoding";
import type { DocState } from "../../src/shared/api-types";
import { saveCheckMessage } from "../../src/shared/save-check";
import { docCellName } from "../../src/worker/addressing";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

afterEach(closeAllClients);

/** Names of the *other* clients this client currently sees. */
const othersSeenBy = (client: Client) =>
  [...client.awareness.getStates()]
    .filter(([id]) => id !== client.awareness.clientID)
    .map(([, state]) => (state as { name: string }).name)
    .sort();

const docStub = (ws: string, doc: string) => env.DOC_CELL.get(env.DOC_CELL.idFromName(docCellName(ws, doc)));

const storedUpdateCount = (ws: string, doc: string) =>
  runInDurableObject(docStub(ws, doc), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM yjs_updates").one().n,
  );

describe("WebSocket sync between two clients", () => {
  it("starts both clients with the existing saved content", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { title: "T", body: "# Existing\n\ncontent" });

    const [a, b] = await Promise.all([connect(ws, doc), connect(ws, doc)]);
    await vi.waitFor(() => {
      expect(a.text.toString()).toBe("# Existing\n\ncontent");
      expect(b.text.toString()).toBe("# Existing\n\ncontent");
    });
    // Converted to Yjs exactly once, even with two clients connecting at the same time.
    expect(await storedUpdateCount(ws, doc)).toBe(1);
  });

  it("shows each client's edits to the other without saving", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "Hello" });
    const a = await connect(ws, doc);
    const b = await connect(ws, doc);
    await vi.waitFor(() => expect(b.text.toString()).toBe("Hello"));

    a.text.insert(5, " from A");
    await vi.waitFor(() => expect(b.text.toString()).toBe("Hello from A"));

    b.text.insert(0, "B says: ");
    await vi.waitFor(() => expect(a.text.toString()).toBe("B says: Hello from A"));

    // The saved plain-text copy follows the live edits; no PUT was needed.
    const read = await api<DocState>("GET", docPath(ws, doc));
    expect(read.data).toMatchObject({ body: "B says: Hello from A", revision: 1 });
  });

  it("merges concurrent edits from both clients", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "middle" });
    const [a, b] = await Promise.all([connect(ws, doc), connect(ws, doc)]);
    await vi.waitFor(() => expect([a.text.toString(), b.text.toString()]).toEqual(["middle", "middle"]));

    a.text.insert(0, "start ");
    b.text.insert(6, " end");
    await vi.waitFor(() => {
      expect(a.text.toString()).toBe("start middle end");
      expect(b.text.toString()).toBe("start middle end");
    });
  });

  it("sends a manual save (PUT) to connected clients", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "draft one" });
    const a = await connect(ws, doc);
    await vi.waitFor(() => expect(a.text.toString()).toBe("draft one"));

    const saved = await api<DocState>("PUT", docPath(ws, doc), { title: "Final", body: "draft two" });
    expect(saved.data).toMatchObject({ title: "Final", body: "draft two", revision: 2 });
    await vi.waitFor(() => expect(a.text.toString()).toBe("draft two"));
  });

  it("keeps synced edits after the cell is evicted from memory", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "v1" });
    const a = await connect(ws, doc);
    await vi.waitFor(() => expect(a.text.toString()).toBe("v1"));
    a.text.insert(2, " plus live edit");
    await vi.waitFor(async () =>
      expect((await api<DocState>("GET", docPath(ws, doc))).data.body).toBe("v1 plus live edit"),
    );
    a.socket.close(1000);
    await evictDurableObject(docStub(ws, doc));

    const b = await connect(ws, doc);
    await vi.waitFor(() => expect(b.text.toString()).toBe("v1 plus live edit"));
  });
});

describe("sync endpoint", () => {
  it("rejects documents that do not exist and plain HTTP requests", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    const missing = await exports.default.fetch(`https://example.test${docPath(ws, doc)}/sync`, {
      headers: { upgrade: "websocket" },
    });
    expect(missing.status).toBe(404);

    await api("PUT", docPath(ws, doc), { body: "x" });
    expect((await api("GET", `${docPath(ws, doc)}/sync`)).status).toBe(426);
  });

  it("closes a connection that sends a malformed message, and keeps serving others", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "safe" });
    const bad = await connect(ws, doc);
    bad.socket.send(new Uint8Array([0, 2, 200]));
    expect((await bad.closed).code).toBe(1003);

    const good = await connect(ws, doc);
    await vi.waitFor(() => expect(good.text.toString()).toBe("safe"));
  });
});

describe("presence (awareness)", () => {
  it("shows who is already connected to a newcomer, and the newcomer to them", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "x" });
    const a = await connect(ws, doc);
    a.awareness.setLocalState({ name: "A" });
    const b = await connect(ws, doc);
    await vi.waitFor(() => expect(othersSeenBy(b)).toEqual(["A"]));

    b.awareness.setLocalState({ name: "B" });
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual(["B"]));
  });

  it("removes a client that leaves cleanly", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "x" });
    const a = await connect(ws, doc);
    const b = await connect(ws, doc);
    a.awareness.setLocalState({ name: "A" });
    b.awareness.setLocalState({ name: "B" });
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual(["B"]));

    b.awareness.setLocalState(null); // what y-websocket sends when a tab closes
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual([]));
  });

  it("removes a client whose connection drops without saying goodbye", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "x" });
    const a = await connect(ws, doc);
    const b = await connect(ws, doc);
    const c = await connect(ws, doc);
    a.awareness.setLocalState({ name: "A" });
    b.awareness.setLocalState({ name: "B" });
    c.awareness.setLocalState({ name: "C" });
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual(["B", "C"]));

    b.socket.close(1001); // no awareness removal sent first
    await vi.waitFor(() => {
      expect(othersSeenBy(a)).toEqual(["C"]);
      expect(othersSeenBy(c)).toEqual(["A"]);
    });
  });

  it("accepts a client back after it dropped, once its clock moves on", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "x" });
    const a = await connect(ws, doc);
    const b = await connect(ws, doc);
    b.awareness.setLocalState({ name: "B" });
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual(["B"]));
    b.socket.close(1001);
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual([]));

    // B reconnects with the same client id and a higher clock (the client
    // bumps its clock on every connect; see connectDocSession).
    const again = await connect(ws, doc);
    const state = { name: "B" };
    const clock = b.awareness.meta.get(b.awareness.clientID)!.clock + 1;
    const update = encoding.createEncoder();
    encoding.writeVarUint(update, 1);
    encoding.writeVarUint(update, b.awareness.clientID);
    encoding.writeVarUint(update, clock);
    encoding.writeVarString(update, JSON.stringify(state));
    const message = encoding.createEncoder();
    encoding.writeVarUint(message, 1);
    encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
    again.socket.send(encoding.toUint8Array(message));
    await vi.waitFor(() => expect(othersSeenBy(a)).toEqual(["B"]));
  });
});

describe("save check", () => {
  it("is answered only after the edits sent before it are stored, deletions included", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "Hello world" });
    const a = await connect(ws, doc);
    await vi.waitFor(() => expect(a.text.toString()).toBe("Hello world"));

    a.text.insert(11, "!");
    a.text.delete(0, 6); // deletions do not show up in state vectors
    a.socket.send(saveCheckMessage(7));
    await vi.waitFor(() => expect(a.savedChecks).toEqual([7]));

    // By the time the check was answered, the server had stored both edits.
    const read = await api<DocState>("GET", docPath(ws, doc));
    expect(read.data.body).toBe("world!");
  });

  it("answers only the client that asked", async () => {
    const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
    await api("PUT", docPath(ws, doc), { body: "x" });
    const [a, b] = [await connect(ws, doc), await connect(ws, doc)];
    a.socket.send(saveCheckMessage(1));
    await vi.waitFor(() => expect(a.savedChecks).toEqual([1]));
    b.socket.send(saveCheckMessage(2));
    await vi.waitFor(() => expect(b.savedChecks).toEqual([2]));
    expect(a.savedChecks).toEqual([1]);
  });
});
