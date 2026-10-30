/**
 * Spreadsheet model shared by the SheetCell (validation, chart data) and the
 * client (display): cell references, a small formula engine and chart config.
 * Cells hold raw text; a raw value starting with "=" is a formula.
 */

export const MAX_ROWS = 100;
export const MAX_COLS = 26;
export const MAX_RAW_LENGTH = 500;

export type Raw = Record<string, string>; // "A1" -> raw text
export type Value = number | string | { error: string };

export const colName = (c: number): string => String.fromCharCode(65 + c);

/** "B3" -> {col: 1, row: 2}, or null when malformed or out of bounds. */
export function parseRef(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z])([1-9]\d{0,2})$/.exec(ref);
  if (!m) return null;
  const col = m[1]!.charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  return col < MAX_COLS && row < MAX_ROWS ? { col, row } : null;
}

export function expandRange(range: string): string[] | null {
  const [a, b = a] = range.split(":");
  const p = parseRef(a ?? ""), q = parseRef(b);
  if (!p || !q) return null;
  const refs: string[] = [];
  for (let r = Math.min(p.row, q.row); r <= Math.max(p.row, q.row); r++)
    for (let c = Math.min(p.col, q.col); c <= Math.max(p.col, q.col); c++) refs.push(`${colName(c)}${r + 1}`);
  return refs;
}

const err = (error: string): Value => ({ error });
export const isError = (v: Value): v is { error: string } => typeof v === "object";

type Token = { t: "num"; v: number } | { t: "ref"; v: string } | { t: "fn"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+\.?\d*|\.\d+)|([A-Z]{1,}\d*(?::[A-Z]\d+)?)|([-+*/(),^]))/gy;
  let pos = 0;
  while (pos < src.trimEnd().length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m) return null;
    pos = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) {
      const rest = src.slice(pos).trimStart();
      tokens.push(rest.startsWith("(") && !/\d/.test(m[2]) ? { t: "fn", v: m[2] } : { t: "ref", v: m[2] });
    } else tokens.push({ t: "op", v: m[3]! });
  }
  return tokens;
}

