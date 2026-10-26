import { useEffect, useState } from "react";
import type { TrashEntry } from "../shared/api-types";
import { api } from "./api";

/**
 * Deleted documents the current user could read. Restoring keeps the
 * document's id, text, versions and comments; "Delete forever" (owner only)
 * erases it at once instead of after the 30 days.
 */
export function RecycleBin({
  workspaceId,
  reloadKey,
  onRestored,
  onChanged,
}: {
  workspaceId: string;
  /** Change this to reload the list (for example after a delete). */
  reloadKey: number;
  onRestored: (docId: string) => void;
  onChanged: () => void;
}) {
  const [docs, setDocs] = useState<TrashEntry[] | "error">([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    const r = await api.listTrash(workspaceId);
    setDocs(r.ok ? r.data.docs : "error");
  };

  useEffect(() => {
    void load();
  }, [workspaceId, reloadKey]);

  const restore = async (docId: string) => {
    const r = await api.restoreDoc(workspaceId, docId);
    setMessage(r.ok ? `Restored ${docId}.` : r.error.message);
    await load();
    if (r.ok) onRestored(docId);
  };

  const purge = async (docId: string) => {
    const r = await api.purgeDoc(workspaceId, docId);
    setMessage(r.ok ? `Deleted ${docId} for good.` : r.error.message);
    await load();
    onChanged();
  };

  return (
    <details className="wide panel" data-testid="recycle-bin">
      <summary>Recycle Bin ({docs === "error" ? "?" : docs.length})</summary>
      <button onClick={load}>Refresh</button>
      {message && <span className="muted"> {message}</span>}
      {docs === "error" ? (
        <p>Could not load the Recycle Bin.</p>
      ) : docs.length === 0 ? (
        <p>Empty.</p>
      ) : (
        <ul>
          {docs.map((d) => (
            <li key={d.docId} data-testid="trash-entry">
              <strong>{d.title || d.docId}</strong> <small>({d.docId})</small>
              <span className="muted">
                {" "}
                deleted {new Date(d.deletedAt).toLocaleString()}
                {d.deletedBy && ` by ${d.deletedBy}`}
                {d.purgeAt && ` · erased for good on ${new Date(d.purgeAt).toLocaleString()}`}
              </span>{" "}
              <button onClick={() => restore(d.docId)}>Restore</button>{" "}
              <button onClick={() => purge(d.docId)}>Delete forever</button>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
