# Progress
- [x] 1. Real AI (src/worker/llm.ts): Anthropic Messages API via server-side `ANTHROPIC_API_KEY` (+`LLM_MODEL`), JSON output validated, edits must match uniquely; goes through existing proposals (approval, permissions, versions, relative-position apply). `LLM_MOCK=1` = deterministic mock. Tests: test/worker/ai.test.ts
- [x] 2a. Spreadsheet backend: SheetCell DO (SQLite raw cells, LWW, hibernatable WS broadcast, perms, charts as range configs), shared formula engine (src/shared/sheet.ts: + - * / ( ) SUM AVERAGE MIN MAX COUNT, #CYCLE/#DIV/0/#REF/#ERR). Routes /api/workspaces/:ws/sheets/... Tests: test/worker/sheets.test.ts, test/shared/sheet.test.ts
- [x] 2b/3. Sheet UI (src/client/SheetPanel.tsx): live grid, bar/line SVG charts from ranges (persisted configs), AI chart suggestion (server validates; human clicks Add). e2e: test/e2e/sheets.spec.ts
- [x] 4. DEMO.md + `npm run demo:seed`.
- Note: port 5180 was occupied by a foreign process (returns 500); demo uses default vite port.
