# Architecture

This document explains how cell-docs-lab is put together and why. It covers
Phase 1 and the Phase 2 document catalogue.

## Key ideas

**Worker.** A Worker is a small serverless function that runs for each HTTP
request. It keeps no memory between requests, so any copy of it can handle any
request. Here, the Worker only routes requests.

**Durable Object.** A Durable Object is a single, uniquely addressable instance
of a class. The runtime guarantees that at most one instance with a given id is
running at a time, so requests for the same object are processed in one place,
one at a time. That removes most locking and race-condition problems.

**Cell.** In this project, a cell is one Durable Object instance that owns one
resource:

| Cell class | One instance per | Stores |
|---|---|---|
| `WorkspaceCell` | workspace | workspace settings (display name) and the document catalogue |
| `DocCell` | document | the document (title, revision, and the body as Yjs updates plus a plain-text copy) |

**SQLite per cell.** The classes are declared under `new_sqlite_classes` in
`wrangler.jsonc`, so every instance gets its own private SQLite database,
reached through `ctx.storage.sql`. No cell can read another cell's database.
The cell's code and its data sit together, so reads and writes are local calls,
not network round trips. The project uses plain SQL with no ORM.

## Request path

```
Browser ──HTTP──▶ Worker (router) ──stub.fetch()──▶ Cell (Durable Object) ──SQL──▶ the cell's own SQLite
```

1. The browser calls, for example, `PUT /api/workspaces/acme/docs/intro`.
2. The Worker (`src/worker/index.ts`) matches the URL and derives a **cell
   name**: `doc:acme/intro` (`src/worker/addressing.ts`).
3. `env.DOC_CELL.idFromName("doc:acme/intro")` turns the name into a Durable
   Object id. The same name always produces the same id, so there is no lookup
   table and any Worker instance reaches the same cell.
4. The Worker forwards only the method, body and content type, plus an
   `x-cell-name` header that it sets itself. A client cannot choose a different
   cell by sending that header.
5. The cell checks the name, validates the input, and writes inside
   `ctx.storage.transactionSync(...)`, so its SQL statements commit all
   together or not at all.
6. The response, which includes the cell's name and id, travels back to the
   browser.

## Live sync (Yjs over WebSockets)

The body of a document is a Yjs `Y.Text`. Browsers that open a document
connect to its `DocCell` at `/api/workspaces/:ws/docs/:doc/sync` and speak the
standard Yjs sync protocol (the `y-websocket` client on the browser side):

1. On connect, each side sends what it has, and the other answers with what
   is missing. The editor appears only after this first exchange, so every
   browser starts from the server's content.
2. After that, every edit is sent as a small update. `DocCell` applies it to
   its own `Y.Doc`, stores it, and forwards it to the other connections.

**One source of truth.** The Yjs state, stored as an append-only log in
`yjs_updates`, is the body. `doc.body` is a plain-text copy rewritten on
every update, in the same handler, so REST reads and the Yjs state cannot
disagree. A `PUT` with a body is applied to the `Y.Text` (only the changed
range is replaced) and reaches connected browsers like any other edit.

**Existing documents.** A document written before live sync has no Yjs
updates. The first time its Yjs state is loaded, `DocCell` creates it from
`doc.body`, once, on the server. Browsers never fill in the text themselves,
since two browsers doing so would duplicate it.

**Durability and restarts.** Updates are written to SQLite before being
forwarded; Durable Objects hold outgoing messages until those writes are
durable. Sockets use the Hibernation API, so an idle cell can leave memory
with connections open and rebuild its `Y.Doc` from SQLite on the next
message. Above 100 stored updates, loading merges them into one row.

Only existing documents can be opened (`404` otherwise); documents are still
created with `PUT`. Presence messages from the client are ignored for now.

## Document catalogue

Each `WorkspaceCell` keeps a `documents` table listing the docs in its
workspace. A document request is handled in two steps:

1. The router forwards the request to the `DocCell`, exactly as in Phase 1.
2. If the response is `200` or `201`, the router registers the doc in the
   `WorkspaceCell` (internal path `PUT /docs/<docId>`, with the doc's
   `createdAt`). Registration is idempotent.

Writing the `DocCell` first means a document is never listed before it
exists. The two cells cannot share a transaction, so a crash or error between
the steps can leave a saved doc unlisted. The router reports that as `502
catalogue_registration_failed`, and the next successful read or write of the
doc registers it. The same rule adds Phase 1 documents to the catalogue the
first time they are read or saved, without migrating or resetting any data.

Clients can only list the catalogue (`GET /api/workspaces/:id/docs`). The
router does not forward any client request to the registration path.

Non-API paths never reach the Worker code: the static-asset layer serves the
React app (`assets.run_worker_first: ["/api/*"]`).

## Addressing rules

- Workspace cell name: `workspace:<workspaceId>`
- Document cell name: `doc:<workspaceId>/<docId>`. Because the name includes
  the workspace, the same doc id in two workspaces lives in two separate cells.
- Ids must match `^[a-z0-9][a-z0-9-]{0,62}$`, so names cannot be ambiguous.

The first write to a cell records its name in a small `cell_meta` table. Every
later request is checked against it (`409` on mismatch). This guards against a
routing bug ever mixing two resources in one database.

## Storage schema (per cell)

Each cell creates its tables in its constructor with
`CREATE TABLE IF NOT EXISTS`, which is safe to run every time the cell starts.

```sql
-- every cell
cell_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)

-- WorkspaceCell
workspace (id INTEGER PRIMARY KEY CHECK (id = 1), display_name, created_at, updated_at)
documents (doc_id TEXT PRIMARY KEY, created_at)

-- DocCell
doc (id INTEGER PRIMARY KEY CHECK (id = 1), title, body, revision, created_at, updated_at)
yjs_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB)  -- body = merged updates
```

`CHECK (id = 1)` allows only one row, because each database belongs to exactly
one workspace or one document.

## Persistence and restarts

A cell's in-memory instance can be stopped at any time: when it's idle, during
a deploy, or if a process crashes. The SQLite database stays. When the next
request arrives, a fresh instance is constructed and reads its state back from
SQLite. A write's response is only sent once the data is durably stored.

How this is verified:

- `test/worker/cells.test.ts` evicts a cell from memory, proves the new
  instance is fresh, and reads the data back.
- `test/integration/restart.test.ts` stops the whole local server (gracefully
  with `SIGTERM`, and as a simulated crash with `SIGKILL`), restarts it on the
  same state directory, and reads the data back. As a control, the test fails
  when persistence is turned off.

## Local development stack

- **Vite** serves the React app. The **Cloudflare Vite plugin** runs the Worker
  and its Durable Objects in workerd, using the same `wrangler.jsonc`.
- Local state lives in `.wrangler/state/`, with one `.sqlite` file per cell.
- **Vitest** with `@cloudflare/vitest-plugin` runs the tests inside workerd
  with the real bindings.

## Boundaries for later phases

- **Phase 2 (lifecycle):** the catalogue lists docs but does not yet gate
  access to them; reads still go straight to the `DocCell`. Deleting and
  renaming documents are not implemented yet.
- **Phase 3 (collaboration):** live sync is in place (see above). Presence
  (who is editing, remote cursors) is next.
- **Phase 5 (celld):** cells talk to the router only through `fetch()`, a
  small and portable interface, which should make running them on another
  runtime easier.
