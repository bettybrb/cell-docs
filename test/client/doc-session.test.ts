import { describe, expect, it } from "vitest";
import { connectDocSession } from "../../src/client/doc-session";

/** Records the sockets the provider opens instead of connecting anywhere. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  closed = false;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onmessage: unknown = null;
  onerror: unknown = null;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
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
