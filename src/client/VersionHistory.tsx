import { useEffect, useState } from "react";
import type { DocState, DocVersion, DocVersionDetail } from "../shared/api-types";
import { api } from "./api";

const REASON_TEXT: Record<DocVersion["reason"], string> = {
  save: "Saved",
  auto: "Before editing",
  restore: "Before a restore",
};

/**
 * The open document's stored versions, newest first: when each was taken,
 * by whom, and who edited the document since the previous one. Each can be
 * previewed in full and restored. A restore never deletes anything: it keeps
 * the text it replaces as a version too, so it can be undone.
 */
export function VersionHistory({
  workspaceId,
  docId,
  reloadKey,
  canRestore,
  onRestored,
}: {
  workspaceId: string;
  docId: string;
  /** Change this to reload the list (for example after a save). */
  reloadKey: number;
  canRestore: boolean;
  onRestored: (doc: DocState) => void;
}) {
  const [versions, setVersions] = useState<DocVersion[] | "error">([]);
  const [preview, setPreview] = useState<DocVersionDetail | null>(null);

  const load = async () => {
    const r = await api.listVersions(workspaceId, docId);
    setVersions(r.ok ? r.data.versions : "error");
  };

  useEffect(() => {
    setPreview(null);
    void load();
  }, [workspaceId, docId, reloadKey]);

  const restore = async (version: DocVersion) => {
    const r = await api.restoreVersion(workspaceId, docId, version.id);
    if (r.ok) onRestored(r.data);
    setPreview(null);
    await load();
  };

  const togglePreview = async (version: DocVersion) => {
    if (preview?.id === version.id) return setPreview(null);
    const r = await api.getVersion(workspaceId, docId, version.id);
    if (r.ok) setPreview(r.data);
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
              <button onClick={() => restore(version)} disabled={!canRestore}>
                Restore
              </button>{" "}
              <button onClick={() => togglePreview(version)}>{preview?.id === version.id ? "Hide" : "Preview"}</button>{" "}
              <strong>{REASON_TEXT[version.reason]}</strong> {new Date(version.createdAt).toLocaleString()}
              {version.createdBy && ` by ${version.createdBy}`} · {version.title} ·{" "}
              <span className="preview">{version.preview || "(empty)"}</span>
              {version.length > version.preview.length && "…"}
              {version.editors.length > 0 && (
                <div className="muted" data-testid="version-editors">
                  Edited since the previous version by {version.editors.join(", ")}
                </div>
              )}
              {preview?.id === version.id && (
                <pre data-testid="version-preview">{preview.body || "(empty)"}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
