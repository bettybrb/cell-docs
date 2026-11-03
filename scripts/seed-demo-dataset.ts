/**
 * Seeds the fictional "Brightwave Analytics" demo workspace into a running dev
 * server, through the public HTTP API only (no direct database access).
 *
 *   npm run demo:data                 # create whatever is missing (safe to rerun)
 *   RESET=1 npm run demo:data         # also restore the demo items to their seeded state
 *   DEMO_WORKSPACE=demo-2 npm run demo:data   # a brand-new, untouched copy
 *   BASE_URL=http://localhost:5180 ...
 *
 * Only the demo workspace (default "demo-brightwave") is ever written to; other
 * workspaces and their data are never read or changed. Everything is fictional.
 * Formulas use only what src/shared/sheet.ts supports; the script evaluates the
 * sheets with that same engine and fails if any value is an error or wrong.
 */
import { display, evaluateSheet, isError, type Raw } from "../src/shared/sheet.ts";

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:5180").replace(/\/$/, "");
const WS = process.env.DEMO_WORKSPACE ?? "demo-brightwave";
const RESET = process.env.RESET === "1";

let failures = 0;
const log = (mark: string, text: string) => console.log(`${mark.padEnd(8)} ${text}`);
const fail = (text: string) => {
  failures++;
  log("FAIL", text);
};

async function api<T = any>(method: string, path: string, user: string, body?: unknown): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE_URL}/api/workspaces/${WS}${path}`, {
    method,
    headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

async function must<T = any>(label: string, method: string, path: string, user: string, body?: unknown, ok: number[] = [200, 201]): Promise<T> {
  const r = await api<T>(method, path, user, body);
  if (!ok.includes(r.status)) {
    fail(`${label}: ${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
    throw new Error(`Seeding stopped at: ${label}`);
  }
  return r.data;
}

// ---------------------------------------------------------------- documents

const ROADMAP_DRAFT = `# Brightwave Product Roadmap, H1 2027

Draft. Priorities still to be agreed.

## Priorities

- SSO for enterprise customers
- Faster dashboards
- Usage-based billing
`;

const ROADMAP = `# Brightwave Product Roadmap, H1 2027

Brightwave helps operations teams turn raw event data into dashboards they can trust. This roadmap covers January to June 2027 and follows the goals set in the FY2026 review: reach 600 customers, keep gross margin above 65%, and cut dashboard load time in half.

## Priorities

| Priority | Theme | Owner | Target |
| --- | --- | --- | --- |
| P0 | Single sign-on (SAML + OIDC) | Alice | March 2027 |
| P0 | Dashboard performance: p95 load under 2 s | Bob | February 2027 |
| P1 | Usage-based billing | Carol | April 2027 |
| P1 | Scheduled report emails | Alice | May 2027 |
| P2 | Public API v2 (beta) | Bob | June 2027 |
| P2 | Dark mode for dashboards | Carol | June 2027 |

## Milestones

### January: Foundations

- Finish the query cache design and get it reviewed.
- Ship the new onboarding checklist to all new accounts.
- Hire a second backend engineer.

### February: Speed

- Query cache live for 25% of workspaces, then 100% by month end.
- Dashboard p95 load time under 2 seconds.

### March: Enterprise readiness

- SAML and OIDC single sign-on in general availability.
- Audit log export for admins.

### April to June: Growth features

- Usage-based billing pilot with five design partners.
- Scheduled report emails.
- Public API v2 beta, then dark mode if time allows.

## Risks

- SSO depends on a security review that is not yet scheduled.
- The query cache touches every dashboard, so a staged rollout is required.
- Billing changes need finance sign-off before the pilot starts.

## Success metrics

- 600 paying customers by end of June 2027.
- Gross margin of at least 65% every month.
- Dashboard p95 load time under 2 seconds.
- Support tickets about slow dashboards down by 50%.
`;

