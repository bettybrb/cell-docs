import { useEffect, useState } from "react";
import type { CatalogueEntry, DocCatalogue, Folder, SearchResult } from "../shared/api-types";
import { api } from "./api";
import { ROLE_TEXT } from "./PresenceBar";

const UNFILED = "__unfiled";

/** "Parent / Child" for nested folders. */
export function folderPath(folders: Folder[], id: string | null): string {
  const names: string[] = [];
  for (let folder = folders.find((f) => f.id === id); folder; folder = folders.find((f) => f.id === folder!.parentId)) {
    names.unshift(folder.name);
    if (names.length > 10) break; // guards against a cycle
  }
  return names.join(" / ");
}

/**
 * The workspace's documents (only those the current user may read), with a
 * folder filter, folder creation, and search by title, text or tag. Document
 * ids never change when a document moves between folders.
 */
export function DocumentBrowser({
  workspaceId,
  catalogue,
  currentDocId,
  onOpen,
  onChanged,
}: {
  workspaceId: string;
  catalogue: DocCatalogue | "error" | null;
  currentDocId: string;
  onOpen: (docId: string) => void;
  /** Called after folders change, so the catalogue is reloaded. */
  onChanged: () => void;
}) {
  const [folder, setFolder] = useState("");
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [newFolder, setNewFolder] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const searching = query.trim() !== "" || tag !== "";

  // Search as the user types (a short pause first); results follow catalogue reloads.
  useEffect(() => {
    if (!searching) {
      setResults(null);
      return;
    }
    let current = true;
    const timer = setTimeout(async () => {
      const r = await api.search(workspaceId, { q: query.trim(), tag });
      if (current) setResults(r.ok ? r.data.results : []);
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [workspaceId, query, tag, catalogue]);

  if (catalogue === null) return <p className="wide">Loading documents…</p>;
  if (catalogue === "error") return <p className="wide">Could not load the document list.</p>;
  const folders = catalogue.folders;

  const inFolder = (entry: CatalogueEntry) =>
    folder === "" || (folder === UNFILED ? entry.folderId === null : entry.folderId === folder);
  const shown: (CatalogueEntry & Partial<SearchResult>)[] = (searching ? (results ?? []) : catalogue.docs).filter(inFolder);

  const createFolder = async () => {
    const parentId = folder && folder !== UNFILED ? folder : null;
    const r = await api.createFolder(workspaceId, { name: newFolder, parentId });
    setMessage(r.ok ? `Created folder ${folderPath([...folders, r.data], r.data.id)}.` : r.error.message);
    if (r.ok) {
      setNewFolder("");
      onChanged();
    }
  };

  const deleteFolder = async () => {
    const r = await api.deleteFolder(workspaceId, folder);
    setMessage(r.ok ? "Folder deleted." : r.error.message);
    if (r.ok) {
      setFolder("");
      onChanged();
    }
  };

  return (
    <div className="wide" data-testid="document-browser">
      <div className="inline">
        <input
          aria-label="Search"
          placeholder="Search titles, text and tags"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select aria-label="Filter by tag" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {catalogue.tags.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name} ({t.count})
            </option>
          ))}
        </select>
        <select aria-label="Filter by folder" value={folder} onChange={(e) => setFolder(e.target.value)}>
          <option value="">All folders</option>
          <option value={UNFILED}>Not in a folder</option>
          {folders.map((f) => (
            <option key={f.id} value={f.id}>
              {folderPath(folders, f.id)}
            </option>
          ))}
        </select>
        <button onClick={onChanged}>Refresh</button>
      </div>
      <div className="inline">
        <input
          aria-label="New folder name"
          placeholder={folder && folder !== UNFILED ? "New folder inside this one" : "New folder"}
          value={newFolder}
          onChange={(e) => setNewFolder(e.target.value)}
        />
        <button onClick={createFolder} disabled={newFolder.trim() === ""}>
          Create folder
        </button>
        {folder && folder !== UNFILED && <button onClick={deleteFolder}>Delete this folder (if empty)</button>}
        {message && <span className="muted">{message}</span>}
      </div>
      {searching && results === null ? (
        <p>Searching…</p>
      ) : shown.length === 0 ? (
        <p>{searching ? "No matching documents." : "No documents here yet. Enter a new doc id below and save it."}</p>
      ) : (
        <ul className="doc-list" data-testid="doc-list">
          {shown.map((d) => (
            <li key={d.docId} data-testid="doc-entry">
              <button onClick={() => onOpen(d.docId)} aria-current={d.docId === currentDocId}>
                {d.title || d.docId} {d.title && <small>({d.docId})</small>}
              </button>{" "}
              {d.tags.map((t) => (
                <span key={t} className="tag">
                  {t}
                </span>
              ))}
              <span className="muted">
                {d.folderId && ` in ${folderPath(folders, d.folderId)}`}
                {d.owner && ` · owner ${d.owner}`}
                {d.yourRole !== "edit" && ` · ${ROLE_TEXT[d.yourRole]}`}
                {d.matchedIn && d.matchedIn.length > 0 && ` · matched in ${d.matchedIn.join(", ")}`}
              </span>
              {d.snippet && <div className="muted">“{d.snippet}”</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
