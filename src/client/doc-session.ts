import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

/**
 * Client-side editing state for one document. The Y.Text is the source of
 * truth for the body while the document is open; the editor is bound to it,
 * and saving reads it back as a plain string.
 *
 * Every document gets its own session and Y.Doc, so two documents never
 * share content.
 */
export interface DocSession {
  ydoc: Y.Doc;
  text: Y.Text;
}

/** A session that exists only in this browser, for a document not saved yet. */
export function createDocSession(body: string): DocSession {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("body");
  text.insert(0, body);
  return { ydoc, text };
}

export interface ConnectedDocSession extends DocSession {
  /** Resolves once the first exchange with the DocCell is done. */
  synced: Promise<void>;
  /** Closes the connection. Call before switching documents. */
  destroy(): void;
}

/**
 * A session synced live with the document's DocCell over a WebSocket.
 *
 * The Y.Doc starts empty and receives the content from the server, never
 * from a REST response: if every browser inserted the saved body itself,
 * the text would appear once per browser.
 *
 * `serverUrl` is the ws(s):// URL of the workspace's docs, for example
 * `ws://localhost:5180/api/workspaces/acme/docs`.
 */
export function connectDocSession(
  serverUrl: string,
  docId: string,
  options: { WebSocketPolyfill?: typeof WebSocket } = {},
): ConnectedDocSession {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(serverUrl, `${docId}/sync`, ydoc, {
    // Sync only through the server, not directly between tabs.
    disableBc: true,
    // Ask the server for missed changes now and then. This also keeps the
    // connection alive: the provider reconnects after 30 s without messages.
    resyncInterval: 15_000,
    ...options,
  });
  const synced = new Promise<void>((resolve) => {
    if (provider.synced) resolve();
    else provider.once("sync", () => resolve());
  });
  return {
    ydoc,
    text: ydoc.getText("body"),
    synced,
    destroy() {
      provider.destroy();
      ydoc.destroy();
    },
  };
}

/**
 * Tracks overlapping async requests so only the newest one is applied.
 * `start()` returns a check that stays true until another request starts.
 */
export function latestOnly(): { start: () => () => boolean } {
  let current = 0;
  return {
    start() {
      const id = ++current;
      return () => id === current;
    },
  };
}
