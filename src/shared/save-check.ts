import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";

/**
 * Save check: this project's addition to the Yjs WebSocket protocol, used by
 * both the browser and DocCell.
 *
 * The browser numbers its own edits and, after editing, sends `[100, n]`.
 * The server sends the same message back. Messages on a socket are handled in
 * order, so the answer means every edit sent before the check is stored
 * (deletions included, which state vectors would miss).
 */
export const MESSAGE_SAVE_CHECK = 100;

export function saveCheckMessage(sequence: number): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SAVE_CHECK);
  encoding.writeVarUint(encoder, sequence);
  // Copy into a plain ArrayBuffer-backed array, which WebSocket.send accepts.
  return new Uint8Array(encoding.toUint8Array(encoder));
}

export function isSaveCheck(data: Uint8Array): boolean {
  return decoding.readVarUint(decoding.createDecoder(data)) === MESSAGE_SAVE_CHECK;
}

/** The sequence number of a save check message. */
export function readSaveCheck(data: Uint8Array): number {
  const decoder = decoding.createDecoder(data);
  decoding.readVarUint(decoder);
  return decoding.readVarUint(decoder);
}
