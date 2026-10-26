import { DurableObject } from "cloudflare:workers";
import {
  CreateFolderRequest,
  UpdateDocMetaRequest,
  UpdateWorkspaceRequest,
  type CatalogueEntry,
  type DocCatalogue,
  type Folder,
  type SearchResult,
  type SearchResults,
  type TrashEntry,
  type TrashList,
  type WorkspaceState,
} from "../../shared/api-types";
import { allows, roleOf, type DocPermissions, type Role } from "../../shared/permissions";
import { isValidId, parseCellName } from "../addressing";
import { CatalogueCopy } from "../catalogue-copy";
import { CELL_NAME_HEADER, errorResponse, json, readBody, requestUser } from "../http";
import { addColumnIfMissing, cellInfo, claimCellName, createCellMetaTable, storedCellName } from "./cell-meta";

const SNIPPET_CONTEXT = 40;

interface WorkspaceRow {
  display_name: string;
  created_at: string;
  updated_at: string;
  [column: string]: SqlStorageValue;
}

interface DocumentRow {
  doc_id: string;
  created_at: string;
  updated_at: string | null;
  title: string | null;
  body_text: string;
  owner: string | null;
  default_role: Role;
  acl: string;
  deleted_at: string | null;
  deleted_by: string | null;
  purge_at: string | null;
  folder_id: string | null;
  [column: string]: SqlStorageValue;
}

