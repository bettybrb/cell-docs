import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import {
  AddCommentRequest,
  UpdateDocRequest,
  UpdatePermissionsRequest,
  type CommentList,
  type DocComment,
  type DocState,
  type DocVersion,
  type DocVersionDetail,
  type DocVersionList,
} from "../../shared/api-types";
import {
  CLOSE_ACCESS_REVOKED,
  CLOSE_DOC_DELETED,
  CLOSE_EDIT_REJECTED,
  roleMessage,
} from "../../shared/doc-messages";
import { allows, canManage, roleOf, type DocPermissions, type Role } from "../../shared/permissions";
import { isSaveCheck } from "../../shared/save-check";
import { DEFAULT_USER, isTestUser } from "../../shared/users";
import { parseCellName, workspaceCellName } from "../addressing";
import { catalogueCopy } from "../catalogue-copy";
import { CELL_NAME_HEADER, errorResponse, json, readBody, requestUser } from "../http";
import {
  addColumnIfMissing,
  cellInfo,
  claimCellName,
  createCellMetaTable,
  getMeta,
  setMeta,
  storedCellName,
} from "./cell-meta";
import {
  addsContent,
  awarenessMessage,
  carriesChanges,
  handleMessage,
  isAwarenessMessage,
  readAwarenessMessage,
  replaceText,
  syncStep1Message,
  updateMessage,
  type PresenceEntry,
} from "./yjs-sync";

/** Above this many stored updates, they are merged into one row. */
export const COMPACT_AFTER_UPDATES = 500;
/** Versions kept per document; older ones are deleted. */
export const MAX_VERSIONS = 50;
/** Live editing takes an automatic version when the newest one is at least this old. */
export const AUTO_VERSION_INTERVAL_MS = 5 * 60 * 1000;
/** How long a document stays in the Recycle Bin (TRASH_RETENTION_MS in wrangler.jsonc overrides it). */
export const DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** After live edits, the catalogue's copy (used by search) is refreshed this much later. */
export const CATALOGUE_REFRESH_DELAY_MS = 2_000;
const PREVIEW_LENGTH = 80;

/** Transaction origin for changes the cell makes itself (saves, repairs, restores). */
const SERVER_ORIGIN = "server";

/**
 * What a socket carries across hibernation (its attachment): the test user
 * it was opened for, and the presence of its client(s), keyed by Yjs client id.
 */
interface SocketState {
  user: string;
  presence: Record<string, { clock: number; state: unknown }>;
}

interface DocRow {
  title: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
  owner: string | null;
  default_role: Role;
  acl: string; // JSON: Record<user, Role>
  deleted_at: string | null;
  deleted_by: string | null;
  purge_at: string | null;
  // SqlStorage row types must be indexable.
  [column: string]: SqlStorageValue;
}

interface VersionRow {
  id: number;
  created_at: string;
  reason: DocVersion["reason"];
  created_by: string | null;
  editors: string;
  title: string;
  body: string;
  [column: string]: SqlStorageValue;
}

/** Who is asking, about which document. */
interface Caller {
  name: string;
  workspaceId: string;
  docId: string;
  user: string;
}

type Need = "read" | "comment" | "edit" | "manage";

/**
 * One DocCell per document. Its private SQLite database holds exactly one
 * document row (enforced by `CHECK (id = 1)`), because the cell *is* the
 * document.
 *
 * The body's source of truth is a Yjs document stored as a log of updates
 * (`yjs_updates`). `doc.body` is a plain-text copy, rewritten on every
 * update, so REST reads stay simple. Browsers connect over WebSockets
 * (`/sync`) and exchange Yjs updates through this cell.
 *
 * The cell is also the authority on the document's permissions, its place in
 * the Recycle Bin, its versions and its comments, and it enforces
 * permissions on every request and every WebSocket message. The workspace
 * catalogue only holds copies (see catalogue-copy.ts).
 */
