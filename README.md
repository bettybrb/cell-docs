# cell-docs-lab

An exploration project: a small collaborative documents and spreadsheets
application built from **cells**. A cell is one
[Cloudflare Durable Object](https://developers.cloudflare.com/durable-objects/)
with its own private SQLite database. A stateless Worker routes each request
to exactly one cell.

Everything runs locally in [workerd](https://github.com/cloudflare/workerd),
the open-source Workers runtime. No Cloudflare account is needed, and nothing
has been deployed.

Further reading: [docs/architecture.md](docs/architecture.md) (design notes
for documents), [DEMO.md](DEMO.md) (walk-through),
[docs/celld-smoke-test.md](docs/celld-smoke-test.md) (a first run on the celld
runtime).

## Architecture

```
Browser ──HTTP / WebSocket──▶ Worker (router) ──stub.fetch()──▶ Cell (Durable Object) ──SQL──▶ its own SQLite
```

| Cell class | One instance per | Name | Stores |
|---|---|---|---|
| `WorkspaceCell` | workspace | `workspace:<ws>` | settings, the catalogue of documents and sheets (folders, tags, searchable text copy), the Recycle Bin |
| `DocCell` | document | `doc:<ws>/<doc>` | title, permissions, the body as Yjs updates plus a plain-text copy, versions, comment threads, AI/agent proposals |
| `SheetCell` | spreadsheet | `sheet:<ws>/<sheet>` | raw cell text, permissions, chart configurations |

- **Worker** ([src/worker/index.ts](src/worker/index.ts)): keeps no state. It
  matches the URL, derives the cell name ([addressing.ts](src/worker/addressing.ts)),
  and forwards the request. The same name always maps to the same Durable
  Object id, so no lookup table is needed. The Worker sets an `x-cell-name`
  header itself; a client cannot pick another cell.
- **Durable Objects** give each resource a single running instance. Requests
  for one document or sheet are handled in one place, one at a time, so there
  are no cross-instance locks or races to manage. WebSocket sessions use the
  Hibernation API, so an idle cell can leave memory with connections open.
- **Per-cell SQLite** (`new_sqlite_classes` in [wrangler.jsonc](wrangler.jsonc))
  keeps code and data together: reads and writes are local calls through
  `ctx.storage.sql`, and one cell cannot read another's database. Plain SQL,
  no ORM.
- **Catalogue.** A document or sheet registers a summary in its
  `WorkspaceCell` after writes, which powers listing and search. Registration
  can fail independently of the save; the API then answers `502
  catalogue_registration_failed` and a retry is safe.

The cell boundary is also the unit of isolation: permissions are checked
inside the cell that owns the resource, not in the router.

## Implemented features

**Documents**
- Live collaborative Markdown editing (Yjs over WebSockets, CodeMirror 6) with
  presence and cursors.
- Autosave, reconnect, and offline edits kept in IndexedDB and synced on the
  next online open; version history with restore; repair of damaged Yjs
  storage.
- Roles per document (`none`, `read`, `comment`, `edit`, plus owner),
  enforced in the cell, including on the live socket.
- Comment threads (optionally anchored to text), Recycle Bin (30 days by
  default, `TRASH_RETENTION_MS`), folders, tags and search.

**Spreadsheets**
- Up to 100 rows × 26 columns. Cells store raw text; a leading `=` makes a
  formula, evaluated by the shared engine in [src/shared/sheet.ts](src/shared/sheet.ts):
  `+ - * / ( )`, `SUM`, `AVERAGE`, `MIN`, `MAX`, `COUNT`, ranges, and the errors
  `#ERR`, `#REF`, `#DIV/0`, `#CYCLE`, `#VALUE`.
- Live editing over WebSockets; the server broadcasts each accepted edit.
  Conflicts are last-writer-wins per cell.
- Per-sheet permissions (default role and per-user roles, owner-managed).

**Charts**
- Bar (vertical or horizontal) and line charts over cell ranges, up to 12 per
  sheet and 1–6 series each. A chart stores ranges, not data, so it follows
  edits to the cells. Charts can be created, edited and deleted, and changes
  reach all open pages.

**AI proposals**
- *Documents:* "Ask AI: edit" (free-text instruction) and "Ask AI: summarise"
  create a **pending proposal**; nothing changes until an editor applies it.
  The model must return JSON with `find`/`replace` edits; each `find` must
  occur exactly once and edits must not overlap, otherwise the whole answer is
  rejected. Applying uses Yjs relative positions, so concurrent edits elsewhere
  are kept; if the proposed lines were changed meanwhile, apply fails with
  `409 proposal_conflict`. A version is saved before each apply. Commenters
  may ask; editors apply.
- *Charts:* "Ask AI: suggest chart" returns a validated chart configuration
  (or a modification of an existing chart). It is a preview; nothing is saved
  until a person clicks **Add this chart** / **Apply to chart**. Editors only.
- A deterministic **simulated agent** (tidy, summary, replace) also exists and
  needs no model.

## AI configuration

AI runs server-side in [src/worker/llm.ts](src/worker/llm.ts). Keys are read
from the Worker environment and are never sent to the browser or included in
error messages (provider error text is scrubbed). Put local settings in
`.dev.vars` (git-ignored, not read by this documentation):

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Enables Gemini. |
| `LLM_MODEL` | Gemini model; default `gemini-flash-lite-latest`. |
| `GEMINI_MODELS` | Extra Gemini models to offer, comma-separated. |
| `OPENROUTER_API_KEY` | Enables OpenRouter. |
| `OPENROUTER_MODEL` | Default OpenRouter model (allowed even if paid). |
| `OPENROUTER_MODELS` | Extra OpenRouter models to allow, comma-separated. |
| `LLM_PROVIDER` | `gemini` or `openrouter`; otherwise the first configured key wins. |
| `LLM_MOCK=1` | Deterministic stand-in model for offline use and tests; no key needed. |

```sh
# .dev.vars (example; use your own key)
GEMINI_API_KEY=...
# or
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=<vendor>/<model>:free
```

- **Selector.** The page offers a provider and model picker (choice kept in
  `localStorage`). `GET /api/ai/providers` lists providers, whether each is
  configured, and models; it never returns a key.
- **Gemini** uses `generateContent` with a JSON response schema.
- **OpenRouter** uses chat completions with `response_format: json_object` and
  a single model per request (no fallback list). Free models that advertise
  tools and structured output are fetched from OpenRouter (cached 10 minutes).
  **Only models ending in `:free` are accepted** unless the operator lists the
  model in `OPENROUTER_MODEL` or `OPENROUTER_MODELS`; other model ids are
  rejected with `model_not_allowed`.
- Without a configured provider, AI endpoints answer `503 ai_not_configured`.
- The code also contains an Anthropic provider (`ANTHROPIC_API_KEY`), which is
  chosen first when its key is set and no provider is named. It is not offered
  in the page's selector.
- Model output is untrusted: it is parsed, schema-checked and, for charts,
  range-checked before anything is shown or stored. Requests time out after 60 s.

## Local setup and development

Requirements: Node.js 22.18 or newer, npm 10 or 11. To add or upgrade
packages use `npx npm@11 install <pkg>` (npm 10 crashes resolving this
dependency tree).

```sh
npm install
npm run dev        # Vite + Worker + Durable Objects at http://localhost:5180
```

State is kept in `.wrangler/state/` (one `.sqlite` file per cell); delete that
folder to start empty. Port 5180 is fixed (`strictPort`).

Seed sample data (document with typos, a sales sheet with two charts) into a
running dev server:

```sh
npm run demo:seed   # BASE_URL=http://localhost:<port> if not 5180
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Production build into `dist/` (not deployed) |
| `npm run typecheck` | Generates Worker types, then type-checks client, Worker, Node and e2e code |
| `npm run demo` | Command-line demo against a running dev server |
| `npm run demo:seed` | Seed demo data |

Requests act as a **test user** (`alice`, `bob`, `carol`) named by the
`x-test-user` header, or `?user=` on the page URL and WebSockets. Default is
`alice`. This is for exercising permissions; it is not authentication.

Ids use lowercase letters, digits and dashes (1–63 characters). Main routes
(all under `/api/workspaces/:ws`): `docs[/:doc[/sync|versions|comments|proposals|permissions|meta|restore|purge]]`,
`sheets[/:sheet[/sync|cells|charts[/:id|/suggest]|permissions]]`, `search`,
`trash`, `folders`; plus `/api/health` and `/api/ai/providers`. See
[src/worker/index.ts](src/worker/index.ts) for the complete routing table.

## Testing

| Command | Scope |
|---|---|
| `npm test` | Worker tests inside workerd with real bindings (routing, cells, permissions, sync, sheets, AI with the mock model and injected fetch) and client/shared tests in happy-dom |
| `npm run test:integration` | Starts the real dev server: restart persistence and live sync between two clients |
| `npm run test:e2e` | Playwright/Chromium with independent browsers (collaboration, comments and proposals, document management, sheets). First run: `npx playwright install chromium` |
| `npm run test:all` | Typecheck plus all of the above |

`npm test` sets `LLM_MOCK=1` and makes no network calls to model providers;
tests do not need keys. Provider adapters are tested with a stubbed `fetch`.
Calls to real Gemini or OpenRouter models are not part of the automated suite.

Documentation checks: there is no markdown linter or link checker in the
project. Before committing README changes, verify that every command in the
tables exists in `package.json` and that linked files exist.

## Project layout

```
src/worker/        router, cells (WorkspaceCell, DocCell, SheetCell), Yjs sync, llm.ts, simulated agent
src/shared/        API types, permissions, test users, formula engine and chart config
src/client/        React UI: editor, presence, comments, proposals, sheet grid and charts, AI model picker
test/worker/       tests inside workerd
test/client/       frontend tests (happy-dom); test/shared/ runs with them
test/integration/  real dev server: restart and sync
test/e2e/          Playwright
scripts/           demo and seed scripts
docs/              architecture notes, celld smoke test
wrangler.jsonc     bindings, migrations, vars
```

## Current limitations

- **No authentication.** The test user is whatever the request says. Anyone
  who can reach the server can act as any user; permissions demonstrate
  enforcement but protect nothing.
- **Local only.** Verified on workerd; nothing is deployed to Cloudflare. A
  first smoke test on celld passed without code changes
  ([docs/celld-smoke-test.md](docs/celld-smoke-test.md)); it is not a full
  compatibility run and predates sheets and AI.
- **Spreadsheets are basic.** The formula set is the list above (no other
  functions); cells are plain text with no formatting; last-writer-wins per
  cell; sheets have no version history, comments, Recycle Bin, or delete/rename.
- **Charts** are bar and line only, over single-column ranges of equal length;
  non-numeric values plot as 0.
- **AI proposals.** Document edits are whole-line proposals and stop applying
  once someone edits one of those lines. Quality depends on the model; free
  OpenRouter models may return invalid JSON, in which case the request fails
  and nothing is proposed. Prompts include the whole document (or up to 400
  cells for charts), so very large inputs are not handled specially. The
  document body limit (100,000 characters) is checked on `PUT`, not on live
  edits. There is no per-user rate limiting or usage tracking.
- **Documents.** The title autosaves about a second after typing but is not
  live; the last title saved wins. A document cannot be opened while offline
  (only edits made while connected earlier). Local IndexedDB copies are never
  cleaned up. A reader's delete-only change over a modified client is dropped
  silently. Search is substring matching on the catalogue copy, which lags live
  edits by about 2 seconds.
- Reading a resource that was never written still creates an empty database
  file for its cell.
- The client bundle is large (about 940 kB, 310 kB gzipped), mostly
  CodeMirror and Yjs, so `npm run build` warns about chunk size.
