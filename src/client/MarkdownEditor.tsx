import { markdown } from "@codemirror/lang-markdown";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

/**
 * Creates a CodeMirror 6 Markdown editor bound to `text`. The binding keeps
 * the two in step: edits in the editor are applied to the Y.Text, and changes
 * to the Y.Text appear in the editor. With `awareness`, other collaborators'
 * cursors and selections are shown too.
 */
export function createMarkdownEditor(parent: Element, text: Y.Text, awareness: Awareness | null = null): EditorView {
  return new EditorView({
    parent,
    doc: text.toString(),
    extensions: [
      // Yjs undo/redo takes precedence over basicSetup's own history keys.
      keymap.of(yUndoManagerKeymap),
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      yCollab(text, awareness),
    ],
  });
}

/**
 * React wrapper. A new Y.Text (a different document) gets a new editor, so
 * content and undo history never carry over between documents.
 */
export function MarkdownEditor({ text, awareness = null }: { text: Y.Text; awareness?: Awareness | null }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const view = createMarkdownEditor(host.current!, text, awareness);
    return () => view.destroy();
  }, [text, awareness]);

  return <div className="markdown-editor" data-testid="markdown-editor" ref={host} />;
}
