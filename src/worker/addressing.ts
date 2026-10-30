/**
 * Deterministic cell addressing.
 *
 * A "cell" is one Durable Object instance. The Worker never stores a lookup
 * table of cells; instead every cell has a *name* derived purely from the
 * resource it owns. `namespace.idFromName(name)` always maps the same name to
 * the same Durable Object id, so any Worker instance, anywhere, reaches the
 * same cell for the same resource.
 *
 *   workspace "acme"            -> WorkspaceCell named "workspace:acme"
 *   doc "intro" in workspace    -> DocCell       named "doc:acme/intro"
 *
 * Document cell names include the workspace id, so the same doc id in two
 * different workspaces lives in two different cells.
 */

/** Lowercase letters, digits and dashes; 1–63 chars; must start alphanumeric. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type CellAddress =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "doc"; workspaceId: string; docId: string }
  | { kind: "sheet"; workspaceId: string; sheetId: string };

export function isValidId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export function workspaceCellName(workspaceId: string): string {
  assertValidId(workspaceId, "workspaceId");
  return `workspace:${workspaceId}`;
}

export function docCellName(workspaceId: string, docId: string): string {
  assertValidId(workspaceId, "workspaceId");
  assertValidId(docId, "docId");
  return `doc:${workspaceId}/${docId}`;
}

export function sheetCellName(workspaceId: string, sheetId: string): string {
  assertValidId(workspaceId, "workspaceId");
  assertValidId(sheetId, "sheetId");
  return `sheet:${workspaceId}/${sheetId}`;
}

/** Inverse of the functions above. Returns null for anything malformed. */
export function parseCellName(name: string | null): CellAddress | null {
  if (!name) return null;

  const workspace = /^workspace:([^/]+)$/.exec(name);
  if (workspace && isValidId(workspace[1])) {
    return { kind: "workspace", workspaceId: workspace[1] };
  }

  const doc = /^doc:([^/]+)\/([^/]+)$/.exec(name);
  if (doc && isValidId(doc[1]) && isValidId(doc[2])) {
    return { kind: "doc", workspaceId: doc[1], docId: doc[2] };
  }

  const sheet = /^sheet:([^/]+)\/([^/]+)$/.exec(name);
  if (sheet && isValidId(sheet[1]) && isValidId(sheet[2])) {
    return { kind: "sheet", workspaceId: sheet[1], sheetId: sheet[2] };
  }

  return null;
}

function assertValidId(value: string, label: string): void {
  if (!isValidId(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}
