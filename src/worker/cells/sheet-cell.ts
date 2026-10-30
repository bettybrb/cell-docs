import { DurableObject } from "cloudflare:workers";
import { AddChartRequest, SheetEditsRequest, UpdatePermissionsRequest, UpdateSheetRequest, type SheetState } from "../../shared/api-types";
import { allows, canManage, roleOf, type DocPermissions, type Role } from "../../shared/permissions";
import { MAX_RAW_LENGTH, chartProblem, parseRef, type ChartConfig } from "../../shared/sheet";
import { parseCellName, workspaceCellName } from "../addressing";
import { CELL_NAME_HEADER, errorResponse, json, readBody, requestUser } from "../http";
import { addColumnIfMissing, cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";

interface SheetRow {
  title: string;
  owner: string | null;
  default_role: Role;
  acl: string;
  revision: number;
  updated_at: string;
  [column: string]: SqlStorageValue;
}

interface Caller {
  name: string;
  workspaceId: string;
  sheetId: string;
  user: string;
}

const MAX_CHARTS = 12;

/**
 * One SheetCell per spreadsheet: a Durable Object with its own SQLite
 * database. Cells are stored as raw text (formulas start with "="), one row
 * per non-empty cell, with last-writer-wins per cell. Open pages hold a
 * hibernatable WebSocket; every accepted edit is broadcast to all of them,
 * so everyone sees the same sheet. Formulas are evaluated by the readers
 * (src/shared/sheet.ts), never stored as results, so they cannot go stale.
 * Charts are stored as configurations (ranges), not as data: when cells
 * change, every chart changes with them.
 */
export class SheetCell extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    createCellMetaTable(this.sql);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sheet (
      id INTEGER PRIMARY KEY CHECK (id = 1), title TEXT NOT NULL, owner TEXT,
      default_role TEXT NOT NULL DEFAULT 'edit', acl TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sheet_cells (
      ref TEXT PRIMARY KEY, raw TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sheet_charts (id TEXT PRIMARY KEY, config TEXT NOT NULL, position INTEGER NOT NULL)`);
    addColumnIfMissing(this.sql, "sheet", "owner", "TEXT");
  }

  async fetch(request: Request): Promise<Response> {
    const name = request.headers.get(CELL_NAME_HEADER);
    const address = parseCellName(name);
    if (!name || address?.kind !== "sheet") return errorResponse(400, "bad_cell_name", "SheetCell requires a sheet cell name.");
    const stored = storedCellName(this.sql);
    if (stored !== null && stored !== name) return errorResponse(409, "cell_name_mismatch", `Cell belongs to ${stored}, not ${name}.`);
    const caller: Caller = { name, workspaceId: address.workspaceId, sheetId: address.sheetId, user: requestUser(request) };
    const path = new URL(request.url).pathname;
    const method = request.method;
    const notAllowed = () => errorResponse(405, "method_not_allowed", `${method} is not supported.`);

    if (path === "/sync") return this.openSync(request, caller);
    if (path === "/") {
      if (method === "GET") return this.read(caller);
      if (method === "PUT") return this.write(request, caller);
      return notAllowed();
    }
    if (path === "/cells") return method === "POST" ? this.editCells(request, caller) : notAllowed();
    if (path === "/permissions") return method === "PUT" ? this.setPermissions(request, caller) : notAllowed();
    if (path === "/charts") return method === "POST" ? this.addChart(request, caller) : notAllowed();
    const chart = /^\/charts\/([a-z0-9-]+)$/.exec(path);
    if (chart) return method === "DELETE" ? this.deleteChart(chart[1]!, caller) : notAllowed();
    return errorResponse(404, "not_found", "Unknown sheet cell path.");
  }

  // ----------------------------------------------------------------- access

  private loadRow(): SheetRow | undefined {
    return this.sql.exec<SheetRow>(`SELECT * FROM sheet WHERE id = 1`).toArray()[0];
  }

  private permissions(row: SheetRow): DocPermissions {
    return { owner: row.owner, defaultRole: row.default_role, users: JSON.parse(row.acl) as Record<string, Role> };
  }

  private access(caller: Caller, need: "read" | "edit" | "manage"): SheetRow | Response {
    const row = this.loadRow();
    if (!row) return errorResponse(404, "sheet_not_found", `Sheet ${caller.sheetId} has not been written yet.`);
    const permissions = this.permissions(row);
    const ok = need === "manage" ? canManage(caller.user, permissions) : allows(roleOf(caller.user, permissions), need);
    if (!ok) return errorResponse(403, "forbidden", `${caller.user} may not ${need === "manage" ? "manage permissions of" : need} sheet ${caller.sheetId}.`);
    return row;
  }

  private cells(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.sql.exec<{ ref: string; raw: string }>(`SELECT ref, raw FROM sheet_cells`)) out[r.ref] = r.raw;
    return out;
  }

  private charts(): ChartConfig[] {
    return this.sql
      .exec<{ config: string }>(`SELECT config FROM sheet_charts ORDER BY position`)
      .toArray()
      .map((r) => JSON.parse(r.config) as ChartConfig);
  }

  private toState(row: SheetRow, caller: Caller): SheetState {
    return {
      cell: cellInfo("sheet", caller.name, this.ctx),
      workspaceId: caller.workspaceId,
      sheetId: caller.sheetId,
      title: row.title,
      owner: row.owner,
      yourRole: roleOf(caller.user, this.permissions(row)),
      revision: row.revision,
      cells: this.cells(),
      charts: this.charts(),
    };
  }

  // -------------------------------------------------------------- sheet

  private read(caller: Caller): Response {
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    return json(this.toState(row, caller));
  }

  /** Creates the sheet (the caller becomes its owner) or renames it. */
  private async write(request: Request, caller: Caller): Promise<Response> {
    const body = await readBody(request, UpdateSheetRequest);
    if (body instanceof Response) return body;
    const now = new Date().toISOString();
    const existing = this.loadRow();
    if (!existing) {
      const problem = this.checkEdits(Object.entries(body.cells ?? {}).map(([ref, raw]) => ({ ref, raw })));
      if (problem) return problem;
      claimCellName(this.sql, caller.name);
      this.sql.exec(
        `INSERT INTO sheet (id, title, owner, default_role, acl, revision, created_at, updated_at) VALUES (1, ?, ?, 'edit', '{}', 1, ?, ?)`,
        body.title.trim(), caller.user, now, now,
      );
      for (const [ref, raw] of Object.entries(body.cells ?? {})) if (raw !== "") this.putCell(ref, raw, caller.user, now);
      for (const chart of (body.charts ?? []) as Partial<ChartConfig>[]) {
        if (!chartProblem(chart)) this.insertChart({ ...(chart as ChartConfig), id: crypto.randomUUID() });
      }
    } else {
      const row = this.access(caller, "edit");
      if (row instanceof Response) return row;
      this.sql.exec(`UPDATE sheet SET title = ?, updated_at = ?, revision = revision + 1 WHERE id = 1`, body.title.trim(), now);
    }
    await this.register();
    this.broadcast({ type: "snapshot" });
    return json(this.toState(this.loadRow()!, caller), existing ? 200 : 201);
  }

  private async setPermissions(request: Request, caller: Caller): Promise<Response> {
    const row = this.access(caller, "manage");
    if (row instanceof Response) return row;
    const body = await readBody(request, UpdatePermissionsRequest);
    if (body instanceof Response) return body;
    this.sql.exec(`UPDATE sheet SET default_role = ?, acl = ?, owner = COALESCE(owner, ?) WHERE id = 1`, body.defaultRole, JSON.stringify(body.users), caller.user);
    await this.register();
    this.broadcast({ type: "snapshot" });
    return json(this.toState(this.loadRow()!, caller));
  }

  // ------------------------------------------------------------------ cells

  private checkEdits(edits: ReadonlyArray<{ ref: string; raw: string }>): Response | null {
    for (const { ref, raw } of edits) {
      if (!parseRef(ref)) return errorResponse(422, "bad_ref", `“${ref}” is not a cell in A1..Z100.`);
      if (raw.length > MAX_RAW_LENGTH) return errorResponse(422, "too_long", `Cell ${ref} is longer than ${MAX_RAW_LENGTH} characters.`);
    }
    return null;
  }

  private putCell(ref: string, raw: string, user: string, now: string): void {
    if (raw === "") this.sql.exec(`DELETE FROM sheet_cells WHERE ref = ?`, ref);
    else
      this.sql.exec(
        `INSERT INTO sheet_cells (ref, raw, updated_by, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (ref) DO UPDATE SET raw = excluded.raw, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        ref, raw, user, now,
      );
  }

  /** Applies edits atomically (all or none) and tells every open page. */
  private applyEdits(edits: ReadonlyArray<{ ref: string; raw: string }>, user: string): Response | number {
    const problem = this.checkEdits(edits);
    if (problem) return problem;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      for (const { ref, raw } of edits) this.putCell(ref, raw, user, now);
      this.sql.exec(`UPDATE sheet SET revision = revision + 1, updated_at = ? WHERE id = 1`, now);
    });
    const revision = this.loadRow()!.revision;
    this.broadcast({ type: "cells", edits, by: user, revision });
    return revision;
  }

  private async editCells(request: Request, caller: Caller): Promise<Response> {
    const row = this.access(caller, "edit");
    if (row instanceof Response) return row;
    const body = await readBody(request, SheetEditsRequest);
    if (body instanceof Response) return body;
    const result = this.applyEdits(body.edits, caller.user);
    if (result instanceof Response) return result;
    await this.register();
    return json(this.toState(this.loadRow()!, caller));
  }

  // ----------------------------------------------------------------- charts

  private insertChart(chart: ChartConfig): void {
    const position = this.sql.exec<{ n: number }>(`SELECT COALESCE(MAX(position), 0) + 1 AS n FROM sheet_charts`).one().n;
    this.sql.exec(`INSERT INTO sheet_charts (id, config, position) VALUES (?, ?, ?)`, chart.id, JSON.stringify(chart), position);
  }

  private async addChart(request: Request, caller: Caller): Promise<Response> {
    const row = this.access(caller, "edit");
    if (row instanceof Response) return row;
    const body = await readBody(request, AddChartRequest);
    if (body instanceof Response) return body;
    const problem = chartProblem(body as Partial<ChartConfig>);
    if (problem) return errorResponse(422, "bad_chart", problem);
    if (this.charts().length >= MAX_CHARTS) return errorResponse(422, "too_many_charts", `At most ${MAX_CHARTS} charts per sheet.`);
    const chart: ChartConfig = { id: crypto.randomUUID(), title: body.title, type: body.type as ChartConfig["type"], labels: body.labels, series: [...body.series] };
    this.insertChart(chart);
    this.sql.exec(`UPDATE sheet SET revision = revision + 1 WHERE id = 1`);
    this.broadcast({ type: "charts", charts: this.charts() });
    return json(chart, 201);
  }

  private deleteChart(id: string, caller: Caller): Response {
    const row = this.access(caller, "edit");
    if (row instanceof Response) return row;
    this.sql.exec(`DELETE FROM sheet_charts WHERE id = ?`, id);
    this.sql.exec(`UPDATE sheet SET revision = revision + 1 WHERE id = 1`);
    this.broadcast({ type: "charts", charts: this.charts() });
    return json(this.toState(this.loadRow()!, caller));
  }

  // ------------------------------------------------------------- live sync

  private openSync(request: Request, caller: Caller): Response {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse(426, "upgrade_required", "Connect with a WebSocket.");
    const row = this.access(caller, "read");
    if (row instanceof Response) return row;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ user: caller.user });
    server.send(JSON.stringify({ type: "hello", state: this.toState(row, caller) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A page sends `{type: "edit", ref, raw}`; it is checked against the sender's *current* role. */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    if (typeof message !== "string") return;
    const { user } = ws.deserializeAttachment() as { user: string };
    const row = this.loadRow();
    if (!row) return;
    let msg: { type?: string; ref?: unknown; raw?: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type !== "edit" || typeof msg.ref !== "string" || typeof msg.raw !== "string") return;
    if (!allows(roleOf(user, this.permissions(row)), "edit")) {
      ws.send(JSON.stringify({ type: "rejected", ref: msg.ref, reason: "You may not edit this sheet." }));
      return;
    }
    const result = this.applyEdits([{ ref: msg.ref, raw: msg.raw }], user);
    if (result instanceof Response) {
      ws.send(JSON.stringify({ type: "rejected", ref: msg.ref, reason: ((await result.json()) as { error: { message: string } }).error.message }));
      return;
    }
    void this.register().catch(() => undefined);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {
      /* already closed */
    }
  }

  private broadcast(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* closing socket */
      }
    }
  }

  /** Keeps the workspace's sheet list current (idempotent). */
  private async register(): Promise<void> {
    const row = this.loadRow();
    const address = parseCellName(storedCellName(this.sql));
    if (!row || address?.kind !== "sheet") return;
    const workspace = workspaceCellName(address.workspaceId);
    const stub = this.env.WORKSPACE_CELL.get(this.env.WORKSPACE_CELL.idFromName(workspace));
    const response = await stub.fetch(`https://cell.internal/sheets/${address.sheetId}`, {
      method: "PUT",
      headers: { [CELL_NAME_HEADER]: workspace, "content-type": "application/json" },
      body: JSON.stringify({ title: row.title, owner: row.owner, defaultRole: row.default_role, acl: JSON.parse(row.acl), updatedAt: row.updated_at }),
    });
    if (!response.ok) throw new Error(`workspace cell answered ${response.status}`);
  }
}
