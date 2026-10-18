/**
 * Worker entry point: a *stateless* router.
 *
 * The Worker holds no data of its own. For each API request it:
 *   1. matches the URL to a resource,
 *   2. derives that resource's deterministic cell name (addressing.ts),
 *   3. forwards the request to that one cell (Durable Object) and returns its response.
 *
 * Document requests touch two cells: the DocCell answers, then the router
 * registers the document in its WorkspaceCell's catalogue (see `routeDoc`).
 *
 * Everything that must survive lives inside the cells' SQLite databases.
 * Non-API paths are served by the static-asset layer (the React app) and
 * normally never reach this code; see `assets` in wrangler.jsonc.
 */
import type { DocState, HealthResponse } from "../shared/api-types";
import { docCellName, isValidId, workspaceCellName } from "./addressing";
import { CELL_NAME_HEADER, errorResponse, json } from "./http";

export { DocCell } from "./cells/doc-cell";
export { WorkspaceCell } from "./cells/workspace-cell";

type Route =
  | { type: "health" }
  | { type: "workspace"; workspaceId: string }
  | { type: "docs"; workspaceId: string }
  | { type: "doc"; workspaceId: string; docId: string }
  | { type: "doc-sync"; workspaceId: string; docId: string };

export function matchRoute(pathname: string): Route | null {
  if (pathname === "/api/health") return { type: "health" };

  const parts = pathname.split("/").filter(Boolean); // ["api", "workspaces", ...]
  if (parts[0] !== "api" || parts[1] !== "workspaces") return null;

  const [, , workspaceId, docsSegment, docId, syncSegment] = parts;
  if (parts.length === 3 && isValidId(workspaceId)) {
    return { type: "workspace", workspaceId };
  }
  if (parts.length === 4 && docsSegment === "docs" && isValidId(workspaceId)) {
    return { type: "docs", workspaceId };
  }
  if (parts.length === 5 && docsSegment === "docs" && isValidId(workspaceId) && isValidId(docId)) {
    return { type: "doc", workspaceId, docId };
  }
  if (parts.length === 6 && docsSegment === "docs" && syncSegment === "sync" && isValidId(workspaceId) && isValidId(docId)) {
    return { type: "doc-sync", workspaceId, docId };
  }
  return null;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);

    if (!route) {
      return errorResponse(404, "not_found", `No route for ${url.pathname}.`);
    }

    switch (route.type) {
      case "health": {
        const body: HealthResponse = { ok: true, service: "cell-docs-lab", time: new Date().toISOString() };
        return json(body);
      }
      case "workspace":
        return forwardToCell(env.WORKSPACE_CELL, workspaceCellName(route.workspaceId), request);
      case "docs":
        return forwardToCell(env.WORKSPACE_CELL, workspaceCellName(route.workspaceId), request, "/docs");
      case "doc":
        return routeDoc(env, route.workspaceId, route.docId, request);
      case "doc-sync":
        // WebSocket upgrade: only the Upgrade header is passed on, no body.
        return callCell(env.DOC_CELL, docCellName(route.workspaceId, route.docId), "/sync", {
          method: "GET",
          headers: { upgrade: request.headers.get("upgrade") ?? "" },
          body: null,
        });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Sends a doc request to its DocCell, then makes sure the document is in the
 * workspace catalogue.
 *
 * The DocCell is written first, so a document is never listed before it
 * exists. Registration runs after every successful read or write and is
 * idempotent, which means:
 *   - documents created before the catalogue existed (Phase 1) are added the
 *     first time they are read or saved;
 *   - if registration fails, the document is already saved, and retrying the
 *     GET or PUT registers it.
 */
async function routeDoc(env: Env, workspaceId: string, docId: string, request: Request): Promise<Response> {
  const response = await forwardToCell(env.DOC_CELL, docCellName(workspaceId, docId), request);
  if (response.status !== 200 && response.status !== 201) return response;

  const doc = (await response.clone().json()) as DocState;
  const failure = await registerDoc(env, workspaceId, docId, doc.createdAt);
  if (failure) {
    return errorResponse(
      502,
      "catalogue_registration_failed",
      `Document ${docId} is stored (revision ${doc.revision}), but adding it to the workspace catalogue failed ` +
        `(${failure}). Retry the request: registration is safe to repeat.`,
    );
  }
  return response;
}

/** Registers a doc in its workspace catalogue. Returns a failure reason, or null on success. */
async function registerDoc(env: Env, workspaceId: string, docId: string, createdAt: string): Promise<string | null> {
  try {
    const response = await callCell(env.WORKSPACE_CELL, workspaceCellName(workspaceId), `/docs/${docId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ createdAt }),
    });
    return response.ok ? null : `workspace cell answered ${response.status}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Sends the request to the single cell identified by `name`.
 *
 * Only the method, body and content type are forwarded. The cell name travels
 * in a header the router sets itself, so a client cannot spoof which cell it
 * is talking to.
 */
function forwardToCell(
  namespace: DurableObjectNamespace,
  name: string,
  request: Request,
  cellPath = "/",
): Promise<Response> {
  const contentType = request.headers.get("content-type");
  return callCell(namespace, name, cellPath, {
    method: request.method,
    headers: contentType ? { "content-type": contentType } : {},
    body: request.body,
  });
}

/** Calls one cell at an internal path, always stamping the router-chosen cell name. */
function callCell(
  namespace: DurableObjectNamespace,
  name: string,
  cellPath: string,
  init: { method: string; headers: Record<string, string>; body: BodyInit | null },
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(name));
  return stub.fetch(`https://cell.internal${cellPath}`, {
    ...init,
    headers: { ...init.headers, [CELL_NAME_HEADER]: name },
  });
}
