import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import type { DocState, UpdateDocRequest } from "../../shared/api-types";
import { parseCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readJsonObject } from "../http";
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

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 100_000;
/** Above this many stored updates, loading merges them into one row. */
const COMPACT_AFTER_UPDATES = 100;

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

    if (new URL(request.url).pathname === "/sync") {
      return this.openSync(request, address.docId);
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
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const update = validateUpdate(body);
    if (typeof update === "string") return errorResponse(400, "invalid_body", update);

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
        if (ydoc) replaceText(ydoc.getText("body"), update.body!);
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

    return json(this.toState(this.loadRow()!, name, workspaceId, docId), existing ? 200 : 201);
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
   * A document written before Yjs existed has no stored updates yet; its
   * plain-text body becomes the initial Y.Text, once, here on the server.
   */
  private loadYDoc(): Y.Doc {
    if (this.ydoc) return this.ydoc;
    const ydoc = new Y.Doc();
    const rows = this.sql.exec<{ data: ArrayBuffer }>(`SELECT data FROM yjs_updates ORDER BY seq`).toArray();
    for (const row of rows) Y.applyUpdate(ydoc, new Uint8Array(row.data));

    if (rows.length > COMPACT_AFTER_UPDATES) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`DELETE FROM yjs_updates`);
        this.sql.exec(`INSERT INTO yjs_updates (data) VALUES (?)`, Y.encodeStateAsUpdate(ydoc));
      });
    }

    ydoc.on("update", (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
    this.ydoc = ydoc;

    const row = this.loadRow();
    if (rows.length === 0 && row && row.body !== "") ydoc.getText("body").insert(0, row.body);
    return ydoc;
  }

  /**
   * Runs for every change to the Yjs document, from a browser or a PUT:
   * stores it, refreshes the plain-text copy, and forwards it to every other
   * connected browser. Durable Objects hold outgoing messages until these
   * writes are durable, so nothing is forwarded before it is stored.
   */
  private onUpdate(update: Uint8Array, origin: unknown): void {
    this.sql.exec(`INSERT INTO yjs_updates (data) VALUES (?)`, update);
    this.sql.exec(
      `UPDATE doc SET body = ?, updated_at = ? WHERE id = 1`,
      this.ydoc!.getText("body").toString(),
      new Date().toISOString(),
    );
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

function validateUpdate(input: Record<string, unknown>): UpdateDocRequest | string {
  const { title, body } = input;
  if (title === undefined && body === undefined) return "Provide at least one of: title, body.";
  if (title !== undefined && (typeof title !== "string" || title.length > MAX_TITLE_LENGTH)) {
    return `title must be a string of at most ${MAX_TITLE_LENGTH} characters.`;
  }
  if (body !== undefined && (typeof body !== "string" || body.length > MAX_BODY_LENGTH)) {
    return `body must be a string of at most ${MAX_BODY_LENGTH} characters.`;
  }
  return { title, body } as UpdateDocRequest;
}

function presenceEntries(ws: WebSocket): PresenceEntry[] {
  const presence: SocketPresence = ws.deserializeAttachment() ?? {};
  return Object.entries(presence).map(([clientId, { clock, state }]) => ({ clientId: Number(clientId), clock, state }));
}
