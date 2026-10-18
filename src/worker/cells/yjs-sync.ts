import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * The parts of the standard Yjs WebSocket protocol (as spoken by the
 * `y-websocket` client) that DocCell uses. Every message starts with a type:
 * 0 = sync (state exchange and updates), 1 = awareness (presence; ignored
 * until presence is implemented).
 */
const MESSAGE_SYNC = 0;

/** "Here is what I have": the other side answers with what is missing. */
export function syncStep1Message(ydoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, ydoc);
  return encoding.toUint8Array(encoder);
}

export function updateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/**
 * Applies one incoming message to `ydoc` (with `origin` as the transaction
 * origin) and returns the reply to send back, if any. Non-sync messages are
 * ignored. Throws on malformed input.
 */
export function handleMessage(data: Uint8Array, ydoc: Y.Doc, origin: unknown): Uint8Array | null {
  const decoder = decoding.createDecoder(data);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.readSyncMessage(decoder, encoder, ydoc, origin, (error) => {
    throw error; // the default only logs; the caller decides what to do
  });
  // Only the type byte means there is nothing to reply.
  return encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : null;
}

/**
 * Makes `text` equal to `next` by replacing only the part that differs, so
 * a save that changes one word does not rewrite (and conflict with) the rest.
 */
export function replaceText(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current[current.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  text.doc!.transact(() => {
    text.delete(start, current.length - start - end);
    text.insert(start, next.slice(start, next.length - end));
  });
}