const MEETING = `# Weekly Product Sync, 3 November 2026

Attendees: Alice (product), Bob (engineering), Carol (design and billing)

## Updates

- Alice: Onboarding checklist tests are going well; completion rate is up from 41% to 58% in the pilot group.
- Bob: The query cache prototype cut median dashboard load time from 3.4 s to 1.9 s on the largest test workspace.
- Carol: Usage-based billing mockups are ready for review; finance has asked for a pricing worksheet.

## Decisions

- Decision: SSO stays P0 and is targeted for March 2027, pending the security review date.
- Decision: The query cache will roll out to 25% of workspaces first, then 100%.
- Decision: Dark mode moves to P2 so billing work is not delayed.

## Action items

- [ ] Alice: book the security review for SSO before 20 November.
- [ ] Bob: publish the query cache design doc and collect review comments.
- [ ] Carol: send the pricing worksheet to finance by Friday.
- [ ] Bob: add a load-time panel to the internal metrics board.
- [x] Alice: share the onboarding experiment results with the team.

## Open questions

- Should scheduled report emails ship before or after usage-based billing?
- Do we need a separate staging workspace for design partners?

## Next meeting

10 November 2026, same time.
`;

const TECH_DESIGN = `# Design: Event Ingestion Pipeline v2

This document proposes replacing our single-step event ingestion with a queue-based pipeline, so that dashboards stay fresh as customer data volumes grow. Status: in review. Author: Bob. Reviewers: Alice and Carol.

## Background

Brightwave currently recieve customer events through a single HTTP endpoint and writes them straight into the primary database. As customers send more data, this approach has become slow and makes dashboards lag behind reality. A queue-based pipeline separates receiving events from processing them.

## Proposed design

Events arrive at a thin receiver service, which validates them and writes them to the legacy queue. A pool of workers reads from the queue, enriches each event, and writes batches into the analytics store. A separate cache layer serves dashboard queries so that repeated requests do not hit the store.

The receiver is stateless and can be scaled horizontally. Workers are also stateless and use the event id to avoid processing the same event twice. If a worker fails, the event stays in the queue and is retried up to five times before moving to a dead letter queue for manual inspection.

## Goals

- Accept events within 100 ms at the 99th percentile, regardless of load.
- Make dashboards reflect new events within 5 seconds.
- Allow the processing stage to scale independently of the receiving stage.

## Non-goals

- Changing the public API shape or authentication.
- Supporting exactly-once delivery. At-least-once with deduplication is enough.

## Alternatives considered

1. Keep writing directly to the database and add read replicas. This is cheap but only delays the problem.
2. Use a managed streaming service. This is the most scalable option but costs roughly three times more than a simple queue at our current volume.

## Rollout plan

1. Deploy the receiver and queue behind a feature flag.
2. Mirror traffic for one week and compare results with the old path.
3. Move 25% of workspaces, then 100%.
4. Remove the old write path after two clean weeks.

## Risks

- Duplicate events if deduplication has a bug. We will add a nightly consistency check.
- Increased operational complexity. We will add dashboards and alerts before launch.
- Cache invalidation can show stale numbers, so the cache time to live will start at 5 seconds.

## Open questions

- Which managed queue product fits our budget?
- How long should the dead letter queue keep events?
`;

interface DocSpec {
  id: string;
  title: string;
  creator: string;
  draft?: string;
  body: string;
  folder: string;
  tags: string[];
  comments: Array<{ user: string; body: string; replies?: Array<{ user: string; body: string }>; resolvedBy?: string }>;
}

const DOCS: DocSpec[] = [
  {
    id: "product-roadmap",
    title: "Product Roadmap H1 2027",
    creator: "alice",
    draft: ROADMAP_DRAFT,
    body: ROADMAP,
    folder: "Product",
    tags: ["roadmap", "planning"],
    comments: [
      {
        user: "bob",
        body: "Can we confirm the SSO date with Security before committing to March?",
        replies: [{ user: "alice", body: "Good point. I will book the review this week; see the action items in the weekly sync notes." }],
      },
      { user: "carol", body: "Usage-based billing mockups are ready, so April still looks realistic.", resolvedBy: "alice" },
    ],
  },
  {
    id: "weekly-sync-notes",
    title: "Weekly Product Sync, 3 Nov 2026",
    creator: "bob",
    body: MEETING,
    folder: "Product",
    tags: ["meeting", "actions"],
    comments: [{ user: "alice", body: "Please tick off your action items after each sync so we can see progress." }],
  },
  {
    id: "design-ingestion-pipeline",
    title: "Design: Event Ingestion Pipeline v2",
    creator: "bob",
    body: TECH_DESIGN,
    folder: "Engineering",
    tags: ["design", "backend"],
    comments: [
      {
        user: "carol",
        body: "Is the 5 second freshness goal realistic with the cache TTL you propose?",
        replies: [{ user: "bob", body: "Yes, the TTL starts at 5 s and we will measure before relaxing it." }],
      },
    ],
  },
];

