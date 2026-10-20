import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { UpdateDocRequest, type DocState, type DocVersion, type DocVersionList } from "../../shared/api-types";
import { parseCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readBody } from "../http";
import { isSaveCheck } from "../../shared/save-check";
import { cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";
import {
  awarenessMessage,
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
const PREVIEW_LENGTH = 80;

/** Transaction origin for changes the cell makes itself (saves, repairs, restores). */
const SERVER_ORIGIN = "server";

/**
 * Presence of the client(s) on one socket, stored as the socket's attachment
 * so it survives hibernation. Keyed by Yjs client id.
 */
type SocketPresence = Record<string, { clock: number; state: unknown }>;

interface DocRow {
  title: string;
  body: string;
  revision: number;
  created_at: string;
  updated_at: string;
  // SqlStorage row types must be indexable.
  [column: string]: SqlStorageValue;
}

/**
 * One DocCell per document. Its private SQLite database holds exactly one
 * document row (enforced by `CHECK (id = 1)`), because the cell *is* the
 * document.
 *
 * The body's source of truth is a Yjs document stored as a log of updates
 * (`yjs_updates`). `doc.body` is a plain-text copy, rewritten on every
 * update, so REST reads stay simple. Browsers connect over WebSockets
 * (`/sync`) and exchange Yjs updates through this cell.
 */
export class DocCell extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  /** Loaded on first use; rebuilt from SQLite after hibernation or restart. */
  private ydoc: Y.Doc | null = null;
  /** Rows in yjs_updates, kept in step with the table once ydoc is loaded. */
  private storedUpdates = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Runs before the first request is delivered. Idempotent, so it is safe
    // every time the cell is (re)started.
    createCellMetaTable(this.sql);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS doc (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      revision   INTEGER NOT NULL,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL
    )`);
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

    const path = new URL(request.url).pathname;
    if (path === "/sync") {
      return this.openSync(request, address.docId);
    }
    if (path === "/versions") {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", `${request.method} is not supported.`);
      return this.listVersions(name);
    }
    const restore = /^\/versions\/(\d+)\/restore$/.exec(path);
    if (restore) {
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed", `${request.method} is not supported.`);
      return this.restoreVersion(Number(restore[1]), name, address.workspaceId, address.docId);
    }

    switch (request.method) {
      case "GET":
        return this.read(name, address.workspaceId, address.docId);
      case "PUT":
        return this.write(request, name, address.workspaceId, address.docId);
      default:
        return errorResponse(405, "method_not_allowed", `${request.method} is not supported.`);
    }
  }

  private read(name: string, workspaceId: string, docId: string): Response {
    const row = this.loadRow();
    if (!row) {
      return errorResponse(404, "doc_not_found", `Document ${docId} has not been written yet.`);
    }
    return json(this.toState(row, name, workspaceId, docId));
  }

  private async write(
    request: Request,
    name: string,
    workspaceId: string,
    docId: string,
  ): Promise<Response> {
    const update = await readBody(request, UpdateDocRequest);
    if (update instanceof Response) return update;

    const now = new Date().toISOString();
    const existing = this.loadRow();
    // A body change on an existing doc goes through Yjs (loaded here, outside
    // the transaction) so connected browsers receive it too.
    const ydoc = existing && update.body !== undefined ? this.loadYDoc() : null;

    // Explicit transaction: the name claim and the document write either
    // both persist or neither does.
    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      if (existing) {
        this.sql.exec(
          `UPDATE doc SET title = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
          update.title ?? existing.title,
          now,
        );
        // The update handler stores the change and rewrites doc.body.
        if (ydoc) replaceText(ydoc.getText("body"), update.body!, SERVER_ORIGIN);
      } else {
        this.sql.exec(
          `INSERT INTO doc (id, title, body, revision, created_at, updated_at)
           VALUES (1, ?, ?, 1, ?, ?)`,
          update.title ?? "Untitled",
          update.body ?? "",
          now,
          now,
        );
      }
    });

    const saved = this.loadRow()!;
    // A save with a body is a moment worth keeping; title-only autosaves are not.
    if (update.body !== undefined) this.addVersion("save", saved.title, saved.body);
    return json(this.toState(saved, name, workspaceId, docId), existing ? 200 : 201);
  }

  private listVersions(name: string): Response {
    const rows = this.sql
      .exec<{ id: number; created_at: string; reason: DocVersion["reason"]; title: string; body: string }>(
        `SELECT id, created_at, reason, title, body FROM doc_versions ORDER BY id DESC`,
      )
      .toArray();
    const list: DocVersionList = {
      cell: cellInfo("doc", name, this.ctx),
      versions: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        reason: row.reason,
        title: row.title,
        preview: row.body.slice(0, PREVIEW_LENGTH),
        length: row.body.length,
      })),
    };
    return json(list);
  }

  /**
   * Makes the document match a stored version: the body as an ordinary Yjs
   * edit (so open browsers update live) and the title. The current text is
   * kept as a "restore" version first, so a restore can itself be undone.
   */
  private restoreVersion(id: number, name: string, workspaceId: string, docId: string): Response {
    const version = this.sql
      .exec<{ title: string; body: string }>(`SELECT title, body FROM doc_versions WHERE id = ?`, id)
      .toArray()[0];
    const current = this.loadRow();
    if (!version || !current) return errorResponse(404, "version_not_found", `Version ${id} does not exist.`);

    const ydoc = this.loadYDoc();
    this.ctx.storage.transactionSync(() => {
      this.addVersion("restore", current.title, current.body);
      this.sql.exec(
        `UPDATE doc SET title = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
        version.title,
        new Date().toISOString(),
      );
      replaceText(ydoc.getText("body"), version.body, SERVER_ORIGIN);
    });
    return json(this.toState(this.loadRow()!, name, workspaceId, docId));
  }

  /** Stores a version and drops the oldest beyond MAX_VERSIONS. */
  private addVersion(reason: DocVersion["reason"], title: string, body: string): void {
    this.sql.exec(
      `INSERT INTO doc_versions (created_at, reason, title, body) VALUES (?, ?, ?, ?)`,
      new Date().toISOString(),
      reason,
      title,
      body,
    );
    this.sql.exec(
      `DELETE FROM doc_versions WHERE id NOT IN (SELECT id FROM doc_versions ORDER BY id DESC LIMIT ?)`,
      MAX_VERSIONS,
    );
  }

  /**
   * Before a live edit from a browser: if the newest version is old enough
   * (or there is none), keep the text as it was just before this edit.
   */
  private autoVersion(): void {
    const newest = this.sql
      .exec<{ created_at: string }>(`SELECT created_at FROM doc_versions ORDER BY id DESC LIMIT 1`)
      .toArray()[0];
    if (newest && Date.now() - Date.parse(newest.created_at) < AUTO_VERSION_INTERVAL_MS) return;
    const before = this.loadRow();
    if (before) this.addVersion("auto", before.title, before.body);
  }

  /** Upgrades the request to a WebSocket that syncs this document. */
  private openSync(request: Request, docId: string): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return errorResponse(426, "upgrade_required", "Connect with a WebSocket.");
    }
    if (!this.loadRow()) {
      return errorResponse(404, "doc_not_found", `Document ${docId} has not been written yet.`);
    }
    const ydoc = this.loadYDoc();
    const [client, server] = Object.values(new WebSocketPair());
    // Hibernatable: the cell may leave memory while sockets stay open.
    this.ctx.acceptWebSocket(server);
    server.send(syncStep1Message(ydoc));
    // Tell the newcomer who is already here.
    const present = this.ctx.getWebSockets().flatMap((ws) => presenceEntries(ws));
    if (present.length > 0) server.send(awarenessMessage(present));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message === "string") return;
    const data = new Uint8Array(message);
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
      const reply = handleMessage(data, this.loadYDoc(), ws);
      if (reply) ws.send(reply);
    } catch {
      ws.close(1003, "Malformed Yjs message");
    }
  }

  /** Remembers the sender's presence on its socket and forwards the message to everyone else. */
  private relayPresence(ws: WebSocket, data: Uint8Array): void {
    const presence: SocketPresence = ws.deserializeAttachment() ?? {};
    for (const entry of readAwarenessMessage(data)) {
      if (entry.state === null) delete presence[entry.clientId];
      else presence[entry.clientId] = { clock: entry.clock, state: entry.state };
    }
    ws.serializeAttachment(presence);
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
    ws.serializeAttachment({});
    this.broadcast(awarenessMessage(left), ws);
  }

  private broadcast(message: Uint8Array, except: unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(message);
      } catch {
        // The socket is closing; its own close handler cleans up.
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.announceLeave(ws);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.announceLeave(ws);
    try {
      ws.close(code === 1005 ? 1000 : code); // 1005 ("no code") cannot be sent back
    } catch {
      // Already closed.
    }
  }

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
    // doc.body still holds the text from before this edit at this point.
    if (origin !== SERVER_ORIGIN) this.autoVersion();
    this.sql.exec(`INSERT INTO yjs_updates (data) VALUES (?)`, update);
    this.sql.exec(
      `UPDATE doc SET body = ?, updated_at = ? WHERE id = 1`,
      this.ydoc!.getText("body").toString(),
      new Date().toISOString(),
    );
    if (++this.storedUpdates > COMPACT_AFTER_UPDATES) this.compact();
    this.broadcast(updateMessage(update), origin);
  }

  private loadRow(): DocRow | undefined {
    return this.sql
      .exec<DocRow>(`SELECT title, body, revision, created_at, updated_at FROM doc WHERE id = 1`)
      .toArray()[0];
  }

  private toState(row: DocRow, name: string, workspaceId: string, docId: string): DocState {
    return {
      cell: cellInfo("doc", name, this.ctx),
      workspaceId,
      docId,
      title: row.title,
      body: row.body,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function presenceEntries(ws: WebSocket): PresenceEntry[] {
  const presence: SocketPresence = ws.deserializeAttachment() ?? {};
  return Object.entries(presence).map(([clientId, { clock, state }]) => ({ clientId: Number(clientId), clock, state }));
}
