# cell-docs-lab

An exploration project: a small document application built from **cells**,
where each cell is one [Cloudflare Durable Object](https://developers.cloudflare.com/durable-objects/)
with its own private SQLite database.

- One `WorkspaceCell` per workspace, one `DocCell` per document.
- A stateless Worker routes every API request to exactly one cell, chosen
  deterministically from the URL.
- Everything runs locally in [workerd](https://github.com/cloudflare/workerd),
  the open-source Workers runtime. No Cloudflare account is needed.

**Status:** Phase 1 (foundation) is done. Phase 2 is in progress: the document
catalogue works; the rest of the document lifecycle and later phases are
planned; see [Roadmap](#roadmap).
Design notes are in [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js 22.18 or newer (tested with 23.11)
- npm 10 or 11. Installing from the lockfile works with both. To *add or
  upgrade* packages, use `npx npm@11 install <pkg>`: npm 10 crashes while
  resolving this dependency tree (an internal `edgesOut` error). The
  `allowScripts` field in `package.json` is npm 11's install-script allowlist.

## Quick start

```sh
npm install          # install dependencies
npm run dev          # start the app at http://localhost:5180
```

Stop the server with `Ctrl+C`. Data is kept in `.wrangler/state/` (git-ignored).
Delete that folder to start from an empty state.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite + Worker + Durable Objects on http://localhost:5180 |
| `npm run typecheck` | Generates Worker types, then type-checks the client, Worker and Node code |
| `npm test` | Tests inside workerd (routing, addressing, isolation, eviction/restart) and client tests with happy-dom (editor ↔ Y.Text binding) |
| `npm run test:integration` | Starts the real dev server: restart persistence (`SIGTERM` and `SIGKILL`) and live sync between two clients |
| `npm run test:all` | Typecheck + both test suites |
| `npm run demo` | End-to-end demo with generated data against a running dev server |
| `npm run build` | Production build into `dist/` (nothing is deployed) |

## API

| Method | Path | Cell |
|---|---|---|
| `GET` | `/api/health` | none (answered by the router) |
| `GET` / `PUT` | `/api/workspaces/:workspaceId` | `WorkspaceCell` named `workspace:<workspaceId>` |
| `GET` | `/api/workspaces/:workspaceId/docs` | `WorkspaceCell` (the document catalogue) |
| `GET` / `PUT` | `/api/workspaces/:workspaceId/docs/:docId` | `DocCell` named `doc:<workspaceId>/<docId>`, then `WorkspaceCell` to register it |
| `GET` (WebSocket) | `/api/workspaces/:workspaceId/docs/:docId/sync` | `DocCell`: live Yjs sync of the body (existing docs only) |

Ids use lowercase letters, digits and dashes (1–63 characters).
`GET` returns `404` until the resource has been written once. The document
list is empty (not `404`) for a workspace with no documents, and workspaces do
not need to be created before adding documents.

Every successful document read or write also registers the document in the
catalogue. If that registration fails, the document is still saved and the
response is `502` with code `catalogue_registration_failed`; retrying the
request is safe. Documents saved before the catalogue existed appear in the
list after they are read or saved once.
Every response includes a `cell` object with the cell's name, Durable Object
id and SQLite size, so you can see which cell answered.

```sh
curl -X PUT localhost:5180/api/workspaces/demo/docs/intro \
  -H 'content-type: application/json' -d '{"title":"Intro","body":"Hello"}'
curl localhost:5180/api/workspaces/demo/docs/intro
```

## Verifying it yourself

1. **Backend:** `curl localhost:5180/api/health`
2. **Frontend:** open http://localhost:5180, check that it shows "Backend OK", then save a doc and
   select it from the document list.
3. **Cells:** `npm run demo`. Every line should say `PASS`, and the table shows a
   different cell id per resource.
4. **SQLite persistence:** save a doc, stop and restart `npm run dev`, then load
   it again. Each cell's database is a separate file under
   `.wrangler/state/v3/do/cell-docs-lab-DocCell/<id>.sqlite`, and you can read
   it with `sqlite3 -readonly <file> "SELECT * FROM doc"`.

## Project layout

```
src/worker/index.ts            stateless router (Worker entry point)
src/worker/addressing.ts       resource → cell name rules
src/worker/cells/              WorkspaceCell, DocCell, shared cell bookkeeping
src/shared/                    API types and dummy-data generator
src/client/                    React page
test/worker/                   tests that run inside workerd
test/client/                   frontend tests (happy-dom)
test/integration/              restart test against the real dev server
scripts/demo.ts                command-line demo
wrangler.jsonc                 bindings and SQLite migrations
```

## Roadmap

1. Foundation: router, cells, per-cell SQLite, tests ✅
2. Resource catalogue ✅ and document lifecycle
3. Collaborative Markdown editing (Yjs, CodeMirror 6, WebSockets) and presence
4. Autosave, reconnect and recovery
5. Compatibility testing with the open-source celld runtime
6. Documentation, CI and handover

## Known limitations

- No authentication: anyone who can reach the server can read and write any cell.
- Reading a resource that was never written still creates an empty database
  file for that cell, because the cell creates its tables when it starts.
- Opening a document connects it to live sync, so body edits are saved and
  shared without pressing Save. The title still needs Save, and `revision`
  counts saves, not live edits.
- The body length limit (100,000 characters) is only checked on `PUT`, not on
  live edits.
- No presence yet: you cannot see who else has the document open.
- Only verified locally. Nothing has been deployed to Cloudflare.
- The client bundle is about 930 kB (about 310 kB gzipped), mostly CodeMirror,
  the language packages that `@codemirror/lang-markdown` pulls in, and Yjs, so
  `npm run build` warns about chunk size. Loading the editor lazily is deferred.
