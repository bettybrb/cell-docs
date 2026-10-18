import { DurableObject } from "cloudflare:workers";
import type { WorkspaceState } from "../../shared/api-types";
import { parseCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readJsonObject } from "../http";
import { cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";

const MAX_DISPLAY_NAME_LENGTH = 100;

interface WorkspaceRow {
  display_name: string;
  created_at: string;
  updated_at: string;
  [column: string]: SqlStorageValue;
}

/**
 * One WorkspaceCell per workspace. For now it stores only workspace settings
 * (a display name). The next phase adds the resource catalogue here: the
 * list of documents that belong to the workspace.
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

    switch (request.method) {
      case "GET":
        return this.read(name, address.workspaceId);
      case "PUT":
        return this.write(request, name, address.workspaceId);
      default:
        return errorResponse(405, "method_not_allowed", `${request.method} is not supported.`);
    }
  }

  private read(name: string, workspaceId: string): Response {
    const row = this.loadRow();
    if (!row) {
      return errorResponse(404, "workspace_not_found", `Workspace ${workspaceId} has not been written yet.`);
    }
    return json(this.toState(row, name, workspaceId));
  }

  private async write(request: Request, name: string, workspaceId: string): Promise<Response> {
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const { displayName } = body;
    if (
      typeof displayName !== "string" ||
      displayName.trim() === "" ||
      displayName.length > MAX_DISPLAY_NAME_LENGTH
    ) {
      return errorResponse(
        400,
        "invalid_body",
        `displayName must be a non-empty string of at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
      );
    }

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
