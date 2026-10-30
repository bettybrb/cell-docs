import { Schema } from "effect";
import type { ProviderInfo, ProvidersResponse } from "../shared/api-types";
import type { ChartConfig } from "../shared/sheet";

/** Secrets and settings for the model; the key lives only in the Worker's env (.dev.vars / wrangler secret). */
export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** "anthropic" or "gemini"; by default whichever key is set (Anthropic first). */
  LLM_PROVIDER?: string;
  /** "1" uses a deterministic stand-in model, for tests and offline demos. */
  LLM_MOCK?: string;
  LLM_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  /** Default OpenRouter model, and any extra models (comma-separated) to offer; paid ones only if listed here. */
  OPENROUTER_MODEL?: string;
  OPENROUTER_MODELS?: string;
  /** Extra Gemini models (comma-separated) to offer. */
  GEMINI_MODELS?: string;
}

/** A provider and model picked in the UI; either part may be missing (the server default applies). */
export interface LlmChoice {
  provider?: "gemini" | "openrouter";
  model?: string;
}

export type AiMode = "edit" | "summarise";

export class LlmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

const MAX_EDITS = 20;
const EditOutput = Schema.Struct({
  summary: Schema.String,
  edits: Schema.Array(
    Schema.Struct({
      // May be "" only to insert into an empty document; applyEdits enforces that.
      find: Schema.String,
      replace: Schema.String,
    }),
  ).check(Schema.isMaxLength(MAX_EDITS)),
});
const SummaryOutput = Schema.Struct({ summary: Schema.String.check(Schema.isMinLength(1)) });

const SYSTEM = {
  edit: `You edit a Markdown document for a user. Reply with ONLY a JSON object: {"summary": string, "edits": [{"find": string, "replace": string}]}. Each "find" must be an exact, unique substring of the document (include enough context to be unique); "replace" is its replacement. Make the smallest edits that satisfy the instruction. If the document is empty, reply with a single edit whose "find" is "" and whose "replace" is the new text. Never include anything outside the JSON.`,
  summarise: `You summarise a Markdown document. Reply with ONLY a JSON object: {"summary": string} where summary is 2-5 concise Markdown bullet points ("- ..."). Never include anything outside the JSON.`,
} as const;

/** Extracts the first JSON object in a model reply (tolerating code fences). */
export function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new LlmError("bad_model_output", "The model did not return JSON.");
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new LlmError("bad_model_output", "The model returned malformed JSON.");
  }
}

function validate<S extends Schema.Decoder<unknown>>(schema: S, value: unknown, fields: string): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new LlmError("bad_model_output", `The model's answer did not match the expected shape (needs ${fields}).`);
  }
}

/** Gemini structured-output schemas (OpenAPI subset); the server-side validation above still decides. */
const EDIT_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    edits: { type: "ARRAY", items: { type: "OBJECT", properties: { find: { type: "STRING" }, replace: { type: "STRING" } }, required: ["find", "replace"] } },
  },
  required: ["summary", "edits"],
};
const SUMMARY_JSON_SCHEMA = { type: "OBJECT", properties: { summary: { type: "STRING" } }, required: ["summary"] };
const CHART_JSON_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    type: { type: "STRING", enum: ["bar", "line"] },
    orientation: { type: "STRING", enum: ["vertical", "horizontal"] },
    labels: { type: "STRING" },
    series: { type: "ARRAY", items: { type: "OBJECT", properties: { name: { type: "STRING" }, range: { type: "STRING" } }, required: ["name", "range"] } },
  },
  required: ["title", "type", "labels", "series"],
};

/**
 * Applies validated edits to the text. Every `find` must occur exactly once
 * in the original and edits must not overlap, otherwise the whole answer is
 * rejected: a proposal must never rest on a guess.
 */
