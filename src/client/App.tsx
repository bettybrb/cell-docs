import { useEffect, useRef, useState } from "react";
import type { DocCatalogue, HealthResponse } from "../shared/api-types";
import { api, type ApiResult } from "./api";
import { connectDocSession, createDocSession, latestOnly, type ConnectedDocSession } from "./doc-session";
import { MarkdownEditor } from "./MarkdownEditor";
import { PresenceBar } from "./PresenceBar";

export function App() {
  return (
    <main>
      <h1>cell-docs-lab</h1>
      <p className="lead">
        A stateless Worker routes each request to a <strong>cell</strong>: one Durable Object
        per workspace and one per document, each with its own private SQLite database.
      </p>
      <BackendStatus />
      <CellExplorer />
    </main>
  );
}

function BackendStatus() {
  const [result, setResult] = useState<ApiResult<HealthResponse> | "loading" | "unreachable">("loading");

  useEffect(() => {
    api.health().then(setResult, () => setResult("unreachable"));
  }, []);

  let text = "Checking…";
  if (result === "unreachable") text = "Backend unreachable";
  else if (result !== "loading") text = result.ok ? `Backend OK (${result.data.time})` : `Error ${result.status}`;

  return (
    <section>
      <h2>1. Backend</h2>
      <p data-testid="backend-status">{text}</p>
    </section>
  );
}

/**
 * Manual read/write against any workspace or document cell. The response shows
 * which cell answered (name and id), so you can see routing and isolation.
 */
function CellExplorer() {
  const [workspaceId, setWorkspaceId] = useState("sample-workspace");
  const [displayName, setDisplayName] = useState("Sample workspace");
  const [docId, setDocId] = useState("welcome");
  const [title, setTitle] = useState("Welcome");
  // The body lives in a Y.Text, not in React state: a local draft until a
  // saved document is opened, then that document's live-synced Y.Text.
  const [draft] = useState(() => createDocSession("Hello from a DocCell."));
  const [opened, setOpened] = useState<{ workspaceId: string; docId: string } | null>(null);
  const [live, setLive] = useState<ConnectedDocSession | null>(null);
  const text = opened ? live?.text : draft.text;
  const [output, setOutput] = useState<unknown>(null);
  const [docs, setDocs] = useState<DocCatalogue["docs"] | "error">([]);

  const loads = useRef(latestOnly());

  const display = (r: ApiResult<unknown>) =>
    setOutput(r.ok ? { status: r.status, ...(r.data as object) } : { status: r.status, error: r.error });

  const show = async <T,>(p: Promise<ApiResult<T>>) => {
    const r = await p;
    display(r);
    return r;
  };

  const refreshDocs = async () => {
    const r = await api.listDocs(workspaceId);
    setDocs(r.ok ? r.data.docs : "error");
  };

  // Connect to the opened document's DocCell. The editor appears once the
  // first sync is done, so it starts with the server's content. Opening
  // another document closes this connection first.
  useEffect(() => {
    if (!opened) return;
    const session = connectDocSession(syncServerUrl(opened.workspaceId), opened.docId);
    let current = true;
    void session.synced.then(() => current && setLive(session));
    return () => {
      current = false;
      setLive(null);
      session.destroy();
    };
  }, [opened]);

  // Reload the catalogue whenever the workspace id changes.
  useEffect(() => {
    void refreshDocs();
  }, [workspaceId]);

  const loadDoc = async (id: string) => {
    // If another load starts before this one answers, drop this one, so a
    // slow response cannot put one document's content under another's id.
    const isLatest = loads.current.start();
    const r = await api.getDoc(workspaceId, id);
    if (!isLatest()) return;
    display(r);
    if (r.ok) {
      // Id, title and body switch together; the body comes from the sync.
      setDocId(id);
      setTitle(r.data.title);
      setOpened({ workspaceId, docId: id });
    }
    await refreshDocs(); // reading can register a Phase 1 document
  };

  const saveDoc = async () => {
    if (!text) return;
    const r = await show(api.putDoc(workspaceId, docId, { title, body: text.toString() }));
    // Saved under a different id than the open one (or the first save of the
    // draft): open the saved document so it syncs from now on.
    if (r.ok && (opened?.workspaceId !== workspaceId || opened.docId !== docId)) {
      setOpened({ workspaceId, docId });
    }
    await refreshDocs();
  };

  return (
    <section>
      <h2>2. Cell explorer</h2>
      <p>Ids: lowercase letters, digits and dashes. Reload the page or restart the server — the data stays.</p>
      <div className="grid">
        <label>
          Workspace id
          <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} />
        </label>
        <label>
          Display name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <div className="buttons">
          <button onClick={() => show(api.getWorkspace(workspaceId))}>Load workspace</button>
          <button onClick={() => show(api.putWorkspace(workspaceId, { displayName }))}>Save workspace</button>
        </div>
        <div className="wide">
          Documents in this workspace{" "}
          <button onClick={refreshDocs}>Refresh</button>
          {docs === "error" ? (
            <p>Could not load the document list.</p>
          ) : docs.length === 0 ? (
            <p>No documents yet. Enter a new doc id below and save it.</p>
          ) : (
            <ul data-testid="doc-list">
              {docs.map((d) => (
                <li key={d.docId}>
                  <button onClick={() => loadDoc(d.docId)} aria-current={d.docId === docId}>
                    {d.docId}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <label>
          Doc id
          <input value={docId} onChange={(e) => setDocId(e.target.value)} />
        </label>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="wide">
          Body (Markdown)
          {live && <PresenceBar session={live} />}
          {text ? <MarkdownEditor text={text} awareness={live?.awareness ?? null} /> : <p>Connecting…</p>}
        </div>
        <div className="buttons">
          <button onClick={() => loadDoc(docId)}>Load doc</button>
          <button onClick={saveDoc} disabled={!text}>
            Save doc
          </button>
        </div>
      </div>
      {output !== null && <pre data-testid="explorer-output">{JSON.stringify(output, null, 2)}</pre>}
    </section>
  );
}

/** WebSocket base URL for a workspace's documents, on the same host as the page. */
function syncServerUrl(workspaceId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/workspaces/${encodeURIComponent(workspaceId)}/docs`;
}
