/**
 * Worker entry point: a *stateless* router.
 *
 * The Worker holds no data of its own. For each API request it:
 *   1. matches the URL to a resource,
 *   2. derives that resource's deterministic cell name (addressing.ts),
 *   3. forwards the request to that one cell (Durable Object) and returns its response.
 *
 * Everything that must survive lives inside the cells' SQLite databases.
 * Non-API paths are served by the static-asset layer (the React app) and
 * normally never reach this code; see `assets` in wrangler.jsonc.
 */
import type { HealthResponse } from "../shared/api-types";
import { docCellName, isValidId, workspaceCellName } from "./addressing";
import { CELL_NAME_HEADER, errorResponse, json } from "./http";

export { DocCell } from "./cells/doc-cell";
export { WorkspaceCell } from "./cells/workspace-cell";

type Route =
  | { type: "health" }
  | { type: "workspace"; workspaceId: string }
  | { type: "doc"; workspaceId: string; docId: string };

export function matchRoute(pathname: string): Route | null {
  if (pathname === "/api/health") return { type: "health" };

  const parts = pathname.split("/").filter(Boolean); // ["api", "workspaces", ...]
  if (parts[0] !== "api" || parts[1] !== "workspaces") return null;

  const [, , workspaceId, docsSegment, docId] = parts;
  if (parts.length === 3 && isValidId(workspaceId)) {
    return { type: "workspace", workspaceId };
  }
  if (parts.length === 5 && docsSegment === "docs" && isValidId(workspaceId) && isValidId(docId)) {
    return { type: "doc", workspaceId, docId };
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
      case "doc":
        return forwardToCell(env.DOC_CELL, docCellName(route.workspaceId, route.docId), request);
    }
  },
} satisfies ExportedHandler<Env>;

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
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(name));

  const headers = new Headers({ [CELL_NAME_HEADER]: name });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  return stub.fetch("https://cell.internal/", {
    method: request.method,
    headers,
    body: request.body,
  });
}
