import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { CommentThread, DocState } from "../shared/api-types";
import { positionsToRange, rangeToPositions } from "../shared/relative-positions";
import { api } from "./api";
import type { Highlight } from "./comment-highlights";
import type { ConnectedDocSession } from "./doc-session";

/**
 * Comment threads on the open document. A thread can be attached to the
 * selected text: its anchor is a pair of Yjs relative positions, so its
 * highlight follows the text while anyone edits. Threads have replies and
 * can be resolved and reopened. Readers see everything; commenters and
 * editors can write. Every open page reloads when anyone changes a thread.
 */
export function CommentThreads({
  doc,
  session,
  selection,
  canComment,
  activeId,
  onHighlights,
  onReveal,
}: {
  doc: DocState;
  /** The live session (for the text, and for change notices); null while connecting. */
  session: ConnectedDocSession | null;
  /** The editor's current selection. */
  selection: { from: number; to: number };
  canComment: boolean;
  activeId: number | null;
  /** The anchors of open threads, for the editor to highlight. */
  onHighlights: (highlights: Highlight[]) => void;
  /** Called when the user wants to see a thread's text (or null to clear). */
  onReveal: (thread: CommentThread | null, range: { from: number; to: number } | null) => void;
}) {
  const [threads, setThreads] = useState<CommentThread[] | "error">([]);
  const [draft, setDraft] = useState("");
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [showResolved, setShowResolved] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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

  // Open threads with an anchor are highlighted in the editor.
  useEffect(() => {
    const open = threads === "error" ? [] : threads.filter((t) => t.anchor && !t.resolvedAt);
    onHighlights(open.map((t) => ({ id: t.id, anchor: t.anchor!, active: t.id === activeId })));
  }, [threads, activeId]);

  const selected = text && selection.from !== selection.to ? text.toString().slice(selection.from, selection.to) : "";

  const start = async () => {
    const anchor = text && selected ? rangeToPositions(text, selection.from, selection.to) : undefined;
    const r = await api.addComment(doc.workspaceId, doc.docId, { body: draft, ...(anchor ? { anchor } : {}) });
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setDraft("");
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

  const list = threads === "error" ? [] : threads.filter((t) => showResolved || !t.resolvedAt);
  const resolvedCount = threads === "error" ? 0 : threads.filter((t) => t.resolvedAt).length;

  return (
    <details className="wide panel" data-testid="comments" open>
      <summary>
        Comments ({threads === "error" ? "?" : threads.length - resolvedCount} open
        {resolvedCount > 0 && `, ${resolvedCount} resolved`})
      </summary>
      <div className="inline">
        <input
          aria-label="New comment"
          placeholder={
            !canComment ? "You may only read this document" : selected ? "Comment on the selected text" : "Comment on the whole document"
          }
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!canComment}
        />
        <button onClick={start} disabled={!canComment || draft.trim() === ""}>
          {selected ? "Comment on selection" : "Add comment"}
        </button>
        {selected && <span className="muted">on “{selected.length > 40 ? `${selected.slice(0, 40)}…` : selected}”</span>}
        <label className="inline muted">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
        {message && <span className="muted">{message}</span>}
      </div>
      {threads === "error" ? (
        <p>Could not load comments.</p>
      ) : (
        <ul className="threads">
          {list.map((thread) => {
            const range = rangeOf(thread);
            const deleted = thread.anchor !== null && (!range || range.from === range.to);
            return (
              <li
                key={thread.id}
                data-testid="thread"
                data-resolved={thread.resolvedAt !== null}
                className={thread.id === activeId ? "active-thread" : undefined}
              >
                {thread.anchor && (
                  <div className="muted" data-testid="thread-quote">
                    {deleted ? "The commented text was deleted: " : "On "}“{thread.quote}”{" "}
                    {!deleted && (
                      <button onClick={() => onReveal(thread, range)} data-testid="show-in-text">
                        Show in text
                      </button>
                    )}
                  </div>
                )}
                <div data-testid="comment">
                  <strong>{thread.author}</strong> <span className="muted">{new Date(thread.createdAt).toLocaleString()}</span>:{" "}
                  {thread.body}
                </div>
                {thread.replies.map((r) => (
                  <div key={r.id} className="reply" data-testid="reply">
                    <strong>{r.author}</strong> <span className="muted">{new Date(r.createdAt).toLocaleString()}</span>: {r.body}
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
    </details>
  );
}
