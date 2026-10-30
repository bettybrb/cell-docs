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
 * Every request acts as a test user (see src/shared/users.ts). The router
 * passes it to the cell in a header it sets itself, like the cell name; the
 * cells enforce permissions.
 *
 * Everything that must survive lives inside the cells' SQLite databases.
 * Non-API paths are served by the static-asset layer (the React app) and
 * normally never reach this code; see `assets` in wrangler.jsonc.
 */
import { Effect } from "effect";
import type { DocState, HealthResponse } from "../shared/api-types";
import { DEFAULT_USER, isTestUser, TEST_USER_HEADER, TEST_USERS } from "../shared/users";
import { docCellName, isValidId, sheetCellName, workspaceCellName } from "./addressing";
import { catalogueCopy } from "./catalogue-copy";
import { CELL_NAME_HEADER, errorResponse, json, USER_HEADER } from "./http";
import { registerInCatalogue } from "./register-doc";

export { DocCell } from "./cells/doc-cell";
export { SheetCell } from "./cells/sheet-cell";
export { WorkspaceCell } from "./cells/workspace-cell";

type Route =
  | { type: "health" }
  | { type: "workspace"; workspaceId: string }
  | { type: "docs"; workspaceId: string }
  | { type: "doc"; workspaceId: string; docId: string }
  | { type: "doc-sync"; workspaceId: string; docId: string }
  | { type: "sheets"; workspaceId: string }
  | { type: "sheet-action"; workspaceId: string; sheetId: string; cellPath: string }
  | { type: "sheet-sync"; workspaceId: string; sheetId: string }
  /** Another path on a DocCell. `register`: refresh the catalogue copy afterwards. */
  | { type: "doc-action"; workspaceId: string; docId: string; cellPath: string; register: boolean }
  /** Another path on the WorkspaceCell (Recycle Bin, search, folders, folder and tags of a doc). */
  | { type: "catalogue"; workspaceId: string; cellPath: string };

export function matchRoute(pathname: string): Route | null {
  if (pathname === "/api/health") return { type: "health" };

  const parts = pathname.split("/").filter(Boolean); // ["api", "workspaces", ...]
  if (parts[0] !== "api" || parts[1] !== "workspaces") return null;

  const [, , workspaceId, section, id, action, versionId, restore] = parts;
  if (!isValidId(workspaceId)) return null;
  if (parts.length === 3) return { type: "workspace", workspaceId };

  if (section === "docs") {
    if (parts.length === 4) return { type: "docs", workspaceId };
    if (!isValidId(id)) return null;
    const docId = id;
    if (parts.length === 5) return { type: "doc", workspaceId, docId };
    const doc = (cellPath: string, register: boolean): Route => ({ type: "doc-action", workspaceId, docId, cellPath, register });
    if (parts.length === 6) {
      switch (action) {
        case "sync":
          return { type: "doc-sync", workspaceId, docId };
        case "restore": // out of the Recycle Bin
          return doc("/restore", true);
        case "purge": // the DocCell removes its own catalogue entry
          return doc("/purge", false);
        case "permissions":
          return doc("/permissions", true);
        case "comments":
          return doc("/comments", false);
        case "proposals": // asking the simulated agent, and listing what it proposed
          return doc("/proposals", false);
        case "versions":
          return doc("/versions", false);
        case "meta": // folder and tags live in the catalogue
          return { type: "catalogue", workspaceId, cellPath: `/docs/${docId}/meta` };
      }
      return null;
    }
    if (action === "versions" && /^\d+$/.test(versionId)) {
      if (parts.length === 7) return doc(`/versions/${versionId}`, false);
      if (parts.length === 8 && restore === "restore") return doc(`/versions/${versionId}/restore`, true);
    }
    // /comments/<thread>/(replies|resolve) and /proposals/<id>/(apply|discard)
    if (parts.length === 8 && /^\d+$/.test(versionId)) {
      const step = restore;
      if (action === "comments" && (step === "replies" || step === "resolve")) {
        return doc(`/comments/${versionId}/${step}`, false);
      }
      if (action === "proposals" && (step === "apply" || step === "discard")) {
        // Applying changes the text like a save, so the catalogue copy is refreshed.
        return doc(`/proposals/${versionId}/${step}`, step === "apply");
      }
    }
    return null;
  }
  if (section === "sheets") {
    if (parts.length === 4) return { type: "sheets", workspaceId };
    if (!isValidId(id)) return null;
    const sheetId = id;
    const sheet = (cellPath: string): Route => ({ type: "sheet-action", workspaceId, sheetId, cellPath });
    if (parts.length === 5) return sheet("/");
    if (parts.length === 6) {
      if (action === "sync") return { type: "sheet-sync", workspaceId, sheetId };
      if (action === "cells" || action === "permissions" || action === "charts") return sheet(`/${action}`);
    }
    if (parts.length === 7 && action === "charts" && /^[a-z0-9-]+$/.test(versionId)) return sheet(`/charts/${versionId}`);
    return null;
  }
  if ((section === "trash" || section === "search") && parts.length === 4) {
    return { type: "catalogue", workspaceId, cellPath: `/${section}` };
  }
  if (section === "folders") {
    if (parts.length === 4) return { type: "catalogue", workspaceId, cellPath: "/folders" };
    if (parts.length === 5 && isValidId(id)) return { type: "catalogue", workspaceId, cellPath: `/folders/${id}` };
  }
  return null;
}

/**
 * The test user a request acts as: the `x-test-user` header, or `?user=`
 * (browsers cannot set headers on a WebSocket), else the default user.
 */
