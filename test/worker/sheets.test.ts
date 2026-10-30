import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { SheetList, SheetState } from "../../src/shared/api-types";
import { chartData, evaluateSheet } from "../../src/shared/sheet";
import { api, uniqueId } from "./helpers";

async function newSheet(cells: Record<string, string> = {}) {
  const [ws, id] = [uniqueId("ws"), uniqueId("sheet")];
  const path = `/api/workspaces/${ws}/sheets/${id}`;
  const r = await api<SheetState>("PUT", path, { title: "Budget", cells }, "alice");
  expect(r.status).toBe(201);
  return { ws, id, path };
}
const edit = (path: string, edits: Array<{ ref: string; raw: string }>, user = "alice") => api<SheetState>("POST", `${path}/cells`, { edits }, user);

async function connect(path: string, user: string) {
  const response = await exports.default.fetch(`https://example.test${path}/sync?user=${user}`, { headers: { upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const messages: any[] = [];
  socket.addEventListener("message", (e) => {
    messages.push(JSON.parse(e.data as string));
  });
  return { socket, messages };
}

describe("sheet cell", () => {
  it("creates, lists, stores raw cells and evaluates formulas from them", async () => {
    const { ws, id, path } = await newSheet({ A1: "Q1", B1: "10", B2: "=B1*3" });
    const state = (await api<SheetState>("GET", path)).data;
    expect(state).toMatchObject({ title: "Budget", owner: "alice", yourRole: "owner", cell: { kind: "sheet" } });
    expect(state.cells).toEqual({ A1: "Q1", B1: "10", B2: "=B1*3" });
    expect(evaluateSheet(state.cells).B2).toBe(30);
    expect((await api<SheetList>("GET", `/api/workspaces/${ws}/sheets`)).data.sheets.map((s) => s.sheetId)).toEqual([id]);
  });

  it("applies edits atomically and rejects bad references", async () => {
    const { path } = await newSheet({ A1: "1" });
    expect((await edit(path, [{ ref: "A1", raw: "5" }, { ref: "ZZ9", raw: "x" }])).status).toBe(422);
    expect((await api<SheetState>("GET", path)).data.cells.A1).toBe("1");
    const ok = await edit(path, [{ ref: "A1", raw: "" }, { ref: "B2", raw: "=A1+1" }]);
    expect(ok.data.cells).toEqual({ B2: "=A1+1" });
  });

  it("enforces permissions", async () => {
    const { path } = await newSheet({ A1: "1" });
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: { carol: "edit" } }, "alice");
    expect((await edit(path, [{ ref: "A1", raw: "2" }], "bob")).status).toBe(403);
    expect((await edit(path, [{ ref: "A1", raw: "3" }], "carol")).status).toBe(200);
    expect((await api("PUT", `${path}/permissions`, { defaultRole: "edit", users: {} }, "bob")).status).toBe(403);
    await api("PUT", `${path}/permissions`, { defaultRole: "none", users: {} }, "alice");
    expect((await api("GET", path, undefined, "bob")).status).toBe(403);
  });

  it("broadcasts edits live to every connected page, and refuses readers", async () => {
    const { path } = await newSheet({ A1: "1" });
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: { alice: "edit", carol: "edit" } }, "alice");
    const [a, c, b] = [await connect(path, "alice"), await connect(path, "carol"), await connect(path, "bob")];
    await vi.waitFor(() => expect(c.messages[0]?.type).toBe("hello"));
    a.socket.send(JSON.stringify({ type: "edit", ref: "A2", raw: "=A1+1" }));
    await vi.waitFor(() => expect(c.messages.some((m) => m.type === "cells" && m.edits[0].ref === "A2" && m.by === "alice")).toBe(true));
    b.socket.send(JSON.stringify({ type: "edit", ref: "A3", raw: "hack" }));
    await vi.waitFor(() => expect(b.messages.some((m) => m.type === "rejected")).toBe(true));
    expect((await api<SheetState>("GET", path)).data.cells).toEqual({ A1: "1", A2: "=A1+1" });
  });

  it("stores charts as ranges, so they follow the data", async () => {
    const { path } = await newSheet({ A1: "Q1", A2: "Q2", B1: "5", B2: "7" });
    const cfg = { title: "Sales", type: "bar", labels: "A1:A2", series: [{ name: "Units", range: "B1:B2" }] };
    expect((await api("POST", `${path}/charts`, { ...cfg, type: "pie" }, "alice")).status).toBe(422);
    expect((await api("POST", `${path}/charts`, cfg, "alice")).status).toBe(201);
    await edit(path, [{ ref: "B2", raw: "=B1*10" }]);
    const state = (await api<SheetState>("GET", path)).data;
    expect(state.charts).toHaveLength(1);
    expect(chartData(state.charts[0]!, evaluateSheet(state.cells)).series[0]!.values).toEqual([5, 50]);
    const del = await api<SheetState>("DELETE", `${path}/charts/${state.charts[0]!.id}`, undefined, "alice");
    expect(del.data.charts).toEqual([]);
  });

  it("AI suggests a chart for review; nothing is saved until it is added", async () => {
    const { path } = await newSheet({ A1: "Month", B1: "Revenue", C1: "Cost", A2: "Jan", B2: "10", C2: "4", A3: "Feb", B3: "12", C3: "5" });
    const s = await api<any>("POST", `${path}/charts/suggest`, { instruction: "line chart of revenue" }, "alice");
    expect(s.status).toBe(200);
    expect(s.data).toMatchObject({ type: "line", labels: "A2:A3", series: [{ name: "Revenue", range: "B2:B3" }] });
    expect((await api<SheetState>("GET", path)).data.charts).toEqual([]);
    expect((await api("POST", `${path}/charts`, s.data, "alice")).status).toBe(201);
    await api("PUT", `${path}/permissions`, { defaultRole: "read", users: {} }, "alice");
    expect((await api("POST", `${path}/charts/suggest`, { instruction: "x" }, "bob")).status).toBe(403);
  });

  it("AI follows the instruction: named columns, horizontal bars, and changing an existing chart", async () => {
    const { path } = await newSheet({ A1: "Month", B1: "Revenue", C1: "Cost", A2: "Jan", B2: "10", C2: "4", A3: "Feb", B3: "12", C3: "5" });
    const s = await api<any>("POST", `${path}/charts/suggest`, { instruction: "horizontal bar chart of cost" }, "alice");
    expect(s.data).toMatchObject({ type: "bar", orientation: "horizontal", series: [{ name: "Cost", range: "C2:C3" }] });
    const added = await api<any>("POST", `${path}/charts`, s.data, "alice");
    expect(added.status).toBe(201);
    expect(added.data.orientation).toBe("horizontal");
    expect((await api("POST", `${path}/charts`, { ...s.data, orientation: "diagonal" }, "alice")).status).toBe(422);

    const m = await api<any>("POST", `${path}/charts/suggest`, { instruction: "make it a line chart", chartId: added.data.id }, "alice");
    expect(m.data).toMatchObject({ type: "line", series: [{ name: "Cost", range: "C2:C3" }] });
    expect(m.data.orientation).toBeUndefined();
    expect((await api("POST", `${path}/charts/suggest`, { instruction: "x", chartId: "nope" }, "alice")).status).toBe(404);

    expect((await api("PUT", `${path}/charts/${added.data.id}`, m.data, "alice")).status).toBe(200);
    const charts = (await api<SheetState>("GET", path)).data.charts;
    expect(charts).toHaveLength(1);
    expect(charts[0]).toMatchObject({ id: added.data.id, type: "line" });
    expect((await api("PUT", `${path}/charts/missing`, m.data, "alice")).status).toBe(404);
  });
});
