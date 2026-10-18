import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { docCellName, isValidId, parseCellName, workspaceCellName } from "../../src/worker/addressing";

describe("cell names", () => {
  it("derives names from resource ids", () => {
    expect(workspaceCellName("acme")).toBe("workspace:acme");
    expect(docCellName("acme", "intro")).toBe("doc:acme/intro");
  });

  it("round-trips through parseCellName", () => {
    expect(parseCellName(workspaceCellName("ws-1"))).toEqual({ kind: "workspace", workspaceId: "ws-1" });
    expect(parseCellName(docCellName("ws-1", "doc-2"))).toEqual({
      kind: "doc",
      workspaceId: "ws-1",
      docId: "doc-2",
    });
  });

  it("rejects malformed names and ids", () => {
    for (const bad of [null, "", "workspace:", "workspace:UPPER", "doc:a", "doc:a/b/c", "other:a", "workspace:a/b"]) {
      expect(parseCellName(bad)).toBeNull();
    }
    for (const bad of ["", "-leading-dash", "Has_Upper", "a/b", "x".repeat(64), "spa ce"]) {
      expect(isValidId(bad)).toBe(false);
      expect(() => workspaceCellName(bad)).toThrow();
    }
    expect(isValidId("x".repeat(63))).toBe(true);
  });
});

describe("deterministic addressing", () => {
  it("maps the same name to the same Durable Object id every time", () => {
    const name = docCellName("acme", "intro");
    const first = env.DOC_CELL.idFromName(name).toString();
    const second = env.DOC_CELL.idFromName(name).toString();
    expect(first).toBe(second);
  });

  it("maps different names to different ids", () => {
    const ids = new Set([
      env.DOC_CELL.idFromName(docCellName("acme", "intro")).toString(),
      env.DOC_CELL.idFromName(docCellName("acme", "other")).toString(),
      env.DOC_CELL.idFromName(docCellName("globex", "intro")).toString(),
    ]);
    expect(ids.size).toBe(3);
  });
});
