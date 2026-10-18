import type { CellInfo, CellKind } from "../../shared/api-types";

/**
 * Bookkeeping shared by every cell type: a tiny key/value table recording the
 * name the cell was first written under. On every later request the cell
 * checks the incoming name against it, so a routing bug cannot silently mix
 * two resources' data in one database.
 */

export function createCellMetaTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS cell_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
}

export function storedCellName(sql: SqlStorage): string | null {
  const rows = sql
    .exec<{ value: string }>(`SELECT value FROM cell_meta WHERE key = 'cell_name'`)
    .toArray();
  return rows[0]?.value ?? null;
}

/** Records the cell name on first write; no-op afterwards. */
export function claimCellName(sql: SqlStorage, name: string): void {
  sql.exec(`INSERT OR IGNORE INTO cell_meta (key, value) VALUES ('cell_name', ?)`, name);
}

export function cellInfo(kind: CellKind, name: string, ctx: DurableObjectState): CellInfo {
  return {
    kind,
    name,
    id: ctx.id.toString(),
    sqliteBytes: ctx.storage.sql.databaseSize,
  };
}