// ------------------------------------------------------------- spreadsheets

// The sheet grid shows columns A-H and rows 1-15, so everything below fits in that view.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"];
// Revenue, COGS, Opex in $ thousands; customers at month end.
const FIN: Array<[number, number, number, number]> = [
  [118, 42, 96, 212], [126, 44, 97, 228], [139, 47, 99, 251], [151, 51, 101, 274],
  [166, 55, 104, 299], [181, 60, 108, 327], [193, 63, 111, 351], [210, 68, 115, 383],
  [228, 73, 119, 418], [247, 79, 124, 452],
];
const LAST = FIN.length + 1; // last data row (11)

function financials(): Raw {
  const cells: Raw = {
    A1: "Month", B1: "Revenue", C1: "COGS", D1: "Gross Profit", E1: "Opex", F1: "Net Income",
    G1: "Gross Margin %", H1: "Customers",
  };
  FIN.forEach(([revenue, cogs, opex, customers], i) => {
    const r = i + 2;
    Object.assign(cells, {
      [`A${r}`]: MONTHS[i]!, [`B${r}`]: String(revenue), [`C${r}`]: String(cogs),
      [`D${r}`]: `=B${r}-C${r}`, [`E${r}`]: String(opex), [`F${r}`]: `=D${r}-E${r}`,
      [`G${r}`]: `=D${r}/B${r}*100`, [`H${r}`]: String(customers),
    });
  });
  const summary: Array<[number, string, string]> = [[12, "Total", "SUM"], [13, "Average", "AVERAGE"], [14, "Highest", "MAX"], [15, "Lowest", "MIN"]];
  for (const [row, label, fn] of summary) {
    cells[`A${row}`] = label;
    for (const c of ["B", "C", "D", "E", "F"]) cells[`${c}${row}`] = `=${fn}(${c}2:${c}${LAST})`;
  }
  cells.G12 = `=D12/B12*100`; // overall gross margin
  cells.G13 = `=AVERAGE(G2:G${LAST})`;
  cells.H12 = `=H${LAST}`; // closing customer count
  return cells;
}

const CHANNELS: Array<[string, number, number, number]> = [
  // channel, leads, signups, spend ($ thousands)
  ["Organic search", 1840, 212, 9], ["Paid search", 1260, 138, 42], ["Referrals", 620, 131, 6],
  ["Partnerships", 410, 74, 18], ["Webinars", 540, 61, 15], ["Social media", 980, 47, 17], ["Outbound sales", 330, 38, 24],
];

function channels(): Raw {
  const cells: Raw = { A1: "Channel", B1: "Leads", C1: "Signups", D1: "Spend", E1: "Conversion %", F1: "CAC ($)" };
  CHANNELS.forEach(([name, leads, signups, spend], i) => {
    const r = i + 2;
    Object.assign(cells, {
      [`A${r}`]: name, [`B${r}`]: String(leads), [`C${r}`]: String(signups), [`D${r}`]: String(spend),
      [`E${r}`]: `=C${r}/B${r}*100`, [`F${r}`]: `=D${r}*1000/C${r}`,
    });
  });
  return cells;
}

interface ChartSpec { title: string; type: "bar" | "line"; orientation?: "horizontal"; labels: string; series: Array<{ name: string; range: string }> }
interface SheetSpec { id: string; title: string; creator: string; cells: Raw; charts: ChartSpec[] }

const SHEETS: SheetSpec[] = [
  {
    id: "fy2026-financials",
    title: "FY2026 Financials, Jan to Oct ($ thousands)",
    creator: "alice",
    cells: financials(),
    charts: [
      { title: "Revenue vs Opex ($k)", type: "bar", labels: "A2:A11", series: [{ name: "Revenue", range: "B2:B11" }, { name: "Opex", range: "E2:E11" }] },
      { title: "Net Income ($k)", type: "line", labels: "A2:A11", series: [{ name: "Net Income", range: "F2:F11" }] },
      { title: "Customers", type: "line", labels: "A2:A11", series: [{ name: "Customers", range: "H2:H11" }] },
    ],
  },
  {
    // No totals and no charts: a clean table for the "ask AI for a chart" scenario.
    id: "acquisition-channels",
    title: "Acquisition Channels, Q3 2026",
    creator: "bob",
    cells: channels(),
    charts: [],
  },
];