export class DocCell extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Loaded on first use; rebuilt from SQLite after hibernation or restart. */
  private ydoc: Y.Doc | null = null;
  /** Rows in yjs_updates, kept in step with the table once ydoc is loaded. */
  private storedUpdates = 0;
  /** The user behind changes the cell makes itself (a save or restore), for version history. */
  private actor: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Runs before the first request is delivered. Idempotent, so it is safe
    // every time the cell is (re)started.
    this.createTables();
  }

  private createTables(): void {
    createCellMetaTable(this.sql);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS doc (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      revision   INTEGER NOT NULL,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL
    )`);
    // Added with permissions and the Recycle Bin; older documents get the defaults.
    addColumnIfMissing(this.sql, "doc", "owner", "TEXT");
    addColumnIfMissing(this.sql, "doc", "default_role", "TEXT NOT NULL DEFAULT 'edit'");
    addColumnIfMissing(this.sql, "doc", "acl", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(this.sql, "doc", "deleted_at", "TEXT");
    addColumnIfMissing(this.sql, "doc", "deleted_by", "TEXT");
    addColumnIfMissing(this.sql, "doc", "purge_at", "TEXT");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS yjs_updates (
      seq  INTEGER PRIMARY KEY AUTOINCREMENT,
      data BLOB    NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS doc_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      reason     TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL
    )`);
    addColumnIfMissing(this.sql, "doc_versions", "created_by", "TEXT");
    addColumnIfMissing(this.sql, "doc_versions", "editors", "TEXT NOT NULL DEFAULT '[]'");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      author     TEXT NOT NULL,
      body       TEXT NOT NULL
    )`);
    // Stored updates that could not be read; kept for inspection, never loaded.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS yjs_quarantine (
      seq            INTEGER PRIMARY KEY,
      data           BLOB NOT NULL,
      quarantined_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const name = request.headers.get(CELL_NAME_HEADER);
    const address = parseCellName(name);
    if (!name || address?.kind !== "doc") {
      return errorResponse(400, "bad_cell_name", "DocCell requires a doc cell name.");
    }
    const stored = storedCellName(this.sql);
    if (stored !== null && stored !== name) {
      return errorResponse(409, "cell_name_mismatch", `Cell belongs to ${stored}, not ${name}.`);
    }
    const caller: Caller = { name, workspaceId: address.workspaceId, docId: address.docId, user: requestUser(request) };
    const path = new URL(request.url).pathname;
    const method = request.method;
    const notAllowed = () => errorResponse(405, "method_not_allowed", `${method} is not supported.`);

    if (path === "/sync") return this.openSync(request, caller);
    if (path === "/") {
      if (method === "GET") return this.read(caller);
      if (method === "PUT") return this.write(request, caller);
      if (method === "DELETE") return this.moveToTrash(caller);
      return notAllowed();
    }
    if (path === "/restore") return method === "POST" ? this.restoreFromTrash(caller) : notAllowed();
    if (path === "/purge") return method === "POST" ? this.purgeNow(caller) : notAllowed();
    if (path === "/permissions") return method === "PUT" ? this.setPermissions(request, caller) : notAllowed();
    if (path === "/comments") {
      if (method === "GET") return this.listComments(caller);
      if (method === "POST") return this.addComment(request, caller);
      return notAllowed();
    }
    if (path === "/versions") return method === "GET" ? this.listVersions(caller) : notAllowed();
    const version = /^\/versions\/(\d+)(\/restore)?$/.exec(path);
    if (version) {
      const id = Number(version[1]);
      if (version[2]) return method === "POST" ? this.restoreVersion(id, caller) : notAllowed();
      return method === "GET" ? this.versionDetail(id, caller) : notAllowed();
    }
    return errorResponse(404, "not_found", "Unknown document cell path.");
  }

  // ---------------------------------------------------------------- access

  /**
   * Checks that the document exists, is (or, with `inTrash`, is not) in the
   * Recycle Bin, and that the caller's role allows `need`. Returns the row,
   * or the error Response to send.
   */
  private access(caller: Caller, need: Need, { inTrash = false } = {}): DocRow | Response {
    const row = this.loadRow();
    if (!row) return errorResponse(404, "doc_not_found", `Document ${caller.docId} has not been written yet.`);
    if (row.deleted_at && !inTrash) {
      return errorResponse(410, "doc_deleted", `Document ${caller.docId} is in the Recycle Bin.`);
    }
    if (!row.deleted_at && inTrash) {
      return errorResponse(409, "doc_not_deleted", `Document ${caller.docId} is not in the Recycle Bin.`);
    }
    const permissions = permissionsOf(row);
    const allowed = need === "manage" ? canManage(caller.user, permissions) : allows(roleOf(caller.user, permissions), need);
    if (!allowed) {
      const what = need === "manage" ? "manage permissions of" : need;
      return errorResponse(403, "forbidden", `${caller.user} may not ${what} document ${caller.docId}.`);
    }
    return row;
  }

  // -------------------------------------------------------------- document

  private read(caller: Caller): Response {
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    return json(this.toState(row, caller));
  }

  private async write(request: Request, caller: Caller): Promise<Response> {
    const update = await readBody(request, UpdateDocRequest);
    if (update instanceof Response) return update;

    const now = new Date().toISOString();
    const existing = this.loadRow();
    if (existing) {
      const allowed = this.access(caller, "edit");
      if (allowed instanceof Response) return allowed;
    }
    // A body change on an existing doc goes through Yjs (loaded here, outside
    // the transaction) so connected browsers receive it too.
    const ydoc = existing && update.body !== undefined ? this.loadYDoc() : null;

    // Explicit transaction: the name claim and the document write either
    // both persist or neither does.
    this.actor = caller.user;
    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, caller.name);
      if (existing) {
        this.sql.exec(
          `UPDATE doc SET title = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
          update.title ?? existing.title,
          now,
        );
        // The update handler stores the change and rewrites doc.body.
        if (ydoc) replaceText(ydoc.getText("body"), update.body!, SERVER_ORIGIN);
      } else {
        // The creator owns the document; everyone else may edit until the owner says otherwise.
        this.sql.exec(
          `INSERT INTO doc (id, title, body, revision, created_at, updated_at, owner, default_role, acl)
           VALUES (1, ?, ?, 1, ?, ?, ?, 'edit', '{}')`,
          update.title ?? "Untitled",
          update.body ?? "",
          now,
          now,
          caller.user,
        );
      }
      this.noteEditor(caller.user);
    });
    this.actor = null;

    const saved = this.loadRow()!;
    // A save with a body is a moment worth keeping; title-only autosaves are not.
    if (update.body !== undefined) this.addVersion("save", saved.title, saved.body, caller.user);
    return json(this.toState(saved, caller), existing ? 200 : 201);
  }

  // ------------------------------------------------------------ permissions

  /**
   * Replaces the document's permissions. Connected browsers learn their new
   * role at once; one that lost access is disconnected. Every later message
   * is checked against the new permissions in any case.
   */
  private async setPermissions(request: Request, caller: Caller): Promise<Response> {
    const row = this.access(caller, "manage");
    if (row instanceof Response) return row;
    const body = await readBody(request, UpdatePermissionsRequest);
    if (body instanceof Response) return body;
    const owner = row.owner ?? caller.user; // claiming a document that had no owner
    for (const user of Object.keys(body.users)) {
      if (!isTestUser(user)) return errorResponse(400, "invalid_body", `Unknown user ${user}.`);
      if (user === owner) return errorResponse(400, "invalid_body", `${user} owns the document.`);
    }

    this.sql.exec(
      `UPDATE doc SET owner = ?, default_role = ?, acl = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
      owner,
      body.defaultRole,
      JSON.stringify(body.users),
      new Date().toISOString(),
    );
    const permissions = permissionsOf(this.loadRow()!);
    for (const ws of this.ctx.getWebSockets()) {
      const role = roleOf(socketState(ws).user, permissions);
      if (role === "none") closeSocket(ws, CLOSE_ACCESS_REVOKED, "access_revoked");
      else sendTo(ws, roleMessage(role));
    }
    return json(this.toState(this.loadRow()!, caller));
  }

  // ------------------------------------------------------------ recycle bin

  private retentionMs(): number {
    const configured = Number(this.env.TRASH_RETENTION_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TRASH_RETENTION_MS;
  }

  /** Moves the document to the Recycle Bin. Nothing is erased until it is purged. */
  private moveToTrash(caller: Caller): Response {
    const row = this.access(caller, "edit");
    if (row instanceof Response) return row;
    const now = new Date();
    this.sql.exec(
      `UPDATE doc SET deleted_at = ?, deleted_by = ?, purge_at = ?, updated_at = ? WHERE id = 1`,
      now.toISOString(),
      caller.user,
      new Date(now.getTime() + this.retentionMs()).toISOString(),
      now.toISOString(),
    );
    for (const ws of this.ctx.getWebSockets()) closeSocket(ws, CLOSE_DOC_DELETED, "document_deleted");
    this.scheduleAlarm();
    return json(this.toState(this.loadRow()!, caller));
  }

  /** Takes the document out of the Recycle Bin, with its id, text, versions and comments. */
  private restoreFromTrash(caller: Caller): Response {
    const row = this.access(caller, "edit", { inTrash: true });
    if (row instanceof Response) return row;
    this.sql.exec(
      `UPDATE doc SET deleted_at = NULL, deleted_by = NULL, purge_at = NULL, updated_at = ? WHERE id = 1`,
      new Date().toISOString(),
    );
    this.scheduleAlarm();
    return json(this.toState(this.loadRow()!, caller));
  }

  /** Deletes a document in the Recycle Bin for good, before its time is up (owner only). */
  private async purgeNow(caller: Caller): Promise<Response> {
    const row = this.access(caller, "manage", { inTrash: true });
    if (row instanceof Response) return row;
    try {
      await this.purge();
    } catch (error) {
      return errorResponse(502, "purge_failed", `Could not delete for good: ${String(error)}. Try again.`);
    }
    return json({ purged: true, docId: caller.docId });
  }

  /**
   * Erases the document: first its catalogue entry (so no list points at an
   * empty cell), then all of the cell's storage. Safe to retry: removing a
   * missing entry is fine, and the alarm retries if this throws.
   */
  private async purge(): Promise<void> {
    const address = parseCellName(storedCellName(this.sql));
    if (address?.kind !== "doc") throw new Error("cell has no document name");
    const name = workspaceCellName(address.workspaceId);
    const stub = this.env.WORKSPACE_CELL.get(this.env.WORKSPACE_CELL.idFromName(name));
    const response = await stub.fetch(`https://cell.internal/docs/${address.docId}`, {
      method: "DELETE",
      headers: { [CELL_NAME_HEADER]: name },
    });
    if (!response.ok) throw new Error(`workspace cell answered ${response.status}`);

    for (const ws of this.ctx.getWebSockets()) closeSocket(ws, CLOSE_DOC_DELETED, "document_deleted");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The instance keeps running; give it empty tables so the id can be used again.
    this.ydoc = null;
    this.storedUpdates = 0;
    this.createTables();
  }

  // ------------------------------------------------- alarm: purge and index

  /**
   * One alarm serves two timers: the Recycle Bin deadline and the catalogue
   * refresh after live edits. A failure throws, and the runtime retries.
   */
  async alarm(): Promise<void> {
    const row = this.loadRow();
    if (!row) return;
    // Never early: deleting for good cannot be undone.
    if (row.deleted_at && row.purge_at && Date.parse(row.purge_at) <= Date.now()) {
      await this.purge();
      return;
    }
    // The refresh delay only batches rapid edits, so refreshing early is fine.
    if (getMeta(this.sql, "catalogue_refresh_due")) {
      await this.sendCatalogueCopy(row);
      setMeta(this.sql, "catalogue_refresh_due", null);
    }
    this.scheduleAlarm();
  }

  private scheduleAlarm(): void {
    const row = this.loadRow();
    const times = [getMeta(this.sql, "catalogue_refresh_due"), row?.deleted_at ? row.purge_at : null]
      .filter((time): time is string => time !== null)
      .map((time) => Date.parse(time));
    if (times.length > 0) void this.ctx.storage.setAlarm(Math.min(...times));
    else void this.ctx.storage.deleteAlarm();
  }

  /** Live edits do not pass the router, so the cell refreshes the catalogue's copy itself, a little later. */
  private refreshCatalogueSoon(): void {
    if (getMeta(this.sql, "catalogue_refresh_due")) return;
    setMeta(this.sql, "catalogue_refresh_due", new Date(Date.now() + CATALOGUE_REFRESH_DELAY_MS).toISOString());
    this.scheduleAlarm();
  }

  private async sendCatalogueCopy(row: DocRow): Promise<void> {
    const name = storedCellName(this.sql);
    const address = parseCellName(name);
    if (!name || address?.kind !== "doc") return;
    const workspace = workspaceCellName(address.workspaceId);
    const stub = this.env.WORKSPACE_CELL.get(this.env.WORKSPACE_CELL.idFromName(workspace));
    const caller: Caller = { name, workspaceId: address.workspaceId, docId: address.docId, user: DEFAULT_USER };
    const response = await stub.fetch(`https://cell.internal/docs/${address.docId}`, {
      method: "PUT",
      headers: { [CELL_NAME_HEADER]: workspace, "content-type": "application/json" },
      body: JSON.stringify(catalogueCopy(this.toState(row, caller))),
    });
    if (!response.ok) throw new Error(`workspace cell answered ${response.status}`);
  }

  // --------------------------------------------------------------- comments

  private listComments(caller: Caller): Response {
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    const comments = this.sql
      .exec<{ id: number; created_at: string; author: string; body: string }>(
        `SELECT id, created_at, author, body FROM comments ORDER BY id`,
      )
      .toArray()
      .map((c): DocComment => ({ id: c.id, createdAt: c.created_at, author: c.author, body: c.body }));
    const list: CommentList = { cell: cellInfo("doc", caller.name, this.ctx), comments };
    return json(list);
  }

  private async addComment(request: Request, caller: Caller): Promise<Response> {
    const row = this.access(caller, "comment");
    if (row instanceof Response) return row;
    const body = await readBody(request, AddCommentRequest);
    if (body instanceof Response) return body;
    const createdAt = new Date().toISOString();
    const { id } = this.sql
      .exec<{ id: number }>(
        `INSERT INTO comments (created_at, author, body) VALUES (?, ?, ?) RETURNING id`,
        createdAt,
        caller.user,
        body.body,
      )
      .one();
    const comment: DocComment = { id, createdAt, author: caller.user, body: body.body };
    return json(comment, 201);
  }

  // --------------------------------------------------------------- versions

  private listVersions(caller: Caller): Response {
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    const rows = this.sql.exec<VersionRow>(`SELECT * FROM doc_versions ORDER BY id DESC`).toArray();
    const list: DocVersionList = { cell: cellInfo("doc", caller.name, this.ctx), versions: rows.map(toVersion) };
    return json(list);
  }

  /** One version with its full text, for previewing before a restore. */
  private versionDetail(id: number, caller: Caller): Response {
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    const version = this.sql.exec<VersionRow>(`SELECT * FROM doc_versions WHERE id = ?`, id).toArray()[0];
    if (!version) return errorResponse(404, "version_not_found", `Version ${id} does not exist.`);
    const detail: DocVersionDetail = { ...toVersion(version), cell: cellInfo("doc", caller.name, this.ctx), body: version.body };
    return json(detail);
  }

  /**
   * Makes the document match a stored version: the body as an ordinary Yjs
   * edit (so open browsers update live) and the title. Nothing is deleted:
   * the current text is kept as a "restore" version first, so a restore can
   * itself be undone, and every older version stays.
   */
  private restoreVersion(id: number, caller: Caller): Response {
    const current = this.access(caller, "edit");
    if (current instanceof Response) return current;
    const version = this.sql
      .exec<{ title: string; body: string }>(`SELECT title, body FROM doc_versions WHERE id = ?`, id)
      .toArray()[0];
    if (!version) return errorResponse(404, "version_not_found", `Version ${id} does not exist.`);

    const ydoc = this.loadYDoc();
    this.actor = caller.user;
    this.ctx.storage.transactionSync(() => {
      this.addVersion("restore", current.title, current.body, caller.user);
      this.sql.exec(
        `UPDATE doc SET title = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
        version.title,
        new Date().toISOString(),
      );
      replaceText(ydoc.getText("body"), version.body, SERVER_ORIGIN);
      this.noteEditor(caller.user);
    });
    this.actor = null;
    return json(this.toState(this.loadRow()!, caller));
  }

  /**
   * Stores a version and drops the oldest beyond MAX_VERSIONS. Its editors
   * are everyone who changed the document since the previous version.
   */
  private addVersion(reason: DocVersion["reason"], title: string, body: string, createdBy: string | null): void {
    this.sql.exec(
      `INSERT INTO doc_versions (created_at, reason, title, body, created_by, editors) VALUES (?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(),
      reason,
      title,
      body,
      createdBy,
      JSON.stringify(this.editorsSinceVersion()),
    );
    setMeta(this.sql, "editors_since_version", null);
    this.sql.exec(
      `DELETE FROM doc_versions WHERE id NOT IN (SELECT id FROM doc_versions ORDER BY id DESC LIMIT ?)`,
      MAX_VERSIONS,
    );
  }

  private editorsSinceVersion(): string[] {
    return JSON.parse(getMeta(this.sql, "editors_since_version") ?? "[]") as string[];
  }

  private noteEditor(user: string): void {
    const editors = this.editorsSinceVersion();
    if (!editors.includes(user)) setMeta(this.sql, "editors_since_version", JSON.stringify([...editors, user]));
  }

  /**
   * Before a live edit from a browser: if the newest version is old enough
   * (or there is none), keep the text as it was just before this edit.
   */
  private autoVersion(createdBy: string | null): void {
    const newest = this.sql
      .exec<{ created_at: string }>(`SELECT created_at FROM doc_versions ORDER BY id DESC LIMIT 1`)
      .toArray()[0];
    if (newest && Date.now() - Date.parse(newest.created_at) < AUTO_VERSION_INTERVAL_MS) return;
    const before = this.loadRow();
    if (before) this.addVersion("auto", before.title, before.body, createdBy);
  }

  // ------------------------------------------------------------- live sync

  /** Upgrades the request to a WebSocket that syncs this document. */
  private openSync(request: Request, caller: Caller): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "upgrade_required", "Connect with a WebSocket.");
    }
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    const ydoc = this.loadYDoc();
    const [client, server] = Object.values(new WebSocketPair());
    // Hibernatable: the cell may leave memory while sockets stay open.
    this.ctx.acceptWebSocket(server);
    const state: SocketState = { user: caller.user, presence: {} };
    server.serializeAttachment(state);
    server.send(syncStep1Message(ydoc));
    server.send(roleMessage(roleOf(caller.user, permissionsOf(row))));
    // Tell the newcomer who is already here.
    const present = this.ctx.getWebSockets().flatMap((ws) => presenceEntries(ws));
    if (present.length > 0) server.send(awarenessMessage(present));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") return;
    const data = new Uint8Array(message);
    // Permissions can change while a socket is open, so every message is checked.
    const row = this.loadRow();
    if (!row || row.deleted_at) return closeSocket(ws, CLOSE_DOC_DELETED, "document_deleted");
    const role = roleOf(socketState(ws).user, permissionsOf(row));
    if (role === "none") return closeSocket(ws, CLOSE_ACCESS_REVOKED, "access_revoked");
    try {
      if (isAwarenessMessage(data)) {
        this.relayPresence(ws, data);
        return;
      }
      if (isSaveCheck(data)) {
        // Every earlier message from this socket is already stored, and the
        // runtime holds this reply until those writes are durable.
        ws.send(data);
        return;
      }
      if (!allows(role, "edit") && carriesChanges(data)) {
        // A reader's normal sync messages add nothing. Anything that would
        // add content is refused, and the connection closed so the client
        // does not keep text it believes is saved. (A delete-only change is
        // simply dropped; the client's editor is read-only anyway.)
        if (addsContent(data)) closeSocket(ws, CLOSE_EDIT_REJECTED, "edit_rejected");
        return;
      }
      const reply = handleMessage(data, this.loadYDoc(), ws);
      if (reply) ws.send(reply);
    } catch {
      ws.close(1003, "Malformed Yjs message");
    }
  }

  /** Remembers the sender's presence on its socket and forwards the message to everyone else. */
  private relayPresence(ws: WebSocket, data: Uint8Array): void {
    const state = socketState(ws);
    for (const entry of readAwarenessMessage(data)) {
      if (entry.state === null) delete state.presence[entry.clientId];
      else state.presence[entry.clientId] = { clock: entry.clock, state: entry.state };
    }
    ws.serializeAttachment(state);
    this.broadcast(data, ws);
  }

  /**
   * A socket closed, cleanly or not (tab closed, network lost, crash). Tell
   * the others its clients left: state null at the last clock seen, which
   * the y-protocols awareness module accepts as a removal.
   */
  private announceLeave(ws: WebSocket): void {
    const left = presenceEntries(ws).map((entry) => ({ ...entry, state: null }));
    if (left.length === 0) return;
    ws.serializeAttachment({ ...socketState(ws), presence: {} });
    this.broadcast(awarenessMessage(left), ws);
  }

  private broadcast(message: Uint8Array, except: unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except) sendTo(ws, message);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.announceLeave(ws);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.announceLeave(ws);
    closeSocket(ws, code === 1005 ? 1000 : code); // 1005 ("no code") cannot be sent back
  }

  // ------------------------------------------------------------ Yjs storage

  /**
   * Returns the document's Yjs state, loading it from SQLite if needed.
   *
   * `doc.body` is written together with every update, so it is the latest
   * known text. If the loaded Yjs text differs from it, the Yjs state is
   * brought in line with an ordinary edit. That covers:
   *   - documents written before Yjs existed (no updates yet): their body
   *     becomes the initial Y.Text, once, here on the server;
   *   - a stored update that cannot be read: it is moved to yjs_quarantine;
   *   - a missing update: Yjs cannot apply what depends on it, and the text
   *     comes out wrong without any error.
   */
  private loadYDoc(): Y.Doc {
    if (this.ydoc) return this.ydoc;
    const ydoc = new Y.Doc();
    const rows = this.sql.exec<{ seq: number; data: ArrayBuffer }>(`SELECT seq, data FROM yjs_updates ORDER BY seq`).toArray();
    const unreadable: number[] = [];
    for (const row of rows) {
      try {
        Y.applyUpdate(ydoc, new Uint8Array(row.data));
      } catch {
        unreadable.push(row.seq);
      }
    }
    if (unreadable.length > 0) this.quarantine(unreadable);
    this.storedUpdates = rows.length - unreadable.length;

    ydoc.on("update", (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
    this.ydoc = ydoc;

    const body = this.loadRow()?.body ?? "";
    const text = ydoc.getText("body");
    if (text.toString() !== body) {
      if (rows.length > 0) {
        console.error(
          `DocCell ${storedCellName(this.sql)}: stored Yjs state does not match the saved text ` +
            `(${unreadable.length} unreadable update(s)); repairing from the saved text.`,
        );
      }
      replaceText(text, body, SERVER_ORIGIN); // stored and broadcast by onUpdate
    }

    if (this.storedUpdates > COMPACT_AFTER_UPDATES) this.compact();
    return ydoc;
  }

  /** Moves unreadable update rows out of the log, keeping them for inspection. */
  private quarantine(seqs: number[]): void {
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const seq of seqs) {
        this.sql.exec(
          `INSERT INTO yjs_quarantine (seq, data, quarantined_at) SELECT seq, data, ? FROM yjs_updates WHERE seq = ?`,
          now,
          seq,
        );
        this.sql.exec(`DELETE FROM yjs_updates WHERE seq = ?`, seq);
      }
    });
    console.error(`DocCell ${storedCellName(this.sql)}: quarantined unreadable update(s) ${seqs.join(", ")}.`);
  }

  /** Replaces the update log with one row holding the merged state. */
  private compact(): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM yjs_updates`);
      this.sql.exec(`INSERT INTO yjs_updates (data) VALUES (?)`, Y.encodeStateAsUpdate(this.ydoc!));
    });
    this.storedUpdates = 1;
  }

  /**
   * Runs for every change to the Yjs document, from a browser or a PUT:
   * stores it, refreshes the plain-text copy, and forwards it to every other
   * connected browser. Durable Objects hold outgoing messages until these
   * writes are durable, so nothing is forwarded before it is stored.
   */
  private onUpdate(update: Uint8Array, origin: unknown): void {
    const live = origin !== SERVER_ORIGIN;
    const editor = this.ctx.getWebSockets().includes(origin as WebSocket)
      ? socketState(origin as WebSocket).user
      : this.actor;
    // doc.body still holds the text from before this edit at this point.
    if (live) this.autoVersion(editor);
    this.sql.exec(`INSERT INTO yjs_updates (data) VALUES (?)`, update);
    this.sql.exec(
      `UPDATE doc SET body = ?, updated_at = ? WHERE id = 1`,
      this.ydoc!.getText("body").toString(),
      new Date().toISOString(),
    );
    if (editor) this.noteEditor(editor);
    if (++this.storedUpdates > COMPACT_AFTER_UPDATES) this.compact();
    if (live) this.refreshCatalogueSoon();
    this.broadcast(updateMessage(update), origin);
  }

  private loadRow(): DocRow | undefined {
    return this.sql
      .exec<DocRow>(
        `SELECT title, body, revision, created_at, updated_at, owner, default_role, acl, deleted_at, deleted_by, purge_at
         FROM doc WHERE id = 1`,
      )
      .toArray()[0];
  }

  private toState(row: DocRow, caller: Caller): DocState {
    const permissions = permissionsOf(row);
    return {
      cell: cellInfo("doc", caller.name, this.ctx),
      workspaceId: caller.workspaceId,
      docId: caller.docId,
      title: row.title,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      permissions,
      yourRole: roleOf(caller.user, permissions),
      deletedAt: row.deleted_at,
      deletedBy: row.deleted_by,
      purgeAt: row.purge_at,
    };
  }
}

function permissionsOf(row: DocRow): DocPermissions {
  return { owner: row.owner, defaultRole: row.default_role, users: JSON.parse(row.acl) as Record<string, Role> };
}

function toVersion(row: VersionRow): DocVersion {
  return {
    id: row.id,
    createdAt: row.created_at,
    reason: row.reason,
    createdBy: row.created_by,
    editors: JSON.parse(row.editors) as string[],
    title: row.title,
    preview: row.body.slice(0, PREVIEW_LENGTH),
    length: row.body.length,
  };
}

function socketState(ws: WebSocket): SocketState {
  return (ws.deserializeAttachment() as SocketState | null) ?? { user: DEFAULT_USER, presence: {} };
}

function presenceEntries(ws: WebSocket): PresenceEntry[] {
  return Object.entries(socketState(ws).presence).map(([clientId, { clock, state }]) => ({
    clientId: Number(clientId),
    clock,
    state,
  }));
}

function sendTo(ws: WebSocket, message: Uint8Array): void {
  try {
    ws.send(message);
  } catch {
    // The socket is closing; its own close handler cleans up.
  }
}

function closeSocket(ws: WebSocket, code: number, reason?: string): void {
  try {
    ws.close(code, reason);
  } catch {
    // Already closed.
  }
}
