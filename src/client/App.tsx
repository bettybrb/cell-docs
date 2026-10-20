import { useEffect, useRef, useState } from "react";
import type { DocCatalogue, HealthResponse } from "../shared/api-types";
import { api, type ApiResult } from "./api";
import { connectDocSession, createDocSession, latestOnly, type ConnectedDocSession } from "./doc-session";
import { MarkdownEditor } from "./MarkdownEditor";
import { PresenceBar } from "./PresenceBar";
import { useTitleAutosave, type TitleSaveState } from "./useTitleAutosave";

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
  // The open document is kept in the URL (?workspace=…&doc=…), so a page
  // reload reopens it; without one, the sample document is opened.
  const [workspaceId, setWorkspaceId] = useState(() => urlParam("workspace") ?? "sample-workspace");
  const [displayName, setDisplayName] = useState("Sample workspace");
  const [docId, setDocId] = useState(() => urlParam("doc") ?? "welcome");
  const [title, setTitle] = useState("Welcome");
  // The body lives in a Y.Text, not in React state: a local draft until a
  // saved document is opened, then that document's live-synced Y.Text.
  const [draft] = useState(() => createDocSession("Hello from a DocCell."));
  const [opened, setOpened] = useState<{ workspaceId: string; docId: string; createdAt: string } | null>(null);
  const [live, setLive] = useState<ConnectedDocSession | null>(null);
  // False until the first load has answered, so the draft is not shown in
  // place of a saved document that is still loading.
  const [ready, setReady] = useState(false);
  const text = opened ? live?.text : ready ? draft.text : undefined;
  const [output, setOutput] = useState<unknown>(null);
  const [docs, setDocs] = useState<DocCatalogue["docs"] | "error">([]);

  const loads = useRef(latestOnly());
  // The document list shows titles, so refresh it after each title save.
  const titleAutosave = useTitleAutosave(opened, () => void refreshDocs());

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
    const session = connectDocSession(syncServerUrl(opened.workspaceId), opened.docId, {
      // createdAt keeps a recreated document from picking up an old local copy.
      localKey: `${opened.workspaceId}/${opened.docId}@${opened.createdAt}`,
    });
    let current = true;
    void session.synced.then(() => current && setLive(session));
    return () => {
      current = false;
      setLive(null);
      session.destroy();
    };
  }, [opened]);

  // Open the document from the URL (or the default) when the page loads.
  // If it does not exist yet, the local draft is shown instead.
  useEffect(() => {
    void loadDoc(docId, { quiet: true });
  }, []);

  // Keep the URL pointing at the open document.
  useEffect(() => {
    if (!opened) return;
    const query = new URLSearchParams({ workspace: opened.workspaceId, doc: opened.docId });
    history.replaceState(null, "", `?${query}`);
  }, [opened]);

  // Ask before leaving the page while edits are not confirmed as saved.
  useEffect(() => {
    if (!live) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (live.unsavedChanges() === 0 && !titleAutosave.unsaved()) return;
      event.preventDefault();
      // Older browsers only show the prompt when returnValue is set.
      event.returnValue = "";
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [live]);

  // Reload the catalogue whenever the workspace id changes.
  useEffect(() => {
    void refreshDocs();
  }, [workspaceId]);

  /** `quiet`: don't show a "not found" error (used for the automatic load on page open). */
  const loadDoc = async (id: string, { quiet = false } = {}) => {
    // If another load starts before this one answers, drop this one, so a
    // slow response cannot put one document's content under another's id.
    const isLatest = loads.current.start();
    const r = await api.getDoc(workspaceId, id);
    if (!isLatest()) return;
    if (r.ok || !quiet) display(r);
    setReady(true);
    if (r.ok) {
      // Id, title and body switch together; the body comes from the sync.
      setDocId(id);
      setTitle(r.data.title);
      setOpened({ workspaceId, docId: id, createdAt: r.data.createdAt });
    }
    await refreshDocs(); // reading can register a Phase 1 document
  };

  const saveDoc = async () => {
    if (!text) return;
    const r = await show(api.putDoc(workspaceId, docId, { title, body: text.toString() }));
    // Saved under a different id than the open one (or the first save of the
    // draft): open the saved document so it syncs from now on.
    if (r.ok && (opened?.workspaceId !== workspaceId || opened.docId !== docId)) {
      setOpened({ workspaceId, docId, createdAt: r.data.createdAt });
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
                    {d.title || d.docId} {d.title && <small>({d.docId})</small>}
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
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              titleAutosave.changed(e.target.value);
            }}
          />
          {opened && <TitleStatus state={titleAutosave.state} />}
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

function TitleStatus({ state }: { state: TitleSaveState }) {
  const text = {
    saved: "Saved",
    saving: "Saving…",
    retrying: "Not saved, retrying…",
    rejected: state.kind === "rejected" ? `Not saved: ${state.message}` : "",
  }[state.kind];
  return (
    <small className="field-status" data-testid="title-status" data-state={state.kind}>
      {text}
    </small>
  );
}

function urlParam(name: string): string | null {
  return new URLSearchParams(location.search).get(name);
}

/** WebSocket base URL for a workspace's documents, on the same host as the page. */
function syncServerUrl(workspaceId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/workspaces/${encodeURIComponent(workspaceId)}/docs`;
}
