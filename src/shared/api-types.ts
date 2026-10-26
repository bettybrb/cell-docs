import { Schema } from "effect";
import { ROLES, type DocPermissions, type EffectiveRole } from "./permissions";

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
  /** Markdown text. */
  body: string;
  /** Increments on every successful write. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  permissions: DocPermissions;
  /** The role of the user who made this request. */
  yourRole: EffectiveRole;
  /** Set while the document is in the Recycle Bin. */
  deletedAt: string | null;
  deletedBy: string | null;
  /** When a document in the Recycle Bin is deleted for good. */
  purgeAt: string | null;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

/** A document as the workspace catalogue knows it (copies refreshed from its DocCell). */
export interface CatalogueEntry {
  docId: string;
  createdAt: string;
  updatedAt: string | null;
  /** null until the doc is next read or saved (entries older than title copies). */
  title: string | null;
  owner: string | null;
  yourRole: EffectiveRole;
  folderId: string | null;
  tags: string[];
}

/** The documents the requesting user may read, oldest first, with folders and tags. */
export interface DocCatalogue {
  cell: CellInfo;
  workspaceId: string;
  docs: CatalogueEntry[];
  folders: Folder[];
  /** Every tag in use, for reuse, with how many readable documents carry it. */
  tags: { name: string; count: number }[];
}

export interface TrashEntry extends CatalogueEntry {
  deletedAt: string;
  deletedBy: string | null;
  purgeAt: string | null;
}

export interface TrashList {
  cell: CellInfo;
  docs: TrashEntry[]; // most recently deleted first
}

export interface SearchResult extends CatalogueEntry {
  /** Where the query matched. */
  matchedIn: ("title" | "content" | "tags")[];
  /** Text around the first content match, if any. */
  snippet: string | null;
}

export interface SearchResults {
  cell: CellInfo;
  query: string;
  results: SearchResult[];
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
  /** Who caused this version: the saver, the editor who started a new burst of edits, or the restorer. */
  createdBy: string | null;
  /** Who changed the document between the previous version and this one. */
  editors: string[];
  title: string;
  /** The first characters of the body. */
  preview: string;
  length: number;
}

export interface DocVersionDetail extends DocVersion {
  cell: CellInfo;
  body: string;
}

export interface DocComment {
  id: number;
  createdAt: string;
  author: string;
  body: string;
}

export interface CommentList {
  cell: CellInfo;
  comments: DocComment[]; // oldest first
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

export const MAX_COMMENT_LENGTH = 2_000;
export const MAX_FOLDER_NAME_LENGTH = 60;
export const MAX_TAGS = 10;

const RoleSchema = Schema.Literals(ROLES);
const nonBlank = (field: string) =>
  Schema.makeFilter((value: string) => value.trim() !== "", { message: `${field} must not be blank.` });

/** The owner's choice: a default role for everyone, plus roles for specific users. */
export const UpdatePermissionsRequest = Schema.Struct({
  defaultRole: RoleSchema,
  users: Schema.Record(Schema.String, RoleSchema),
});
export type UpdatePermissionsRequest = typeof UpdatePermissionsRequest.Type;

export const AddCommentRequest = Schema.Struct({
  body: Schema.String.check(Schema.isMaxLength(MAX_COMMENT_LENGTH), nonBlank("body")),
});
export type AddCommentRequest = typeof AddCommentRequest.Type;

export const CreateFolderRequest = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(MAX_FOLDER_NAME_LENGTH), nonBlank("name")),
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CreateFolderRequest = typeof CreateFolderRequest.Type;

/** A tag: letters, digits, spaces, "-" or "_", up to 30 characters (stored in lower case). */
export const Tag = Schema.String.check(
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,29}$/u, { message: "Tags use letters, digits, spaces, - or _ (up to 30)." }),
);

/** Catalogue-only metadata: which folder a document is in, and its tags. */
export const UpdateDocMetaRequest = Schema.Struct({
  folderId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Tag).check(Schema.isMaxLength(MAX_TAGS))),
});
export type UpdateDocMetaRequest = typeof UpdateDocMetaRequest.Type;
