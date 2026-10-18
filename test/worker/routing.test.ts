import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ApiError, DocState, HealthResponse, WorkspaceState } from "../../src/shared/api-types";
import { docCellName, workspaceCellName } from "../../src/worker/addressing";
import { matchRoute } from "../../src/worker/index";
import { api, uniqueId } from "./helpers";

describe("matchRoute", () => {
  it("recognises the supported routes", () => {
    expect(matchRoute("/api/health")).toEqual({ type: "health" });
    expect(matchRoute("/api/workspaces/acme")).toEqual({ type: "workspace", workspaceId: "acme" });
    expect(matchRoute("/api/workspaces/acme/docs/intro")).toEqual({
      type: "doc",
      workspaceId: "acme",
      docId: "intro",
    });
    expect(matchRoute("/api/workspaces/acme/docs")).toEqual({ type: "docs", workspaceId: "acme" });
  });

  it("rejects everything else", () => {
    for (const path of [
      "/",
      "/api",
      "/api/workspaces",
      "/api/workspaces/Bad_Id",
      "/api/workspaces/Bad_Id/docs",
      "/api/workspaces/acme/files/intro",
      "/api/workspaces/acme/docs/intro/extra",
      "/other/workspaces/acme",
    ]) {
      expect(matchRoute(path), path).toBeNull();
    }
  });
});

describe("router", () => {
  it("answers health checks without touching any cell", async () => {
    const { status, data } = await api<HealthResponse>("GET", "/api/health");
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("returns a JSON 404 for unknown API paths", async () => {
    const { status, data } = await api<ApiError>("GET", "/api/nope");
    expect(status).toBe(404);
    expect(data.error.code).toBe("not_found");
  });

  it("routes a workspace request to the WorkspaceCell named after it", async () => {
    const ws = uniqueId("ws");
    const { status, data } = await api<WorkspaceState>("PUT", `/api/workspaces/${ws}`, { displayName: "Routing test" });

    expect(status).toBe(201);
    expect(data.cell.kind).toBe("workspace");
    expect(data.cell.name).toBe(workspaceCellName(ws));
    expect(data.cell.id).toBe(env.WORKSPACE_CELL.idFromName(workspaceCellName(ws)).toString());
  });

  it("routes a doc request to the DocCell named after workspace + doc", async () => {
    const ws = uniqueId("ws");
    const doc = uniqueId("doc");
    const { status, data } = await api<DocState>("PUT", `/api/workspaces/${ws}/docs/${doc}`, { body: "hi" });

    expect(status).toBe(201);
    expect(data.cell.kind).toBe("doc");
    expect(data.cell.name).toBe(docCellName(ws, doc));
    expect(data.cell.id).toBe(env.DOC_CELL.idFromName(docCellName(ws, doc)).toString());
  });

  it("ignores a client-supplied cell-name header", async () => {
    const ws = uniqueId("ws");
    const response = await exports.default.fetch(
      `https://example.test/api/workspaces/${ws}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", "x-cell-name": "workspace:someone-else" },
        body: JSON.stringify({ displayName: "Spoof attempt" }),
      },
    );
    const data = (await response.json()) as WorkspaceState;
    expect(data.cell.name).toBe(workspaceCellName(ws));
  });
});
