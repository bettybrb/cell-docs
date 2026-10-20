import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { connectDocSession } from "../../src/client/doc-session";
import { isSaveCheck, readSaveCheck, saveCheckMessage } from "../../src/shared/save-check";

/** Records the sockets the provider opens instead of connecting anywhere. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
  onerror: unknown = null;
  readonly sent: Uint8Array[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }
  /** Plays a message from the server. */
  receive(data: Uint8Array): void {
    this.onmessage!({ data: data.slice().buffer });
  }
  /** Opens the connection and completes the first sync, as the server would. */
  connectAndSync(): void {
    this.readyState = 1;
    this.onopen!();
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0); // sync message
    syncProtocol.writeSyncStep2(encoder, new Y.Doc());
    this.receive(encoding.toUint8Array(encoder));
  }
  saveChecksSent(): number[] {
    return this.sent.filter(isSaveCheck).map(readSaveCheck);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

const options = { WebSocketPolyfill: FakeWebSocket as unknown as typeof WebSocket };

describe("connected doc session", () => {
  it("connects to the document's sync URL and starts empty until the server answers", () => {
    const session = connectDocSession("ws://host/api/workspaces/acme/docs", "intro", options);
    const socket = FakeWebSocket.instances.at(-1)!;
    expect(socket.url).toBe("ws://host/api/workspaces/acme/docs/intro/sync");
    expect(session.text.toString()).toBe("");
    session.destroy();
  });

  it("shares the user's presence and re-announces it with a higher clock on every connect", () => {
    const user = { name: "Ada", color: "#000000", colorLight: "#00000033" };
    const session = connectDocSession("ws://host/api/workspaces/acme/docs", "intro", { ...options, user });
    const statuses: string[] = [];
    session.subscribe(() => statuses.push(session.status()));
    expect(session.awareness.getLocalState()).toEqual({ user });
    const clockBefore = session.awareness.meta.get(session.awareness.clientID)!.clock;

    const socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.onopen!();

    expect(statuses).toEqual(["connected"]);
    expect(session.status()).toBe("connected");
    expect(session.awareness.meta.get(session.awareness.clientID)!.clock).toBeGreaterThan(clockBefore);
    session.destroy();
  });

  it("closes the old connection when switching documents", () => {
    const a = connectDocSession("ws://host/api/workspaces/acme/docs", "doc-a", options);
    const socketA = FakeWebSocket.instances.at(-1)!;
    a.destroy();
    const b = connectDocSession("ws://host/api/workspaces/acme/docs", "doc-b", options);
    const socketB = FakeWebSocket.instances.at(-1)!;

    expect(socketA.closed).toBe(true);
    expect(socketB.closed).toBe(false);
    expect(a.ydoc).not.toBe(b.ydoc);
    b.destroy();
  });
});

describe("saved acknowledgements", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts edits until the server confirms them, including edits made offline", () => {
    vi.useFakeTimers();
    const session = connectDocSession("ws://host/api/workspaces/acme/docs", "intro", options);
    const first = FakeWebSocket.instances.at(-1)!;
    first.connectAndSync();
    expect(session.unsavedChanges()).toBe(0);

    // An edit is unsaved until the server answers the check sent shortly after.
    session.text.insert(0, "Hello");
    expect(session.unsavedChanges()).toBe(1);
    vi.advanceTimersByTime(300);
    expect(first.saveChecksSent()).toEqual([1]);
    first.receive(saveCheckMessage(1));
    expect(session.unsavedChanges()).toBe(0);

    // Offline: edits pile up and no check is sent.
    first.onclose!({ code: 1006 });
    session.text.insert(5, " again");
    session.text.delete(0, 1);
    vi.advanceTimersByTime(300);
    expect(session.unsavedChanges()).toBe(2);

    // Reconnected: once the first sync is done, one check covers the offline edits.
    vi.advanceTimersByTime(3_000); // the provider's reconnect delay
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.connectAndSync();
    expect(second.saveChecksSent()).toEqual([3]);
    second.receive(saveCheckMessage(3));
    expect(session.unsavedChanges()).toBe(0);
    session.destroy();
  });

  it("goes offline on request, stays offline, and reconnects when switched back", () => {
    vi.useFakeTimers();
    const session = connectDocSession("ws://host/api/workspaces/acme/docs", "intro", options);
    const first = FakeWebSocket.instances.at(-1)!;
    first.connectAndSync();

    session.setOffline(true);
    expect(first.closed).toBe(true);
    expect(session.offline()).toBe(true);
    expect(session.status()).toBe("disconnected");
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances.at(-1)).toBe(first); // no reconnect attempts

    session.text.insert(0, "offline edit");
    session.setOffline(false);
    const second = FakeWebSocket.instances.at(-1)!;
    expect(second).not.toBe(first);
    second.connectAndSync();
    expect(second.saveChecksSent()).toEqual([1]);
    session.destroy();
  });

  it("does not count changes that came from the server", () => {
    const session = connectDocSession("ws://host/api/workspaces/acme/docs", "intro", options);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.onopen!();
    const remote = new Y.Doc();
    remote.getText("body").insert(0, "from someone else");
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(remote));
    socket.receive(encoding.toUint8Array(encoder));

    expect(session.text.toString()).toBe("from someone else");
    expect(session.unsavedChanges()).toBe(0);
    session.destroy();
  });
});
