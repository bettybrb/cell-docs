import { DurableObject } from "cloudflare:workers";
import type { DocState, UpdateDocRequest } from "../../shared/api-types";
import { parseCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readJsonObject } from "../http";
import { cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 100_000;

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
 * document. Later phases will add Yjs updates and WebSocket sessions here.
 */
export class DocCell extends DurableObject<Env> {
  private readonly sql: SqlStorage;

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

    // Explicit transaction: the name claim and the document write either
    // both persist or neither does.
    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      if (existing) {
        this.sql.exec(
          `UPDATE doc SET title = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = 1`,
          update.title ?? existing.title,
          update.body ?? existing.body,
          now,
        );
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
