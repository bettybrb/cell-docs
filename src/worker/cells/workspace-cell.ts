import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { UpdateWorkspaceRequest, type DocCatalogue, type WorkspaceState } from "../../shared/api-types";
import { isValidId, parseCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readBody } from "../http";
import { cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";

/** Body of the router's internal "register this document" call. */
const RegisterDocRequest = Schema.Struct({ createdAt: Schema.NonEmptyString });

interface WorkspaceRow {
  display_name: string;
  created_at: string;
  updated_at: string;
  [column: string]: SqlStorageValue;
}

interface DocumentRow {
  doc_id: string;
  created_at: string;
  [column: string]: SqlStorageValue;
}

/**
 * One WorkspaceCell per workspace. It stores the workspace settings (a display
 * name) and the document catalogue: the list of documents that belong to the
 * workspace.
 *
 * Paths inside the cell (set by the router, never by clients directly):
 *   /              GET / PUT workspace settings
 *   /docs          GET the catalogue
 *   /docs/<docId>  PUT registers a document (idempotent)
 */
export class WorkspaceCell extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    createCellMetaTable(this.sql);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS workspace (
      id           INTEGER PRIMARY KEY CHECK (id = 1),
      display_name TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      doc_id     TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    const name = request.headers.get(CELL_NAME_HEADER);
    const address = parseCellName(name);
    if (!name || address?.kind !== "workspace") {
      return errorResponse(400, "bad_cell_name", "WorkspaceCell requires a workspace cell name.");
    }
    const stored = storedCellName(this.sql);
    if (stored !== null && stored !== name) {
      return errorResponse(409, "cell_name_mismatch", `Cell belongs to ${stored}, not ${name}.`);
    }

    const [section, docId, ...rest] = new URL(request.url).pathname.split("/").filter(Boolean);
    if (section === undefined) {
      if (request.method === "GET") return this.read(name, address.workspaceId);
      if (request.method === "PUT") return this.write(request, name, address.workspaceId);
    } else if (section === "docs" && docId === undefined) {
      if (request.method === "GET") return this.listDocs(name, address.workspaceId);
    } else if (section === "docs" && rest.length === 0 && isValidId(docId)) {
      if (request.method === "PUT") return this.registerDoc(request, name, docId);
    } else {
      return errorResponse(404, "not_found", "Unknown workspace cell path.");
    }
    return errorResponse(405, "method_not_allowed", `${request.method} is not supported.`);
  }

  private listDocs(name: string, workspaceId: string): Response {
    const rows = this.sql
      .exec<DocumentRow>(`SELECT doc_id, created_at FROM documents ORDER BY created_at, doc_id`)
      .toArray();
    const catalogue: DocCatalogue = {
      cell: cellInfo("workspace", name, this.ctx),
      workspaceId,
      docs: rows.map((row) => ({ docId: row.doc_id, createdAt: row.created_at })),
    };
    return json(catalogue);
  }

  /**
   * Adds a document to the catalogue. Safe to repeat: an existing entry is
   * left unchanged, so retries and re-registrations are harmless.
   */
  private async registerDoc(request: Request, name: string, docId: string): Promise<Response> {
    const body = await readBody(request, RegisterDocRequest);
    if (body instanceof Response) return body;
    const { createdAt } = body;

    const exists = this.sql.exec(`SELECT 1 FROM documents WHERE doc_id = ?`, docId).toArray().length > 0;
    if (exists) return new Response(null, { status: 204 });

    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      this.sql.exec(`INSERT OR IGNORE INTO documents (doc_id, created_at) VALUES (?, ?)`, docId, createdAt);
    });
    return new Response(null, { status: 201 });
  }

  private read(name: string, workspaceId: string): Response {
    const row = this.loadRow();
    if (!row) {
      return errorResponse(404, "workspace_not_found", `Workspace ${workspaceId} has not been written yet.`);
    }
    return json(this.toState(row, name, workspaceId));
  }

  private async write(request: Request, name: string, workspaceId: string): Promise<Response> {
    const body = await readBody(request, UpdateWorkspaceRequest);
    if (body instanceof Response) return body;
    const { displayName } = body;

    const now = new Date().toISOString();
    const existed = this.loadRow() !== undefined;
    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      this.sql.exec(
        `INSERT INTO workspace (id, display_name, created_at, updated_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at`,
        displayName,
        now,
        now,
      );
    });

    return json(this.toState(this.loadRow()!, name, workspaceId), existed ? 200 : 201);
  }

  private loadRow(): WorkspaceRow | undefined {
    return this.sql
      .exec<WorkspaceRow>(`SELECT display_name, created_at, updated_at FROM workspace WHERE id = 1`)
      .toArray()[0];
  }

  private toState(row: WorkspaceRow, name: string, workspaceId: string): WorkspaceState {
    return {
      cell: cellInfo("workspace", name, this.ctx),
      workspaceId,
      displayName: row.display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
