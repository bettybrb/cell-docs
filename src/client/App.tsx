import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/api-types";
import { api, type ApiResult } from "./api";

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
  const [body, setBody] = useState("Hello from a DocCell.");
  const [output, setOutput] = useState<unknown>(null);

  const show = async (p: Promise<ApiResult<unknown>>) => {
    const r = await p;
    setOutput(r.ok ? { status: r.status, ...(r.data as object) } : { status: r.status, error: r.error });
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
        <label>
          Doc id
          <input value={docId} onChange={(e) => setDocId(e.target.value)} />
        </label>
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="wide">
          Body
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="buttons">
          <button onClick={() => show(api.getDoc(workspaceId, docId))}>Load doc</button>
          <button onClick={() => show(api.putDoc(workspaceId, docId, { title, body }))}>Save doc</button>
        </div>
      </div>
      {output !== null && <pre data-testid="explorer-output">{JSON.stringify(output, null, 2)}</pre>}
    </section>
  );
}