export function applyEdits(text: string, edits: ReadonlyArray<{ find: string; replace: string }>): string {
  if (edits.some((edit) => edit.find === "")) {
    if (text !== "" || edits.length !== 1) throw new LlmError("bad_model_output", "The model proposed an edit with no text to find in a document that is not empty.");
    return edits[0]!.replace;
  }
  const spans = edits.map((edit) => {
    const first = text.indexOf(edit.find);
    if (first < 0) throw new LlmError("bad_model_output", `The model proposed text that is not in the document: “${edit.find.slice(0, 40)}”.`);
    if (text.indexOf(edit.find, first + 1) >= 0) throw new LlmError("bad_model_output", `The model's “${edit.find.slice(0, 40)}” matches more than once.`);
    return { start: first, end: first + edit.find.length, replace: edit.replace };
  });
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) throw new LlmError("bad_model_output", "The model's edits overlap.");
  }
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += text.slice(at, span.start) + span.replace;
    at = span.end;
  }
  return out + text.slice(at);
}

const ChartOutput = Schema.Struct({
  title: Schema.String,
  type: Schema.Literals(["bar", "line"]),
  orientation: Schema.optionalKey(Schema.Literals(["vertical", "horizontal"])),
  labels: Schema.String,
  series: Schema.Array(Schema.Struct({ name: Schema.String, range: Schema.String })),
});

const CHART_SYSTEM = `You design one chart for a spreadsheet and MUST follow the user's request exactly: use the chart type, orientation, columns, rows and title the user asks for, and only add or drop series when they ask. If the request names columns or headers, use those columns. The user gives cells as "REF: raw" lines. Reply with ONLY a JSON object: {"title": string, "type": "bar" | "line", "orientation": "vertical" | "horizontal", "labels": "A2:A7", "series": [{"name": string, "range": "B2:B7"}]}. Use "horizontal" only for bar charts the user wants horizontal (otherwise "vertical"). Ranges are single-column A1 ranges of equal length covering data rows (not headers); a series name is its column header. If a current chart is given, return the full modified chart: keep everything the user did not ask to change. Never include anything outside the JSON.`;

/** Asks the model for a chart over the sheet (or a modified `existing` chart); the caller must still validate the ranges (chartProblem). */
export async function suggestChart(env: LlmEnv, instruction: string, cells: Record<string, string>, complete?: Complete, existing?: Omit<ChartConfig, "id">, choice?: LlmChoice) {
  const lines = Object.entries(cells).slice(0, 400).map(([ref, raw]) => `${ref}: ${raw}`).join("\n");
  const call = complete ?? pickProvider(env, choice);
  const current = existing ? `\n\n<current_chart>\n${JSON.stringify({ title: existing.title, type: existing.type, orientation: existing.orientation ?? "vertical", labels: existing.labels, series: existing.series })}\n</current_chart>` : "";
  const out = validate(ChartOutput, parseJsonObject(await call(CHART_SYSTEM, `Request: ${instruction}${current}\n\n<cells>\n${lines}\n</cells>`, CHART_JSON_SCHEMA)), "title, type, labels, series");
  return {
    title: out.title.slice(0, 80),
    type: out.type,
    ...(out.type === "bar" && out.orientation === "horizontal" ? { orientation: "horizontal" as const } : {}),
    labels: out.labels,
    series: [...out.series],
  };
}

export interface AiResult {
  proposed: string;
  summary: string;
}

/** The model call: (system, user) -> raw reply text. Replaceable in tests. */
export type Complete = (system: string, user: string, schema?: object) => Promise<string>;

