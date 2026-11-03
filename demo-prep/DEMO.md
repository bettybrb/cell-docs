# Cell Docs live demo: Brightwave Analytics

A fictional startup workspace (`demo-brightwave`) with 3 documents and 2 spreadsheets, two demo users (Alice, Bob) and an offline mock AI, so nothing depends on a paid API or the internet.

## 1. Launch (2 terminals, about 1 minute)

```bash
cd ~/projects/cell-docs-lab
npm run demo:start          # terminal 1: app on http://localhost:5180, AI = offline mock
npm run demo:data           # terminal 2, once the URL is printed: seeds the workspace
```

- `demo:start` runs the normal dev server with `LLM_MOCK=1`. It reads a separate, git-ignored `.dev.vars.demo` (created automatically). Your own `.dev.vars` with the Gemini key is **not** read or changed, so no paid call can happen.
- Data is stored in `.wrangler/state`, so it survives restarts. After the first seed you only need `npm run demo:start`.
- The port is fixed at 5180 (the old `DEMO.md` says 5173; that is out of date). If it is busy, stop the other process.

## 2. Reset the dataset safely

| Goal | Command |
| --- | --- |
| Create anything missing, change nothing else | `npm run demo:data` (safe to rerun) |
| Put the demo back to its seeded state before a run | `RESET=1 npm run demo:data` (restores demo doc text and sheet cells and charts, drops pending AI proposals; comments and version history stay) |
| A brand-new untouched copy | `DEMO_WORKSPACE=demo-2 npm run demo:data`, then use `workspace=demo-2` in the URLs |

Only the demo workspace is ever written. Other workspaces (`sample-workspace`, etc.) are never touched. Do not delete `.wrangler/` unless you want to lose all local data.

## 3. URLs (two browser windows, ideally side by side)

- Alice: http://localhost:5180/?user=alice&workspace=demo-brightwave
- Bob: http://localhost:5180/?user=bob&workspace=demo-brightwave

Use two separate windows (a normal one and a private one are fine). The **Documents** tab lists the three documents (click one, it loads in the editor); the **Spreadsheets** tab lists the two sheets. The user switcher is top right ("Test user"; there is no real login).

Direct links, if you prefer: add `&doc=product-roadmap`, `&doc=weekly-sync-notes`, `&doc=design-ingestion-pipeline`, `&sheet=fy2026-financials` or `&sheet=acquisition-channels`.

## 4. What is in the dataset

| Item | Content |
| --- | --- |
| **Product Roadmap H1 2027** (`product-roadmap`) | Headings, a priority table (P0/P1/P2), monthly milestones, risks, metrics. 2 comment threads (one with a reply, one resolved) and a version history (short draft, then the full roadmap). |
| **Weekly Product Sync, 3 Nov 2026** (`weekly-sync-notes`) | Updates, decisions, action items as checkboxes. 1 comment. |
| **Design: Event Ingestion Pipeline v2** (`design-ingestion-pipeline`) | Technical design for AI editing and summarising. Contains the typo `recieve` and the phrase `legacy queue`. 1 comment thread with a reply. |
| **FY2026 Financials, Jan to Oct** (`fy2026-financials`) | Monthly revenue, COGS, opex, customers ($ thousands). Formulas: gross profit, net income, margin %, and Total/Average/Highest/Lowest rows (`SUM AVERAGE MAX MIN`). 3 charts: *Revenue vs Opex* (bar), *Net Income* (line), *Customers* (line). Totals: revenue 1759, net income 103, margin about 66.9%. |
| **Acquisition Channels, Q3 2026** (`acquisition-channels`) | 7 channels with Leads, Signups, Spend, `Conversion %` and `CAC ($)` formulas. **No charts yet**, on purpose: this is the sheet for "ask AI for a chart". |

Alice owns the roadmap and the financials; Bob owns the meeting notes, the design doc and the channels sheet. Everyone can edit (default role), and Carol exists as a third test user if you want a commenter or read-only example.

## 5. Scenarios

### A. Real-time document editing (1.5 min)
1. Both windows: **Documents** → *Product Roadmap H1 2027*. The status line shows "Connected" and "2 here" with both users' colours.
2. Alice edits a target date in the priority table (e.g. change `March 2027` to `April 2027` for SSO). Bob sees it appear while typing.
3. At the same moment Bob types a new bullet under **Risks**. Both edits survive (no overwrite).
4. Show the comment sidebar: Bob's SSO question with Alice's reply, plus the resolved thread (tick *Show resolved*). Add a new comment as Bob and watch it appear for Alice.
5. Open **Versions**: saved versions with the author; preview the oldest (the original short draft).

