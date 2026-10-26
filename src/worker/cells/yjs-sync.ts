import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

/**
 * The parts of the standard Yjs WebSocket protocol (as spoken by the
 * `y-websocket` client) that DocCell uses. Every message starts with a type:
 * 0 = sync (state exchange and updates), 1 = awareness (presence: who is
 * connected, their name and cursor). 100 = save check, this project's own
 * addition (see src/shared/save-check.ts).
 */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

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
export function replaceText(text: Y.Text, next: string, origin: unknown = null): void {
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
  text.doc!.transact((): void => {
    text.delete(start, current.length - start - end);
    text.insert(start, next.slice(start, next.length - end));
  }, origin);
}

/**
 * One client's presence as carried by an awareness message. `clock` grows
 * with every change; a `state` of null means the client has left.
 */
export interface PresenceEntry {
  clientId: number;
  clock: number;
  state: unknown;
}

export function isAwarenessMessage(data: Uint8Array): boolean {
  return decoding.readVarUint(decoding.createDecoder(data)) === MESSAGE_AWARENESS;
}

/** Reads the entries of an awareness message. Throws on malformed input. */
export function readAwarenessMessage(data: Uint8Array): PresenceEntry[] {
  const outer = decoding.createDecoder(data);
  decoding.readVarUint(outer); // message type
  const decoder = decoding.createDecoder(decoding.readVarUint8Array(outer));
  const entries: PresenceEntry[] = [];
  const count = decoding.readVarUint(decoder);
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state: unknown = JSON.parse(decoding.readVarString(decoder));
    entries.push({ clientId, clock, state });
  }
  return entries;
}

/** Encodes entries in the same format the y-protocols awareness module uses. */
export function awarenessMessage(entries: PresenceEntry[]): Uint8Array {
  const update = encoding.createEncoder();
  encoding.writeVarUint(update, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(update, entry.clientId);
    encoding.writeVarUint(update, entry.clock);
    encoding.writeVarString(update, JSON.stringify(entry.state));
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encoding.toUint8Array(update));
  return encoding.toUint8Array(encoder);
}

/**
 * For a sync message that carries document changes (sync step 2 or an
 * update), whether applying it would add content. Used to keep users without
 * edit rights from changing the document: a reader's normal messages (asking
 * for state, or answering with nothing new) add nothing.
 *
 * Only added content counts; a delete-only change from a reader is ignored
 * rather than rejected (see DocCell.webSocketMessage).
 */
export function addsContent(data: Uint8Array): boolean {
  const decoder = decoding.createDecoder(data);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;
  const kind = decoding.readVarUint(decoder);
  if (kind !== syncProtocol.messageYjsSyncStep2 && kind !== syncProtocol.messageYjsUpdate) return false;
  return Y.decodeUpdate(decoding.readVarUint8Array(decoder)).structs.length > 0;
}

/** Whether a sync message carries document changes (step 2 or update) rather than a request for them. */
export function carriesChanges(data: Uint8Array): boolean {
  const decoder = decoding.createDecoder(data);
  if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;
  const kind = decoding.readVarUint(decoder);
  return kind === syncProtocol.messageYjsSyncStep2 || kind === syncProtocol.messageYjsUpdate;
}