function identify(request: Request, url: URL): string | Response {
  const user = request.headers.get(TEST_USER_HEADER) ?? url.searchParams.get("user") ?? DEFAULT_USER;
  if (!isTestUser(user)) {
    return errorResponse(400, "unknown_user", `Unknown test user ${user}; use one of ${TEST_USERS.join(", ")}.`);
  }
  return user;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(url.pathname);

    if (!route) {
      return errorResponse(404, "not_found", `No route for ${url.pathname}.`);
    }
    if (route.type === "health") {
      const body: HealthResponse = { ok: true, service: "cell-docs-lab", time: new Date().toISOString() };
      return json(body);
    }
    const user = identify(request, url);
    if (user instanceof Response) return user;

    switch (route.type) {
      case "workspace":
        return forwardToCell(env.WORKSPACE_CELL, workspaceCellName(route.workspaceId), request, user);
      case "docs":
        return forwardToCell(env.WORKSPACE_CELL, workspaceCellName(route.workspaceId), request, user, "/docs");
      case "catalogue":
        // Keep the query string: search reads its parameters from it.
        return forwardToCell(env.WORKSPACE_CELL, workspaceCellName(route.workspaceId), request, user, route.cellPath + url.search);
      case "doc":
        return routeDoc(env, route.workspaceId, route.docId, request, user, "/");
      case "doc-action":
        return route.register
          ? routeDoc(env, route.workspaceId, route.docId, request, user, route.cellPath)
          : forwardToCell(env.DOC_CELL, docCellName(route.workspaceId, route.docId), request, user, route.cellPath);
      case "sheets":
        return forwardToCell(env.WORKSPACE_CELL, workspaceCellName(route.workspaceId), request, user, "/sheets");
      case "sheet-action":
        return forwardToCell(env.SHEET_CELL, sheetCellName(route.workspaceId, route.sheetId), request, user, route.cellPath);
      case "sheet-sync":
        return callCell(env.SHEET_CELL, sheetCellName(route.workspaceId, route.sheetId), user, "/sync", {
          method: "GET",
          headers: { upgrade: request.headers.get("upgrade") ?? "" },
          body: null,
        });
      case "doc-sync":
        // WebSocket upgrade: only the Upgrade header is passed on, no body.
        return callCell(env.DOC_CELL, docCellName(route.workspaceId, route.docId), user, "/sync", {
          method: "GET",
          headers: { upgrade: request.headers.get("upgrade") ?? "" },
          body: null,
        });
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * Sends a doc request to its DocCell, then makes sure the document's entry
 * in the workspace catalogue is current (title, text for search,
 * permissions, Recycle Bin state).
 *
 * The DocCell is written first, so a document is never listed before it
 * exists. Registration runs after every successful request here and is
 * idempotent, which means:
 *   - documents created before the catalogue existed (Phase 1) are added the
 *     first time they are read or saved;
 *   - registration is retried briefly on temporary failures (register-doc.ts);
 *   - if it still fails, the document is already saved, and retrying the GET
 *     or PUT registers it.
 *
 * The DocCell call itself is neither retried nor timed out: a PUT raises the
 * revision, so repeating it could apply a save twice.
 */
function routeDoc(
  env: Env,
  workspaceId: string,
  docId: string,
  request: Request,
  user: string,
  cellPath: string,
): Promise<Response> {
  const program = Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      forwardToCell(env.DOC_CELL, docCellName(workspaceId, docId), request, user, cellPath),
    );
    if (response.status !== 200 && response.status !== 201) return response;

    const doc = yield* Effect.promise(() => response.clone().json() as Promise<DocState>);
    return yield* registerInCatalogue(() =>
      callCell(env.WORKSPACE_CELL, workspaceCellName(workspaceId), user, `/docs/${docId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(catalogueCopy(doc)),
      }),
    ).pipe(
      Effect.as(response),
      Effect.catchTag("RegistrationFailed", (failure) =>
        Effect.succeed(
          errorResponse(
            502,
            "catalogue_registration_failed",
            `Document ${docId} is stored (revision ${doc.revision}), but adding it to the workspace catalogue ` +
              `failed (${failure.reason}). Retry the request: registration is safe to repeat.`,
          ),
        ),
      ),
    );
  });
  // Every typed failure is handled above, so this only rejects on an unexpected
  // exception (for example the DocCell call throwing), as before.
  return Effect.runPromise(program);
}

/**
 * Sends the request to the single cell identified by `name`.
 *
 * Only the method, body and content type are forwarded. The cell name and
 * the user travel in headers the router sets itself, so a client cannot
 * spoof which cell it is talking to, or bypass the user check.
 */
function forwardToCell(
  namespace: DurableObjectNamespace,
  name: string,
  request: Request,
  user: string,
  cellPath = "/",
): Promise<Response> {
  const contentType = request.headers.get("content-type");
  return callCell(namespace, name, user, cellPath, {
    method: request.method,
    headers: contentType ? { "content-type": contentType } : {},
    body: request.body,
  });
}

/** Calls one cell at an internal path, always stamping the router-chosen cell name and user. */
function callCell(
  namespace: DurableObjectNamespace,
  name: string,
  user: string,
  cellPath: string,
  init: { method: string; headers: Record<string, string>; body: BodyInit | null },
): Promise<Response> {
  const stub = namespace.get(namespace.idFromName(name));
  return stub.fetch(`https://cell.internal${cellPath}`, {
    ...init,
    headers: { ...init.headers, [CELL_NAME_HEADER]: name, [USER_HEADER]: user },
  });
}