### B. Spreadsheet and formulas (1.5 min)
1. Both windows: **Spreadsheets** → *FY2026 Financials*.
2. Alice clicks `B3` and enters `150` (was 126). Bob sees the value change, then `D3`, `F3`, `G3`, the totals row (`B12`: 1759 → 1783) and the Revenue vs Opex chart all update live.
3. Click `D3` to show the formula `=B3-C3`; click `G3` for `=D3/B3*100`; click `B12` for `=SUM(B2:B11)`.
4. In the free cell `H13` (Bob) type `=MAX(H2:H11)` → 452, then `=COUNT(B2:B11)` in `H14` → 10.
5. Optional error demo: type `=B2/0` in `H15` → `#DIV/0`; `=H15` typed into `H15` itself → `#CYCLE`. Clear them afterwards (or run `RESET=1 npm run demo:data`).
   Supported formula syntax: `+ - * / ( )`, `SUM AVERAGE MIN MAX COUNT`, ranges like `B2:B11`. (No `ROUND`, no `%` literal, no `IF`.) Percent columns therefore show many decimals; that is the engine, not a bug.

### C. AI proposal with manual approval (2 min)
1. Open *Design: Event Ingestion Pipeline v2* in both windows.
2. In **Agent proposals → Ask AI**, type `replace recieve with receives` and click **Ask AI: edit**. A proposal appears: open it to see the red/green preview. Nothing in the document has changed yet.
3. While it is pending, Bob types a sentence elsewhere in the document. Alice clicks **Apply**: the fix is applied and Bob's text is kept. (If someone edits the *same lines*, Apply is refused instead; show this if you have time.)
4. Click **Ask AI: summarise**: a `## Summary` section is proposed at the top; apply or discard it.
5. Show the **Versions** list: the applied proposal appears as a version you can restore.
6. A second edit that works with the mock: `replace legacy queue with message queue`.

The mock understands `replace X with Y` and summarise. Free-form instructions ("make this more concise") only work with a real model; with the mock they answer "no changes".

### D. Charts (1.5 min)
1. Open *Acquisition Channels, Q3 2026* (no charts). Under **Charts → Ask AI**, type `bar chart of Signups` → **Ask AI: suggest chart**. A preview appears; nothing is saved until you click **Add this chart**.
2. Add it; Bob sees the chart appear. Then try `horizontal bar chart of Spend` and `line chart of Leads`.
3. Edit a number as Bob (e.g. `C2` from 212 to 300) and show the chart move on both screens.
4. Tip: with the mock, name the column header in the request (Leads, Signups, Spend, `Conversion %`); otherwise it charts the first two numeric columns.
5. Do the AI chart **before** typing extra cells into this sheet: the mock charts down to the last row that contains anything.

## 6. If an external AI API is unavailable

You are already protected: `npm run demo:start` uses the offline mock, so the AI buttons work without internet or keys. Things to know:

- The provider drop-down may still read "Gemini / gemini-flash-lite-latest". With the mock on, that selection is ignored; this is expected.
- To use a real model instead, run `npm run dev` (reads `.dev.vars`) and make sure it contains a key and `LLM_MOCK=0`. If the live API then errors or rate-limits, stop the server and switch back with `npm run demo:start`; the data is kept.
- Even with no AI at all, the non-AI buttons beside the AI ones work: **Ask agent: tidy up**, **Ask agent: add a summary**, and **Ask agent: replace** (find / replace-with boxes). They produce the same previewed, manually applied proposals. Charts can be built by hand under **Add a chart manually**.

## 7. Suggested 6 to 8 minute run

| Time | Step |
| --- | --- |
| 0:00 | Intro (30 s): every doc and sheet is its own "cell", a Durable Object with its own SQLite. Show the Documents list: folders, tags, owners. |
| 0:30 | **A**. Two windows editing the roadmap live, comments, version history (2 min). |
| 2:30 | **B**. Financials sheet: change `B3`, watch formulas, totals and charts update in both windows (1.5 min). |
| 4:00 | **C**. AI edit on the design doc: preview, concurrent typing, Apply; then summarise (2 min). |
| 6:00 | **D**. Ask AI for a chart on the channels sheet, review, add (1.5 min). |
| 7:30 | Close (30 s): permissions (switch Bob to read-only: AI and Apply are refused server-side), restart the server to show persistence. Reset with `RESET=1 npm run demo:data`. |

Before you start, always: `RESET=1 npm run demo:data` (a few seconds), then hard-refresh both windows.

## 8. Troubleshooting

- `Cannot reach http://localhost:5180`: `npm run demo:start` is not running yet.
- Workspace list empty: you opened the wrong URL. Include `workspace=demo-brightwave`; the default workspace is `sample-workspace`.
- AI says "not configured" (503): you started with `npm run dev` without a key. Use `npm run demo:start`.
- Windows do not sync: reload both; check the status line says "Connected".
