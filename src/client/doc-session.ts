import * as decoding from "lib0/decoding";
import type { Awareness } from "y-protocols/awareness";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { MESSAGE_SAVE_CHECK, saveCheckMessage } from "../shared/save-check";

/** How long after the last edit to ask the server to confirm it has saved. */
const SAVE_CHECK_DELAY_MS = 250;

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
  /** Edits made in this browser that the server has not yet confirmed as saved. */
  unsavedChanges(): number;
  /** Calls `listener` whenever status() or unsavedChanges() changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
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
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  // Saved acknowledgements (src/shared/save-check.ts): number this browser's
  // edits, ask the server to confirm the latest number, and count what is
  // not confirmed yet.
  let editCount = 0;
  let confirmedCount = 0;
  let checkTimer: ReturnType<typeof setTimeout> | undefined;
  const sendSaveCheck = () => {
    if (provider.wsconnected && provider.synced && editCount > confirmedCount) {
      provider.ws?.send(saveCheckMessage(editCount));
    }
  };
  ydoc.on("update", (_update: Uint8Array, origin: unknown) => {
    if (origin === provider) return; // came from the server, so it is already saved there
    editCount++;
    notify();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(sendSaveCheck, SAVE_CHECK_DELAY_MS);
  });
  provider.messageHandlers[MESSAGE_SAVE_CHECK] = (_encoder, decoder) => {
    confirmedCount = Math.max(confirmedCount, decoding.readVarUint(decoder));
    notify();
  };
  // After (re)connecting, edits made offline are sent during the first sync;
  // a check sent once that sync is done therefore covers them too.
  provider.on("sync", (isSynced) => {
    if (isSynced) sendSaveCheck();
  });

  provider.on("status", (event) => {
    status = event.status;
    if (status === "connected") {
      // While this browser was away, the others were told it left. Re-sending
      // the same presence with a higher clock makes them accept it again
      // (an update with the old clock would be ignored).
      awareness.setLocalState(awareness.getLocalState());
    }
    notify();
  });

  return {
    ydoc,
    text: ydoc.getText("body"),
    awareness,
    synced,
    status: () => status,
    unsavedChanges: () => editCount - confirmedCount,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      clearTimeout(checkTimer);
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
