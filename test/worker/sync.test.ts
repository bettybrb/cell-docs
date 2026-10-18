import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { DocState } from "../../src/shared/api-types";
import { docCellName } from "../../src/worker/addressing";
import { handleMessage, syncStep1Message, updateMessage } from "../../src/worker/cells/yjs-sync";
import { api, uniqueId } from "./helpers";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

interface Client {
  socket: WebSocket;
  text: Y.Text;
  closed: Promise<CloseEvent>;
}

const open: WebSocket[] = [];

afterEach(() => {
  for (const socket of open.splice(0)) {
    try {
      socket.close(1000);
    } catch {
      // already closed
    }
  }
});

/** A minimal browser stand-in: a Y.Doc synced over the same protocol y-websocket speaks. */
async function connect(ws: string, doc: string): Promise<Client> {
  const response = await exports.default.fetch(`https://example.test${docPath(ws, doc)}/sync`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer"; // as y-websocket does in the browser
  socket.accept();
  open.push(socket);

  const ydoc = new Y.Doc();
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
  socket.addEventListener("message", (event) => {
    const reply = handleMessage(new Uint8Array(event.data as ArrayBuffer), ydoc, socket);
    if (reply) socket.send(reply);
  });
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== socket) socket.send(updateMessage(update));
  });
  socket.send(syncStep1Message(ydoc));
  return { socket, text: ydoc.getText("body"), closed };
}

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
