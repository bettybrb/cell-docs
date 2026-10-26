import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type * as Y from "yjs";
import type { CommentAnchor } from "../shared/api-types";
import { positionsToRange } from "../shared/relative-positions";

/** A thread's anchor to highlight; `active` for the thread the user picked. */
export interface Highlight {
  id: number;
  anchor: CommentAnchor;
  active: boolean;
}

/** Replaces the highlights shown in an editor. */
export const setHighlights = StateEffect.define<Highlight[]>();

const mark = Decoration.mark({ class: "cm-comment" });
const activeMark = Decoration.mark({ class: "cm-comment cm-comment-active" });

/**
 * Highlights commented text. Anchors are Yjs relative positions, so on every
 * change the ranges are worked out again from the Y.Text (which the Yjs
 * binding has already updated): a highlight follows its text wherever others
 * insert or delete, and disappears if all of its text is deleted.
 */
export function commentHighlights(text: Y.Text): Extension {
  const decorate = (highlights: Highlight[]): DecorationSet => {
    const ranges: Range<Decoration>[] = [];
    for (const highlight of highlights) {
      const range = positionsToRange(text, highlight.anchor);
      if (range && range.from < range.to && range.to <= text.length) {
        ranges.push((highlight.active ? activeMark : mark).range(range.from, range.to));
      }
    }
    return Decoration.set(ranges, true);
  };

  const field = StateField.define<{ highlights: Highlight[]; decorations: DecorationSet }>({
    create: () => ({ highlights: [], decorations: Decoration.none }),
    update(value, transaction) {
      let { highlights } = value;
      for (const effect of transaction.effects) if (effect.is(setHighlights)) highlights = effect.value;
      if (highlights === value.highlights && !transaction.docChanged) return value;
      return { highlights, decorations: decorate(highlights) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });

  return [
    field,
    EditorView.baseTheme({
      ".cm-comment": { backgroundColor: "#edae4955", borderBottom: "2px solid #edae49" },
      ".cm-comment-active": { backgroundColor: "#edae49aa" },
    }),
  ];
}
