import * as Y from "yjs";

/**
 * Client-side editing state for one loaded document. The Y.Text is the
 * source of truth for the body while the document is open; the editor is
 * bound to it, and saving reads it back as a plain string.
 *
 * Every load creates a new session, so two documents never share a Y.Doc.
 * The server still stores plain text; Yjs stays in the browser for now.
 */
export interface DocSession {
  ydoc: Y.Doc;
  text: Y.Text;
}

export function createDocSession(body: string): DocSession {
  const ydoc = new Y.Doc();
  const text = ydoc.getText("body");
  text.insert(0, body);
  return { ydoc, text };
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
