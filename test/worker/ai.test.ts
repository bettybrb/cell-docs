import { describe, expect, it } from "vitest";
import type { DocState, Proposal } from "../../src/shared/api-types";
import { LlmError, anthropic, applyEdits, interpret, runAi } from "../../src/worker/llm";
import { api, uniqueId } from "./helpers";

const TEXT = "Intro line.\nThe teh cat sat.\nEnd.\n";

async function newDoc(body = TEXT) {
  const [ws, doc] = [uniqueId("ws"), uniqueId("doc")];
  const path = `/api/workspaces/${ws}/docs/${doc}`;
  await api("PUT", path, { title: "Notes", body }, "alice");
  return path;
}

describe("llm output validation", () => {
  it("applies unique, non-overlapping edits", () => {
    expect(applyEdits("a b c", [{ find: "b", replace: "X" }, { find: "a", replace: "Y" }])).toBe("Y X c");
  });
  it("rejects missing, ambiguous and overlapping edits", () => {
    expect(() => applyEdits("a a", [{ find: "a", replace: "x" }])).toThrow(LlmError);
    expect(() => applyEdits("abc", [{ find: "z", replace: "x" }])).toThrow(LlmError);
    expect(() => applyEdits("abc", [{ find: "ab", replace: "x" }, { find: "bc", replace: "y" }])).toThrow(LlmError);
  });
  it("rejects non-JSON and wrongly shaped output, accepts fenced JSON", () => {
    expect(() => interpret("edit", "x", "sorry I cannot")).toThrow(LlmError);
    expect(() => interpret("edit", "x", '{"summary":1,"edits":[]}')).toThrow(LlmError);
    expect(() => interpret("edit", "x", '{"summary":"s","edits":[{"find":"","replace":"y"}]}')).toThrow(LlmError);
    expect(interpret("edit", "x y", '```json\n{"summary":"s","edits":[{"find":"y","replace":"z"}]}\n```').proposed).toBe("x z");
  });
  it("summarise puts a Summary section first", () => {
    expect(interpret("summarise", "Body.", '{"summary":"- short"}').proposed).toBe("## Summary\n\n- short\n\nBody.");
  });
  it("reports a missing key without calling anything", async () => {
    await expect(runAi({}, "edit", "x", "t")).rejects.toMatchObject({ code: "ai_not_configured" });
  });
  it("calls the Anthropic API with the key server-side", async () => {
    let seen: { url: string; key: string | null; body: any } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, key: new Headers(init.headers).get("x-api-key"), body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ content: [{ type: "text", text: '{"summary":"s","edits":[]}' }] }));
    }) as unknown as typeof fetch;
    await anthropic("k", "m", fake)("sys", "usr");
    expect(seen).toMatchObject({ url: "https://api.anthropic.com/v1/messages", key: "k", body: { model: "m", system: "sys" } });
  });
});

describe("AI proposals", () => {
  it("proposes an edit from natural language, applied only after approval", async () => {
    const path = await newDoc();
    const r = await api<Proposal>("POST", `${path}/proposals`, { action: "ai", mode: "edit", instruction: "replace teh with the" }, "alice");
    expect(r.status).toBe(201);
    expect(r.data).toMatchObject({ agent: "ai", status: "pending", instruction: "AI: replace teh with the" });
    expect((await api<DocState>("GET", path)).data.body).toBe(TEXT);
    expect((await api("POST", `${path}/proposals/${r.data.id}/apply`, undefined, "alice")).status).toBe(200);
    expect((await api<DocState>("GET", path)).data.body).toContain("The the cat");
  });
  it("summarises", async () => {
    const path = await newDoc("First para here.\n\nSecond para.\n");
    const r = await api<Proposal>("POST", `${path}/proposals`, { action: "ai", mode: "summarise", instruction: "" }, "alice");
    expect(r.status).toBe(201);
    expect(r.data.changes[0]!.replacement).toContain("## Summary");
  });
  it("respects permissions and validates input", async () => {
    const path = await newDoc();
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: {} }, "alice");
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "summarise", instruction: "" }, "bob")).status).toBe(403);
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "edit", instruction: "  " }, "alice")).status).toBe(422);
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "bogus", instruction: "" }, "alice")).status).toBe(400);
  });
});
