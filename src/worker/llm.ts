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
      find: Schema.String.check(Schema.isMinLength(1)),
      replace: Schema.String,
    }),
  ).check(Schema.isMaxLength(MAX_EDITS)),
});
const SummaryOutput = Schema.Struct({ summary: Schema.String.check(Schema.isMinLength(1)) });

const SYSTEM = {
  edit: `You edit a Markdown document for a user. Reply with ONLY a JSON object: {"summary": string, "edits": [{"find": string, "replace": string}]}. Each "find" must be an exact, unique substring of the document (include enough context to be unique); "replace" is its replacement. Make the smallest edits that satisfy the instruction. Never include anything outside the JSON.`,
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

function validate<S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new LlmError("bad_model_output", "The model's answer did not match the expected shape.");
  }
}

/**
 * Applies validated edits to the text. Every `find` must occur exactly once
 * in the original and edits must not overlap, otherwise the whole answer is
 * rejected: a proposal must never rest on a guess.
 */
export function applyEdits(text: string, edits: ReadonlyArray<{ find: string; replace: string }>): string {
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
  const out = validate(ChartOutput, parseJsonObject(await call(CHART_SYSTEM, `Request: ${instruction}\n\n<cells>\n${lines}\n</cells>`)));
  return { title: out.title.slice(0, 80), type: out.type, labels: out.labels, series: [...out.series] };
}

export interface AiResult {
  proposed: string;
  summary: string;
}

/** The model call: (system, user) -> raw reply text. Replaceable in tests. */
export type Complete = (system: string, user: string) => Promise<string>;

/** Turns a validated model answer into proposed text. */
export function interpret(mode: AiMode, text: string, raw: string): AiResult {
  const json = parseJsonObject(raw);
  if (mode === "summarise") {
    const { summary } = validate(SummaryOutput, json);
    const section = `## Summary\n\n${summary.trim()}\n\n`;
    const proposed = text.startsWith("## Summary") ? text.replace(/^## Summary\n[\s\S]*?\n\n(?=\S)/, section) : section + text;
    return { proposed, summary: "AI summary" };
  }
  const out = validate(EditOutput, json);
  return { proposed: applyEdits(text, out.edits), summary: out.summary };
}

export async function runAi(env: LlmEnv, mode: AiMode, instruction: string, text: string, complete?: Complete): Promise<AiResult> {
  const user = mode === "edit" ? `Instruction: ${instruction}\n\n<document>\n${text}\n</document>` : `<document>\n${text}\n</document>`;
  const call = complete ?? pickProvider(env);
  return interpret(mode, text, await call(SYSTEM[mode], user));
}

function pickProvider(env: LlmEnv): Complete {
  if (env.LLM_MOCK === "1") return mockModel;
  const provider = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : env.GEMINI_API_KEY ? "gemini" : "anthropic");
  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) throw new LlmError("ai_not_configured", "No GEMINI_API_KEY is configured on the server.", 503);
    return gemini(env.GEMINI_API_KEY, env.LLM_MODEL ?? "gemini-2.5-flash");
  }
  if (provider !== "anthropic") throw new LlmError("ai_not_configured", `Unknown LLM_PROVIDER “${provider}”; use anthropic or gemini.`, 503);
  if (!env.ANTHROPIC_API_KEY) throw new LlmError("ai_not_configured", "No ANTHROPIC_API_KEY or GEMINI_API_KEY is configured on the server.", 503);
  return anthropic(env.ANTHROPIC_API_KEY, env.LLM_MODEL ?? "claude-sonnet-5-5");
}

export function gemini(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Complete {
  return async (system, user) => {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4096 },
      }),
    });
    if (!response.ok) throw new LlmError("model_error", `The model request failed (${response.status}).`);
    const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const reply = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("");
    if (!reply) throw new LlmError("bad_model_output", "The model returned no text.");
    return reply;
  };
}

export function anthropic(apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Complete {
  return async (system, user) => {
    const response = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] }),
    });
    if (!response.ok) throw new LlmError("model_error", `The model request failed (${response.status}).`);
    const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
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
