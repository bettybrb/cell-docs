import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { setHighlights, type HighlightListeners, type HighlightPosition } from "../../src/client/comment-highlights";
import { createDocSession, latestOnly } from "../../src/client/doc-session";
import { createMarkdownEditor } from "../../src/client/MarkdownEditor";
import { rangeToPositions } from "../../src/shared/relative-positions";

const views: EditorView[] = [];

function mount(text: Parameters<typeof createMarkdownEditor>[1], listeners?: HighlightListeners): EditorView {
  const view = createMarkdownEditor(document.body.appendChild(document.createElement("div")), text, null, false, undefined, listeners);
  views.push(view);
  return view;
}

/** Simulates typing: a user-originated change at `pos`. */
function type(view: EditorView, pos: number, insert: string): void {
  view.dispatch({ changes: { from: pos, insert }, userEvent: "input.type" });
}

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  document.body.innerHTML = "";
});

describe("doc session", () => {
  it("seeds a Y.Text with the loaded body", () => {
    const session = createDocSession("# Title\n\nBody");
    expect(session.text.toString()).toBe("# Title\n\nBody");
  });

  it("gives each document its own Y.Doc", () => {
    const a = createDocSession("A");
    const b = createDocSession("B");
    expect(a.ydoc).not.toBe(b.ydoc);
    a.text.insert(1, " edited");
    expect(b.text.toString()).toBe("B");
  });
});

describe("Markdown editor bound to Y.Text", () => {
  it("shows the Y.Text content when created", () => {
    const view = mount(createDocSession("Hello *world*").text);
    expect(view.state.doc.toString()).toBe("Hello *world*");
  });

  it("writes editor edits into the Y.Text, which is what saving reads", () => {
    const session = createDocSession("Hello");
    const view = mount(session.text);
    type(view, 5, ", Yjs");
    expect(session.text.toString()).toBe("Hello, Yjs");
  });

  it("shows changes made to the Y.Text in the editor", () => {
    const session = createDocSession("Hello");
    const view = mount(session.text);
    session.text.insert(0, "## ");
    expect(view.state.doc.toString()).toBe("## Hello");
  });

  it("keeps documents apart when the editor switches to another document", () => {
    const a = createDocSession("Doc A");
    const b = createDocSession("Doc B");
    const viewA = mount(a.text);
    type(viewA, 5, " edited");
    viewA.destroy();

    const viewB = mount(b.text);
    expect(viewB.state.doc.toString()).toBe("Doc B");
    type(viewB, 5, " changed");

    expect(a.text.toString()).toBe("Doc A edited");
    expect(b.text.toString()).toBe("Doc B changed");
  });

  it("undoes local edits through the Yjs undo manager", () => {
    const session = createDocSession("Hello");
    const view = mount(session.text);
    type(view, 5, "!");
    const undo = yUndoManagerKeymap.find((binding) => binding.key === "Mod-z")!;
    expect(undo.run!(view)).toBe(true);
    expect(session.text.toString()).toBe("Hello");
    expect(view.state.doc.toString()).toBe("Hello");
  });
});

describe("comment highlights", () => {
  /** Highlights `word` (its first occurrence) as thread `id`. */
  const highlight = (text: ReturnType<typeof createDocSession>["text"], id: number, word: string, active = false) => {
    const from = text.toString().indexOf(word);
    return { id, anchor: rangeToPositions(text, from, from + word.length), active };
  };
  const marks = (view: EditorView) =>
    [...view.dom.querySelectorAll<HTMLElement>(".cm-comment")].map((m) => [m.dataset.threadId, m.textContent, m.classList.contains("cm-comment-active")]);

  it("marks each thread's text with its id, and the active one", () => {
    const session = createDocSession("The quick brown fox.");
    const view = mount(session.text);
    view.dispatch({ effects: setHighlights.of([highlight(session.text, 1, "quick"), highlight(session.text, 2, "fox", true)]) });
    expect(marks(view)).toEqual([["1", "quick", false], ["2", "fox", true]]);
  });

  it("keeps a highlight on its text through this user's own edits, and drops it when its text is deleted", () => {
    const session = createDocSession("Keep this. Remove that.");
    const view = mount(session.text);
    view.dispatch({ effects: setHighlights.of([highlight(session.text, 1, "Remove")]) });
    type(view, 0, ">> ");
    expect(marks(view)).toEqual([["1", "Remove", false]]);
    view.dispatch({ changes: { from: 14, to: 21 }, userEvent: "delete" }); // "Remove "
    expect(session.text.toString()).toBe(">> Keep this. that.");
    expect(marks(view)).toEqual([]);
  });

  it("tells which thread's highlight was clicked", () => {
    const session = createDocSession("The quick brown fox.");
    const clicked: number[] = [];
    const view = mount(session.text, { onClick: (id) => clicked.push(id) });
    view.dispatch({ effects: setHighlights.of([highlight(session.text, 7, "brown")]) });
    view.dom.querySelector(".cm-comment")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    view.contentDOM.querySelector(".cm-line")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); // not on a highlight
    expect(clicked).toEqual([7]);
  });

  it("reports highlight positions in text order, without threads whose text was deleted", async () => {
    const session = createDocSession("Alpha\nBravo\nCharlie");
    const layouts: HighlightPosition[][] = [];
    const view = mount(session.text, { onLayout: (positions) => layouts.push(positions) });
    view.dispatch({ effects: setHighlights.of([highlight(session.text, 2, "Charlie"), highlight(session.text, 1, "Alpha")]) });
    await vi.waitFor(() => expect(layouts.at(-1)?.map((p) => p.id)).toEqual([1, 2]));

    session.text.delete(0, "Alpha".length); // thread 1's text is gone
    await vi.waitFor(() => expect(layouts.at(-1)?.map((p) => p.id)).toEqual([2]));
    expect(marks(view)).toEqual([["2", "Charlie", false]]);
  });
});

describe("latestOnly", () => {
  it("lets only the most recent request apply its result", () => {
    const loads = latestOnly();
    const first = loads.start();
    const second = loads.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
