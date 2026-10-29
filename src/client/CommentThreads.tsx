import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type * as Y from "yjs";
import type { CommentAnchor, CommentThread, DocState } from "../shared/api-types";
import { positionsToRange, rangeToPositions } from "../shared/relative-positions";
import { api } from "./api";
import type { Highlight, HighlightPosition } from "./comment-highlights";
import { layoutCards } from "./comment-layout";
import type { ConnectedDocSession } from "./doc-session";

/** The card id of a comment being written (stored threads start at 1). */
const DRAFT = 0;

/** A comment being written: on the text selected when it was started, or the whole document. */
interface Draft {
  body: string;
  anchor?: CommentAnchor;
  quote: string;
}

/**
 * Comment threads on the open document. A thread can be attached to the
 * selected text: its anchor is a pair of Yjs relative positions, so its
 * highlight follows the text while anyone edits. Threads have replies and
 * can be resolved and reopened. Readers see everything; commenters and
 * editors can write. Every open page reloads when anyone changes a thread.
 *
 * The threads are cards in a margin beside the editor (`children`), each
 * beside its text; threads without text to sit beside (on the whole document,
 * text deleted, resolved) come first. Clicking a card selects its text, and
 * clicking a highlight brings its card into view. The margin can be hidden,
 * and on narrow screens it goes below the editor.
 */