/** Turns a validated model answer into proposed text. */
export function interpret(mode: AiMode, text: string, raw: string): AiResult {
  const json = parseJsonObject(raw);
  if (mode === "summarise") {
    const { summary } = validate(SummaryOutput, json, "summary");
    const section = `## Summary\n\n${summary.trim()}\n\n`;
    const proposed = text.startsWith("## Summary") ? text.replace(/^## Summary\n[\s\S]*?\n\n(?=\S)/, section) : section + text;
    return { proposed, summary: "AI summary" };
  }
  const out = validate(EditOutput, json, "summary, edits");
  return { proposed: applyEdits(text, out.edits), summary: out.summary };
}

export async function runAi(env: LlmEnv, mode: AiMode, instruction: string, text: string, complete?: Complete, choice?: LlmChoice): Promise<AiResult> {
  if (mode === "summarise" && !text.trim()) throw new LlmError("empty_document", "The document is empty, so there is nothing to summarise.", 422);
  const user = mode === "edit" ? `Instruction: ${instruction}\n\n<document>\n${text}\n</document>` : `<document>\n${text}\n</document>`;
  const call = complete ?? pickProvider(env, choice);
  return interpret(mode, text, await call(SYSTEM[mode], user, mode === "edit" ? EDIT_JSON_SCHEMA : SUMMARY_JSON_SCHEMA));
}

const GEMINI_DEFAULT = "gemini-flash-lite-latest";
const OPENROUTER_PAID_HINT = "Only free OpenRouter models (ids ending in :free) are used unless the server lists a model in OPENROUTER_MODELS.";

const csv = (value?: string) => (value ?? "").split(",").map((m) => m.trim()).filter(Boolean);

/** An OpenRouter model may be used if it is free, or the server operator listed it explicitly. */
export function openRouterAllowed(env: LlmEnv, model: string): boolean {
  return /^[\w.~-]+\/[\w.:~-]+$/.test(model) && (model.endsWith(":free") || csv(env.OPENROUTER_MODELS).includes(model) || model === env.OPENROUTER_MODEL);
}

export function pickProvider(env: LlmEnv, choice: LlmChoice = {}): Complete {
  if (env.LLM_MOCK === "1") return mockModel;
  const provider = choice.provider ?? env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : env.GEMINI_API_KEY ? "gemini" : env.OPENROUTER_API_KEY ? "openrouter" : "anthropic");
  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) throw new LlmError("ai_not_configured", "No GEMINI_API_KEY is configured on the server.", 503);
    return gemini(env.GEMINI_API_KEY, choice.model || env.LLM_MODEL || GEMINI_DEFAULT);
  }
  if (provider === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new LlmError("ai_not_configured", "No OPENROUTER_API_KEY is configured on the server.", 503);
    const model = choice.model ?? env.OPENROUTER_MODEL;
    if (!model) throw new LlmError("model_required", "Choose an OpenRouter model first.", 422);
    if (!openRouterAllowed(env, model)) throw new LlmError("model_not_allowed", `“${model.slice(0, 80)}” is not an allowed OpenRouter model. ${OPENROUTER_PAID_HINT}`, 422);
    return openrouter(env.OPENROUTER_API_KEY, model);
  }
  if (provider !== "anthropic") throw new LlmError("ai_not_configured", `Unknown LLM_PROVIDER “${provider}”; use anthropic, gemini or openrouter.`, 503);
  if (!env.ANTHROPIC_API_KEY) throw new LlmError("ai_not_configured", "No ANTHROPIC_API_KEY or GEMINI_API_KEY is configured on the server.", 503);
  return anthropic(env.ANTHROPIC_API_KEY, env.LLM_MODEL ?? "claude-sonnet-5-5");
}

/** OpenRouter (OpenAI-style chat completions). One model, no `models` fallback list, so a request never moves to another (possibly paid) model. */
export function openrouter(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Complete {
  return async (system, user) => {
    const data = (await post(
      `OpenRouter (${model})`,
      "https://openrouter.ai/api/v1/chat/completions",
      { authorization: `Bearer ${apiKey}` },
      {
        model,
        max_tokens: 4096,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      },
      apiKey,
      fetchImpl,
    )) as { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string; code?: number | string } };
    // OpenRouter can answer 200 with an error body (e.g. the upstream provider failed).
    if (data.error) throw new LlmError("model_error", `OpenRouter (${model}) failed${data.error.code ? ` (${data.error.code})` : ""}: ${scrub(data.error.message ?? "", apiKey)}`);
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new LlmError("bad_model_output", "The model returned no text.");
    return reply;
  };
}

interface OpenRouterModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
}

