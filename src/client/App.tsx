import { useEffect, useRef, useState } from "react";
import type { DocCatalogue, DocState, HealthResponse } from "../shared/api-types";
import { allows, type EffectiveRole } from "../shared/permissions";
import { TEST_USERS } from "../shared/users";
import { api, type ApiResult } from "./api";
import { currentCollaborator, currentUser } from "./current-user";
import { DocumentBrowser } from "./DocumentBrowser";
import type { Highlight, HighlightPosition } from "./comment-highlights";
import { CommentThreads } from "./CommentThreads";
import { OrganisePanel, PermissionsPanel } from "./DocumentPanels";
import { connectDocSession, createDocSession, latestOnly, type ClosedReason, type ConnectedDocSession } from "./doc-session";
import { MarkdownEditor } from "./MarkdownEditor";
import { PresenceBar } from "./PresenceBar";
import { Proposals } from "./Proposals";
import { SheetPanel } from "./SheetPanel";
import { RecycleBin } from "./RecycleBin";
import { useTitleAutosave, type TitleSaveState } from "./useTitleAutosave";
import { VersionHistory } from "./VersionHistory";

export function App() {
  return (
    <main>
      <h1>cell-docs-lab</h1>
      <p className="lead">
        A stateless Worker routes each request to a <strong>cell</strong>: one Durable Object
        per workspace and one per document, each with its own private SQLite database.
      </p>
      <UserSwitcher />
      <BackendStatus />
      <CellExplorer />
      <SheetPanel workspaceId={urlParam("workspace") ?? "sample-workspace"} />
    </main>
  );
}

/**
 * Picks the test user this tab acts as. The choice is kept in the URL, so
 * each tab can be a different user. Switching reloads the page so every
 * connection starts again as the new user.
 */
