import { useCallback, useEffect, useRef, useState } from "react";
import type { SheetEntry, SheetList, SheetState } from "../shared/api-types";
import { allows } from "../shared/permissions";
import { chartData, colName, display, evaluateSheet, type ChartConfig, type ChartData } from "../shared/sheet";
import { AiModelPicker, useAiChoice } from "./AiModelPicker";
import { api } from "./api";
import { currentUser } from "./current-user";

const ROWS = 15;
const COLS = 8;
// Mid-tone, so each reads on both light and dark backgrounds.
const COLORS = ["#e0566a", "#1fa2b8", "#a678b3", "#edae49", "#5a8fd0", "#7bb35e"];

type Edit = { ref: string; raw: string };

/** Live connection to one SheetCell: the full state, updated by broadcast edits. */
function useSheet(workspaceId: string, sheetId: string | null) {
  const [state, setState] = useState<SheetState | null>(null);
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    setState(null);
    if (!sheetId) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/workspaces/${encodeURIComponent(workspaceId)}/sheets/${encodeURIComponent(sheetId)}/sync?user=${currentUser()}`;
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => setLive(true);
      ws.onclose = () => {
        setLive(false);
        if (!closed) retry = setTimeout(open, 1000);
      };
      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === "hello") setState(msg.state);
        else if (msg.type === "cells")
          setState((s) => {
            if (!s) return s;
            const cells = { ...s.cells };
            for (const e of msg.edits as Edit[]) if (e.raw === "") delete cells[e.ref]; else cells[e.ref] = e.raw;
            return { ...s, cells, revision: msg.revision };
          });
        else if (msg.type === "charts") setState((s) => (s ? { ...s, charts: msg.charts } : s));
        else if (msg.type === "snapshot") {
          const r = await api.getSheet(workspaceId, sheetId);
          if (r.ok) setState(r.data);
        } else if (msg.type === "rejected") setNotice(msg.reason);
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [workspaceId, sheetId]);

  const edit = useCallback((ref: string, raw: string) => {
    // Optimistic: show it at once; the broadcast confirms or `rejected` explains.
    setState((s) => {
      if (!s) return s;
      const cells = { ...s.cells };
      if (raw === "") delete cells[ref]; else cells[ref] = raw;
      return { ...s, cells };
    });
    socket.current?.send(JSON.stringify({ type: "edit", ref, raw }));
  }, []);

  return { state, live, edit, notice, clearNotice: () => setNotice(null) };
}

export function SheetPanel({ workspaceId }: { workspaceId: string }) {
  const [sheets, setSheets] = useState<SheetEntry[]>([]);
  const [sheetId, setSheetId] = useState<string | null>(() => new URLSearchParams(location.search).get("sheet"));
  const [newId, setNewId] = useState("budget");
  const [message, setMessage] = useState<string | null>(null);
  const { state, live, edit, notice, clearNotice } = useSheet(workspaceId, sheetId);

  const refresh = async () => {
    const r = await api.listSheets(workspaceId);
    if (r.ok) setSheets((r.data as SheetList).sheets);
  };
  useEffect(() => void refresh(), [workspaceId, sheetId]);

  const create = async () => {
    const r = await api.putSheet(workspaceId, newId, { title: newId, cells: {} });
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) {
      setSheetId(newId);
      history.replaceState(null, "", `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(location.search)), sheet: newId })}`);
    }
  };

  const canEdit = state ? allows(state.yourRole, "edit") : false;

  return (
    <section data-testid="sheets">
      <div className="inline">
        {sheets.map((s) => (
          <button key={s.sheetId} onClick={() => setSheetId(s.sheetId)} data-testid="sheet-link" disabled={s.sheetId === sheetId}>
            {s.title}
          </button>
        ))}
        <input aria-label="New sheet id" value={newId} onChange={(e) => setNewId(e.target.value)} size={12} />
        <button onClick={create}>Create / open sheet</button>
        {message && <span className="muted">{message}</span>}
      </div>
      {state && sheetId && (
        <>
          <p className="muted" data-testid="sheet-status">
            {state.title} · {live ? "live" : "reconnecting…"} · you are {state.yourRole} · revision {state.revision}
            {notice && (
              <>
                {" · "}
                <strong>{notice}</strong> <button onClick={clearNotice}>ok</button>
              </>
            )}
          </p>
          <Grid state={state} canEdit={canEdit} onEdit={edit} />
          <Charts workspaceId={workspaceId} sheetId={sheetId} state={state} canEdit={canEdit} />
        </>
      )}
    </section>
  );
}

function Grid({ state, canEdit, onEdit }: { state: SheetState; canEdit: boolean; onEdit: (ref: string, raw: string) => void }) {
  const values = evaluateSheet(state.cells);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const commit = () => {
    if (editing !== null && draft !== (state.cells[editing] ?? "")) onEdit(editing, draft);
    setEditing(null);
  };
  return (
    <div style={{ overflowX: "auto" }}>
      <table data-testid="sheet-grid" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th />
            {Array.from({ length: COLS }, (_, c) => (
              <th key={c} style={{ minWidth: 90 }}>{colName(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ROWS }, (_, r) => (
            <tr key={r}>
              <th>{r + 1}</th>
              {Array.from({ length: COLS }, (_, c) => {
                const ref = `${colName(c)}${r + 1}`;
                const isError = typeof values[ref] === "object";
                return (
                  <td key={ref} data-ref={ref} style={{ border: "1px solid var(--border)", padding: 0 }}>
                    {editing === ref ? (
                      <input
                        autoFocus
                        aria-label={`Cell ${ref}`}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commit();
                          if (e.key === "Escape") setEditing(null);
                        }}
                        style={{ width: "100%", boxSizing: "border-box" }}
                      />
                    ) : (
                      <div
                        tabIndex={0}
                        role="gridcell"
                        onClick={() => canEdit && (setEditing(ref), setDraft(state.cells[ref] ?? ""))}
                        onKeyDown={(e) => e.key === "Enter" && canEdit && (setEditing(ref), setDraft(state.cells[ref] ?? ""))}
                        style={{ minHeight: 22, padding: "2px 4px", color: isError ? "var(--error)" : undefined, textAlign: typeof values[ref] === "number" ? "right" : "left" }}
                      >
                        {display(values[ref])}
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Charts({ workspaceId, sheetId, state, canEdit }: { workspaceId: string; sheetId: string; state: SheetState; canEdit: boolean }) {
  const values = evaluateSheet(state.cells);
  const [draft, setDraft] = useState({ title: "Chart", type: "bar", labels: "A2:A5", range: "B2:B5" });
  const [instruction, setInstruction] = useState("");
  // The AI's proposal, and the chart it would replace (null: add a new one).
  const [suggestion, setSuggestion] = useState<{ chart: Omit<ChartConfig, "id">; replaces: string | null } | null>(null);
  const [target, setTarget] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const aiChoice = useAiChoice();

  const add = async (chart: Omit<ChartConfig, "id">) => {
    const r = await api.addChart(workspaceId, sheetId, chart);
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setSuggestion(null);
  };
  const accept = async () => {
    if (!suggestion) return;
    if (!suggestion.replaces) return add(suggestion.chart);
    const r = await api.updateChart(workspaceId, sheetId, suggestion.replaces, suggestion.chart);
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setSuggestion(null);
  };
  const suggest = async () => {
    setMessage("AI is working…");
    const replaces = state.charts.some((c) => c.id === target) ? target : null;
    const r = await api.suggestChart(workspaceId, sheetId, instruction, replaces ?? undefined, aiChoice);
    setMessage(r.ok ? "AI suggestion below: review it, then apply it." : r.error.message);
    if (r.ok) setSuggestion({ chart: r.data, replaces });
  };
  const replaced = suggestion?.replaces ? state.charts.find((c) => c.id === suggestion.replaces) : undefined;

  return (
    <div data-testid="charts">
      <h3>Charts</h3>
      {canEdit && (
        <>
          <AiModelPicker />
          <div className="inline">
            <input aria-label="AI chart request" placeholder="Describe a chart, or how to change one…" value={instruction} onChange={(e) => setInstruction(e.target.value)} size={40} />
            {state.charts.length > 0 && (
              <select aria-label="Chart to modify" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">New chart</option>
                {state.charts.map((c) => (
                  <option key={c.id} value={c.id}>Modify: {c.title}</option>
                ))}
              </select>
            )}
            <button onClick={suggest} disabled={instruction.trim() === ""}>Ask AI: suggest chart</button>
          </div>
          <details className="panel">
            <summary>Add a chart manually</summary>
            <div className="inline">
              <input aria-label="Chart title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              <select aria-label="Chart type" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })}>
                <option value="bar">bar</option>
                <option value="line">line</option>
              </select>
              <input aria-label="Labels range" value={draft.labels} onChange={(e) => setDraft({ ...draft, labels: e.target.value })} size={8} />
              <input aria-label="Series range" value={draft.range} onChange={(e) => setDraft({ ...draft, range: e.target.value })} size={8} />
              <button onClick={() => add({ title: draft.title, type: draft.type as "bar" | "line", labels: draft.labels, series: [{ name: draft.range, range: draft.range }] })}>
                Add chart
              </button>
            </div>
          </details>
        </>
      )}
      {message && <p className="muted" data-testid="chart-message">{message}</p>}
      {suggestion && (
        <div className="notice" data-testid="chart-suggestion">
          {replaced && <p className="muted">Replaces “{replaced.title}”.</p>}
          <ChartView config={{ ...suggestion.chart, id: "preview" }} data={chartData({ ...suggestion.chart, id: "preview" }, values)} />
          <button onClick={accept} disabled={!canEdit}>{replaced ? "Apply to chart" : "Add this chart"}</button>{" "}
          <button onClick={() => setSuggestion(null)}>Dismiss</button>
          <details>
            <summary>Developer details</summary>
            <pre>{JSON.stringify(suggestion.chart, null, 2)}</pre>
          </details>
        </div>
      )}
      <div className="inline" style={{ alignItems: "flex-start" }}>
        {state.charts.map((chart) => (
          <figure key={chart.id} data-testid="chart" style={{ margin: 8 }}>
            <ChartView config={chart} data={chartData(chart, values)} />
            {canEdit && <button onClick={() => api.deleteChart(workspaceId, sheetId, chart.id)}>Remove</button>}
          </figure>
        ))}
      </div>
    </div>
  );
}

/** A small SVG bar (vertical or horizontal) or line chart; text follows the page colour, so it reads in dark mode. */
function ChartView({ config, data }: { config: ChartConfig; data: ChartData }) {
  const horizontal = config.type === "bar" && config.orientation === "horizontal";
  const [w, h] = [360, 220];
  const padL = horizontal ? 64 : 36;
  const [padR, padT, padB] = [36, 24, 36];
  const all = data.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const n = Math.max(1, data.labels.length);
  const span = max - min || 1;
  // Value axis runs along y for vertical charts and along x for horizontal ones.
  const y = (v: number) => h - padB - ((v - min) / span) * (h - padT - padB);
  const x = (v: number) => padL + ((v - min) / span) * (w - padL - padR);
  const slot = horizontal ? (h - padT - padB) / n : (w - padL - padR) / n;
  const bw = (slot * 0.8) / data.series.length;
  const color = (si: number) => COLORS[si % COLORS.length];
  return (
    <svg width={w} height={h} role="img" aria-label={config.title} data-testid="chart-svg" data-values={JSON.stringify(data.series.map((s) => s.values))} style={{ fill: "currentColor" }}>
      <text x={w / 2} y={14} textAnchor="middle" fontWeight="bold" fontSize="12">{config.title}</text>
      {horizontal ? (
        <>
          <line x1={x(0)} y1={padT} x2={x(0)} y2={h - padB} stroke="currentColor" strokeOpacity="0.5" />
          <text x={x(max)} y={h - padB + 28} textAnchor="end" fontSize="10">{Math.round(max * 100) / 100}</text>
          {data.labels.map((label, i) => (
            <text key={i} x={padL - 4} y={padT + slot * (i + 0.5) + 3} textAnchor="end" fontSize="10">{label.slice(0, 10)}</text>
          ))}
        </>
      ) : (
        <>
          <line x1={padL} y1={y(0)} x2={w - padR} y2={y(0)} stroke="currentColor" strokeOpacity="0.5" />
          <text x={4} y={y(max) + 4} fontSize="10">{Math.round(max * 100) / 100}</text>
          {data.labels.map((label, i) => (
            <text key={i} x={padL + slot * (i + 0.5)} y={h - padB + 14} textAnchor="middle" fontSize="10">{label.slice(0, 8)}</text>
          ))}
        </>
      )}
      {data.series.map((s, si) =>
        config.type === "bar" ? (
          s.values.map((v, i) =>
            horizontal ? (
              <rect key={i} x={Math.min(x(v), x(0))} y={padT + slot * i + slot * 0.1 + bw * si} width={Math.abs(x(v) - x(0))} height={bw} fill={color(si)} />
            ) : (
              <rect key={i} x={padL + slot * i + slot * 0.1 + bw * si} y={Math.min(y(v), y(0))} width={bw} height={Math.abs(y(v) - y(0))} fill={color(si)} />
            ),
          )
        ) : (
          <polyline key={si} fill="none" stroke={color(si)} strokeWidth="2" points={s.values.map((v, i) => `${padL + slot * (i + 0.5)},${y(v)}`).join(" ")} />
        ),
      )}
      {data.series.map((s, si) => (
        <text key={si} x={w - 4} y={14 + 11 * (si + 1)} textAnchor="end" fontSize="10" style={{ fill: color(si) }}>{s.name}</text>
      ))}
    </svg>
  );
}
