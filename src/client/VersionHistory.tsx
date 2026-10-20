import { useEffect, useState } from "react";
import type { DocState, DocVersion } from "../shared/api-types";
import { api } from "./api";

const REASON_TEXT: Record<DocVersion["reason"], string> = {
  save: "Saved",
  auto: "Before editing",
  restore: "Before a restore",
};

/**
 * The open document's stored versions, newest first, each with Restore.
 * A restore keeps the text it replaces as a version too, so it can be undone.
 */
export function VersionHistory({
  workspaceId,
  docId,
  reloadKey,
  onRestored,
}: {
  workspaceId: string;
  docId: string;
  /** Change this to reload the list (for example after a save). */
  reloadKey: number;
  onRestored: (doc: DocState) => void;
}) {
  const [versions, setVersions] = useState<DocVersion[] | "error">([]);

  const load = async () => {
    const r = await api.listVersions(workspaceId, docId);
    setVersions(r.ok ? r.data.versions : "error");
  };

  useEffect(() => {
    void load();
  }, [workspaceId, docId, reloadKey]);

  const restore = async (version: DocVersion) => {
    const r = await api.restoreVersion(workspaceId, docId, version.id);
    if (r.ok) onRestored(r.data);
    await load();
  };

  return (
    <details className="wide versions" data-testid="versions">
      <summary>Versions</summary>
      <button onClick={load}>Refresh</button>
      {versions === "error" ? (
        <p>Could not load the versions.</p>
      ) : versions.length === 0 ? (
        <p>No versions yet. One is kept on every Save, and before editing at most every 5 minutes.</p>
      ) : (
        <ul>
          {versions.map((version) => (
            <li key={version.id} data-testid="version">
              <button onClick={() => restore(version)}>Restore</button>{" "}
              <strong>{REASON_TEXT[version.reason]}</strong> {new Date(version.createdAt).toLocaleString()} ·{" "}
              {version.title} · <span className="preview">{version.preview || "(empty)"}</span>
              {version.length > version.preview.length && "…"}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