function UserSwitcher() {
  const switchTo = (user: string) => {
    const url = new URL(location.href);
    url.searchParams.set("user", user);
    location.assign(url);
  };
  return (
    <p className="inline" data-testid="user-switcher">
      <label className="inline">
        Acting as test user
        <select aria-label="Test user" value={currentUser()} onChange={(e) => switchTo(e.target.value)}>
          {TEST_USERS.map((user) => (
            <option key={user} value={user}>
              {user}
            </option>
          ))}
        </select>
      </label>
      <span className="muted">No real login: open another tab with a different user to test permissions.</span>
    </p>
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
  // The open document as the server last described it (permissions, role, Recycle Bin state).
  const [doc, setDoc] = useState<DocState | null>(null);
  // Live role and close reason, from the open connection.
  const [liveRole, setLiveRole] = useState<EffectiveRole | null>(null);
  const [closed, setClosed] = useState<ClosedReason | null>(null);
  // False until the first load has answered, so the draft is not shown in
  // place of a saved document that is still loading.
  const [ready, setReady] = useState(false);
  const text = opened ? live?.text : ready ? draft.text : undefined;
  const [output, setOutput] = useState<unknown>(null);
  const [catalogue, setCatalogue] = useState<DocCatalogue | "error" | null>(null);
  // Bumped to make the version list and Recycle Bin reload.
  const [versionsKey, setVersionsKey] = useState(0);
  const [trashKey, setTrashKey] = useState(0);
  // Comment threads and the editor: the current selection, the highlighted
  // ranges and where the editor shows them, the thread the user picked, and a
  // range to scroll to.
  const [selection, setSelection] = useState({ from: 0, to: 0 });
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [highlightPositions, setHighlightPositions] = useState<HighlightPosition[]>([]);
  const [activeThread, setActiveThread] = useState<number | null>(null);
  const [reveal, setReveal] = useState<{ from: number; to: number } | null>(null);

  // What the current user may do with the open document. The server checks
  // every request and message anyway; this only adapts the page.
  const role = opened ? (liveRole ?? doc?.yourRole ?? null) : "owner"; // a draft is yours
  const canEdit = role !== null && allows(role, "edit") && !closed;
  const canComment = role !== null && allows(role, "comment") && !closed;

  const loads = useRef(latestOnly());
  // The document list shows titles, so refresh it after each title save.
  const titleAutosave = useTitleAutosave(opened, () => void refreshCatalogue());

  const display = (r: ApiResult<unknown>) =>
    setOutput(r.ok ? { status: r.status, ...(r.data as object) } : { status: r.status, error: r.error });

  const show = async <T,>(p: Promise<ApiResult<T>>) => {
    const r = await p;
    display(r);
    return r;
  };

  const refreshCatalogue = async () => {
    const r = await api.listDocs(workspaceId);
    setCatalogue(r.ok ? r.data : "error");
  };

  // Connect to the opened document's DocCell. The editor appears once the
  // first sync is done, so it starts with the server's content. Opening
  // another document closes this connection first.
  useEffect(() => {
    if (!opened) return;
    const session = connectDocSession(syncServerUrl(opened.workspaceId), opened.docId, {
      user: currentCollaborator(),
      testUser: currentUser(),
      // createdAt keeps a recreated document from picking up an old local copy.
      localKey: `${opened.workspaceId}/${opened.docId}@${opened.createdAt}`,
    });
    let current = true;
    void session.synced.then(() => current && setLive(session));
    const stop = session.subscribe(() => {
      setLiveRole(session.role());
      setClosed(session.closedReason());
    });
    return () => {
      current = false;
      stop();
      setLive(null);
      setLiveRole(null);
      setClosed(null);
      session.destroy();
    };
  }, [opened]);

  // Someone else deleted the open document: show it in the lists at once.
  useEffect(() => {
    if (closed === "document_deleted") {
      void refreshCatalogue();
      setTrashKey((key) => key + 1);
    }
  }, [closed]);

  // Open the document from the URL (or the default) when the page loads.
  // If it does not exist yet, the local draft is shown instead.
  useEffect(() => {
    void loadDoc(docId, { quiet: true });
  }, []);

  // Keep the URL pointing at the open document (and the current user).
  useEffect(() => {
    if (!opened) return;
    const query = new URLSearchParams({ workspace: opened.workspaceId, doc: opened.docId, user: currentUser() });
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

  // Reload the catalogue and the Recycle Bin whenever the workspace id changes.
  useEffect(() => {
    void refreshCatalogue();
    setTrashKey((key) => key + 1);
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
      setDoc(r.data);
      setOpened({ workspaceId, docId: id, createdAt: r.data.createdAt });
    }
    await refreshCatalogue(); // reading can register a Phase 1 document
  };

  const saveDoc = async () => {
    if (!text) return;
    const r = await show(api.putDoc(workspaceId, docId, { title, body: text.toString() }));
    if (r.ok) setDoc(r.data);
    // Saved under a different id than the open one (or the first save of the
    // draft): open the saved document so it syncs from now on.
    if (r.ok && (opened?.workspaceId !== workspaceId || opened.docId !== docId)) {
      setOpened({ workspaceId, docId, createdAt: r.data.createdAt });
    }
    setVersionsKey((key) => key + 1);
    await refreshCatalogue();
  };

  const closeDoc = () => {
    setOpened(null);
    setDoc(null);
  };

  const editor = text ? (
    <MarkdownEditor
      text={text}
      awareness={live?.awareness ?? null}
      readOnly={!canEdit}
      highlights={opened ? highlights : []}
      onSelection={(from, to) => setSelection({ from, to })}
      onHighlightClick={setActiveThread}
      onHighlightLayout={setHighlightPositions}
      reveal={reveal}
    />
  ) : (
    <p>Connecting…</p>
  );

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
          <strong>Documents in this workspace</strong> <span className="muted">(only those you may read)</span>
        </div>
        <DocumentBrowser
          workspaceId={workspaceId}
          catalogue={catalogue}
          currentDocId={docId}
          onOpen={(id) => void loadDoc(id)}
          onChanged={() => void refreshCatalogue()}
        />
        <label>
          Doc id
          <input value={docId} onChange={(e) => setDocId(e.target.value)} />
        </label>
        <label>
          Title
          <input
            value={title}
            readOnly={!canEdit}
            onChange={(e) => {
              setTitle(e.target.value);
              titleAutosave.changed(e.target.value);
            }}
          />
          {opened && canEdit && <TitleStatus state={titleAutosave.state} />}
        </label>
        <div className="wide">
          Body (Markdown)
          {live && <PresenceBar session={live} />}
          {opened && doc ? (
            <CommentThreads
              doc={doc}
              session={live}
              selection={selection}
              canComment={canComment}
              activeId={activeThread}
              positions={highlightPositions}
              onHighlights={setHighlights}
              onReveal={(thread, range) => {
                setActiveThread(thread?.id ?? null);
                setReveal(range ? { ...range } : null);
              }}
            >
              {editor}
            </CommentThreads>
          ) : (
            editor
          )}
        </div>
        <div className="buttons">
          <button onClick={() => loadDoc(docId)}>Load doc</button>
          <button onClick={saveDoc} disabled={!text || !canEdit}>
            Save doc
          </button>
        </div>
        {opened && doc && (
          <>
            <OrganisePanel
              doc={doc}
              catalogue={catalogue}
              canEdit={canEdit}
              onChanged={() => void refreshCatalogue()}
              onDeleted={() => {
                closeDoc();
                setOutput({ status: 200, message: `${doc.docId} was moved to the Recycle Bin.` });
                void refreshCatalogue();
                setTrashKey((key) => key + 1);
              }}
            />
            <PermissionsPanel
              doc={doc}
              onChanged={(updated) => {
                setDoc(updated);
                display({ ok: true, status: 200, data: updated });
                void refreshCatalogue();
              }}
            />
            <Proposals
              doc={doc}
              session={live}
              role={closed ? null : role}
              onApplied={(applied) => {
                // The text arrives through live sync; the version list gains "Before an agent proposal".
                setDoc(applied);
                display({ ok: true, status: 200, data: applied });
                setVersionsKey((key) => key + 1);
                void refreshCatalogue();
              }}
            />
            <VersionHistory
              workspaceId={opened.workspaceId}
              docId={opened.docId}
              reloadKey={versionsKey}
              canRestore={canEdit}
              onRestored={(restored) => {
                // The body arrives through live sync; the title is set here.
                setTitle(restored.title);
                setDoc(restored);
                display({ ok: true, status: 200, data: restored });
                void refreshCatalogue();
              }}
            />
          </>
        )}
        <RecycleBin
          workspaceId={workspaceId}
          reloadKey={trashKey}
          onRestored={(id) => {
            void loadDoc(id);
          }}
          onChanged={() => void refreshCatalogue()}
        />
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
