import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { commentHighlights, setHighlights, type Highlight, type HighlightListeners, type HighlightPosition } from "./comment-highlights";

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
  onSelection?: (from: number, to: number) => void,
  highlightListeners: HighlightListeners = {},
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
      commentHighlights(text, highlightListeners),
      EditorView.updateListener.of((update) => {
        if (update.selectionSet && onSelection) {
          const { from, to } = update.state.selection.main;
          onSelection(from, to);
        }
      }),
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
  highlights = [],
  onSelection,
  onHighlightClick,
  onHighlightLayout,
  reveal,
}: {
  text: Y.Text;
  awareness?: Awareness | null;
  readOnly?: boolean;
  /** Commented ranges to highlight (they follow their text as it is edited). */
  highlights?: Highlight[];
  /** Told the selection whenever it changes (offsets in the text). */
  onSelection?: (from: number, to: number) => void;
  /** Told which thread's highlight was clicked. */
  onHighlightClick?: (id: number) => void;
  /** Told where each highlight is (pixels below the top of the editor) whenever that changes. */
  onHighlightLayout?: (positions: HighlightPosition[]) => void;
  /** Selects and scrolls to this range; a new object each time it should happen. */
  reveal?: { from: number; to: number } | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const selectionListener = useRef(onSelection);
  selectionListener.current = onSelection;
  const clickListener = useRef(onHighlightClick);
  clickListener.current = onHighlightClick;
  const layoutListener = useRef(onHighlightLayout);
  layoutListener.current = onHighlightLayout;

  useEffect(() => {
    view.current = createMarkdownEditor(
      host.current!,
      text,
      awareness,
      readOnly,
      (from, to) => selectionListener.current?.(from, to),
      {
        onClick: (id) => clickListener.current?.(id),
        onLayout: (positions) => layoutListener.current?.(positions),
      },
    );
    view.current.dispatch({ effects: setHighlights.of(highlights) });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, [text, awareness]);

  useEffect(() => {
    if (view.current) setReadOnly(view.current, readOnly);
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: setHighlights.of(highlights) });
  }, [highlights]);

  useEffect(() => {
    if (!view.current || !reveal) return;
    view.current.dispatch({ selection: { anchor: reveal.from, head: reveal.to }, scrollIntoView: true });
    view.current.focus();
  }, [reveal]);

  return (
    <div className="markdown-editor" data-testid="markdown-editor" data-readonly={readOnly} ref={host} />
  );
}
