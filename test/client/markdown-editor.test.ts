import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { yUndoManagerKeymap } from "y-codemirror.next";
import { createDocSession, latestOnly } from "../../src/client/doc-session";
import { createMarkdownEditor } from "../../src/client/MarkdownEditor";

const views: EditorView[] = [];

function mount(text: Parameters<typeof createMarkdownEditor>[1]): EditorView {
  const view = createMarkdownEditor(document.body.appendChild(document.createElement("div")), text);
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

describe("latestOnly", () => {
  it("lets only the most recent request apply its result", () => {
    const loads = latestOnly();
    const first = loads.start();
    const second = loads.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
