import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

interface Props {
  value: string;
  onChange: (value: string) => void;
}

/**
 * CodeMirror 6 editor with Markdown highlighting, used like a controlled
 * <textarea>: the parent owns `value`, and every edit is reported through
 * `onChange`. Plain text in, plain text out; nothing collaborative yet.
 */
export function MarkdownEditor({ value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Create the editor once; destroy it on unmount.
  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      doc: value,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  // Replace the content when the value changes from outside (e.g. loading a doc).
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (value !== current) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div className="markdown-editor" data-testid="markdown-editor" ref={host} />;
}
