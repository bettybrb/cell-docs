import { useCallback, useEffect, useRef, useState } from "react";
import type { SheetEntry, SheetList, SheetState } from "../shared/api-types";
import { allows } from "../shared/permissions";
import { chartData, colName, display, evaluateSheet, type ChartConfig, type ChartData } from "../shared/sheet";
import { api } from "./api";
import { currentUser } from "./current-user";

const ROWS = 15;
const COLS = 8;
const COLORS = ["#d1495b", "#00798c", "#8d5a97", "#edae49", "#30638e", "#6a994e"];

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
      <h2>Spreadsheets</h2>
      <p className="muted">Each sheet is its own cell: a Durable Object with SQLite, live-synced to every open tab.</p>
      <div className="inline">
        <input aria-label="New sheet id" value={newId} onChange={(e) => setNewId(e.target.value)} />
        <button onClick={create}>Create / open sheet</button>
        {sheets.map((s) => (
          <button key={s.sheetId} onClick={() => setSheetId(s.sheetId)} data-testid="sheet-link" disabled={s.sheetId === sheetId}>
            {s.title}
          </button>
        ))}
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
                  <td key={ref} data-ref={ref} style={{ border: "1px solid #ccc", padding: 0 }}>
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
                        style={{ minHeight: 22, padding: "2px 4px", color: isError ? "#b00" : undefined, textAlign: typeof values[ref] === "number" ? "right" : "left" }}
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
  const [suggestion, setSuggestion] = useState<Omit<ChartConfig, "id"> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const add = async (chart: Omit<ChartConfig, "id">) => {
    const r = await api.addChart(workspaceId, sheetId, chart);
    setMessage(r.ok ? null : r.error.message);
    if (r.ok) setSuggestion(null);
  };
  const suggest = async () => {
    setMessage("AI is working…");
    const r = await api.suggestChart(workspaceId, sheetId, instruction);
    setMessage(r.ok ? "AI suggestion below: review it, then add it." : r.error.message);
    if (r.ok) setSuggestion(r.data);
  };

  return (
    <div data-testid="charts">
      <h3>Charts</h3>
      {canEdit && (
        <>
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
          <div className="inline">
            <input aria-label="AI chart request" placeholder="Ask AI for a chart…" value={instruction} onChange={(e) => setInstruction(e.target.value)} size={32} />
            <button onClick={suggest} disabled={instruction.trim() === ""}>Ask AI: suggest chart</button>
          </div>
        </>
      )}
      {message && <p className="muted" data-testid="chart-message">{message}</p>}
      {suggestion && (
        <div className="notice" data-testid="chart-suggestion">
          <ChartView config={{ ...suggestion, id: "preview" }} data={chartData({ ...suggestion, id: "preview" }, values)} />
          <button onClick={() => add(suggestion)} disabled={!canEdit}>Add this chart</button>{" "}
          <button onClick={() => setSuggestion(null)}>Dismiss</button>
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

/** A small SVG bar or line chart. */
function ChartView({ config, data }: { config: ChartConfig; data: ChartData }) {
  const [w, h, pad] = [360, 220, 36];
  const all = data.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const min = Math.min(0, ...all);
  const n = Math.max(1, data.labels.length);
  const y = (v: number) => h - pad - ((v - min) / (max - min || 1)) * (h - 2 * pad);
  const slot = (w - 2 * pad) / n;
  return (
    <svg width={w} height={h} role="img" aria-label={config.title} data-testid="chart-svg" data-values={JSON.stringify(data.series.map((s) => s.values))}>
      <text x={w / 2} y={14} textAnchor="middle" fontWeight="bold" fontSize="12">{config.title}</text>
      <line x1={pad} y1={y(0)} x2={w - pad} y2={y(0)} stroke="#999" />
      <text x={4} y={y(max) + 4} fontSize="10">{Math.round(max * 100) / 100}</text>
      {data.labels.map((label, i) => (
        <text key={i} x={pad + slot * (i + 0.5)} y={h - pad + 14} textAnchor="middle" fontSize="10">{label.slice(0, 8)}</text>
      ))}
      {data.series.map((s, si) =>
        config.type === "bar" ? (
          s.values.map((v, i) => {
            const bw = (slot * 0.8) / data.series.length;
            const x = pad + slot * i + slot * 0.1 + bw * si;
            return <rect key={i} x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.abs(y(v) - y(0))} fill={COLORS[si % COLORS.length]} />;
          })
        ) : (
          <polyline
            key={si}
            fill="none"
            stroke={COLORS[si % COLORS.length]}
            strokeWidth="2"
            points={s.values.map((v, i) => `${pad + slot * (i + 0.5)},${y(v)}`).join(" ")}
          />
        ),
      )}
      {data.series.map((s, si) => (
        <text key={si} x={w - pad} y={14 + 11 * (si + 1)} textAnchor="end" fontSize="10" fill={COLORS[si % COLORS.length]}>{s.name}</text>
      ))}
    </svg>
  );
}
