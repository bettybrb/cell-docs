import { markdown } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type * as Y from "yjs";

/**
 * Creates a CodeMirror 6 Markdown editor bound to `text`. The binding keeps
 * the two in step: edits in the editor are applied to the Y.Text, and changes
 * to the Y.Text appear in the editor.
 */
export function createMarkdownEditor(parent: Element, text: Y.Text): EditorView {
  return new EditorView({
    parent,
    doc: text.toString(),
    extensions: [
      // Yjs undo/redo takes precedence over basicSetup's own history keys.
      keymap.of(yUndoManagerKeymap),
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      // No awareness object: no presence or remote cursors yet.
      yCollab(text, null),
    ],
  });
}

/**
 * React wrapper. A new Y.Text (a different document) gets a new editor, so
 * content and undo history never carry over between documents.
 */
export function MarkdownEditor({ text }: { text: Y.Text }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = createMarkdownEditor(host.current!, text);
    return () => view.destroy();
  }, [text]);

  return <div className="markdown-editor" data-testid="markdown-editor" ref={host} />;
}