/** Evaluates every cell of the sheet. Errors: #ERR (syntax), #REF, #DIV/0, #CYCLE, #VALUE. */
export function evaluateSheet(raw: Raw): Record<string, Value> {
  const cache = new Map<string, Value>();
  const visiting = new Set<string>();

  const cell = (ref: string): Value => {
    const hit = cache.get(ref);
    if (hit !== undefined) return hit;
    if (visiting.has(ref)) return err("#CYCLE");
    const text = raw[ref] ?? "";
    let value: Value;
    if (text.startsWith("=")) {
      visiting.add(ref);
      value = formula(text.slice(1));
      visiting.delete(ref);
    } else if (text.trim() !== "" && Number.isFinite(Number(text))) value = Number(text);
    else value = text;
    cache.set(ref, value);
    return value;
  };

  const formula = (src: string): Value => {
    const tokens = tokenize(src);
    if (!tokens || tokens.length === 0) return err("#ERR");
    let i = 0;
    const peek = () => tokens[i];
    const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;

    // Values here may be a number or a list (from a range) for functions.
    const range = (r: string): Value[] | Value => {
      const refs = expandRange(r);
      return refs ? refs.map(cell) : err("#REF");
    };
    const nums = (vals: Value[]): number[] | Value => {
      const out: number[] = [];
      for (const v of vals) {
        if (isError(v)) return v;
        if (typeof v === "number") out.push(v);
      }
      return out;
    };
    const scalar = (v: Value): number | Value => {
      if (isError(v)) return v;
      if (typeof v === "number") return v;
      return v.trim() === "" ? 0 : err("#VALUE");
    };

    const expr = (): Value => {
      let left = term();
      while (!isError(left) && (isOp("+") || isOp("-"))) {
        const op = tokens[i++]!.v;
        const right = term();
        const [a, b] = [scalar(left), scalar(right)];
        if (typeof a !== "number") return a;
        if (typeof b !== "number") return b;
        left = op === "+" ? a + b : a - b;
      }
      return left;
    };
    const term = (): Value => {
      let left = unary();
      while (!isError(left) && (isOp("*") || isOp("/"))) {
        const op = tokens[i++]!.v;
        const right = unary();
        const [a, b] = [scalar(left), scalar(right)];
        if (typeof a !== "number") return a;
        if (typeof b !== "number") return b;
        if (op === "/" && b === 0) return err("#DIV/0");
        left = op === "*" ? a * b : a / b;
      }
      return left;
    };
    const unary = (): Value => {
      if (isOp("-")) {
        i++;
        const v = scalar(unary());
        return typeof v === "number" ? -v : v;
      }
      return primary();
    };
    const primary = (): Value => {
      const tok = tokens[i++];
      if (!tok) return err("#ERR");
      if (tok.t === "num") return tok.v;
      if (tok.t === "ref") {
        if (tok.v.includes(":")) return err("#VALUE");
        return parseRef(tok.v) ? cell(tok.v) : err("#REF");
      }
      if (tok.t === "op" && tok.v === "(") {
        const v = expr();
        if (!isOp(")")) return err("#ERR");
        i++;
        return v;
      }
      if (tok.t === "fn") {
        if (!["SUM", "AVERAGE", "MIN", "MAX", "COUNT"].includes(tok.v)) return err("#ERR");
        i++; // "("
        const vals: Value[] = [];
        while (!isOp(")")) {
          const arg = peek();
          if (!arg) return err("#ERR");
          if (arg.t === "ref" && arg.v.includes(":")) {
            i++;
            const r = range(arg.v);
            if (!Array.isArray(r)) return r;
            vals.push(...r);
          } else vals.push(expr());
          if (isOp(",")) i++;
          else if (!isOp(")")) return err("#ERR");
        }
        i++;
        const n = nums(vals);
        if (!Array.isArray(n)) return n;
        switch (tok.v) {
          case "COUNT": return n.length;
          case "SUM": return n.reduce((s, x) => s + x, 0);
          case "AVERAGE": return n.length ? n.reduce((s, x) => s + x, 0) / n.length : err("#DIV/0");
          case "MIN": return n.length ? Math.min(...n) : 0;
          default: return n.length ? Math.max(...n) : 0;
        }
      }
      return err("#ERR");
    };

    const result = expr();
    return i < tokens.length && !isError(result) ? err("#ERR") : result;
  };

  const out: Record<string, Value> = {};
  for (const ref of Object.keys(raw)) out[ref] = cell(ref);
  return out;
}

export function display(v: Value | undefined): string {
  if (v === undefined) return "";
  if (isError(v)) return v.error;
  return typeof v === "number" ? String(Math.round(v * 1e6) / 1e6) : v;
}

// ------------------------------------------------------------------ charts

export interface ChartConfig {
  id: string;
  title: string;
  type: "bar" | "line";
  /** Range of category labels, e.g. "A2:A7". */
  labels: string;
  /** One range of numbers per series, e.g. "B2:B7". */
  series: Array<{ name: string; range: string }>;
}

export interface ChartData {
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
}

/** Resolves a chart config against the current values; non-numbers count as 0. */
export function chartData(config: ChartConfig, values: Record<string, Value>): ChartData {
  const get = (range: string) => (expandRange(range) ?? []).map((ref) => values[ref]);
  return {
    labels: get(config.labels).map((v) => display(v)),
    series: config.series.map((s) => ({
      name: s.name,
      values: get(s.range).map((v) => (typeof v === "number" ? v : 0)),
    })),
  };
}

/** Returns an error message when a chart config is unusable, else null. */
export function chartProblem(c: Partial<ChartConfig>): string | null {
  if (c.type !== "bar" && c.type !== "line") return "Chart type must be bar or line.";
  if (typeof c.title !== "string" || c.title.length > 80) return "Chart needs a title (up to 80 characters).";
  const rangeOf = (r: unknown) => (typeof r === "string" ? expandRange(r) : null);
  const labels = rangeOf(c.labels);
  if (!labels) return "Chart labels must be a range like A2:A7.";
  if (!Array.isArray(c.series) || c.series.length < 1 || c.series.length > 6) return "Chart needs 1-6 series.";
  for (const s of c.series) {
    const r = rangeOf(s?.range);
    if (typeof s?.name !== "string" || !r) return "Each series needs a name and a range like B2:B7.";
    if (r.length !== labels.length) return "Series ranges must be as long as the labels range.";
  }
  return null;
}