// ------------------------------------------------------------------- checks

function checkSheet(spec: SheetSpec): void {
  const values = evaluateSheet(spec.cells);
  const errors = Object.entries(values).filter(([, v]) => isError(v));
  if (errors.length) return fail(`${spec.id}: formula errors ${errors.map(([r, v]) => `${r}=${display(v)}`).join(", ")}`);
  const num = (ref: string) => values[ref] as number;
  if (spec.id === "fy2026-financials") {
    const revenue = FIN.reduce((s, r) => s + r[0], 0);
    const cogs = FIN.reduce((s, r) => s + r[1], 0);
    const net = FIN.reduce((s, r) => s + r[0] - r[1] - r[2], 0);
    const ok =
      num("B12") === revenue && num("F12") === net && num("B14") === 247 && num("B15") === 118 && num("F15") === -20 &&
      num("H12") === 452 && Math.abs(num("G12") - ((revenue - cogs) / revenue) * 100) < 1e-9;
    ok
      ? log("OK", `${spec.id}: formulas evaluate (total revenue ${revenue}k, net income ${net}k, gross margin ${display(Math.round(num("G12") * 10) / 10)}%)`)
      : fail(`${spec.id}: totals do not match the seed data`);
  } else {
    const ok = CHANNELS.every((c, i) => Math.abs(num(`E${i + 2}`) - (c[2] / c[1]) * 100) < 1e-9);
    ok ? log("OK", `${spec.id}: formulas evaluate`) : fail(`${spec.id}: conversion values wrong`);
  }
}

// -------------------------------------------------------------------- seeding

async function ensureFolders(): Promise<Map<string, string>> {
  await must("workspace", "PUT", "", "alice", { displayName: "Brightwave Analytics (demo)" });
  const list = await must("list docs", "GET", "/docs", "alice");
  const ids = new Map<string, string>((list.folders ?? []).filter((f: any) => f.parentId === null).map((f: any) => [f.name, f.id]));
  for (const name of new Set(DOCS.map((x) => x.folder))) {
    if (!ids.has(name)) ids.set(name, (await must(`folder ${name}`, "POST", "/folders", "alice", { name })).id);
  }
  return ids;
}

async function seedDoc(spec: DocSpec): Promise<void> {
  const path = `/docs/${spec.id}`;
  const existing = await api("GET", path, "alice");
  if (existing.status === 404) {
    if (spec.draft) await must(`${spec.id} draft`, "PUT", path, spec.creator, { title: spec.title, body: spec.draft });
    await must(`${spec.id} create`, "PUT", path, spec.creator, { title: spec.title, body: spec.body });
    log("CREATED", `doc ${spec.id}`);
  } else if (existing.status === 200 && RESET) {
    // Pending AI proposals were made against the old text; drop them so the demo starts clean.
    const pending = ((await must(`${spec.id} proposals`, "GET", `${path}/proposals`, "alice")) as any).proposals ?? [];
    for (const p of pending.filter((x: any) => x.status === "pending")) await must(`${spec.id} discard proposal`, "POST", `${path}/proposals/${p.id}/discard`, "alice");
    if (existing.data.body !== spec.body || existing.data.title !== spec.title) await must(`${spec.id} reset`, "PUT", path, "alice", { title: spec.title, body: spec.body });
    log("RESET", `doc ${spec.id}`);
  } else if (existing.status === 200) {
    log("KEPT", `doc ${spec.id} (already exists; RESET=1 restores the seeded text)`);
  } else if (existing.status === 410) {
    log("SKIPPED", `doc ${spec.id} is in the Recycle Bin; restore it there or use another DEMO_WORKSPACE`);
    return;
  } else throw new Error(`Unexpected ${existing.status} for ${path}`);

  const threads = (await must(`${spec.id} comments`, "GET", `${path}/comments`, "alice")).threads as unknown[];
  if (threads.length === 0) {
    for (const c of spec.comments) {
      const thread = await must(`${spec.id} comment`, "POST", `${path}/comments`, c.user, { body: c.body });
      for (const reply of c.replies ?? []) await must(`${spec.id} reply`, "POST", `${path}/comments/${thread.id}/replies`, reply.user, { body: reply.body });
      if (c.resolvedBy) await must(`${spec.id} resolve`, "POST", `${path}/comments/${thread.id}/resolve`, c.resolvedBy, { resolved: true });
    }
    log("OK", `${spec.id}: ${spec.comments.length} comment thread(s) added`);
  }
}

