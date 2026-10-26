import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

/** Holds the read-only setting so it can change without rebuilding the editor. */
const readOnlySetting = new Compartment();

const readOnlyExtension = (readOnly: boolean) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];

/**
 * Creates a CodeMirror 6 Markdown editor bound to `text`. The binding keeps
 * the two in step: edits in the editor are applied to the Y.Text, and changes
 * to the Y.Text appear in the editor. With `awareness`, other collaborators'
 * cursors and selections are shown too. A read-only editor still shows
 * others' changes live.
 */
export function createMarkdownEditor(
  parent: Element,
  text: Y.Text,
  awareness: Awareness | null = null,
  readOnly = false,
): EditorView {
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
      readOnlySetting.of(readOnlyExtension(readOnly)),
    ],
  });
}

/** Switches an editor between editable and read-only in place. */
export function setReadOnly(view: EditorView, readOnly: boolean): void {
  view.dispatch({ effects: readOnlySetting.reconfigure(readOnlyExtension(readOnly)) });
}

/**
 * React wrapper. A new Y.Text (a different document) gets a new editor, so
 * content and undo history never carry over between documents. `readOnly`
 * can change while the document is open (for example when an owner takes
 * away this user's edit right).
 */
export function MarkdownEditor({
  text,
  awareness = null,
  readOnly = false,
}: {
  text: Y.Text;
  awareness?: Awareness | null;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    view.current = createMarkdownEditor(host.current!, text, awareness, readOnly);
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [text, awareness]);

  useEffect(() => {
    if (view.current) setReadOnly(view.current, readOnly);
  }, [readOnly]);

  return (
    <div className="markdown-editor" data-testid="markdown-editor" data-readonly={readOnly} ref={host} />
  );
}
