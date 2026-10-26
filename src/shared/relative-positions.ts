import * as Y from "yjs";

/**
 * Yjs relative positions travel as base64 text (in JSON, in SQLite). They
 * identify a place in a Y.Text by the Yjs ids of its characters, not by an
 * offset, so they keep pointing at the same text while others edit.
 */

export function encodePosition(position: Y.RelativePosition): string {
  let binary = "";
  for (const byte of Y.encodeRelativePosition(position)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Throws if `encoded` is not a relative position. */
export function decodePosition(encoded: string): Y.RelativePosition {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return Y.decodeRelativePosition(bytes);
}

/**
 * Relative positions for the range [from, to) of `text`. The start sticks to
 * the character after it and the end to the character before it, so text
 * typed just outside the range stays outside.
 */
export function rangeToPositions(text: Y.Text, from: number, to: number): { start: string; end: string } {
  return {
    start: encodePosition(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    end: encodePosition(Y.createRelativePositionFromTypeIndex(text, to, -1)),
  };
}

/**
 * The current offsets of a range in `text`, or null if a position cannot be
 * resolved in this document (it refers to text this copy has never seen).
 * When all of the range's text was deleted, `from === to`.
 */
export function positionsToRange(text: Y.Text, range: { start: string; end: string }): { from: number; to: number } | null {
  const doc = text.doc;
  if (!doc) return null;
  try {
    const start = Y.createAbsolutePositionFromRelativePosition(decodePosition(range.start), doc);
    const end = Y.createAbsolutePositionFromRelativePosition(decodePosition(range.end), doc);
    if (!start || !end || start.type !== text || end.type !== text) return null;
    return { from: start.index, to: Math.max(start.index, end.index) };
  } catch {
    return null;
  }
}
