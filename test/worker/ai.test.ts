import { describe, expect, it } from "vitest";
import type { DocState, Proposal } from "../../src/shared/api-types";
import { LlmError, anthropic, freeCapableModels, gemini, listProviders, openrouter, openRouterAllowed, pickProvider, scrub, applyEdits, interpret, runAi } from "../../src/worker/llm";
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
  it("accepts a valid answer for a populated document", () => {
    const r = interpret("edit", TEXT, '{"summary":"Fix typo","edits":[{"find":"teh","replace":"the"}]}');
    expect(r.proposed).toBe(TEXT.replace("teh", "the"));
    expect(r.summary).toBe("Fix typo");
  });
  it("rejects malformed JSON and missing fields, naming the fields needed", () => {
    expect(() => interpret("edit", "x", '{"summary":"s","edits":[}')).toThrow(/malformed JSON/);
    expect(() => interpret("edit", "x", '{"summary":"s"}')).toThrow(/needs summary, edits/);
    expect(() => interpret("edit", "x", '{"edits":[]}')).toThrow(/needs summary, edits/);
    expect(() => interpret("edit", "x", '{"summary":"s","edits":[{"find":"x"}]}')).toThrow(/expected shape/);
    expect(() => interpret("summarise", "x", "{}")).toThrow(/needs summary/);
  });
  it("lets the model insert into an empty document, and only there", async () => {
    expect(interpret("edit", "", '{"summary":"Intro","edits":[{"find":"","replace":"# Hi\\n"}]}').proposed).toBe("# Hi\n");
    expect(interpret("edit", "", '{"summary":"None","edits":[]}').proposed).toBe("");
    expect(() => interpret("edit", "text", '{"summary":"s","edits":[{"find":"","replace":"y"}]}')).toThrow(LlmError);
    expect(() => interpret("edit", "", '{"summary":"s","edits":[{"find":"","replace":"a"},{"find":"","replace":"b"}]}')).toThrow(LlmError);
  });
  it("refuses to summarise an empty document without calling the model", async () => {
    const never: () => Promise<string> = async () => { throw new Error("model called"); };
    await expect(runAi({}, "summarise", "", "  \n", never)).rejects.toMatchObject({ code: "empty_document", status: 422 });
  });
  it("sends Gemini a response schema and still validates the reply", async () => {
    let body: any;
    const fetchStub = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({ candidates: [{ content: { parts: [{ text: '{"summary":"s"}' }] } }] });
    }) as unknown as typeof fetch;
    const r = await runAi({}, "summarise", "", "Body.", gemini("k", "m", fetchStub));
    expect(body.generationConfig.responseSchema.required).toEqual(["summary"]);
    expect(r.proposed).toContain("## Summary");
    await expect(runAi({}, "edit", "x", "t", gemini("k", "m", (async () => Response.json({ candidates: [{ content: { parts: [{ text: '{"summary":"s"}' }] } }] })) as unknown as typeof fetch))).rejects.toMatchObject({ code: "bad_model_output" });
  });
  it("summarise puts a Summary section first", () => {
    expect(interpret("summarise", "Body.", '{"summary":"- short"}').proposed).toBe("## Summary\n\n- short\n\nBody.");
  });
  it("reports a missing key without calling anything", async () => {
    await expect(runAi({}, "edit", "x", "t")).rejects.toMatchObject({ code: "ai_not_configured" });
  });
  it("selects Gemini by key or LLM_PROVIDER, and reports a missing Gemini key", async () => {
    await expect(runAi({ LLM_PROVIDER: "gemini" }, "edit", "x", "t")).rejects.toMatchObject({ code: "ai_not_configured", message: /GEMINI_API_KEY/ });
    await expect(runAi({ LLM_PROVIDER: "other" }, "edit", "x", "t")).rejects.toMatchObject({ code: "ai_not_configured" });
  });
  it("calls the Gemini API with the key in a header, never the URL", async () => {
    let seen: { url: string; key: string | null; body: any } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, key: new Headers(init.headers).get("x-goog-api-key"), body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summary":"- ok"}' }] } }] }));
    }) as unknown as typeof fetch;
    expect(await gemini("g", "gemini-x", fake)("sys", "usr")).toBe('{"summary":"- ok"}');
    expect(seen!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(seen).toMatchObject({ key: "g", body: { systemInstruction: { parts: [{ text: "sys" }] } } });
  });
  it("explains provider failures usefully without leaking the key", async () => {
    const failing = (status: number, message: string) =>
      (async () => new Response(JSON.stringify({ error: { status: "NOT_FOUND", message } }), { status })) as unknown as typeof fetch;
    const err = await gemini("AIzaSECRETSECRETSECRET", "old-model", failing(404, "models/old-model is gone, key AIzaSECRETSECRETSECRET"))("s", "u").catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toMatch(/Gemini \(old-model\) request failed \(404\).*LLM_MODEL.*is gone/);
    expect(err.message).not.toContain("SECRET");
    const down = (async () => { throw new Error("boom AIzaSECRETSECRETSECRET"); }) as unknown as typeof fetch;
    const unreachable = await anthropic("sk-ant-secretsecretsecret", "m", down)("s", "u").catch((e) => e);
    expect(unreachable.code).toBe("model_unreachable");
    expect(unreachable.message).not.toContain("secret");
    expect(scrub("x sk-ant-abcdefghijklmnop y")).toBe("x [redacted] y");
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

describe("OpenRouter and provider selection", () => {
  it("calls OpenRouter with one model, the key in a header, and validates the reply", async () => {
    let seen: { url: string; auth: string | null; body: any } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) };
      return Response.json({ choices: [{ message: { content: '{"summary":"s","edits":[]}' } }] });
    }) as unknown as typeof fetch;
    expect(await openrouter("sk-or-k", "meta/x:free", fake)("sys", "usr")).toBe('{"summary":"s","edits":[]}');
    expect(seen!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen!.auth).toBe("Bearer sk-or-k");
    expect(seen!.body.model).toBe("meta/x:free");
    expect(seen!.body.models).toBeUndefined(); // no fallback list: never moves to another model
    await expect(runAi({}, "edit", "x", "t", openrouter("k", "m/x:free", (async () => Response.json({ choices: [{ message: { content: '{"summary":"s"}' } }] })) as unknown as typeof fetch))).rejects.toMatchObject({ code: "bad_model_output" });
  });
  it("explains OpenRouter rate limits, unavailable models and in-body errors without leaking the key", async () => {
    const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const limited = await openrouter("sk-or-secretsecret1", "m/x:free", respond(429, { error: { message: "rate limited sk-or-secretsecret1" } }))("s", "u").catch((e) => e);
    expect(limited.message).toMatch(/OpenRouter \(m\/x:free\) request failed \(429\).*rate limit.*another model/);
    expect(limited.message).not.toContain("secretsecret1");
    const gone = await openrouter("k", "m/x:free", respond(404, { error: { message: "No endpoints found" } }))("s", "u").catch((e) => e);
    expect(gone.message).toMatch(/\(404\).*pick another model/);
    const inBody = await openrouter("k", "m/x:free", respond(200, { error: { code: 502, message: "upstream down" } }))("s", "u").catch((e) => e);
    expect(inBody).toMatchObject({ code: "model_error", message: /upstream down/ });
  });
  it("only allows free OpenRouter models unless the operator lists a paid one", async () => {
    const env = { OPENROUTER_API_KEY: "k" };
    expect(openRouterAllowed(env, "meta/llama:free")).toBe(true);
    expect(openRouterAllowed(env, "openai/gpt-5")).toBe(false);
    expect(openRouterAllowed({ ...env, OPENROUTER_MODELS: "openai/gpt-5" }, "openai/gpt-5")).toBe(true);
    expect(() => pickProvider(env, { provider: "openrouter", model: "openai/gpt-5" })).toThrow(/not an allowed OpenRouter model/);
    expect(() => pickProvider(env, { provider: "openrouter" })).toThrow(/Choose an OpenRouter model/);
    expect(() => pickProvider({}, { provider: "openrouter", model: "a/b:free" })).toThrow(/OPENROUTER_API_KEY/);
    expect(() => pickProvider({ LLM_PROVIDER: "openrouter", GEMINI_API_KEY: "g" }, { provider: "gemini" })).not.toThrow();
  });
  it("lists only free models that support structured output and tools; no key in the listing", async () => {
    expect(
      freeCapableModels([
        { id: "a/ok:free", supported_parameters: ["tools", "structured_outputs"] },
        { id: "a/notools:free", supported_parameters: ["structured_outputs"] },
        { id: "a/nostruct:free", supported_parameters: ["tools"] },
        { id: "a/paid", pricing: { prompt: "0.1", completion: "0.2" }, supported_parameters: ["tools", "structured_outputs"] },
        { id: "a/zero", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools", "response_format"] },
      ]),
    ).toEqual(["a/ok:free", "a/zero"]);
    // Before the success below: a good answer is cached for a few minutes.
    const down = await listProviders({ OPENROUTER_API_KEY: "k", OPENROUTER_MODELS: "q/x:free" }, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(down.providers.find((p) => p.id === "openrouter")).toMatchObject({ models: ["q/x:free"], note: expect.stringMatching(/Could not fetch/) });
    const fetchStub = (async () => Response.json({ data: [{ id: "z/free-one:free", supported_parameters: ["tools", "structured_outputs"] }] })) as unknown as typeof fetch;
    const out = await listProviders({ GEMINI_API_KEY: "gem-secret", OPENROUTER_API_KEY: "or-secret", OPENROUTER_MODEL: "z/default:free" }, fetchStub);
    expect(out.providers.find((p) => p.id === "openrouter")).toMatchObject({ configured: true, models: expect.arrayContaining(["z/free-one:free", "z/default:free"]) });
    expect(out.providers.find((p) => p.id === "gemini")!.configured).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });
  it("accepts the picked provider on proposals and chart suggestions (mock model), rejects unknown providers", async () => {
    const path = await newDoc();
    const ok = await api<Proposal>("POST", `${path}/proposals`, { action: "ai", mode: "edit", instruction: "replace teh with the", provider: "openrouter", model: "mock/free-model:free" }, "alice");
    expect(ok.status).toBe(201);
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "edit", instruction: "x", provider: "evil" }, "alice")).status).toBe(400);
    const providers = await api<any>("GET", "/api/ai/providers");
    expect(providers.status).toBe(200);
    expect(providers.data.providers.map((p: any) => p.id)).toEqual(["gemini", "openrouter"]);
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
  it("summarising an empty document is a clear 422, editing it works", async () => {
    const path = await newDoc("");
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "summarise", instruction: "" }, "alice")).status).toBe(422);
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "edit", instruction: "replace nothing with anything" }, "alice")).status).not.toBe(500);
  });
  it("respects permissions and validates input", async () => {
    const path = await newDoc();
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: {} }, "alice");
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "summarise", instruction: "" }, "bob")).status).toBe(403);
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "edit", instruction: "  " }, "alice")).status).toBe(422);
    expect((await api("POST", `${path}/proposals`, { action: "ai", mode: "bogus", instruction: "" }, "alice")).status).toBe(400);
  });
});
