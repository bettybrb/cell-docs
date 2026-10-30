/**
 * Seeds realistic demo data into a running dev server (`npm run dev` first):
 *   npm run demo:seed            # http://localhost:5180
 * Creates workspace "sample-workspace" with a report document (with typos for
 * the AI to fix) and a sales sheet with formulas and two charts. Safe to rerun.
 */
const BASE_URL = process.env.BASE_URL ?? "http://localhost:5180";
const WS = "sample-workspace";

async function put(path: string, body: unknown) {
  const r = await fetch(`${BASE_URL}/api/workspaces/${WS}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-test-user": "alice" },
    body: JSON.stringify(body),
  });
  console.log(`${r.status}  PUT ${path}`);
}

const regions = [
  ["North", 120, 80], ["South", 95, 70], ["East", 140, 90], ["West", 110, 85], ["Central", 75, 40],
] as const;
const cells: Record<string, string> = { A1: "Region", B1: "Revenue", C1: "Cost", D1: "Profit" };
regions.forEach(([name, revenue, cost], i) => {
  const row = i + 2;
  Object.assign(cells, { [`A${row}`]: name, [`B${row}`]: String(revenue), [`C${row}`]: String(cost), [`D${row}`]: `=B${row}-C${row}` });
});
Object.assign(cells, { A7: "Total", B7: "=SUM(B2:B6)", C7: "=SUM(C2:C6)", D7: "=SUM(D2:D6)", A8: "Margin %", B8: "=D7/B7*100" });

await put("/docs/q3-report", {
  title: "Q3 Report",
  body: `# Q3 Report

our regional teams  had a strong quarter , with revenue up across the board.
The East region was the stand-out, while Central remains the smallest market.

## Risks

Supply chain delays in the South region hurt margins, and teh West region lost one key account.
We expect these issues to ease in Q4 as new suppliers come online.

## Next steps

Hire two account managers for Central. Renegotiate freight contracts. Review pricing in the West.
`,
});
await put("/sheets/sales-q3", {
  title: "Q3 Sales by region",
  cells,
  charts: [
    { title: "Revenue vs cost", type: "bar", labels: "A2:A6", series: [{ name: "Revenue", range: "B2:B6" }, { name: "Cost", range: "C2:C6" }] },
    { title: "Profit", type: "line", labels: "A2:A6", series: [{ name: "Profit", range: "D2:D6" }] },
  ],
});
console.log(`Open ${BASE_URL}/?user=alice  (and a second tab with ?user=bob)`);

export {};
