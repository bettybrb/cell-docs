import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from "@codemirror/view";
import type * as Y from "yjs";
import type { CommentAnchor } from "../shared/api-types";
import { positionsToRange } from "../shared/relative-positions";

/** A thread's anchor to highlight; `active` for the thread the user picked. */
export interface Highlight {
  id: number;
  anchor: CommentAnchor;
  active: boolean;
}

/** Where a highlighted thread's text starts: pixels below the top of the editor. */
export interface HighlightPosition {
  id: number;
  top: number;
}

/** What the page is told about highlights. */
export interface HighlightListeners {
  /** A highlight was clicked (the innermost one, if they overlap). */
  onClick?: (id: number) => void;
  /** The highlights' positions changed; in text order, leaving out threads whose text was deleted. */
  onLayout?: (positions: HighlightPosition[]) => void;
}

/** Replaces the highlights shown in an editor. */
export const setHighlights = StateEffect.define<Highlight[]>();

const mark = (id: number, active: boolean) =>
  Decoration.mark({
    class: active ? "cm-comment cm-comment-active" : "cm-comment",
    attributes: { "data-thread-id": String(id) },
  });

/**
 * Highlights commented text. Anchors are Yjs relative positions: whenever the
 * highlights are set, their ranges are worked out from the Y.Text. Between
 * times they are mapped through each edit, because the Yjs binding writes a
 * local edit to the Y.Text only after this field has updated. Either way a
 * highlight follows its text wherever anyone inserts or deletes, keeps text
 * typed just outside it outside, and disappears if all of its text is deleted.
 */
export function commentHighlights(text: Y.Text, listeners: HighlightListeners = {}): Extension {
  const rangesOf = (highlights: Highlight[]) =>
    highlights.flatMap((highlight) => {
      const range = positionsToRange(text, highlight.anchor);
      return range && range.from < range.to && range.to <= text.length ? [{ highlight, ...range }] : [];
    });

  const decorate = (highlights: Highlight[]): DecorationSet =>
    Decoration.set(
      rangesOf(highlights).map(({ highlight, from, to }): Range<Decoration> => mark(highlight.id, highlight.active).range(from, to)),
      true,
    );

  const field = StateField.define<{ highlights: Highlight[]; decorations: DecorationSet }>({
    create: () => ({ highlights: [], decorations: Decoration.none }),
    update(value, transaction) {
      let { highlights } = value;
      for (const effect of transaction.effects) if (effect.is(setHighlights)) highlights = effect.value;
      if (highlights !== value.highlights) return { highlights, decorations: decorate(highlights) };
      if (!transaction.docChanged) return value;
      return { highlights, decorations: value.decorations.map(transaction.changes) };
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.decorations),
  });

  // Reports positions after layout, and only when they changed.
  const measureKey = {};
  const layout = ViewPlugin.define((view) => {
    let last = "";
    const measure = () =>
      view.requestMeasure({
        key: measureKey,
        read: (view) => {
          const offset = view.documentTop - view.dom.getBoundingClientRect().top;
          return rangesOf(view.state.field(field).highlights)
            .sort((a, b) => a.from - b.from)
            .map(({ highlight, from }) => ({ id: highlight.id, top: Math.round(view.lineBlockAt(from).top + offset) }));
        },
        write: (positions) => {
          const key = JSON.stringify(positions);
          if (key !== last) listeners.onLayout?.(positions);
          last = key;
        },
      });
    measure();
    return {
      update(update) {
        if (update.docChanged || update.geometryChanged || update.state.field(field) !== update.startState.field(field)) measure();
      },
    };
  });

  return [
    field,
    ...(listeners.onLayout ? [layout] : []),
    EditorView.domEventHandlers({
      click(event) {
        const target = (event.target as Element).closest?.("[data-thread-id]");
        if (target && listeners.onClick) listeners.onClick(Number(target.getAttribute("data-thread-id")));
        return false; // the click still places the cursor
      },
    }),
    EditorView.baseTheme({
      ".cm-comment": { backgroundColor: "#edae4926", borderBottom: "2px solid #edae4999", cursor: "pointer" },
      ".cm-comment-active": { backgroundColor: "#edae4966", borderBottomColor: "#edae49" },
    }),
  ];
}
