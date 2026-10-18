import { useEffect, useRef, useState } from "react";
import type { DocCatalogue, HealthResponse } from "../shared/api-types";
import { api, type ApiResult } from "./api";
import { createDocSession, latestOnly } from "./doc-session";
import { MarkdownEditor } from "./MarkdownEditor";

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
  // The open document's body lives in a Y.Text, not in React state.
  const [session, setSession] = useState(() => createDocSession("Hello from a DocCell."));
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
      // Id, title and body switch together, onto a fresh Y.Doc.
      setDocId(id);
      setTitle(r.data.title);
      setSession(createDocSession(r.data.body));
    }
    await refreshDocs(); // reading can register a Phase 1 document
  };

  const saveDoc = async () => {
    await show(api.putDoc(workspaceId, docId, { title, body: session.text.toString() }));
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
          <MarkdownEditor text={session.text} />
        </div>
        <div className="buttons">
          <button onClick={() => loadDoc(docId)}>Load doc</button>
          <button onClick={saveDoc}>Save doc</button>
        </div>
      </div>
      {output !== null && <pre data-testid="explorer-output">{JSON.stringify(output, null, 2)}</pre>}
    </section>
  );
}
