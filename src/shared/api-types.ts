import { Schema } from "effect";

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

/** The documents registered in a workspace's catalogue, oldest first. */
export interface DocCatalogue {
  cell: CellInfo;
  workspaceId: string;
  /** `title` is a copy, refreshed whenever the doc is read or saved; null if not known yet. */
  docs: { docId: string; createdAt: string; title: string | null }[];
}

/*
 * Request bodies are Effect schemas: one definition gives the TypeScript type
 * (used by the client) and the validation (used by the cells). The client
 * imports only the types, so Effect is not part of the browser bundle.
 */

export const MAX_DISPLAY_NAME_LENGTH = 100;
export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 100_000;

export const UpdateWorkspaceRequest = Schema.Struct({
  displayName: Schema.String.check(
    Schema.isMaxLength(MAX_DISPLAY_NAME_LENGTH),
    Schema.makeFilter((name: string) => name.trim() !== "", { message: "displayName must not be blank." }),
  ),
});
export type UpdateWorkspaceRequest = typeof UpdateWorkspaceRequest.Type;

/** Either field may be left out, but not both. */
export const UpdateDocRequest = Schema.Struct({
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_TITLE_LENGTH))),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_BODY_LENGTH))),
}).check(
  Schema.makeFilter((update) => update.title !== undefined || update.body !== undefined, {
    message: "Provide at least one of: title, body.",
  }),
);
export type UpdateDocRequest = typeof UpdateDocRequest.Type;

/** A stored copy of a document; `reason` says why it was taken. */
export interface DocVersion {
  id: number;
  createdAt: string;
  /** "save": a manual save. "auto": before live edits, at most every 5 minutes. "restore": before a restore. */
  reason: "save" | "auto" | "restore";
  title: string;
  /** The first characters of the body. */
  preview: string;
  length: number;
}

export interface DocVersionList {
  cell: CellInfo;
  versions: DocVersion[]; // newest first
}

export interface HealthResponse {
  ok: true;
  service: "cell-docs-lab";
  time: string;
}

export interface ApiError {
  error: { code: string; message: string };
}
