import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { EffectiveRole } from "./permissions";

/**
 * This project's additions to the Yjs WebSocket protocol, besides the save
 * check (save-check.ts).
 *
 * `[101, json]`: the server tells a client its current role on the document,
 * when it connects and whenever permissions change while it is connected.
 */
export const MESSAGE_ROLE = 101;

/**
 * Close codes DocCell uses. y-websocket does not reconnect after a code in
 * 4400-4499, which is right for all of these: trying again cannot help.
 */
export const CLOSE_ACCESS_REVOKED = 4403;
/** The client sent an edit it is not allowed to make (its role is read or comment). */
export const CLOSE_EDIT_REJECTED = 4409;
export const CLOSE_DOC_DELETED = 4410;

export function roleMessage(role: EffectiveRole): Uint8Array<ArrayBuffer> {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_ROLE);
  encoding.writeVarString(encoder, JSON.stringify({ role }));
  return new Uint8Array(encoding.toUint8Array(encoder));
}

/** Reads the role from a role message's decoder, positioned after the message type. */
export function readRole(decoder: decoding.Decoder): EffectiveRole {
  return (JSON.parse(decoding.readVarString(decoder)) as { role: EffectiveRole }).role;
}
