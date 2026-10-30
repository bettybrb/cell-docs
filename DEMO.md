# Cell Docs demo

Every document, spreadsheet and workspace is its own **cell**: a Durable Object with a private SQLite database, addressed by name (`doc:ws/id`, `sheet:ws/id`). A stateless Worker routes to cells.

## Run

```bash
npm install
# AI: pick one. Without either, AI buttons answer 503 "not configured".
echo 'LLM_MOCK=1' > .dev.vars                 # deterministic offline stand-in model (free)
# echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars   # real model (billed); optional LLM_MODEL=claude-sonnet-5-5
# echo 'GEMINI_API_KEY=...' > .dev.vars              # or Gemini; optional LLM_MODEL=gemini-flash-lite-latest
# If both keys are set, Anthropic wins unless LLM_PROVIDER=gemini.
npm run dev                                   # note the URL (default port 5173)
BASE_URL=http://localhost:5173 npm run demo:seed
```

`.dev.vars` is local only; the key never reaches the browser.
The mock understands `replace X with Y` edits and summarising; use the real key for free-form instructions.

## Walk-through

Open `?user=alice` and, in a second window, `?user=bob` (test users, no real login).

1. **Cells + persistence**: the "Spreadsheets" section lists *Q3 Sales by region*. Stop and restart `npm run dev`: data and charts remain (SQLite per cell).
2. **Real-time collaboration**: in both windows open the sheet. Alice types `=B2*2` in `F2`; Bob sees it instantly. Edit `B3` as Bob: the *Revenue vs cost* bar chart and the Profit line chart change on both screens. Formulas: `+ - * / ( )`, `SUM AVERAGE MIN MAX COUNT`, ranges, `#CYCLE`/`#DIV/0` errors.
3. **AI chart (human approval)**: type "line chart of revenue" under *Ask AI*. A preview appears; nothing is saved until **Add this chart** is clicked.
4. **AI editing with approval**: open document `q3-report` (Agent proposals panel). Under *Ask AI* type `replace teh with the` → **Ask AI: edit**. Preview the red/green change; Bob types elsewhere in the doc meanwhile; **Apply** keeps his edits. Edit the same lines first and Apply refuses (409), so no silent overwrite. **Ask AI: summarise** adds a Summary section as a proposal too.
5. **Permissions / history**: switch to `?user=bob` with Bob set read-only (permissions panel): Ask AI and Apply are refused server-side. Applied proposals appear in Version history (reason "proposal"), and can be restored.

## Checks

```bash
npm run typecheck && npm test && npm run test:integration && npm run test:e2e
```
