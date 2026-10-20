import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";
import { UpdateWorkspaceRequest, type DocCatalogue, type WorkspaceState } from "../../shared/api-types";
import { isValidId, parseCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readBody } from "../http";
import { cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";

/** Body of the router's internal "register this document" call. */
const RegisterDocRequest = Schema.Struct({ createdAt: Schema.NonEmptyString, title: Schema.String });

interface WorkspaceRow {
  display_name: string;
  created_at: string;
  updated_at: string;
  [column: string]: SqlStorageValue;
}

interface DocumentRow {
  doc_id: string;
  created_at: string;
  title: string | null;
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
      created_at TEXT NOT NULL,
      title      TEXT -- copy of the doc's title; NULL until it is next read or saved
    )`);
    // Catalogues created before titles were tracked lack the column.
    const columns = this.sql.exec<{ name: string }>(`PRAGMA table_info(documents)`).toArray();
    if (!columns.some((column) => column.name === "title")) {
      this.sql.exec(`ALTER TABLE documents ADD COLUMN title TEXT`);
    }
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
      .exec<DocumentRow>(`SELECT doc_id, created_at, title FROM documents ORDER BY created_at, doc_id`)
      .toArray();
    const catalogue: DocCatalogue = {
      cell: cellInfo("workspace", name, this.ctx),
      workspaceId,
      docs: rows.map((row) => ({ docId: row.doc_id, createdAt: row.created_at, title: row.title })),
    };
    return json(catalogue);
  }

  /**
   * Adds a document to the catalogue, or updates its title copy. Safe to
   * repeat, so retries and re-registrations are harmless.
   */
  private async registerDoc(request: Request, name: string, docId: string): Promise<Response> {
    const body = await readBody(request, RegisterDocRequest);
    if (body instanceof Response) return body;
    const { createdAt, title } = body;

    const existing = this.sql
      .exec<{ title: string | null }>(`SELECT title FROM documents WHERE doc_id = ?`, docId)
      .toArray()[0];
    if (existing && existing.title === title) return new Response(null, { status: 204 });

    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      this.sql.exec(
        `INSERT INTO documents (doc_id, created_at, title) VALUES (?, ?, ?)
         ON CONFLICT (doc_id) DO UPDATE SET title = excluded.title`,
        docId,
        createdAt,
        title,
      );
    });
    return new Response(null, { status: existing ? 204 : 201 });
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