async function seedSheet(spec: SheetSpec): Promise<void> {
  const path = `/sheets/${spec.id}`;
  const existing = await api("GET", path, "alice");
  if (existing.status === 404) {
    await must(`${spec.id} create`, "PUT", path, spec.creator, { title: spec.title, cells: spec.cells, charts: spec.charts });
    log("CREATED", `sheet ${spec.id} (${Object.keys(spec.cells).length} cells, ${spec.charts.length} charts)`);
  } else if (existing.status === 200 && RESET) {
    if (existing.data.title !== spec.title) await must(`${spec.id} title`, "PUT", path, "alice", { title: spec.title });
    const current: Raw = existing.data.cells ?? {};
    const edits = [
      ...Object.entries(spec.cells).filter(([ref, raw]) => current[ref] !== raw).map(([ref, raw]) => ({ ref, raw })),
      ...Object.keys(current).filter((ref) => !(ref in spec.cells)).map((ref) => ({ ref, raw: "" })),
    ];
    if (edits.length) await must(`${spec.id} reset cells`, "POST", `${path}/cells`, "alice", { edits });
    for (const chart of existing.data.charts ?? []) await must(`${spec.id} drop chart`, "DELETE", `${path}/charts/${chart.id}`, "alice", undefined, [200, 204]);
    for (const chart of spec.charts) await must(`${spec.id} chart`, "POST", `${path}/charts`, "alice", chart);
    log("RESET", `sheet ${spec.id} (${edits.length} cell(s) restored)`);
  } else if (existing.status === 200) {
    log("KEPT", `sheet ${spec.id} (already exists; RESET=1 restores the seeded cells and charts)`);
  } else {
    log("SKIPPED", `sheet ${spec.id}: status ${existing.status}`);
  }
}

// ----------------------------------------------------------------------- run

try {
  await fetch(`${BASE_URL}/api/health`);
} catch {
  console.error(`Cannot reach ${BASE_URL}. Start the app first (npm run demo:start) and rerun.`);
  process.exit(1);
}

console.log(`Seeding workspace "${WS}" at ${BASE_URL}${RESET ? " (RESET=1)" : ""}\n`);
SHEETS.forEach(checkSheet);
if (failures) process.exit(1);

try {
  const folders = await ensureFolders();
  for (const doc of DOCS) await seedDoc(doc);
  for (const sheet of SHEETS) await seedSheet(sheet);
  // Folders and tags are catalogue metadata (documents only) and are harmless to reapply.
  for (const doc of DOCS) await api("PUT", `/docs/${doc.id}/meta`, "alice", { folderId: folders.get(doc.folder), tags: doc.tags });

  // Verify by reading everything back through the API as Bob.
  const list = await must("final list", "GET", "/docs", "bob");
  for (const d of DOCS) {
    const found = (list.docs ?? []).some((x: any) => x.id === d.id || x.docId === d.id);
    found ? log("OK", `doc "${d.title}" visible to bob`) : fail(`doc ${d.id} not in the catalogue`);
  }
  for (const s of SHEETS) {
    const state = await must(`read ${s.id}`, "GET", `/sheets/${s.id}`, "bob");
    const values: Record<string, unknown> = state.values ?? {};
    const bad = Object.keys(values).filter((r) => typeof values[r] === "object");
    bad.length === 0 && Object.keys(state.cells ?? {}).length > 0
      ? log("OK", `sheet "${s.title}" readable by bob, ${state.charts?.length ?? 0} chart(s)`)
      : fail(`sheet ${s.id} unreadable or has errors`);
  }
} catch (error) {
  fail(String(error));
}

console.log(`
Open in two windows:
  Alice: ${BASE_URL}/?user=alice&workspace=${WS}
  Bob:   ${BASE_URL}/?user=bob&workspace=${WS}
`);
process.exit(failures ? 1 : 0);
