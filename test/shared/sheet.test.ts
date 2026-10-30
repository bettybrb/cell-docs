import { describe, expect, it } from "vitest";
import { chartData, chartProblem, display, evaluateSheet, expandRange, parseRef } from "../../src/shared/sheet";

const ev = (raw: Record<string, string>, ref: string) => display(evaluateSheet(raw)[ref]);

describe("formulas", () => {
  const raw = { A1: "10", A2: "20", A3: "30", B1: "=A1*2+1", B2: "=SUM(A1:A3)", B3: "=AVERAGE(A1:A3)/(A1-10)", B4: "=MAX(A1:A3, 5)-MIN(A1:A3)", C1: "=C2", C2: "=C1", D1: "=B1+B2", D2: "=COUNT(A1:A3)", D3: "=1+", D4: "=A9+Z99", D5: "=-A1+ (2*3)", E1: "hello", E2: "=E1+1" };
  it.each([
    ["B1", "21"], ["B2", "60"], ["B3", "#DIV/0"], ["B4", "20"], ["C1", "#CYCLE"], ["D1", "81"], ["D2", "3"], ["D3", "#ERR"], ["D4", "0"], ["D5", "-4"], ["E2", "#VALUE"],
  ])("%s = %s", (ref, expected) => expect(ev(raw, ref)).toBe(expected));
  it("parses refs and ranges", () => {
    expect(parseRef("A1")).toEqual({ col: 0, row: 0 });
    expect(parseRef("AA1")).toBeNull();
    expect(parseRef("A101")).toBeNull();
    expect(expandRange("A1:B2")).toEqual(["A1", "B1", "A2", "B2"]);
  });
  it("builds chart data and validates configs", () => {
    const values = evaluateSheet({ A1: "Q1", A2: "Q2", B1: "5", B2: "=B1*2" });
    const cfg = { id: "c", title: "T", type: "bar" as const, labels: "A1:A2", series: [{ name: "S", range: "B1:B2" }] };
    expect(chartData(cfg, values)).toEqual({ labels: ["Q1", "Q2"], series: [{ name: "S", values: [5, 10] }] });
    expect(chartProblem(cfg)).toBeNull();
    expect(chartProblem({ ...cfg, series: [{ name: "S", range: "B1:B3" }] })).toMatch(/as long/);
    expect(chartProblem({ ...cfg, type: "pie" as never })).toMatch(/bar or line/);
  });
});
