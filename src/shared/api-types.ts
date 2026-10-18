/**
 * JSON shapes exchanged between the browser and the Worker.
 * Imported by both the React client and the Worker so they cannot drift apart.
 */

export type CellKind = "workspace" | "doc";

/** Identifies the exact cell (Durable Object instance) that produced a response. */
export interface CellInfo {
  kind: CellKind;
  /** Deterministic name the router derived from the URL, e.g. "doc:acme/intro". */
  name: string;
  /** Durable Object id: the same name always yields the same id. */
  id: string;
  /** Size of this cell's private SQLite database, in bytes. */
  sqliteBytes: number;
}

export interface WorkspaceState {
  cell: CellInfo;
  workspaceId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocState {
  cell: CellInfo;
  workspaceId: string;
  docId: string;
  title: string;
  /** Plain text for now; becomes collaborative Markdown in a later phase. */
  body: string;
  /** Increments on every successful write. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateWorkspaceRequest {
  displayName: string;
}

export interface UpdateDocRequest {
  title?: string;
  body?: string;
}

export interface HealthResponse {
  ok: true;
  service: "cell-docs-lab";
  time: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