/** Free models that can return structured output and call tools. */
export function freeCapableModels(models: OpenRouterModel[]): string[] {
  return models
    .filter((m) => {
      const params = m.supported_parameters ?? [];
      const free = m.id.endsWith(":free") || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0 && m.pricing?.prompt !== undefined);
      return free && params.includes("tools") && (params.includes("structured_outputs") || params.includes("response_format"));
    })
    .map((m) => m.id)
    .sort();
}

let modelCache: { at: number; ids: string[] } | undefined;
const MODEL_CACHE_MS = 10 * 60_000;

async function openRouterModels(fetchImpl: typeof fetch): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.ids;
  const response = await fetchImpl("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`status ${response.status}`);
  const ids = freeCapableModels(((await response.json()) as { data?: OpenRouterModel[] }).data ?? []);
  modelCache = { at: Date.now(), ids };
  return ids;
}

/** What the page's provider/model selector offers. Never contains a key. */
export async function listProviders(env: LlmEnv, fetchImpl: typeof fetch = fetch): Promise<ProvidersResponse> {
  const mock = env.LLM_MOCK === "1";
  const gemModels = [...new Set([env.LLM_MODEL && env.LLM_PROVIDER !== "openrouter" ? env.LLM_MODEL : GEMINI_DEFAULT, ...csv(env.GEMINI_MODELS)])];
  const extra = [...csv(env.OPENROUTER_MODELS), ...(env.OPENROUTER_MODEL ? [env.OPENROUTER_MODEL] : [])];
  let note: string | undefined;
  let fetched: string[] = [];
  if (mock) fetched = ["mock/free-model:free"];
  else if (env.OPENROUTER_API_KEY) {
    try {
      fetched = await openRouterModels(fetchImpl);
    } catch {
      note = "Could not fetch the OpenRouter model list; showing configured models only.";
    }
  }
  const router: ProviderInfo = { id: "openrouter", label: "OpenRouter", configured: mock || !!env.OPENROUTER_API_KEY, models: [...new Set([...fetched, ...extra])], ...(note ? { note } : {}) };
  const gem: ProviderInfo = { id: "gemini", label: "Gemini", configured: mock || !!env.GEMINI_API_KEY, models: gemModels };
  const provider = env.LLM_PROVIDER ?? (env.GEMINI_API_KEY ? "gemini" : env.OPENROUTER_API_KEY ? "openrouter" : "gemini");
  return { providers: [gem, router], current: { provider, model: provider === "openrouter" ? (env.OPENROUTER_MODEL ?? null) : (env.LLM_MODEL ?? GEMINI_DEFAULT) } };
}

