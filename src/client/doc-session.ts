import type { Awareness } from "y-protocols/awareness";
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

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** What each browser shares about itself. `color`/`colorLight` style its cursor. */
export interface Collaborator {
  name: string;
  color: string;
  colorLight: string;
}

export interface ConnectedDocSession extends DocSession {
  /** Presence: who is connected to this document (including this browser). */
  awareness: Awareness;
  /** Resolves once the first exchange with the DocCell is done. */
  synced: Promise<void>;
  status(): ConnectionStatus;
  /** Calls `listener` on every status change; returns an unsubscribe function. */
  onStatus(listener: (status: ConnectionStatus) => void): () => void;
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
  { user = randomGuest(), ...options }: { user?: Collaborator; WebSocketPolyfill?: typeof WebSocket } = {},
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

  const { awareness } = provider;
  awareness.setLocalStateField("user", user);

  let status: ConnectionStatus = "connecting";
  const listeners = new Set<(status: ConnectionStatus) => void>();
  provider.on("status", (event) => {
    status = event.status;
    if (status === "connected") {
      // While this browser was away, the others were told it left. Re-sending
      // the same presence with a higher clock makes them accept it again
      // (an update with the old clock would be ignored).
      awareness.setLocalState(awareness.getLocalState());
    }
    listeners.forEach((listener) => listener(status));
  });

  return {
    ydoc,
    text: ydoc.getText("body"),
    awareness,
    synced,
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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

const COLORS = ["#d1495b", "#00798c", "#edae49", "#66a182", "#8d5a97", "#2e86ab"];

function randomGuest(): Collaborator {
  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  return { name: `Guest-${Math.floor(100 + Math.random() * 900)}`, color, colorLight: `${color}33` };
}
