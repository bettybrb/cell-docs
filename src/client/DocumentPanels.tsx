import { useEffect, useState } from "react";
import type { DocCatalogue, DocComment, DocState } from "../shared/api-types";
import { canManage, ROLES, type Role } from "../shared/permissions";
import { TEST_USERS } from "../shared/users";
import { api } from "./api";
import { currentUser } from "./current-user";
import { folderPath } from "./DocumentBrowser";
import { ROLE_TEXT } from "./PresenceBar";

/**
 * Where the open document is filed and how it is tagged (catalogue-only
 * information: the document id stays the same), plus moving it to the
 * Recycle Bin.
 */
export function OrganisePanel({
  doc,
  catalogue,
  canEdit,
  onChanged,
  onDeleted,
}: {
  doc: DocState;
  catalogue: DocCatalogue | "error" | null;
  canEdit: boolean;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const entry = catalogue && catalogue !== "error" ? catalogue.docs.find((d) => d.docId === doc.docId) : undefined;
  const folders = catalogue && catalogue !== "error" ? catalogue.folders : [];
  const [folderId, setFolderId] = useState(entry?.folderId ?? "");
  const [tags, setTags] = useState((entry?.tags ?? []).join(", "));
  const [message, setMessage] = useState<string | null>(null);

  // Follow the catalogue when another document is opened or the catalogue reloads.
  useEffect(() => {
    setFolderId(entry?.folderId ?? "");
    setTags((entry?.tags ?? []).join(", "));
  }, [doc.docId, entry?.folderId, entry?.tags.join(",")]);

  const save = async () => {
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    const r = await api.setDocMeta(doc.workspaceId, doc.docId, { folderId: folderId || null, tags: tagList });
    setMessage(r.ok ? "Saved." : r.error.message);
    if (r.ok) onChanged();
  };

  const moveToTrash = async () => {
    const r = await api.deleteDoc(doc.workspaceId, doc.docId);
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) onDeleted();
  };

  return (
    <details className="wide panel" data-testid="organise" open>
      <summary>Folder, tags and delete</summary>
      <div className="inline">
        <label>
          Folder
          <select aria-label="Move to folder" value={folderId} onChange={(e) => setFolderId(e.target.value)} disabled={!canEdit}>
            <option value="">Not in a folder</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {folderPath(folders, f.id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tags (comma separated)
          <input aria-label="Tags" value={tags} onChange={(e) => setTags(e.target.value)} disabled={!canEdit} list="known-tags" />
          <datalist id="known-tags">
            {catalogue && catalogue !== "error" && catalogue.tags.map((t) => <option key={t.name} value={t.name} />)}
          </datalist>
        </label>
        <button onClick={save} disabled={!canEdit}>
          Save folder and tags
        </button>
        <button onClick={moveToTrash} disabled={!canEdit}>
          Move to Recycle Bin
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </details>
  );
}

/**
 * Who may do what with the open document. Only the owner can change it (or,
 * for a document without an owner, anyone who may edit it). The server
 * enforces every role; this panel only shows and edits them.
 */
export function PermissionsPanel({ doc, onChanged }: { doc: DocState; onChanged: (doc: DocState) => void }) {
  const manager = canManage(currentUser(), doc.permissions);
  const [defaultRole, setDefaultRole] = useState<Role>(doc.permissions.defaultRole);
  const [users, setUsers] = useState<Record<string, Role>>(doc.permissions.users);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDefaultRole(doc.permissions.defaultRole);
    setUsers(doc.permissions.users);
  }, [doc.docId, JSON.stringify(doc.permissions)]);

  const others = TEST_USERS.filter((user) => user !== (doc.permissions.owner ?? currentUser()));

  const save = async () => {
    const r = await api.setPermissions(doc.workspaceId, doc.docId, { defaultRole, users });
    setMessage(r.ok ? "Permissions saved." : r.error.message);
    if (r.ok) onChanged(r.data);
  };

  return (
    <details className="wide panel" data-testid="permissions">
      <summary>Permissions</summary>
      <p className="muted">
        Owner: <strong>{doc.permissions.owner ?? "nobody yet"}</strong> · You: {ROLE_TEXT[doc.yourRole]}
        {!manager && " · only the owner can change permissions"}
      </p>
      <div className="inline">
        <label>
          Everyone else
          <select
            aria-label="Default role"
            value={defaultRole}
            onChange={(e) => setDefaultRole(e.target.value as Role)}
            disabled={!manager}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {role === "none" ? "No access (private)" : ROLE_TEXT[role]}
              </option>
            ))}
          </select>
        </label>
        {others.map((user) => (
          <label key={user}>
            {user}
            <select
              aria-label={`Role for ${user}`}
              value={users[user] ?? ""}
              disabled={!manager}
              onChange={(e) => {
                const next = { ...users };
                if (e.target.value) next[user] = e.target.value as Role;
                else delete next[user];
                setUsers(next);
              }}
            >
              <option value="">Same as everyone</option>
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role === "none" ? "No access" : ROLE_TEXT[role]}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button onClick={save} disabled={!manager}>
          Save permissions
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </details>
  );
}

/** Comments on the open document: readers see them, commenters and editors can add one. */
export function CommentsPanel({ doc, canComment }: { doc: DocState; canComment: boolean }) {
  const [comments, setComments] = useState<DocComment[] | "error">([]);
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    const r = await api.listComments(doc.workspaceId, doc.docId);
    setComments(r.ok ? r.data.comments : "error");
  };

  useEffect(() => {
    void load();
  }, [doc.workspaceId, doc.docId]);

  const add = async () => {
    const r = await api.addComment(doc.workspaceId, doc.docId, { body: draft });
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setDraft("");
    await load();
  };

  return (
    <details className="wide panel" data-testid="comments">
      <summary>Comments ({comments === "error" ? "?" : comments.length})</summary>
      <button onClick={load}>Refresh</button>
      {comments === "error" ? (
        <p>Could not load comments.</p>
      ) : (
        <ul>
          {comments.map((c) => (
            <li key={c.id} data-testid="comment">
              <strong>{c.author}</strong> <span className="muted">{new Date(c.createdAt).toLocaleString()}</span>: {c.body}
            </li>
          ))}
        </ul>
      )}
      <div className="inline">
        <input
          aria-label="New comment"
          placeholder={canComment ? "Write a comment" : "You may only read this document"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!canComment}
        />
        <button onClick={add} disabled={!canComment || draft.trim() === ""}>
          Add comment
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </details>
  );
}