/**
 * One WorkspaceCell per workspace. It stores the workspace settings (a display
 * name) and the catalogue: which documents exist, in which folders, with which
 * tags. Folders and tags belong to the catalogue alone, so a document's id
 * never depends on where it is filed.
 *
 * Everything else about a document (title, text for search, permissions,
 * Recycle Bin state) is a copy of what its DocCell holds, refreshed by the
 * router after document requests and by the DocCell after live edits. The
 * copy decides what each user is shown; the DocCell still checks every
 * request itself.
 *
 * Paths inside the cell (set by the router; `/docs/<id>` PUT and DELETE are
 * only ever called by the router or a DocCell, never for a client):
 *   /                    GET / PUT workspace settings
 *   /docs                GET the documents the user may read, with folders and tags
 *   /docs/<id>           PUT a catalogue copy (idempotent); DELETE the entry (after a purge)
 *   /docs/<id>/meta      PUT folder and tags
 *   /trash               GET the Recycle Bin
 *   /search?q=&tag=&folder=   GET matching documents
 *   /folders             POST create a folder
 *   /folders/<id>        DELETE an empty folder
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
    // Copies of the DocCell's state (NULL or defaults until the doc is next read or saved).
    addColumnIfMissing(this.sql, "documents", "title", "TEXT");
    addColumnIfMissing(this.sql, "documents", "updated_at", "TEXT");
    addColumnIfMissing(this.sql, "documents", "body_text", "TEXT NOT NULL DEFAULT ''");
    addColumnIfMissing(this.sql, "documents", "owner", "TEXT");
    addColumnIfMissing(this.sql, "documents", "default_role", "TEXT NOT NULL DEFAULT 'edit'");
    addColumnIfMissing(this.sql, "documents", "acl", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing(this.sql, "documents", "deleted_at", "TEXT");
    addColumnIfMissing(this.sql, "documents", "deleted_by", "TEXT");
    addColumnIfMissing(this.sql, "documents", "purge_at", "TEXT");
    // Owned by the catalogue.
    addColumnIfMissing(this.sql, "documents", "folder_id", "TEXT");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS folders (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      parent_id  TEXT,
      created_at TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS doc_tags (
      doc_id TEXT NOT NULL,
      tag    TEXT NOT NULL,
      PRIMARY KEY (doc_id, tag)
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

    const url = new URL(request.url);
    const user = requestUser(request);
    const method = request.method;
    const [section, id, detail, ...rest] = url.pathname.split("/").filter(Boolean);
    const notAllowed = () => errorResponse(405, "method_not_allowed", `${method} is not supported.`);

    if (section === undefined) {
      if (method === "GET") return this.read(name, address.workspaceId);
      if (method === "PUT") return this.write(request, name, address.workspaceId);
      return notAllowed();
    }
    if (section === "docs" && id === undefined) return method === "GET" ? this.listDocs(name, address.workspaceId, user) : notAllowed();
    if (section === "docs" && isValidId(id) && detail === undefined) {
      if (method === "PUT") return this.storeCopy(request, name, id);
      if (method === "DELETE") return this.removeEntry(id);
      return notAllowed();
    }
    if (section === "docs" && isValidId(id) && detail === "meta" && rest.length === 0) {
      return method === "PUT" ? this.updateMeta(request, id, user) : notAllowed();
    }
    if (section === "trash" && id === undefined) return method === "GET" ? this.listTrash(name, user) : notAllowed();
    if (section === "search" && id === undefined) return method === "GET" ? this.search(name, url.searchParams, user) : notAllowed();
    if (section === "folders" && id === undefined) return method === "POST" ? this.createFolder(request, name) : notAllowed();
    if (section === "folders" && isValidId(id) && detail === undefined) {
      return method === "DELETE" ? this.deleteFolder(id) : notAllowed();
    }
    return errorResponse(404, "not_found", "Unknown workspace cell path.");
  }

  // ---------------------------------------------------------------- catalogue

  /** Documents not in the Recycle Bin that `user` may read, oldest first, with folders and tags in use. */
  private listDocs(name: string, workspaceId: string, user: string): Response {
    const docs = this.readable(user, this.rows(`deleted_at IS NULL`));
    const counts = new Map<string, number>();
    for (const doc of docs) for (const tag of doc.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    const catalogue: DocCatalogue = {
      cell: cellInfo("workspace", name, this.ctx),
      workspaceId,
      docs,
      folders: this.folders(),
      tags: [...counts].map(([tagName, count]) => ({ name: tagName, count })).sort((a, b) => a.name.localeCompare(b.name)),
    };
    return json(catalogue);
  }

  /**
   * Stores the copy a DocCell or the router sends (title, text, permissions,
   * Recycle Bin state). Folder and tags are the catalogue's own and stay.
   * Safe to repeat, so retries and re-registrations are harmless.
   */
  private async storeCopy(request: Request, name: string, docId: string): Promise<Response> {
    const copy = await readBody(request, CatalogueCopy);
    if (copy instanceof Response) return copy;
    const existed = this.sql.exec(`SELECT 1 FROM documents WHERE doc_id = ?`, docId).toArray().length > 0;
    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      this.sql.exec(
        `INSERT INTO documents (doc_id, created_at, updated_at, title, body_text, owner, default_role, acl, deleted_at, deleted_by, purge_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc_id) DO UPDATE SET
           updated_at = excluded.updated_at, title = excluded.title, body_text = excluded.body_text,
           owner = excluded.owner, default_role = excluded.default_role, acl = excluded.acl,
           deleted_at = excluded.deleted_at, deleted_by = excluded.deleted_by, purge_at = excluded.purge_at`,
        docId,
        copy.createdAt,
        copy.updatedAt,
        copy.title,
        copy.body,
        copy.permissions.owner,
        copy.permissions.defaultRole,
        JSON.stringify(copy.permissions.users),
        copy.deletedAt,
        copy.deletedBy,
        copy.purgeAt,
      );
    });
    return new Response(null, { status: existed ? 204 : 201 });
  }

  /** Called by a DocCell just before it erases itself. Removing a missing entry is fine. */
  private removeEntry(docId: string): Response {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`DELETE FROM doc_tags WHERE doc_id = ?`, docId);
      this.sql.exec(`DELETE FROM documents WHERE doc_id = ?`, docId);
    });
    return new Response(null, { status: 204 });
  }

  /** Files a document in a folder and/or replaces its tags. Needs edit rights on the document. */
  private async updateMeta(request: Request, docId: string, user: string): Promise<Response> {
    const row = this.rows(`doc_id = ?`, docId)[0];
    if (!row) return errorResponse(404, "doc_not_found", `Document ${docId} is not in the catalogue.`);
    if (row.deleted_at) return errorResponse(410, "doc_deleted", `Document ${docId} is in the Recycle Bin.`);
    if (!allows(roleOf(user, permissionsOf(row)), "edit")) {
      return errorResponse(403, "forbidden", `${user} may not edit document ${docId}.`);
    }
    const meta = await readBody(request, UpdateDocMetaRequest);
    if (meta instanceof Response) return meta;
    if (meta.folderId && !this.folderExists(meta.folderId)) {
      return errorResponse(400, "invalid_body", `Folder ${meta.folderId} does not exist.`);
    }
    this.ctx.storage.transactionSync(() => {
      if (meta.folderId !== undefined) {
        this.sql.exec(`UPDATE documents SET folder_id = ? WHERE doc_id = ?`, meta.folderId, docId);
      }
      if (meta.tags !== undefined) {
        this.sql.exec(`DELETE FROM doc_tags WHERE doc_id = ?`, docId);
        for (const tag of new Set(meta.tags.map((t) => t.trim().toLowerCase()))) {
          this.sql.exec(`INSERT INTO doc_tags (doc_id, tag) VALUES (?, ?)`, docId, tag);
        }
      }
    });
    return json(this.entry(this.rows(`doc_id = ?`, docId)[0], user));
  }

  /** Documents in the Recycle Bin that `user` may read, most recently deleted first. */
  private listTrash(name: string, user: string): Response {
    const rows = this.rows(`deleted_at IS NOT NULL`).sort((a, b) => b.deleted_at!.localeCompare(a.deleted_at!));
    const docs = rows
      .filter((row) => allows(roleOf(user, permissionsOf(row)), "read"))
      .map(
        (row): TrashEntry => ({
          ...this.entry(row, user),
          deletedAt: row.deleted_at!,
          deletedBy: row.deleted_by,
          purgeAt: row.purge_at,
        }),
      );
    const list: TrashList = { cell: cellInfo("workspace", name, this.ctx), docs };
    return json(list);
  }

  /**
   * Finds readable documents (not in the Recycle Bin) whose title, text or
   * tags contain `q` (case-insensitive), optionally only with `tag` or in
   * `folder`. The text searched is the catalogue's copy, refreshed within a
   * few seconds of live edits.
   */
  private search(name: string, params: URLSearchParams, user: string): Response {
    const query = (params.get("q") ?? "").trim();
    const tag = params.get("tag")?.trim().toLowerCase() || null;
    const folder = params.get("folder") || null;
    const needle = query.toLowerCase();
    const rows = this.rows(`deleted_at IS NULL`);
    const results: SearchResult[] = [];
    if (query || tag || folder) {
      for (const entry of this.readable(user, rows)) {
        if (tag && !entry.tags.includes(tag)) continue;
        if (folder && entry.folderId !== folder) continue;
        const row = rows.find((r) => r.doc_id === entry.docId)!;
        const matchedIn: SearchResult["matchedIn"] = [];
        let snippet: string | null = null;
        if (needle) {
          if ((entry.title ?? entry.docId).toLowerCase().includes(needle)) matchedIn.push("title");
          const at = row.body_text.toLowerCase().indexOf(needle);
          if (at >= 0) {
            matchedIn.push("content");
            snippet = snippetAround(row.body_text, at, needle.length);
          }
          if (entry.tags.some((t) => t.includes(needle))) matchedIn.push("tags");
          if (matchedIn.length === 0) continue;
        }
        results.push({ ...entry, matchedIn, snippet });
      }
    }
    const body: SearchResults = { cell: cellInfo("workspace", name, this.ctx), query, results };
    return json(body);
  }

  // ------------------------------------------------------------------ folders

  private async createFolder(request: Request, name: string): Promise<Response> {
    const body = await readBody(request, CreateFolderRequest);
    if (body instanceof Response) return body;
    const parentId = body.parentId ?? null;
    if (parentId && !this.folderExists(parentId)) {
      return errorResponse(400, "invalid_body", `Folder ${parentId} does not exist.`);
    }
    const folderName = body.name.trim();
    const clash = this.folders().some((f) => f.parentId === parentId && f.name.toLowerCase() === folderName.toLowerCase());
    if (clash) return errorResponse(409, "folder_exists", `A folder named ${folderName} already exists there.`);
    const folder: Folder = {
      id: `f-${crypto.randomUUID().slice(0, 8)}`,
      name: folderName,
      parentId,
      createdAt: new Date().toISOString(),
    };
    this.ctx.storage.transactionSync(() => {
      claimCellName(this.sql, name);
      this.sql.exec(
        `INSERT INTO folders (id, name, parent_id, created_at) VALUES (?, ?, ?, ?)`,
        folder.id,
        folder.name,
        folder.parentId,
        folder.createdAt,
      );
    });
    return json(folder, 201);
  }

  /** Deletes a folder that holds no documents (including ones in the Recycle Bin) and no folders. */
  private deleteFolder(id: string): Response {
    if (!this.folderExists(id)) return errorResponse(404, "folder_not_found", `Folder ${id} does not exist.`);
    const docs = this.sql.exec(`SELECT 1 FROM documents WHERE folder_id = ? LIMIT 1`, id).toArray().length;
    const children = this.sql.exec(`SELECT 1 FROM folders WHERE parent_id = ? LIMIT 1`, id).toArray().length;
    if (docs || children) return errorResponse(409, "folder_not_empty", `Folder ${id} is not empty.`);
    this.sql.exec(`DELETE FROM folders WHERE id = ?`, id);
    return new Response(null, { status: 204 });
  }

  private folders(): Folder[] {
    return this.sql
      .exec<{ id: string; name: string; parent_id: string | null; created_at: string }>(
        `SELECT id, name, parent_id, created_at FROM folders ORDER BY name`,
      )
      .toArray()
      .map((f) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: f.created_at }));
  }

  private folderExists(id: string): boolean {
    return this.sql.exec(`SELECT 1 FROM folders WHERE id = ?`, id).toArray().length > 0;
  }

  // ----------------------------------------------------------------- helpers

  private rows(where: string, ...params: SqlStorageValue[]): DocumentRow[] {
    return this.sql
      .exec<DocumentRow>(`SELECT * FROM documents WHERE ${where} ORDER BY created_at, doc_id`, ...params)
      .toArray();
  }

  private readable(user: string, rows: DocumentRow[]): CatalogueEntry[] {
    return rows.filter((row) => allows(roleOf(user, permissionsOf(row)), "read")).map((row) => this.entry(row, user));
  }

  private entry(row: DocumentRow, user: string): CatalogueEntry {
    const tags = this.sql
      .exec<{ tag: string }>(`SELECT tag FROM doc_tags WHERE doc_id = ? ORDER BY tag`, row.doc_id)
      .toArray()
      .map((t) => t.tag);
    return {
      docId: row.doc_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      owner: row.owner,
      yourRole: roleOf(user, permissionsOf(row)),
      folderId: row.folder_id,
      tags,
    };
  }

  // ------------------------------------------------------- workspace settings

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

function permissionsOf(row: DocumentRow): DocPermissions {
  return { owner: row.owner, defaultRole: row.default_role, users: JSON.parse(row.acl) as Record<string, Role> };
}

function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
