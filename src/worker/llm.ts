import { Schema } from "effect";

/** Secrets and settings for the model; the key lives only in the Worker's env (.dev.vars / wrangler secret). */
export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** "anthropic" or "gemini"; by default whichever key is set (Anthropic first). */
  LLM_PROVIDER?: string;
  /** "1" uses a deterministic stand-in model, for tests and offline demos. */
  LLM_MOCK?: string;
  LLM_MODEL?: string;
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
  labels: Schema.String,
  series: Schema.Array(Schema.Struct({ name: Schema.String, range: Schema.String })),
});

const CHART_SYSTEM = `You design one chart for a spreadsheet. The user gives cells as "REF: raw" lines. Reply with ONLY a JSON object: {"title": string, "type": "bar" | "line", "labels": "A2:A7", "series": [{"name": string, "range": "B2:B7"}]}. Ranges are single-column A1 ranges of equal length covering data rows (not headers). Never include anything outside the JSON.`;

/** Asks the model for a chart over the sheet; the caller must still validate the ranges (chartProblem). */
export async function suggestChart(env: LlmEnv, instruction: string, cells: Record<string, string>, complete?: Complete) {
  const lines = Object.entries(cells).slice(0, 400).map(([ref, raw]) => `${ref}: ${raw}`).join("\n");
  const call = complete ?? pickProvider(env);
  const out = validate(ChartOutput, parseJsonObject(await call(CHART_SYSTEM, `Request: ${instruction}\n\n<cells>\n${lines}\n</cells>`, CHART_JSON_SCHEMA)), "title, type, labels, series");
  return { title: out.title.slice(0, 80), type: out.type, labels: out.labels, series: [...out.series] };
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

export async function runAi(env: LlmEnv, mode: AiMode, instruction: string, text: string, complete?: Complete): Promise<AiResult> {
  if (mode === "summarise" && !text.trim()) throw new LlmError("empty_document", "The document is empty, so there is nothing to summarise.", 422);
  const user = mode === "edit" ? `Instruction: ${instruction}\n\n<document>\n${text}\n</document>` : `<document>\n${text}\n</document>`;
  const call = complete ?? pickProvider(env);
  return interpret(mode, text, await call(SYSTEM[mode], user, mode === "edit" ? EDIT_JSON_SCHEMA : SUMMARY_JSON_SCHEMA));
}

function pickProvider(env: LlmEnv): Complete {
  if (env.LLM_MOCK === "1") return mockModel;
  const provider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : env.GEMINI_API_KEY ? "gemini" : "anthropic");
  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) throw new LlmError("ai_not_configured", "No GEMINI_API_KEY is configured on the server.", 503);
    return gemini(env.GEMINI_API_KEY, env.LLM_MODEL ?? "gemini-flash-lite-latest");
  }
  if (provider !== "anthropic") throw new LlmError("ai_not_configured", `Unknown LLM_PROVIDER “${provider}”; use anthropic or gemini.`, 503);
  if (!env.ANTHROPIC_API_KEY) throw new LlmError("ai_not_configured", "No ANTHROPIC_API_KEY or GEMINI_API_KEY is configured on the server.", 503);
  return anthropic(env.ANTHROPIC_API_KEY, env.LLM_MODEL ?? "claude-sonnet-5-5");
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
    const hint = response.status === 404 ? " (the model may be retired or misspelled: set LLM_MODEL)" : response.status === 429 ? " (rate limit or quota reached)" : response.status === 401 || response.status === 403 ? " (check the API key)" : "";
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
    const refs = [...user.matchAll(/^([A-Z])(\d+): /gm)].map((m) => ({ col: m[1]!, row: Number(m[2]) }));
    const last = Math.max(...refs.map((r) => r.row), 2);
    const cols = [...new Set(refs.map((r) => r.col))].sort();
    const header = (col: string) => /^[A-Z]1: (.*)$/m.exec(user.replace(new RegExp(`^(?!${col}1: ).*\\n?`, "gm"), ""))?.[1] ?? col;
    return JSON.stringify({
      title: /line/i.test(user) ? "Trend" : "Overview",
      type: /line|trend/i.test(user) ? "line" : "bar",
      labels: `${cols[0]}2:${cols[0]}${last}`,
      series: cols.slice(1, 3).map((col) => ({ name: header(col), range: `${col}2:${col}${last}` })),
    });
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
