import { Schema } from "effect";
import type { ChartConfig } from "./sheet";
import { ROLES, type DocPermissions, type EffectiveRole } from "./permissions";

/**
 * JSON shapes exchanged between the browser and the Worker.
 * Imported by both the React client and the Worker so they cannot drift apart.
 */

export type CellKind = "workspace" | "doc" | "sheet";

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
  /**
   * "save": a manual save. "auto": before live edits, at most every 5 minutes.
   * "restore": before a restore. "proposal": before an agent proposal was applied.
   */
  reason: "save" | "auto" | "restore" | "proposal";
  /** Who caused this version: the saver, the editor who started a new burst of edits, the restorer or the approver. */
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

/** A comment or a reply to one. */
export interface DocComment {
  id: number;
  createdAt: string;
  author: string;
  body: string;
}

/**
 * Where a comment thread is attached: two Yjs relative positions (base64 of
 * Y.encodeRelativePosition) in the document's Y.Text. They point at Yjs's own
 * identities for the characters, so the range follows its text while others
 * insert and delete around it.
 */
export interface CommentAnchor {
  start: string;
  end: string;
}

export interface CommentThread extends DocComment {
  /** null: a comment on the whole document. */
  anchor: CommentAnchor | null;
  /** The highlighted text when the thread was started (shown if that text is later deleted). */
  quote: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  replies: DocComment[]; // oldest first
}

export interface CommentList {
  cell: CellInfo;
  threads: CommentThread[]; // oldest first
}

/** One change in a proposal: replace `original` with `replacement`, at a range given by relative positions. */
export interface ProposalChange {
  start: string;
  end: string;
  original: string;
  replacement: string;
  /** A little of the surrounding text at proposal time, for the preview. */
  before: string;
  after: string;
  /** Whether the original text is still there, unchanged, right now. */
  applicable: boolean;
}

export interface Proposal {
  id: number;
  createdAt: string;
  requestedBy: string;
  agent: "simulated" | "ai";
  /** What was asked, in words. */
  instruction: string;
  /** Short description of what the agent changed. */
  summary: string;
  status: "pending" | "applied" | "discarded";
  decidedBy: string | null;
  decidedAt: string | null;
  changes: ProposalChange[];
}

export interface ProposalList {
  cell: CellInfo;
  proposals: Proposal[]; // newest first
}

export interface SheetState {
  cell: CellInfo;
  workspaceId: string;
  sheetId: string;
  title: string;
  owner: string | null;
  yourRole: EffectiveRole;
  revision: number;
  /** Raw cell contents by reference ("A1"); formulas start with "=". */
  cells: Record<string, string>;
  charts: ChartConfig[];
}

export interface SheetEntry {
  sheetId: string;
  title: string;
  owner: string | null;
  updatedAt: string;
}

export interface SheetList {
  sheets: SheetEntry[];
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

const CommentBody = Schema.String.check(Schema.isMaxLength(MAX_COMMENT_LENGTH), nonBlank("body"));

/** A new thread, on the whole document or (with `anchor`) on a range of text. */
export const AddCommentRequest = Schema.Struct({
  body: CommentBody,
  anchor: Schema.optionalKey(Schema.Struct({ start: Schema.String, end: Schema.String })),
});
export type AddCommentRequest = typeof AddCommentRequest.Type;

export const ReplyRequest = Schema.Struct({ body: CommentBody });
export type ReplyRequest = typeof ReplyRequest.Type;

export const ResolveRequest = Schema.Struct({ resolved: Schema.Boolean });
export type ResolveRequest = typeof ResolveRequest.Type;

/** What to ask the simulated agent for. */
export const ProposalRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("tidy") }),
  Schema.Struct({ action: Schema.Literal("summary") }),
  /** A real model: natural-language editing, or summarising. */
  Schema.Struct({
    action: Schema.Literal("ai"),
    mode: Schema.Literals(["edit", "summarise"]),
    instruction: Schema.String.check(Schema.isMaxLength(1_000)),
  }),
  Schema.Struct({
    action: Schema.Literal("replace"),
    find: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    replace: Schema.String.check(Schema.isMaxLength(200)),
  }),
]);
export type ProposalRequest = typeof ProposalRequest.Type;

export const MAX_SHEET_EDITS = 500;
export const SheetEditsRequest = Schema.Struct({
  edits: Schema.Array(Schema.Struct({ ref: Schema.String, raw: Schema.String })).check(Schema.isMaxLength(MAX_SHEET_EDITS)),
});
export type SheetEditsRequest = typeof SheetEditsRequest.Type;

export const UpdateSheetRequest = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(120), nonBlank("title")),
  /** Starting cells, honoured only when the sheet is created. */
  cells: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  charts: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});
export type UpdateSheetRequest = typeof UpdateSheetRequest.Type;

/** A chart config as sent by a client (validated by chartProblem); the server assigns the id. */
export const AddChartRequest = Schema.Struct({
  title: Schema.String,
  type: Schema.String,
  orientation: Schema.optionalKey(Schema.String),
  labels: Schema.String,
  series: Schema.Array(Schema.Struct({ name: Schema.String, range: Schema.String })),
});
export type AddChartRequest = typeof AddChartRequest.Type;

export const AiChartRequest = Schema.Struct({
  instruction: Schema.String.check(Schema.isMaxLength(500), nonBlank("instruction")),
  /** Id of an existing chart to modify instead of designing a new one. */
  chartId: Schema.optionalKey(Schema.String),
});

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
