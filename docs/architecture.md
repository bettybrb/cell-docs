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
message. Whenever the log holds more than 500 updates (checked on load and
after every update), they are merged into one row.

**Damaged storage.** Because `doc.body` is written together with every
update, it is the latest known text, and loading compares the Yjs text with
it. A stored update that cannot be read is moved to `yjs_quarantine` (kept,
never loaded). A missing update makes Yjs silently leave out everything that
depends on it. In either case, if the loaded text differs from `doc.body`,
`DocCell` repairs the Yjs state with an ordinary edit that replaces only the
differing range, and logs it. The repair is stored and synced like any edit.
Caveat: if a browser that still holds the lost update reconnects later, Yjs
adds that update's content again, so some text may appear twice.

Only existing documents can be opened (`404` otherwise); documents are still
created with `PUT`.

## Presence and reconnection

**Presence** uses Yjs *awareness*, the second message type on the same
socket. Each browser shares a small state (a guest name and colour, plus its
cursor). `DocCell` forwards awareness messages to the other connections and
keeps each socket's latest state in the socket's attachment, which survives
hibernation. With that it can:

- send a newcomer everyone already connected;
- announce a leave when a socket closes, even without a goodbye (tab killed,
  network lost, server restart), by sending that client's state as `null` at
  its last clock. Browsers also drop anyone they have not heard from for 30
  seconds, as a fallback.

Each awareness state has a clock, and an update with a clock that is not
newer is ignored. A browser that was announced as gone therefore re-sends its
state with a higher clock every time it connects; otherwise the others would
not see it again until its next periodic renewal (up to 30 seconds).

**Reconnection** needs no extra server logic. `y-websocket` retries with a
growing delay (at most 2.5 s). The editor stays editable offline: edits go
into the browser's `Y.Doc`. On reconnect the normal first exchange (each side
sends what it has, the other answers with what is missing) delivers those
edits to `DocCell`, and anything others wrote meanwhile to the browser. Yjs
merges both without losing either. After a backend restart the same happens,
with `DocCell` first rebuilding its `Y.Doc` from SQLite.

**Local copy (IndexedDB).** Each open document is also kept in the
browser's IndexedDB (`y-indexeddb`), so edits made offline survive closing
the tab, a crash or a browser restart. The next time the document is opened
(online), the local copy is loaded into the fresh `Y.Doc`, merged with the
server's state, and its edits count as unsaved until a save check confirms
them. The local database is named after the document *and its `createdAt`*:
if a document is recreated under the same id (for example after deleting
`.wrangler/state`), old local copies are ignored instead of merging their
text into the new document.

