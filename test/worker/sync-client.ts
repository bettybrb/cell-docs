import { exports } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { expect } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import { MESSAGE_CHANGED, MESSAGE_ROLE, readChangeTopic, readRole } from "../../src/shared/doc-messages";
import { isSaveCheck, readSaveCheck } from "../../src/shared/save-check";
import { handleMessage, isAwarenessMessage, syncStep1Message, updateMessage } from "../../src/worker/cells/yjs-sync";

const docPath = (ws: string, doc: string) => `/api/workspaces/${ws}/docs/${doc}`;

export interface Client {
  socket: WebSocket;
  text: Y.Text;
  awareness: awarenessProtocol.Awareness;
  closed: Promise<CloseEvent>;
  /** Sequence numbers of save checks the server has answered. */
  savedChecks: number[];
  /** Roles the server has announced to this client, in order. */
  roles: string[];
  /** Topics of "something besides the text changed" notices, in order. */
  changes: string[];
}

const open: WebSocket[] = [];
const awarenesses: awarenessProtocol.Awareness[] = [];

/** Call in afterEach: closes every client opened by connect(). */
export function closeAllClients(): void {
  awarenesses.splice(0).forEach((awareness) => awareness.destroy());
  for (const socket of open.splice(0)) {
    try {
      socket.close(1000);
    } catch {
      // already closed
    }
  }
}

/**
 * A minimal browser stand-in: a Y.Doc synced over the same protocol
 * y-websocket speaks, as test user `user` (the router's default if omitted).
 */
export async function connect(ws: string, doc: string, user?: string): Promise<Client> {
  const query = user ? `?user=${user}` : "";
  const response = await exports.default.fetch(`https://example.test${docPath(ws, doc)}/sync${query}`, {
    headers: { upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.binaryType = "arraybuffer"; // as y-websocket does in the browser
  socket.accept();
  open.push(socket);

  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  awareness.setLocalState(null); // like y-websocket: no presence until the app sets it
  awarenesses.push(awareness);
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve));
  const savedChecks: number[] = [];
  const roles: string[] = [];
  const changes: string[] = [];
  const send = (data: Uint8Array) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(data);
  };
  socket.addEventListener("message", (event) => {
    const data = new Uint8Array(event.data as ArrayBuffer);
    if (isSaveCheck(data)) {
      savedChecks.push(readSaveCheck(data));
      return;
    }
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_ROLE) {
      roles.push(readRole(decoder));
      return;
    }
    if (type === MESSAGE_CHANGED) {
      changes.push(readChangeTopic(decoder));
      return;
    }
    if (isAwarenessMessage(data)) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoder), socket);
      return;
    }
    const reply = handleMessage(data, ydoc, socket);
    if (reply) send(reply);
  });
  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== socket) send(updateMessage(update));
  });
  awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
    if (origin === socket) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 1);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
    );
    send(encoding.toUint8Array(encoder));
  });
  socket.send(syncStep1Message(ydoc));
  return { socket, text: ydoc.getText("body"), awareness, closed, savedChecks, roles, changes };
}