export function CommentThreads({
  doc,
  session,
  selection,
  canComment,
  activeId,
  positions,
  onHighlights,
  onReveal,
  children,
}: {
  doc: DocState;
  /** The live session (for the text, and for change notices); null while connecting. */
  session: ConnectedDocSession | null;
  /** The editor's current selection. */
  selection: { from: number; to: number };
  canComment: boolean;
  activeId: number | null;
  /** Where the editor shows each highlight. */
  positions: HighlightPosition[];
  /** The anchors of open threads (and of the draft), for the editor to highlight. */
  onHighlights: (highlights: Highlight[]) => void;
  /** Called when the user wants to see a thread's text (or null to clear). */
  onReveal: (thread: CommentThread | null, range: { from: number; to: number } | null) => void;
  /** The editor. */
  children: ReactNode;
}) {
  const [threads, setThreads] = useState<CommentThread[] | "error">([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const cards = useRef(new Map<number, HTMLLIElement>());
  const [heights, setHeights] = useState<Record<number, number>>({});
  const text: Y.Text | null = session?.text ?? null;

  const load = async () => {
    const r = await api.listComments(doc.workspaceId, doc.docId);
    setThreads(r.ok ? r.data.threads : "error");
  };

  useEffect(() => {
    void load();
    if (!session) return;
    return session.onChanged((topic) => {
      if (topic === "comments") void load();
    });
  }, [doc.workspaceId, doc.docId, session]);

  // Open threads with an anchor are highlighted in the editor, and so is the draft's text.
  useEffect(() => {
    const open = threads === "error" ? [] : threads.filter((t) => t.anchor && !t.resolvedAt);
    onHighlights([
      ...open.map((t) => ({ id: t.id, anchor: t.anchor!, active: !draft && t.id === activeId })),
      ...(draft?.anchor ? [{ id: DRAFT, anchor: draft.anchor, active: true }] : []),
    ]);
  }, [threads, activeId, draft?.anchor]);

  // A card picked from its highlight may be out of view (in the margin, or below the editor).
  useEffect(() => {
    if (activeId !== null) cards.current.get(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  const selected = text && selection.from !== selection.to ? text.toString().slice(selection.from, selection.to) : "";

  const startDraft = () => {
    setCollapsed(false);
    setDraft({
      body: draft?.body ?? "",
      quote: selected,
      ...(text && selected ? { anchor: rangeToPositions(text, selection.from, selection.to) } : {}),
    });
  };

  const submit = async () => {
    if (!draft) return;
    const r = await api.addComment(doc.workspaceId, doc.docId, {
      body: draft.body,
      ...(draft.anchor ? { anchor: draft.anchor } : {}),
    });
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setDraft(null);
    await load();
  };

  const reply = async (thread: CommentThread) => {
    const r = await api.reply(doc.workspaceId, doc.docId, thread.id, { body: replies[thread.id] ?? "" });
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setReplies({ ...replies, [thread.id]: "" });
    await load();
  };

  const resolve = async (thread: CommentThread, resolved: boolean) => {
    const r = await api.resolveThread(doc.workspaceId, doc.docId, thread.id, resolved);
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setThreads(r.data.threads);
  };

  /** Where a thread's text is now; null for whole-document threads, from === to if it was deleted. */
  const rangeOf = (thread: CommentThread) => (text && thread.anchor ? positionsToRange(text, thread.anchor) : null);

  /** Clicking a card (not one of its controls) picks the thread and selects its text. */
  const pick = (thread: CommentThread, target: EventTarget) => {
    if ((target as Element).closest("button, input, textarea, label")) return;
    const range = rangeOf(thread);
    onReveal(thread, range && range.from < range.to ? range : null);
  };

  const shown = threads === "error" ? [] : threads.filter((t) => showResolved || !t.resolvedAt);
  const resolvedCount = threads === "error" ? 0 : threads.filter((t) => t.resolvedAt).length;
  // Cards beside their text, in text order, after those with no text to sit beside.
  const placed = new Map(positions.map((p, i) => [p.id, { top: p.top, order: i }]));
  const list: { id: number; thread?: CommentThread }[] = [
    ...(draft ? [{ id: DRAFT }] : []),
    ...shown.map((thread) => ({ id: thread.id, thread })),
  ].sort((a, b) => (placed.get(a.id)?.order ?? -1) - (placed.get(b.id)?.order ?? -1));
  const tops = layoutCards(
    list.map(({ id }) => ({ id, desired: placed.get(id)?.top ?? 0, height: heights[id] ?? 0 })),
    draft ? DRAFT : activeId,
  );
  const marginHeight = list.length ? tops.at(-1)! + (heights[list.at(-1)!.id] ?? 0) : 0;

  // Cards are placed by their measured heights, so measure after every render.
  useLayoutEffect(() => {
    const measured: Record<number, number> = {};
    for (const [id, card] of cards.current) measured[id] = card.offsetHeight;
    if (JSON.stringify(measured) !== JSON.stringify(heights)) setHeights(measured);
  });

  const cardProps = (id: number, i: number) => ({
    ref: (card: HTMLLIElement | null) => {
      if (card) cards.current.set(id, card);
      else cards.current.delete(id);
    },
    style: { top: tops[i] },
  });

  const quoted = (quote: string) => `“${quote.length > 40 ? `${quote.slice(0, 40)}…` : quote}”`;

  return (
    <div className="comments" data-testid="comments" data-collapsed={collapsed}>
      <div className="inline">
        <strong>
          Comments ({threads === "error" ? "?" : threads.length - resolvedCount} open
          {resolvedCount > 0 && `, ${resolvedCount} resolved`})
        </strong>
        <button onClick={startDraft} disabled={!canComment} title={canComment ? undefined : "You may only read this document"}>
          Add comment
        </button>
        {canComment && <span className="muted">{selected ? `on ${quoted(selected)}` : "on the whole document"}</span>}
        <label className="inline muted">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
        <button onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          {collapsed ? "Show comments" : "Hide comments"}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
      {threads === "error" && <p>Could not load comments.</p>}
      <div className="doc-area">
        <div className="doc-area-text">{children}</div>
        {!collapsed && threads !== "error" && (
          <ul className="threads" data-testid="comment-margin" style={{ minHeight: marginHeight }}>
            {list.map(({ id, thread }, i) => {
              if (!thread) {
                return (
                  <li key="draft" {...cardProps(id, i)} data-testid="draft" className="active-thread">
                    <div className="muted">{draft!.anchor ? `On ${quoted(draft!.quote)}` : "On the whole document"}</div>
                    <textarea
                      aria-label="New comment"
                      placeholder="Comment"
                      rows={3}
                      autoFocus
                      value={draft!.body}
                      onChange={(e) => setDraft({ ...draft!, body: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setDraft(null);
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && draft!.body.trim()) void submit();
                      }}
                    />
                    <div className="inline">
                      <button onClick={submit} disabled={draft!.body.trim() === ""}>
                        Submit
                      </button>
                      <button onClick={() => setDraft(null)}>Cancel</button>
                    </div>
                  </li>
                );
              }
              const range = rangeOf(thread);
              const deleted = thread.anchor !== null && (!range || range.from === range.to);
              return (
                <li
                  key={thread.id}
                  {...cardProps(id, i)}
                  onClick={(e) => pick(thread, e.target)}
                  data-testid="thread"
                  data-thread-id={thread.id}
                  data-resolved={thread.resolvedAt !== null}
                  className={thread.id === activeId ? "active-thread" : undefined}
                >
                  {thread.anchor && (
                    <div className="muted" data-testid="thread-quote">
                      {deleted ? (
                        <>
                          <span className="tag" data-testid="anchor-deleted">
                            Text deleted
                          </span>
                          was “{thread.quote}”
                        </>
                      ) : (
                        <>On “{thread.quote}”</>
                      )}
                    </div>
                  )}
                  <div data-testid="comment">
                    <strong>{thread.author}</strong> <span className="muted">{new Date(thread.createdAt).toLocaleString()}</span>
                    <div>{thread.body}</div>
                  </div>
                  {thread.replies.map((r) => (
                    <div key={r.id} className="reply" data-testid="reply">
                      <strong>{r.author}</strong> <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>
                      <div>{r.body}</div>
                    </div>
                  ))}
                  {thread.resolvedAt && (
                    <div className="muted">
                      Resolved by {thread.resolvedBy} {new Date(thread.resolvedAt).toLocaleString()}
                    </div>
                  )}
                  {canComment && (
                    <div className="inline">
                      <input
                        aria-label={`Reply to ${thread.author}`}
                        placeholder="Reply"
                        value={replies[thread.id] ?? ""}
                        onChange={(e) => setReplies({ ...replies, [thread.id]: e.target.value })}
                      />
                      <button onClick={() => reply(thread)} disabled={!(replies[thread.id] ?? "").trim()}>
                        Reply
                      </button>
                      <button onClick={() => resolve(thread, !thread.resolvedAt)}>{thread.resolvedAt ? "Reopen" : "Resolve"}</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