**Saved acknowledgements.** The browser numbers its own edits and, 250 ms
after the last one (or right after a reconnect's first sync), sends a *save
check* `[100, n]` on the same socket (`src/shared/save-check.ts`). `DocCell`
sends the message straight back. Messages on a socket are handled in order,
and the runtime holds the reply until earlier writes are durable, so the
answer means every edit up to `n` is stored, deletions included (state
vectors would miss those). The editor shows "All changes saved", "Saving…"
or "Not saved yet, will sync when back online", and the page asks before
closing while anything is unconfirmed.

## Version history

`DocCell` keeps up to 50 versions (title and full body) in `doc_versions`:

- **On a manual save** (a `PUT` that includes a body): the saved text.
  Title-only autosaves do not create versions.
- **Before live edits**, when the newest version is at least 5 minutes old:
  the text from just before the edit (read from `doc.body` before the
  update handler rewrites it). Changes the cell makes itself (saves,
  repairs, restores) do not trigger this.
- **Before a restore**: the text being replaced, so a restore can be undone
  by restoring that version.

A restore applies the body as an ordinary Yjs edit (only the differing
range), so every open browser updates live, sets the title, and raises the
revision. It goes through the router like a save, which refreshes the
catalogue's title copy. Nothing is ever deleted by a restore: every older
version stays, and the replaced text becomes one more version.

Each version records **who** caused it (`created_by`: the saver, the editor
whose edit started a new burst, or the restorer) and **who edited** the
document since the previous version (`editors`, collected from saves and
from each live edit's socket). `GET …/versions/:id` returns a version's full
text, which the page shows as a preview.

## Users and permissions

There is no login. A request names a **test user** (`alice`, `bob`,
`carol`) in the `x-test-user` header, or `?user=` on the sync WebSocket
because browsers cannot set headers there. The router checks the name and
passes it to the cell in its own `x-user` header, like the cell name, so a
client cannot bypass the router's check. Requests without a user act as
`alice`.

Each `DocCell` owns its permissions: an **owner** (the creator), a
**default role** for everyone else and **per-user roles**. Roles, weakest
first: `none` (a default of `none` makes the document private), `read`,
`comment`, `edit`; the owner can also change permissions and delete for
good. Documents created before permissions have no owner and stay editable
by everyone; the first editor to change their permissions becomes the owner.

Enforcement is on the server, in the `DocCell`:

- **Every HTTP request** checks the caller's role (`403 forbidden` otherwise).
- **Every WebSocket message** is checked against the *current* permissions,
  not the ones at connect time. A reader's normal sync messages add nothing;
  a message that would add content is refused and the connection is closed
  with code `4409` ("edit rejected"), so the client does not keep text it
  believes is saved (it also deletes its local IndexedDB copy).
- **When permissions change**, every connected browser is told its new role
  at once (message `[101, json]`), and the page switches the editor to
  read-only in place; one that lost access is disconnected with `4403`.

The workspace catalogue keeps a copy of each document's permissions and
uses it to list, search and show the Recycle Bin only with documents the
user may read. The copy decides what is *shown*; the `DocCell` still
decides every request.

## Recycle Bin

`DELETE …/docs/:docId` is a soft delete: the `DocCell` records who deleted it
and when, closes every connection with `4410`, refuses reads and writes with
`410`, and schedules a Durable Object **alarm** for the purge time (30 days;
`TRASH_RETENTION_MS` in `wrangler.jsonc`, or `.dev.vars` for local testing).
Its text, Yjs history, versions and comments stay untouched.

- **Restore** (`POST …/restore`, editors) clears the deleted state; the
  document keeps its id and everything else.
- **Delete for good** happens when the alarm fires after the deadline, or at
  once with `POST …/purge` (owner only). The `DocCell` first removes its
  catalogue entry (a cell-to-cell call to the `WorkspaceCell`), then erases
  all of its own storage with `deleteAll()`. If the catalogue call fails,
  nothing is erased and the alarm retries. Afterwards the id can be used for
  a new document; its new `createdAt` keeps browsers from merging old local
  copies into it.

## Folders, tags and search

Folders and tags belong to the catalogue (`WorkspaceCell`): a document's id
and URL never depend on its folder, and moving it changes one column.
Folders can be nested and are deleted only when empty. Tags are stored in
lower case and offered for reuse with their counts.

Search (`GET …/search?q=&tag=&folder=`) matches `q` case-insensitively in
titles, text and tags, and returns a snippet around content matches. It
reads the catalogue's copy of each document's text: the router refreshes it
after every document request, and the `DocCell` refreshes it about 2 seconds
after live edits (which do not pass the router), using the same alarm as the
Recycle Bin.

## Comment threads

Threads live in the `DocCell`'s SQLite (`comments`): a thread is a row
without `parent_id`, its replies point at it. A thread can be **anchored**
to a range of text by two **Yjs relative positions** (`anchor_start`,
`anchor_end`, base64 of `Y.encodeRelativePosition`). A relative position
names a place by the Yjs ids of the characters around it, not by an offset,
so every browser turns it back into the current offsets after any edit and
the highlight follows its text. The start sticks to the first character
after it and the end to the last character before it, so text typed just
outside the range stays outside. If all of the text is deleted, the range
becomes empty; the thread stays, with the quote taken when it was started.

The server checks that both positions resolve in its own copy of the
document (an anchor cannot point at text it has never seen) and takes the
quote from its own text. Readers see threads; commenters, editors and the
owner can start, reply, resolve and reopen. Every change sends
`[102, {"topic":"comments"}]` on the sync WebSocket, and open pages reload
the threads.

Why not keep threads inside the Yjs document? Commenters may not change the
document, and the server would then have to inspect every binary update to
tell comment changes from text changes. SQL plus relative positions keeps
enforcement simple while the anchors still follow the shared text.

## Agent proposals

A **simulated agent** (`src/worker/agent.ts`: tidy, add a summary, replace)
stands in for an AI model. Asking it (commenters and up) stores a *pending*
proposal and changes nothing. The proposal is split into **changes of whole
lines** (`diffLines`); each is stored with its original text, its
replacement, a little context for the preview, and two Yjs relative
positions for where it applies.

**Applying** (editors and up) works on the document as it is *now*: each
change is located through its relative positions and accepted only if its
original text is still exactly there. Then all changes are applied in one
Yjs transaction, so edits others made elsewhere since the proposal are kept,
and every open browser receives the change live. If any change's lines were
edited meanwhile, nothing is applied (`409 proposal_conflict`), and the
listing marks those changes as no longer fitting; the proposal can be
discarded (by editors or by whoever asked) and asked for again. Before
applying, the text is kept as a "Before an agent proposal" version, so an
applied proposal can be undone with Restore. Each proposal is applied or
discarded at most once.

## Document catalogue

Each `WorkspaceCell` keeps a `documents` table listing the docs in its
workspace. A document request is handled in two steps:

1. The router forwards the request to the `DocCell`, exactly as in Phase 1.
2. If the response is `200` or `201`, the router registers the doc in the
   `WorkspaceCell` (internal path `PUT /docs/<docId>`, with the doc's
   `createdAt` and title). Registration is idempotent and refreshes the
   catalogue's copy of the title, which the document list shows.

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
documents (doc_id TEXT PRIMARY KEY, created_at, updated_at, title, body_text, owner, default_role, acl,
           deleted_at, deleted_by, purge_at,   -- copies from the DocCell
           folder_id)                          -- the catalogue's own
folders  (id TEXT PRIMARY KEY, name, parent_id, created_at)
doc_tags (doc_id, tag, PRIMARY KEY (doc_id, tag))

-- DocCell
doc (id INTEGER PRIMARY KEY CHECK (id = 1), title, body, revision, created_at, updated_at,
     owner, default_role, acl, deleted_at, deleted_by, purge_at)
yjs_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB)  -- body = merged updates
yjs_quarantine (seq INTEGER PRIMARY KEY, data BLOB, quarantined_at)  -- unreadable updates
doc_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at, reason, title, body, created_by, editors)  -- newest 50
comments (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at, author, body,
          parent_id, anchor_start, anchor_end, quote, resolved_at, resolved_by)  -- threads and replies
proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at, requested_by, instruction, summary,
           changes, status, decided_by, decided_at)  -- changes: JSON with relative positions
```

Columns added after a table was first created are added on startup when
missing (`ALTER TABLE … ADD COLUMN`), because `CREATE TABLE IF NOT EXISTS`
never changes an existing table. Existing data keeps working with the new
defaults.

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
- `test/e2e/collaboration.spec.ts` kills the server with `SIGKILL` while a
  browser is editing: everything shown as "All changes saved" is still there
  after the restart, and edits typed just before the crash are resent.

## Failure modes at a glance

| What goes wrong | What happens | Covered by |
|---|---|---|
| Network drops (one browser) | Editor stays editable, status shows offline; reconnects on its own and exchanges missing edits both ways | e2e: lost connection, Go offline toggle |
| Tab closed or browser crashes while offline | Edits are in IndexedDB; synced the next time the doc is opened | e2e: offline edits survive closing the tab |
| Server stopped or killed (`SIGTERM`/`SIGKILL`) | Acknowledged edits are durable; unacknowledged ones are resent after reconnect | integration: restart; e2e: restart, crash mid-editing |
| A cell is evicted from memory | Rebuilt from SQLite on the next request or message | worker: eviction tests |
| A stored Yjs update is unreadable or missing | Unreadable rows are quarantined; the text is repaired from `doc.body` | worker: recovery tests |
| Someone deletes or breaks content | Restore any of the last 50 versions; a restore can be undone | worker: versions; e2e: restore |
| Catalogue registration fails | Retried briefly; otherwise `502`, and the next read or save registers it | worker: registration policy, catalogue |
| Title save fails | Retried every 3 s on network errors and 5xx; a rejected title shows the reason | e2e: title retries |

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
- **Phase 3 (collaboration):** done: live sync, presence and reconnection.
- **Phase 4 (autosave and recovery):** done: saved acknowledgements, local
  IndexedDB copies, title autosave, log merging, damaged-storage repair and
  version history (see above and "Failure modes at a glance"). Not covered:
  Cloudflare's point-in-time recovery for Durable Objects
  (`ctx.storage.getBookmarkForTime`), which can roll a whole cell back to any
  moment in the last 30 days but only exists on Cloudflare, not in local
  workerd, so it could not be tested here.
- **Phase 5 (celld):** cells talk to the router only through `fetch()`, a
  small and portable interface, which should make running them on another
  runtime easier.

## Testing documents, permissions and the Recycle Bin by hand

Start the app with `npm run dev` and open two windows side by side, one as
`alice` and one as `bob` (use the "Acting as test user" switcher, or add
`&user=bob` to the URL). A private window works as the second browser.

1. **Permissions while connected.** As alice, open a document. As bob, open
   the same document (Load doc) and type: alice sees it live. As alice,
   open **Permissions**, set bob to *Read only* and save. Bob's status line
   changes to "Read only" at once and his editor stops accepting keys, but
   he still sees alice's typing. Set *Everyone else* to *No access
   (private)* and bob to *Same as everyone*: bob's page says his access was
   removed, the document disappears from his list, and loading it shows
   `403`.
2. **Comment role.** Give carol *Can comment*. As carol (third window), the
   editor is read-only, Save is disabled, and **Comments** lets her add one.
3. **Recycle Bin.** As alice, click **Move to Recycle Bin**. Bob's open copy
   says it was moved there; it vanishes from both lists and appears under
   **Recycle Bin** with who deleted it and when it will be erased. Click
   **Restore**: the document reopens with the same id, text, versions and
   comments. **Delete forever** (owner only) erases it at once.
   To watch the automatic deletion, create `.dev.vars` with
   `TRASH_RETENTION_MS=60000`, restart `npm run dev`, delete a document and
   wait a minute: it leaves the Recycle Bin by itself.
4. **Folders, tags and search.** Create a folder, then in **Folder, tags and
   delete** move the open document into it and give it tags. The list shows
   the folder and tags, and the URL (the id) is unchanged. Type a word from
   the text into the search box: the document appears with a snippet. Pick
   a tag in the tag filter.
5. **Version history.** Click **Save doc** as alice, edit and save as bob.
   **Versions** shows who saved each version and who edited in between.
   **Preview** shows an old version's full text; **Restore** brings it back
   in every open window and adds the replaced text as a new version, so
   nothing is lost.
6. **Comments on text.** As alice, select a few words in the editor, type
   in the comment box and click **Comment on selection**: the words are
   highlighted in both windows. As bob, type before and after them: the
   highlight stays on the same words. Bob can **Reply** and **Resolve**;
   alice sees both without reloading (tick **Show resolved** to see resolved
   threads). Delete the highlighted words: the thread says its text was
   deleted and keeps the quote.
7. **Agent proposals.** As alice, enter *find* and *replace with* and click
   **Ask agent: replace** (or *tidy up*, or *add a summary*). The preview
   shows each changed line as removed and added text; the document does not
   change yet. As bob, edit a *different* line, then as alice click
   **Apply**: the change lands and bob's edit stays. Ask again, and this
   time let bob edit *the same line* first: the proposal says its change no
   longer fits, **Apply** is disabled, and **Discard** removes it. As carol
   with *Can comment*, asking works but **Apply** is disabled. After an
   apply, **Versions** has a "Before an agent proposal" entry to undo it.