export function gemini(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Complete {
  return async (system, user, schema) => {
    const data = (await post(
      `Gemini (${model})`,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { "x-goog-api-key": apiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        // Room for the model's own "thinking" tokens as well as the JSON answer.
        generationConfig: { responseMimeType: "application/json", ...(schema ? { responseSchema: schema } : {}), maxOutputTokens: 8192 },
      },
      apiKey,
      fetchImpl,
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
    const reply = data.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    if (!reply) throw new LlmError("bad_model_output", "The model returned no text.");
    return reply;
  };
}

const REQUEST_TIMEOUT_MS = 60_000;

/** Removes anything that looks like a credential from text taken from a provider's error. */
export function scrub(text: string, secret?: string): string {
  let out = text;
  if (secret) out = out.split(secret).join("[redacted]");
  return out.replace(/(AIza[\w-]{10,}|sk-[\w-]{10,})/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** One POST to a provider; failures become LlmErrors that say who failed, how, and the provider's own reason. */
async function post(provider: string, url: string, headers: Record<string, string>, body: unknown, secret: string, fetchImpl: typeof fetch): Promise<any> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LlmError("model_unreachable", timedOut ? `${provider} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.` : `Could not reach ${provider}.`);
  }
  if (!response.ok) {
    let reason = "";
    try {
      const data = (await response.json()) as { error?: { message?: string; status?: string } };
      reason = scrub(`${data.error?.status ?? ""} ${data.error?.message ?? ""}`, secret);
    } catch {
      /* no JSON body */
    }
    const hint = response.status === 404 ? " (the model may be retired, misspelled or not available to you: pick another model, or set LLM_MODEL)" : response.status === 429 ? " (rate limit or quota reached: wait a moment or pick another model; nothing was switched automatically)" : response.status === 401 || response.status === 403 ? " (check the API key)" : "";
    throw new LlmError("model_error", `${provider} request failed (${response.status})${hint}${reason ? `: ${reason}` : ""}`);
  }
  return response.json();
}

export function anthropic(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Complete {
  return async (system, user) => {
    const data = (await post(
      `Anthropic (${model})`,
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      { model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] },
      apiKey,
      fetchImpl,
    )) as { content?: Array<{ type: string; text?: string }> };
    const reply = data.content?.find((block) => block.type === "text")?.text;
    if (!reply) throw new LlmError("bad_model_output", "The model returned no text.");
    return reply;
  };
}

/**
 * Deterministic stand-in: understands `replace X with Y` / `fix typo X to Y`
 * instructions and summarises by first sentences. Lets the whole flow run
 * (and be tested) without credentials or cost.
 */
const mockModel: Complete = async (system, user) => {
  if (system === CHART_SYSTEM) {
    const request = /^Request: (.*)$/m.exec(user)?.[1] ?? "";
    const current = /<current_chart>\n(.*)\n<\/current_chart>/.exec(user)?.[1];
    const cur = current ? JSON.parse(current) : null;
    const refs = [...user.matchAll(/^([A-Z])(\d+): /gm)].map((m) => ({ col: m[1]!, row: Number(m[2]) }));
    const last = Math.max(...refs.map((r) => r.row), 2);
    const cols = [...new Set(refs.map((r) => r.col))].sort();
    const header = (col: string) => new RegExp(`^${col}1: (.*)$`, "m").exec(user)?.[1] ?? col;
    // Columns whose header the request mentions; otherwise the first two value columns.
    const named = cols.slice(1).filter((col) => request.toLowerCase().includes(header(col).toLowerCase()));
    const valueCols = named.length ? named : cols.slice(1, 3);
    const line = /line|trend/i.test(request);
    const bar = /bar|column/i.test(request);
    const horizontal = /horizontal/i.test(request);
    const type = line ? "line" : bar || !cur ? "bar" : cur.type;
    const fresh = {
      title: line ? "Trend" : "Overview",
      type,
      orientation: horizontal ? "horizontal" : /vertical/i.test(request) ? "vertical" : (cur?.orientation ?? "vertical"),
      labels: `${cols[0]}2:${cols[0]}${last}`,
      series: valueCols.map((col) => ({ name: header(col), range: `${col}2:${col}${last}` })),
    };
    if (!cur) return JSON.stringify(fresh);
    const retitle = /(?:title|call it|rename)[^"“']*["“']([^"”']+)["”']/i.exec(request)?.[1];
    return JSON.stringify({ ...cur, type, orientation: fresh.orientation, title: retitle ?? cur.title, series: named.length ? fresh.series : cur.series });
  }
  const doc = /<document>\n([\s\S]*)\n<\/document>/.exec(user)?.[1] ?? "";
  if (system === SYSTEM.summarise) {
    const bullets = doc
      .split(/\n\s*\n/)
      .filter((p) => p.trim() && !p.startsWith("#"))
      .slice(0, 3)
      .map((p) => `- ${/^[^.!?\n]*[.!?]?/.exec(p.trim())![0]}`);
    return JSON.stringify({ summary: bullets.join("\n") || "- (empty document)" });
  }
  const m = /Instruction:\s*(?:replace|change)\s+["“]?(.+?)["”]?\s+(?:with|to)\s+["“]?(.+?)["”]?\s*\n/i.exec(user);
  if (!m) return JSON.stringify({ summary: "No change", edits: [] });
  return JSON.stringify({ summary: `Replace “${m[1]}” with “${m[2]}”`, edits: [{ find: m[1], replace: m[2] }] });
};
